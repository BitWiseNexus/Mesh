"use client";

import { Download, PanelBottomOpen, Redo2, Undo2, Upload, Waypoints } from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, type ChangeEvent, type MouseEvent } from "react";
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
import { useRunStore } from "@/stores/run-store";

import { FlowIssuesMenu } from "./flow-issues-menu";
import { RunButton } from "./run-button";
import { SaveStatus } from "./save-status";

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "flow";

export function EditorToolbar({
  onSave,
  onRun,
  onStop,
}: {
  onSave: () => void;
  onRun: (triggerId?: string) => void;
  onStop: () => void;
}) {
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
  const router = useRouter();
  const runPanelHidden = useRunStore((s) => s.phase !== "idle" && !s.panelOpen);

  /**
   * Leaving normally just works: autosave flushes pending edits on the way out. But if saving is
   * currently failing or in conflict, those edits would be lost — ask first.
   */
  const guardLeave = async (event: MouseEvent<HTMLAnchorElement>) => {
    const { dirty, save } = useFlowStore.getState();
    if (!dirty || (save.status !== "error" && save.status !== "conflict")) return;
    event.preventDefault();
    const href = event.currentTarget.getAttribute("href") ?? "/flows";
    const leave = await confirm({
      title: "Leave without saving?",
      description:
        save.status === "conflict"
          ? "Your latest edits conflict with a newer version and haven't been saved."
          : `Your latest edits couldn't be saved${save.error ? ` (${save.error})` : ""}.`,
      confirmLabel: "Leave without saving",
      destructive: true,
    });
    if (leave) router.push(href);
  };

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

  /** Replaces this flow's content with a file's (the flow keeps its id; autosave persists it). */
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
    // An ordinary edit of *this* flow (its id and version stay): unsaved until autosave sends it,
    // and Ctrl+Z brings the previous content back.
    useFlowStore.getState().replaceContent(result.flow);
    // Wait a frame so React Flow has the new nodes before fitting.
    requestAnimationFrame(() => void fitView(FIT_VIEW_OPTIONS));
    toast.success(`Imported “${result.flow.name}”`);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      {confirmDialog}
      <Link
        href="/flows"
        onClick={guardLeave}
        className="flex items-center gap-1.5 font-semibold tracking-tight"
        aria-label="Mesh — all flows"
      >
        <Waypoints className="size-4" />
        Mesh
      </Link>
      <Separator orientation="vertical" className="mx-1 h-5" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <Link
          href="/flows"
          onClick={guardLeave}
          className="text-muted-foreground hover:text-foreground"
        >
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
        <SaveStatus onSave={onSave} />
        <Separator orientation="vertical" className="mx-1 h-5" />
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
        {runPanelHidden && (
          <Hint label="Show run panel">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Show run panel"
              onClick={() => useRunStore.getState().setPanelOpen(true)}
            >
              <PanelBottomOpen />
            </Button>
          </Hint>
        )}
        <RunButton onRun={onRun} onStop={onStop} />
        <Separator orientation="vertical" className="mx-1 h-5" />
        <UserMenu />
      </div>
    </header>
  );
}
