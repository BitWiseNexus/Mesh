"use client";

import { useReactFlow, type XYPosition } from "@xyflow/react";
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Maximize,
  Plus,
  Scissors,
  SquareDashedMousePointer,
  Trash2,
  WandSparkles,
} from "lucide-react";
import type { ReactNode } from "react";

import { useNodeClipboard } from "@/components/editor/use-node-clipboard";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useCanvasUi, type PickerRequest } from "@/stores/canvas-ui-store";
import { useFlowStore } from "@/stores/flow-store";

import { useFitView } from "./use-fit-view";
import { useTidyUp } from "./use-tidy-up";

/** What was right-clicked: some nodes, an edge, or empty canvas (at a flow position). */
export type MenuTarget =
  | { kind: "nodes"; ids: string[] }
  /** `client` / `position`: where it was right-clicked, on screen and in the flow. */
  | { kind: "edge"; id: string; client: XYPosition; position: XYPosition }
  | { kind: "pane"; client: XYPosition; position: XYPosition };

/** React Flow's own panels keep the browser's context menu. */
const OWN_MENU = ".react-flow__controls, .react-flow__minimap, .react-flow__panel";

function NodeItems({ ids }: { ids: string[] }) {
  const { copyFromMenu, duplicate } = useNodeClipboard();
  const deleteNodes = useFlowStore((s) => s.deleteNodes);
  return (
    <>
      <ContextMenuItem onClick={() => copyFromMenu()}>
        <Copy />
        Copy
        <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onClick={() => copyFromMenu(true)}>
        <Scissors />
        Cut
        <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onClick={duplicate}>
        <CopyPlus />
        Duplicate
        <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={() => deleteNodes(ids)}>
        <Trash2 />
        {ids.length > 1 ? `Delete ${ids.length} nodes` : "Delete"}
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

/**
 * Opens the node picker once the menu has closed (the menu hands focus back to the canvas as it
 * closes, which would otherwise take it from the picker's search field).
 */
function useOpenPickerLater() {
  const openPicker = useCanvasUi((s) => s.openPicker);
  return (request: PickerRequest) => setTimeout(() => openPicker(request), 0);
}

function EdgeItems({ id, client, position }: Extract<MenuTarget, { kind: "edge" }>) {
  const { deleteElements } = useReactFlow();
  const openPicker = useOpenPickerLater();
  const isData = useFlowStore((s) => (s.edges.find((e) => e.id === id)?.type ?? "data") === "data");
  return (
    <>
      {isData && (
        <>
          <ContextMenuItem
            onClick={() => openPicker({ client, point: position, link: { kind: "split", edgeId: id } })}
          >
            <Plus />
            Insert node…
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem variant="destructive" onClick={() => void deleteElements({ edges: [{ id }] })}>
        <Trash2 />
        Delete connection
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </>
  );
}

function PaneItems({ client, position }: Extract<MenuTarget, { kind: "pane" }>) {
  const { pasteFromMenu } = useNodeClipboard();
  const fit = useFitView();
  const openPicker = useOpenPickerLater();
  const tidyUp = useTidyUp();
  const selectAll = useFlowStore((s) => s.selectAll);
  const hasNodes = useFlowStore((s) => s.nodes.length > 0);
  return (
    <>
      <ContextMenuItem onClick={() => openPicker({ client, point: position })}>
        <Plus />
        Add node…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void pasteFromMenu(position)}>
        <ClipboardPaste />
        Paste here
        <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!hasNodes} onClick={selectAll}>
        <SquareDashedMousePointer />
        Select all
        <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!hasNodes} onClick={() => void tidyUp()}>
        <WandSparkles />
        Tidy up
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!hasNodes}
        onClick={() => fit()}
      >
        <Maximize />
        Fit view
      </ContextMenuItem>
    </>
  );
}

/**
 * Right-click menu for the canvas. FlowCanvas reports what was clicked (`target`, via React Flow's
 * node/edge/pane context-menu callbacks, which run before the menu opens) and wraps itself in
 * this. The target is kept after closing, so the menu doesn't empty during its exit animation.
 */
export function CanvasContextMenu({
  target,
  children,
}: {
  target: MenuTarget | null;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="size-full"
        onContextMenuCapture={(event) => {
          if ((event.target as Element).closest(OWN_MENU)) event.stopPropagation();
        }}
      >
        {children}
      </ContextMenuTrigger>
      {target && (
        <ContextMenuContent className="min-w-52" aria-label="Canvas actions">
          {target.kind === "nodes" && <NodeItems ids={target.ids} />}
          {target.kind === "edge" && <EdgeItems {...target} />}
          {target.kind === "pane" && <PaneItems {...target} />}
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
