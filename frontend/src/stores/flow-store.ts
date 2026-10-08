import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createDebouncedJSONStorage } from "@/lib/debounced-storage";
import {
  checkConnection,
  createEdge,
  fromFlow,
  newId,
  parseFlowJson,
  toFlow,
  type CanvasEdge,
  type CanvasNode,
  type ConnectionCheck,
} from "@/lib/flow/graph";
import { contentFingerprint } from "@/lib/flow/fingerprint";
import { renameReferences } from "@/lib/flow/references";
import { refProblem, uniqueRef } from "@/lib/flow/refs";
import { createFlowFromTemplate, type FlowTemplate } from "@/lib/flow/templates";
import { issuesByNode, validateFlow, type FlowIssue } from "@/lib/flow/validate";
import { createDefaultData, NODE_REGISTRY } from "@/lib/nodes/registry";
import type { Flow, NodeData, NodeType } from "@/types/flow";

const HISTORY_LIMIT = 100;
/** Edits with the same coalesce key within this window become one undo step. */
const COALESCE_MS = 1000;

type Snapshot = { nodes: CanvasNode[]; edges: CanvasEdge[]; name: string; description: string };

/**
 * What the local backup holds (persist version 3): the flow's content and the server version it
 * was based on, so a restore can tell "unsaved edits on top of the latest save" from "edits made on
 * an older version that has since changed elsewhere".
 */
type PersistedDraft = { flow: Flow; baseVersion?: number | null };

/**
 * Local backup of the open flow, per user *and* flow, written continuously (debounced). The server
 * is the source of truth; the backup lets the editor recover edits that never reached it (crash,
 * closed tab, failed save). See `readDraftBackup`.
 */
export const draftKeyFor = (uid: string, flowId: string) => `mesh:flow-draft:${uid}:${flowId}`;
const UNBOUND_DRAFT_KEY = "mesh:flow-draft:unbound";
const draftStorage = createDebouncedJSONStorage<PersistedDraft>(() => localStorage);

/** Writes any pending draft immediately (tests, and before navigating away programmatically). */
export const flushDraft = () => draftStorage.flush();

/** Points the local backup at this flow (finishing the previous flow's pending write first). */
export function bindDraft(uid: string, flowId: string): void {
  flushDraft();
  useFlowStore.persist.setOptions({ name: draftKeyFor(uid, flowId) });
}

/** The local backup of `flowId` for `uid`, if it holds a valid flow. Call after `bindDraft`. */
export function readDraftBackup(
  uid: string,
  flowId: string,
): { flow: Flow; baseVersion: number | null } | null {
  try {
    const raw = localStorage.getItem(draftKeyFor(uid, flowId));
    if (!raw) return null;
    const { state } = JSON.parse(raw) as { state?: PersistedDraft };
    const flow = parseStoredDraft(raw);
    return flow ? { flow, baseVersion: state?.baseVersion ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Drafts from before flows lived on the server: one shared pre-auth draft and one per user. The
 * dashboard offers to import them as server flows.
 */
export const legacyDraftKeysFor = (uid: string) => ["mesh:flow-draft", `mesh:flow-draft:${uid}`];

/** Parses a stored draft (persist v1 or v2) into a valid flow, or null. */
export function parseStoredDraft(raw: string | null): Flow | null {
  if (!raw) return null;
  try {
    const { state, version } = JSON.parse(raw) as { state?: unknown; version?: number };
    const persisted = (version ?? 0) < 2 ? migrateV1(state) : state;
    return restoreDraft(persisted);
  } catch {
    return null;
  }
}

/** The first non-empty legacy draft for `uid`, if any. */
export function findLegacyDraft(uid: string): { key: string; flow: Flow } | null {
  for (const key of legacyDraftKeysFor(uid)) {
    try {
      const flow = parseStoredDraft(localStorage.getItem(key));
      if (flow && flow.nodes.length > 0) return { key, flow };
    } catch {
      return null; // storage unavailable
    }
  }
  return null;
}

export function discardLegacyDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** v1 stored the flow's fields flat ({ flowId, name, description, nodes, edges }). */
function migrateV1(persisted: unknown): PersistedDraft {
  const v1 = (persisted ?? {}) as Record<string, unknown>;
  return {
    flow: {
      schema_version: 1,
      flow_id: (v1.flowId as string | null) ?? null,
      name: (v1.name as string) ?? "Untitled flow",
      description: (v1.description as string) ?? "",
      nodes: v1.nodes as Flow["nodes"],
      edges: v1.edges as Flow["edges"],
    },
  };
}

/**
 * React Flow reports one deletion as separate node and edge changes in the same tick. Open a
 * "removal batch" for the current tick so they share a single undo step, while deletions a
 * moment apart still get their own.
 */
let removalBatchOpen = false;
function snapshotRemovalBatch(snapshot: () => void) {
  if (removalBatchOpen) return;
  removalBatchOpen = true;
  snapshot();
  queueMicrotask(() => {
    removalBatchOpen = false;
  });
}

/**
 * Returns the persisted draft only if it is still a valid flow (node types can be renamed or
 * removed between releases); otherwise null, and the caller falls back to the starter flow.
 */
function restoreDraft(persisted: unknown): Flow | null {
  const flow = (persisted as Partial<PersistedDraft> | undefined)?.flow;
  if (!flow) return null;
  const result = parseFlowJson(JSON.stringify(flow));
  if (!result.ok) {
    console.warn(`Discarding saved draft: ${result.error}`);
    return null;
  }
  return result.flow;
}

export type SaveStatus = "idle" | "saving" | "error" | "conflict";

export interface SaveState {
  status: SaveStatus;
  /** User-facing message for `error`. */
  error: string | null;
  /** Whether an `error` is worth retrying automatically (network/5xx yes, validation no). */
  retryable: boolean;
  /** Consecutive failed attempts, for retry backoff. */
  failures: number;
  lastSavedAt: number | null;
}

const INITIAL_SAVE: SaveState = {
  status: "idle",
  error: null,
  retryable: true,
  failures: 0,
  lastSavedAt: null,
};

interface FlowState {
  flowId: string | null;
  /** Server version this state is based on (null for flows not loaded from the server). */
  version: number | null;
  name: string;
  description: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeId: string | null;

  /** Derived from nodes/edges by `validateFlow`; kept in sync by a store subscription below. */
  issues: FlowIssue[];
  nodeIssues: Record<string, FlowIssue[]>;

  /** `contentFingerprint` of the current content (kept in sync by a subscription below). */
  fingerprint: string;
  /** Fingerprint of the content last loaded from / saved to the server. */
  savedFingerprint: string;
  /** Current content differs from what the server has. */
  dirty: boolean;
  save: SaveState;
  /** Unsaved local edits awaiting the user's decision (see RecoveryBanner). */
  pendingRecovery: Flow | null;

  past: Snapshot[];
  future: Snapshot[];
  lastSnapshot: { key: string | null; at: number };

  // React Flow wiring
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect: (connection: Connection) => ConnectionCheck;

  // Graph edits
  addNode: (type: NodeType, position: XYPosition) => string;
  updateNodeData: (id: string, patch: Partial<NodeData>) => void;
  /**
   * Renames a node's ref and rewrites every `{{oldRef.output…}}` in templated fields to match.
   * Returns a user-facing problem (and changes nothing) if the name can't be used.
   */
  renameRef: (id: string, ref: string) => string | null;
  deleteNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  setMeta: (meta: Partial<{ name: string; description: string }>) => void;

  // Whole-flow operations
  /** Loads a flow as the saved (clean) state. */
  loadFlow: (flow: Flow & { version?: number }) => void;
  /**
   * Replaces the content with `flow`'s as an ordinary edit — undoable, unsaved (so autosave sends
   * it) — keeping this flow's id and version. Used for imports and recovered local edits.
   */
  replaceContent: (flow: Flow) => void;
  /**
   * Records a successful save of content with `fingerprint`. Ignored if another flow has been
   * opened meanwhile (saves can finish after the user navigated away).
   */
  markSaved: (flowId: string, version: number, fingerprint: string) => void;
  setSave: (patch: Partial<SaveState>) => void;
  newFlow: (template?: FlowTemplate) => void;
  toFlow: () => Flow;

  // History
  snapshot: (coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
}

const RESET = {
  selectedNodeId: null,
  past: [] as Snapshot[],
  future: [] as Snapshot[],
  lastSnapshot: { key: null, at: 0 },
};

function stateFromFlow(flow: Flow & { version?: number }) {
  const { nodes, edges } = fromFlow(flow);
  const issues = validateFlow(nodes, edges);
  // Fingerprint the *normalised* content (e.g. refs filled in for older flows), so loading alone
  // never makes a flow look unsaved.
  const fingerprint = contentFingerprint({ ...flow, nodes: toFlow(flow, nodes, edges).nodes });
  return {
    fingerprint,
    savedFingerprint: fingerprint,
    dirty: false,
    save: INITIAL_SAVE,
    pendingRecovery: null,
    ...RESET,
    flowId: flow.flow_id,
    version: flow.version ?? null,
    name: flow.name,
    description: flow.description,
    nodes,
    edges,
    issues,
    nodeIssues: issuesByNode(issues),
  };
}

const selectedIdOf = (nodes: CanvasNode[]): string | null => {
  const selected = nodes.filter((n) => n.selected);
  return selected.length === 1 ? selected[0].id : null;
};

export const useFlowStore = create<FlowState>()(
  persist(
    (set, get) => ({
      ...stateFromFlow(createFlowFromTemplate("starter")),

      onNodesChange: (changes) => {
        const { nodes } = get();
        const startsDrag = changes.some(
          (c) =>
            c.type === "position" && c.dragging && !nodes.find((n) => n.id === c.id)?.dragging,
        );
        if (startsDrag) get().snapshot();
        if (changes.some((c) => c.type === "remove" || c.type === "add")) {
          snapshotRemovalBatch(get().snapshot);
        }

        const next = applyNodeChanges(changes, nodes);
        set({ nodes: next, selectedNodeId: selectedIdOf(next) });
      },

      onEdgesChange: (changes) => {
        if (changes.some((c) => c.type === "remove" || c.type === "add")) {
          snapshotRemovalBatch(get().snapshot);
        }
        set({ edges: applyEdgeChanges(changes, get().edges) });
      },

      onConnect: (connection) => {
        const { nodes, edges } = get();
        const check = checkConnection(connection, nodes, edges);
        if (check.ok) {
          get().snapshot();
          set({ edges: [...edges, createEdge(connection, check.type)] });
        }
        return check;
      },

      addNode: (type, position) => {
        get().snapshot();
        const id = newId("node");
        const taken = get().nodes.flatMap((n) => [n.id, n.ref ?? ""]);
        const ref = uniqueRef(NODE_REGISTRY[type].refPrefix, taken);
        const node: CanvasNode = {
          id,
          type,
          ref,
          position,
          data: createDefaultData(type),
          selected: true,
        };
        const nodes = get().nodes.map((n) => (n.selected ? { ...n, selected: false } : n));
        set({ nodes: [...nodes, node], selectedNodeId: id });
        return id;
      },

      updateNodeData: (id, patch) => {
        get().snapshot(`data:${id}:${Object.keys(patch).sort().join(",")}`);
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } as NodeData } : n,
          ),
        });
      },

      renameRef: (id, ref) => {
        const { nodes } = get();
        const node = nodes.find((n) => n.id === id);
        if (!node) return "Node not found.";
        if (node.ref === ref) return null;
        const problem = refProblem(ref, id, nodes);
        if (problem) return problem;
        const oldRef = node.ref;
        get().snapshot();
        set({
          nodes: nodes.map((n) => {
            const renamed = n.id === id ? { ...n, ref } : n;
            if (!oldRef) return renamed;
            // Rewrite references in this node's templated fields.
            let data = renamed.data;
            for (const field of NODE_REGISTRY[n.type].fields) {
              const value = data[field.key];
              if (!field.templated || typeof value !== "string") continue;
              const next = renameReferences(value, oldRef, ref);
              if (next !== value) data = { ...data, [field.key]: next };
            }
            return data === renamed.data ? renamed : { ...renamed, data };
          }),
        });
        return null;
      },

      deleteNode: (id) => {
        get().snapshot();
        const { nodes, edges, selectedNodeId } = get();
        set({
          nodes: nodes.filter((n) => n.id !== id),
          edges: edges.filter((e) => e.source !== id && e.target !== id),
          selectedNodeId: selectedNodeId === id ? null : selectedNodeId,
        });
      },

      selectNode: (id) => {
        set({
          nodes: get().nodes.map((n) =>
            n.selected === (n.id === id) ? n : { ...n, selected: n.id === id },
          ),
          selectedNodeId: id,
        });
      },

      setMeta: (meta) => {
        get().snapshot(`meta:${Object.keys(meta).sort().join(",")}`);
        set(meta);
      },

      loadFlow: (flow) => set(stateFromFlow(flow)),

      replaceContent: (flow) => {
        get().snapshot(); // Ctrl+Z goes back to the server version
        const { nodes, edges } = fromFlow(flow);
        set({ name: flow.name, description: flow.description, nodes, edges, selectedNodeId: null });
      },

      markSaved: (flowId, version, fingerprint) => {
        if (get().flowId !== flowId) return;
        set({
          version,
          savedFingerprint: fingerprint,
          dirty: get().fingerprint !== fingerprint,
          save: { ...INITIAL_SAVE, lastSavedAt: Date.now() },
        });
      },

      setSave: (patch) => set({ save: { ...get().save, ...patch } }),

      newFlow: (template = "starter") => set(stateFromFlow(createFlowFromTemplate(template))),

      toFlow: () => {
        const { flowId, name, description, nodes, edges } = get();
        return toFlow({ flow_id: flowId, name, description }, nodes, edges);
      },

      snapshot: (coalesceKey) => {
        const { nodes, edges, name, description, past, lastSnapshot } = get();
        const now = Date.now();
        if (coalesceKey && coalesceKey === lastSnapshot.key && now - lastSnapshot.at < COALESCE_MS) {
          set({ lastSnapshot: { key: coalesceKey, at: now } });
          return;
        }
        set({
          past: [...past, { nodes, edges, name, description }].slice(-HISTORY_LIMIT),
          future: [],
          lastSnapshot: { key: coalesceKey ?? null, at: now },
        });
      },

      undo: () => {
        const { past, future, nodes, edges, name, description } = get();
        const previous = past.at(-1);
        if (!previous) return;
        set({
          ...previous,
          past: past.slice(0, -1),
          future: [{ nodes, edges, name, description }, ...future],
          selectedNodeId: selectedIdOf(previous.nodes),
          lastSnapshot: { key: null, at: 0 },
        });
      },

      redo: () => {
        const { past, future, nodes, edges, name, description } = get();
        const next = future[0];
        if (!next) return;
        set({
          ...next,
          past: [...past, { nodes, edges, name, description }],
          future: future.slice(1),
          selectedNodeId: selectedIdOf(next.nodes),
          lastSnapshot: { key: null, at: 0 },
        });
      },
    }),
    {
      name: UNBOUND_DRAFT_KEY, // replaced by bindDraft(uid, flowId) when a flow is opened
      version: 3,
      storage: draftStorage,
      // Hydrated explicitly on the client (see FlowEditor) to avoid SSR mismatches.
      skipHydration: true,
      partialize: (state): PersistedDraft => ({ flow: state.toFlow(), baseVersion: state.version }),
      // v1: flat fields; v2: { flow } without baseVersion (treated as unknown).
      migrate: (persisted, version) =>
        version < 2 ? migrateV1(persisted) : (persisted as PersistedDraft),
      // Called on every rehydrate, with `undefined` when the user has no draft yet. Never keep the
      // in-memory flow here: it may belong to a previously signed-in user.
      merge: (persisted, current) => ({
        ...current,
        ...stateFromFlow(restoreDraft(persisted) ?? createFlowFromTemplate("starter")),
      }),
    },
  ),
);

// Keep validation in sync with the graph. Node positions change on every drag frame, so only
// replace `issues` when the result actually differs — subscribers then re-render only on change.
useFlowStore.subscribe((state, prev) => {
  if (state.nodes === prev.nodes && state.edges === prev.edges) return;
  const issues = validateFlow(state.nodes, state.edges);
  if (JSON.stringify(issues) !== JSON.stringify(state.issues)) {
    useFlowStore.setState({ issues, nodeIssues: issuesByNode(issues) });
  }
});

// Track unsaved changes by fingerprinting the content. Selecting or measuring nodes also replaces
// node objects, so recompute on any change but only write when the fingerprint actually differs.
useFlowStore.subscribe((state, prev) => {
  if (
    state.nodes === prev.nodes &&
    state.edges === prev.edges &&
    state.name === prev.name &&
    state.description === prev.description
  ) {
    return;
  }
  const fingerprint = contentFingerprint(state.toFlow());
  if (fingerprint !== state.fingerprint) {
    useFlowStore.setState({ fingerprint, dirty: fingerprint !== state.savedFingerprint });
  }
});

export const canUndo = (s: FlowState) => s.past.length > 0;
export const canRedo = (s: FlowState) => s.future.length > 0;
