"use client";

import { Download, Loader2, Play, Redo2, Save, Undo2, Upload, Waypoints } from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import Link from "next/link";
import { useRef, type ChangeEvent } from "react";
import { toast } from "sonner";

import { UserMenu } from "@/components/auth/user-menu";
import { FIT_VIEW_OPTIONS } from "@/components/canvas/flow-canvas";
import { useConfirm } from "@/components/confirm-dialog";
import { Hint } from "@/components/hint";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { parseFlowJson } from "@/lib/flow/graph";
import { canRedo, canUndo, useFlowStore } from "@/stores/flow-store";

import { FlowIssuesMenu } from "./flow-issues-menu";

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow";

export function EditorToolbar({ onSave, isSaving }: { onSave: () => void; isSaving: boolean }) {
  const name = useFlowStore((s) => s.name);
  const setMeta = useFlowStore((s) => s.setMeta);
  const undo = useFlowStore((s) => s.undo);
  const redo = useFlowStore((s) => s.redo);
  const undoable = useFlowStore(canUndo);
  const redoable = useFlowStore(canRedo);
  const hasNodes = useFlowStore((s) => s.nodes.length > 0);
  const fileInput = useRef<HTMLInputElement>(null);
  const { fitView } = useReactFlow();
  const [confirm, confirmDialog] = useConfirm();

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

  /** Replaces this flow's content with a file's (the flow keeps its id; Save to persist). */
  const importFlow = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-importing the same file
    if (!file) return;
    const result = parseFlowJson(await file.text());
    if (!result.ok) {
      toast.error(`Import failed: ${result.error}`);
      return;
    }
    const replace =
      !hasNodes ||
      (await confirm({
        title: `Replace this flow's content with “${result.flow.name}”?`,
        description:
          "What's on the canvas now will be replaced. Export it first if you want to keep it.",
        confirmLabel: "Replace",
        destructive: true,
      }));
    if (!replace) return;
    const { flowId, version, loadFlow } = useFlowStore.getState();
    // Keep this flow's identity so Save updates it rather than the file's original flow.
    loadFlow({ ...result.flow, flow_id: flowId, version: version ?? undefined });
    // Wait a frame so React Flow has the new nodes before fitting.
    requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
    toast.success(`Imported “${result.flow.name}” — save to keep it`);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      {confirmDialog}
      <Link
        href="/flows"
        className="flex items-center gap-1.5 font-semibold tracking-tight"
        aria-label="Mesh — all flows"
      >
        <Waypoints className="size-4" />
        Mesh
      </Link>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <Link href="/flows" className="text-muted-foreground hover:text-foreground">
          Flows
        </Link>
        <span className="text-muted-foreground">/</span>
        <input
          value={name}
          onChange={(e) => setMeta({ name: e.target.value })}
          onBlur={(e) => !e.target.value.trim() && setMeta({ name: "Untitled flow" })}
          maxLength={200}
          aria-label="Flow name"
          className="w-64 min-w-0 rounded-md bg-transparent px-2 py-1 font-medium outline-none hover:bg-muted focus:bg-muted"
        />
      </nav>

      <div className="ml-auto flex items-center gap-1">
        <FlowIssuesMenu />
        <Separator orientation="vertical" className="mx-1 h-5" />
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
        name="import-into-flow"
          accept="application/json,.json"
          className="hidden"
          onChange={importFlow}
        />
        <ThemeToggle />
        <Separator orientation="vertical" className="mx-1 h-5" />
        <Hint label="Save (Ctrl+S)">
          <Button variant="outline" size="sm" onClick={onSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="animate-spin" /> : <Save />}
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </Hint>
        <Hint label="Running flows arrives in Phase 3">
          {/* span wrapper: disabled buttons don't emit the pointer events tooltips need */}
          <span tabIndex={0}>
            <Button size="sm" disabled>
              <Play />
              Run
            </Button>
          </span>
        </Hint>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <UserMenu />
      </div>
    </header>
  );
}
