"use client";

import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type OnConnectEnd,
  type OnNodeDrag,
  type XYPosition,
} from "@xyflow/react";
import { Maximize, WandSparkles } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useState, type DragEvent, type MouseEvent } from "react";
import { toast } from "sonner";

import { canSplitWith } from "@/lib/flow/connect";
import { checkConnection, type CanvasEdge, type CanvasNode } from "@/lib/flow/graph";
import { CATEGORIES, NODE_REGISTRY } from "@/lib/nodes/registry";
import { useCanvasUi } from "@/stores/canvas-ui-store";
import { closeFloatingPalette } from "@/stores/editor-ui-store";
import { useFlowStore } from "@/stores/flow-store";
import { NODE_TYPES, type NodeType } from "@/types/flow";

import { CanvasContextMenu, type MenuTarget } from "./canvas-context-menu";
import {
  canvasPointer,
  centeredNodePosition,
  DRAG_MIME,
  edgeAt,
  FIT_VIEW_OPTIONS,
} from "./canvas-utils";
import { DataEdge, EdgeMarkers, ToolEdge } from "./flow-edges";
import { FlowNode } from "./flow-node";
import { NodePicker } from "./node-picker";
import { useFitView } from "./use-fit-view";
import { useTidyUp } from "./use-tidy-up";

import "@xyflow/react/dist/style.css";

// Every node type renders through the registry-driven FlowNode.
const nodeTypes: NodeTypes = Object.fromEntries(NODE_TYPES.map((t) => [t, FlowNode]));
const edgeTypes: EdgeTypes = { data: DataEdge, tool_connection: ToolEdge };

/** The data edge under a client point (where a dragged node would be inserted), or null. */
function dataEdgeAt(point: XYPosition): string | null {
  const ids = useFlowStore
    .getState()
    .edges.filter((e) => (e.type ?? "data") === "data")
    .map((e) => e.id);
  return edgeAt(point, new Set(ids));
}

const clientPoint = (event: globalThis.MouseEvent | TouchEvent): XYPosition => {
  const point = "changedTouches" in event ? event.changedTouches[0] : event;
  return { x: point.clientX, y: point.clientY };
};

export function FlowCanvas() {
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange);
  const onConnect = useFlowStore((s) => s.onConnect);
  const addNode = useFlowStore((s) => s.addNode);
  const openPicker = useCanvasUi((s) => s.openPicker);
  const setInsertEdge = useCanvasUi((s) => s.setInsertEdge);
  const { screenToFlowPosition } = useReactFlow();
  const { resolvedTheme } = useTheme();
  // React Flow's fitView fires the first time nodes appear; on an empty canvas that would
  // re-center the viewport on the first dropped node, so only fit when opening a non-empty flow.
  const [fitOnOpen] = useState(() => useFlowStore.getState().nodes.length > 0);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const tidyUp = useTidyUp();
  const fit = useFitView();
  const hasNodes = nodes.length > 0;

  // Right-click on a node acts on the selection it belongs to, else selects just that node.
  const onNodeContextMenu = useCallback((_event: MouseEvent, node: CanvasNode) => {
    const { nodes, selectNode } = useFlowStore.getState();
    if (!node.selected) selectNode(node.id);
    const ids = node.selected ? nodes.filter((n) => n.selected).map((n) => n.id) : [node.id];
    setMenu({ kind: "nodes", ids });
  }, []);

  const menuAt = useCallback(
    (event: MouseEvent | globalThis.MouseEvent) => {
      const client = { x: event.clientX, y: event.clientY };
      return { client, position: screenToFlowPosition(client) };
    },
    [screenToFlowPosition],
  );

  const isValidConnection = useCallback((conn: CanvasEdge | Connection) => {
    const { nodes, edges } = useFlowStore.getState();
    return checkConnection(conn, nodes, edges).ok;
  }, []);

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromHandle) return;
      if (state.toHandle) {
        // React Flow silently refuses invalid connections; tell the user why.
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
        return;
      }
      // Dropped on empty canvas: offer the nodes that can connect there.
      const target = event.target;
      if (!(target instanceof Element) || !target.classList.contains("react-flow__pane")) return;
      const client = clientPoint(event);
      openPicker({
        client,
        point: screenToFlowPosition(client),
        link: {
          kind: "connect",
          from: {
            nodeId: state.fromHandle.nodeId,
            handleId: state.fromHandle.id ?? null,
            handleType: state.fromHandle.type,
          },
        },
      });
    },
    [openPicker, screenToFlowPosition],
  );

  // Palette drags: highlight the data edge under the pointer — dropping there inserts the node.
  const onDragOver = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setInsertEdge(dataEdgeAt({ x: event.clientX, y: event.clientY }));
    },
    [setInsertEdge],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const edgeId = useCanvasUi.getState().insertEdgeId;
      setInsertEdge(null);
      const type = event.dataTransfer.getData(DRAG_MIME) as NodeType;
      if (!NODE_TYPES.includes(type) || NODE_REGISTRY[type].comingSoon) return;
      const position = centeredNodePosition(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      const link = edgeId && canSplitWith(type) ? ({ kind: "split", edgeId } as const) : undefined;
      addNode(type, position, link);
      closeFloatingPalette();
    },
    [addNode, screenToFlowPosition, setInsertEdge],
  );

  // Dragging a single unconnected node over a data edge: dropping it there inserts it.
  const onNodeDrag: OnNodeDrag<CanvasNode> = useCallback(
    (event, node, dragged) => {
      const { edges } = useFlowStore.getState();
      const loose = !edges.some((e) => e.source === node.id || e.target === node.id);
      const insertable = dragged.length === 1 && loose && canSplitWith(node.type);
      setInsertEdge(insertable ? dataEdgeAt(clientPoint(event)) : null);
    },
    [setInsertEdge],
  );

  const onNodeDragStop: OnNodeDrag<CanvasNode> = useCallback(
    (_event, node) => {
      const edgeId = useCanvasUi.getState().insertEdgeId;
      setInsertEdge(null);
      // The drag already took the undo snapshot: moving + inserting is one step.
      if (edgeId) useFlowStore.getState().insertNodeIntoEdge(node.id, edgeId, { record: false });
    },
    [setInsertEdge],
  );

  return (
    <>
      <CanvasContextMenu target={menu}>
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
          onDragLeave={() => setInsertEdge(null)}
          onDrop={onDrop}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onPointerMove={(e) => (canvasPointer.client = { x: e.clientX, y: e.clientY })}
          onPointerLeave={() => (canvasPointer.client = null)}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={(_e, selected) =>
            setMenu({ kind: "nodes", ids: selected.map((n) => n.id) })
          }
          onEdgeContextMenu={(e, edge) => setMenu({ kind: "edge", id: edge.id, ...menuAt(e) })}
          onPaneContextMenu={(e) => setMenu({ kind: "pane", ...menuAt(e) })}
          colorMode={resolvedTheme === "dark" ? "dark" : "light"}
          deleteKeyCode={["Backspace", "Delete"]}
          snapToGrid
          snapGrid={[10, 10]}
          fitView={fitOnOpen}
          fitViewOptions={FIT_VIEW_OPTIONS}
          proOptions={{ hideAttribution: true }}
        >
          <EdgeMarkers />
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          {/* Our own fit button: it leaves out what a floating settings panel covers. */}
          <Controls showInteractive={false} showFitView={false}>
            <ControlButton onClick={() => fit()} disabled={!hasNodes} title="Fit view" aria-label="Fit view">
              <Maximize />
            </ControlButton>
            <ControlButton
              onClick={() => void tidyUp()}
              disabled={!hasNodes}
              title="Tidy up (auto-layout)"
              aria-label="Tidy up"
            >
              <WandSparkles />
            </ControlButton>
          </Controls>
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => CATEGORIES[NODE_REGISTRY[n.type as NodeType].category].color}
            nodeStrokeWidth={0}
          />
        </ReactFlow>
      </CanvasContextMenu>
      {/* Outside the menu's trigger: React events bubble through portals. */}
      <NodePicker />
    </>
  );
}
