import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  checkConnection,
  createEdge,
  fromFlow,
  newId,
  toFlow,
  type CanvasEdge,
  type CanvasNode,
  type ConnectionCheck,
} from "@/lib/flow/graph";
import { createDefaultData } from "@/lib/nodes/registry";
import type { Flow, NodeData, NodeType } from "@/types/flow";

const HISTORY_LIMIT = 100;
/** Edits with the same coalesce key within this window become one undo step. */
const COALESCE_MS = 1000;

type Snapshot = { nodes: CanvasNode[]; edges: CanvasEdge[] };

interface FlowState {
  flowId: string | null;
  name: string;
  description: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeId: string | null;

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
  loadFlow: (flow: Flow) => void;
  newFlow: () => void;
  toFlow: () => Flow;

  // History
  snapshot: (coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
}

const EMPTY = {
  flowId: null,
  name: "Untitled flow",
  description: "",
  nodes: [] as CanvasNode[],
  edges: [] as CanvasEdge[],
  selectedNodeId: null,
  past: [] as Snapshot[],
  future: [] as Snapshot[],
  lastSnapshot: { key: null, at: 0 },
};

const selectedIdOf = (nodes: CanvasNode[]): string | null => {
  const selected = nodes.filter((n) => n.selected);
  return selected.length === 1 ? selected[0].id : null;
};

export const useFlowStore = create<FlowState>()(
  persist(
    (set, get) => ({
      ...EMPTY,

      onNodesChange: (changes) => {
        const { nodes } = get();
        const startsDrag = changes.some(
          (c) =>
            c.type === "position" && c.dragging && !nodes.find((n) => n.id === c.id)?.dragging,
        );
        if (startsDrag) get().snapshot();
        if (changes.some((c) => c.type === "remove" || c.type === "add")) get().snapshot("remove");

        const next = applyNodeChanges(changes, nodes);
        set({ nodes: next, selectedNodeId: selectedIdOf(next) });
      },

      onEdgesChange: (changes) => {
        if (changes.some((c) => c.type === "remove" || c.type === "add")) get().snapshot("remove");
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

      loadFlow: (flow) => {
        const { nodes, edges } = fromFlow(flow);
        set({
          ...EMPTY,
          flowId: flow.flow_id,
          name: flow.name,
          description: flow.description,
          nodes,
          edges,
        });
      },

      newFlow: () => set({ ...EMPTY }),

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
      name: "mesh:flow-draft",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Hydrated explicitly on the client (see FlowCanvas) to avoid SSR mismatches.
      skipHydration: true,
      partialize: (state) => {
        const flow = state.toFlow();
        return {
          flowId: flow.flow_id,
          name: flow.name,
          description: flow.description,
          ...fromFlow(flow),
        };
      },
    },
  ),
);

export const canUndo = (s: FlowState) => s.past.length > 0;
export const canRedo = (s: FlowState) => s.future.length > 0;
