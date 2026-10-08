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
import { createFlowFromTemplate, type FlowTemplate } from "@/lib/flow/templates";
import { issuesByNode, validateFlow, type FlowIssue } from "@/lib/flow/validate";
import { createDefaultData } from "@/lib/nodes/registry";
import type { Flow, NodeData, NodeType } from "@/types/flow";

const HISTORY_LIMIT = 100;
/** Edits with the same coalesce key within this window become one undo step. */
const COALESCE_MS = 1000;

type Snapshot = { nodes: CanvasNode[]; edges: CanvasEdge[] };

/** What the autosaved draft holds (persist version 2). */
type PersistedDraft = { flow: Flow };

/**
 * Local backup of the open flow, per user *and* flow, written continuously (debounced). The server
 * is the source of truth; the backup is for recovering unsaved edits (restore lands with autosave).
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
  deleteNode: (id: string) => void;
  selectNode: (id: string | null) => void;
  setMeta: (meta: Partial<{ name: string; description: string }>) => void;

  // Whole-flow operations
  loadFlow: (flow: Flow & { version?: number }) => void;
  /** Records a successful server save. */
  markSaved: (version: number) => void;
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
  return {
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
        const node: CanvasNode = { id, type, position, data: createDefaultData(type), selected: true };
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

      setMeta: (meta) => set(meta),

      loadFlow: (flow) => set(stateFromFlow(flow)),

      markSaved: (version) => set({ version }),

      newFlow: (template = "starter") => set(stateFromFlow(createFlowFromTemplate(template))),

      toFlow: () => {
        const { flowId, name, description, nodes, edges } = get();
        return toFlow({ flow_id: flowId, name, description }, nodes, edges);
      },

      snapshot: (coalesceKey) => {
        const { nodes, edges, past, lastSnapshot } = get();
        const now = Date.now();
        if (coalesceKey && coalesceKey === lastSnapshot.key && now - lastSnapshot.at < COALESCE_MS) {
          set({ lastSnapshot: { key: coalesceKey, at: now } });
          return;
        }
        set({
          past: [...past, { nodes, edges }].slice(-HISTORY_LIMIT),
          future: [],
          lastSnapshot: { key: coalesceKey ?? null, at: now },
        });
      },

      undo: () => {
        const { past, future, nodes, edges } = get();
        const previous = past.at(-1);
        if (!previous) return;
        set({
          ...previous,
          past: past.slice(0, -1),
          future: [{ nodes, edges }, ...future],
          selectedNodeId: selectedIdOf(previous.nodes),
          lastSnapshot: { key: null, at: 0 },
        });
      },

      redo: () => {
        const { past, future, nodes, edges } = get();
        const next = future[0];
        if (!next) return;
        set({
          ...next,
          past: [...past, { nodes, edges }],
          future: future.slice(1),
          selectedNodeId: selectedIdOf(next.nodes),
          lastSnapshot: { key: null, at: 0 },
        });
      },
    }),
    {
      name: UNBOUND_DRAFT_KEY, // replaced by bindDraft(uid, flowId) when a flow is opened
      version: 2,
      storage: draftStorage,
      // Hydrated explicitly on the client (see FlowEditor) to avoid SSR mismatches.
      skipHydration: true,
      partialize: (state): PersistedDraft => ({ flow: state.toFlow() }),
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

export const canUndo = (s: FlowState) => s.past.length > 0;
export const canRedo = (s: FlowState) => s.future.length > 0;
