"use client";

import {
  Download,
  FilePlus2,
  Moon,
  Play,
  Redo2,
  Sun,
  Undo2,
  Upload,
  Waypoints,
} from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useRef, type ChangeEvent, type ReactElement } from "react";
import { toast } from "sonner";

import { FIT_VIEW_OPTIONS } from "@/components/canvas/flow-canvas";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { parseFlowJson } from "@/lib/flow/graph";
import { canRedo, canUndo, useFlowStore } from "@/stores/flow-store";

function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow";

export function EditorToolbar() {
  const name = useFlowStore((s) => s.name);
  const setMeta = useFlowStore((s) => s.setMeta);
  const undo = useFlowStore((s) => s.undo);
  const redo = useFlowStore((s) => s.redo);
  const undoable = useFlowStore(canUndo);
  const redoable = useFlowStore(canRedo);
  const hasNodes = useFlowStore((s) => s.nodes.length > 0);
  const fileInput = useRef<HTMLInputElement>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const { fitView } = useReactFlow();

  const exportFlow = () => {
    const flow = useFlowStore.getState().toFlow();
    const blob = new Blob([JSON.stringify(flow, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(flow.name)}.mesh.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFlow = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-importing the same file
    if (!file) return;
    const result = parseFlowJson(await file.text());
    if (!result.ok) {
      toast.error(`Import failed: ${result.error}`);
      return;
    }
    if (hasNodes && !window.confirm("Replace the current flow with the imported one?")) return;
    useFlowStore.getState().loadFlow(result.flow);
    // Wait a frame so React Flow has the new nodes before fitting.
    requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
    toast.success(`Imported “${result.flow.name}”`);
  };

  const newFlow = () => {
    if (hasNodes && !window.confirm("Start a new flow? The current flow will be cleared.")) return;
    useFlowStore.getState().newFlow();
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      <Link href="/" className="flex items-center gap-1.5 font-semibold tracking-tight">
        <Waypoints className="size-4" />
        Mesh
      </Link>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <input
        value={name}
        onChange={(e) => setMeta({ name: e.target.value })}
        onBlur={(e) => !e.target.value.trim() && setMeta({ name: "Untitled flow" })}
        aria-label="Flow name"
        className="w-64 rounded-md bg-transparent px-2 py-1 text-sm font-medium outline-none hover:bg-muted focus:bg-muted"
      />

      <div className="ml-auto flex items-center gap-1">
        <Hint label="Undo (Ctrl+Z)">
          <Button variant="ghost" size="icon-sm" onClick={undo} disabled={!undoable} aria-label="Undo">
            <Undo2 />
          </Button>
        </Hint>
        <Hint label="Redo (Ctrl+Shift+Z)">
          <Button variant="ghost" size="icon-sm" onClick={redo} disabled={!redoable} aria-label="Redo">
            <Redo2 />
          </Button>
        </Hint>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Hint label="New flow">
          <Button variant="ghost" size="icon-sm" onClick={newFlow} aria-label="New flow">
            <FilePlus2 />
          </Button>
        </Hint>
        <Hint label="Import JSON">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => fileInput.current?.click()}
            aria-label="Import JSON"
          >
            <Upload />
          </Button>
        </Hint>
        <Hint label="Export JSON">
          <Button variant="ghost" size="icon-sm" onClick={exportFlow} aria-label="Export JSON">
            <Download />
          </Button>
        </Hint>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={importFlow}
        />
        <Hint label="Toggle theme">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
          >
            <Sun className="hidden dark:block" />
            <Moon className="dark:hidden" />
          </Button>
        </Hint>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Hint label="Running flows arrives in Phase 3">
          {/* span wrapper: disabled buttons don't emit the pointer events tooltips need */}
          <span tabIndex={0}>
            <Button size="sm" disabled>
              <Play />
              Run
            </Button>
          </span>
        </Hint>
      </div>
    </header>
  );
}
