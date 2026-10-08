"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type OnConnectEnd,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { useCallback, useState, type DragEvent } from "react";
import { toast } from "sonner";

import { checkConnection, type CanvasEdge, type CanvasNode } from "@/lib/flow/graph";
import { CATEGORIES, NODE_REGISTRY } from "@/lib/nodes/registry";
import { useFlowStore } from "@/stores/flow-store";
import { NODE_TYPES, type NodeType } from "@/types/flow";

import { DataEdge, ToolEdge } from "./flow-edges";
import { FlowNode } from "./flow-node";

import "@xyflow/react/dist/style.css";

export const FIT_VIEW_OPTIONS = { maxZoom: 1, padding: 0.3 } as const;

/** dataTransfer key used when dragging a node type from the palette. */
export const DRAG_MIME = "application/x-mesh-node";

// Every node type renders through the registry-driven FlowNode.
const nodeTypes: NodeTypes = Object.fromEntries(NODE_TYPES.map((t) => [t, FlowNode]));
const edgeTypes: EdgeTypes = { data: DataEdge, tool_connection: ToolEdge };

export function FlowCanvas() {
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange);
  const onConnect = useFlowStore((s) => s.onConnect);
  const addNode = useFlowStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  const { resolvedTheme } = useTheme();
  // React Flow's fitView fires the first time nodes appear; on an empty canvas that would
  // re-center the viewport on the first dropped node, so only fit when opening a non-empty flow.
  const [fitOnOpen] = useState(() => useFlowStore.getState().nodes.length > 0);

  const isValidConnection = useCallback((conn: CanvasEdge | Connection) => {
    const { nodes, edges } = useFlowStore.getState();
    return checkConnection(conn, nodes, edges).ok;
  }, []);

  // React Flow silently refuses invalid connections; tell the user why.
  const onConnectEnd: OnConnectEnd = useCallback((_event, state) => {
    if (state.isValid || !state.fromHandle || !state.toHandle) return;
    const [from, to] =
      state.fromHandle.type === "source"
        ? [state.fromHandle, state.toHandle]
        : [state.toHandle, state.fromHandle];
    const { nodes, edges } = useFlowStore.getState();
    const check = checkConnection(
      { source: from.nodeId, sourceHandle: from.id ?? null, target: to.nodeId, targetHandle: to.id ?? null },
      nodes,
      edges,
    );
    if (!check.ok) toast.error(check.reason);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(DRAG_MIME) as NodeType;
      if (!NODE_TYPES.includes(type) || NODE_REGISTRY[type].comingSoon) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      // Center the node on the cursor (nodes are w-60 ≈ 240px wide, ~60px tall).
      addNode(type, { x: position.x - 120, y: position.y - 30 });
    },
    [addNode, screenToFlowPosition],
  );

  return (
    <ReactFlow<CanvasNode, CanvasEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      isValidConnection={isValidConnection}
      onDragOver={onDragOver}
      onDrop={onDrop}
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      deleteKeyCode={["Backspace", "Delete"]}
      snapToGrid
      snapGrid={[10, 10]}
      fitView={fitOnOpen}
      fitViewOptions={FIT_VIEW_OPTIONS}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => CATEGORIES[NODE_REGISTRY[n.type as NodeType].category].color}
        nodeStrokeWidth={0}
      />
    </ReactFlow>
  );
}
