"use client";

import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { refProblem } from "@/lib/flow/refs";
import { useFlowStore } from "@/stores/flow-store";

/**
 * Edits a node's reference name (the `agent` in `{{agent.output}}`). Validated as you type,
 * committed on Enter/blur; renaming rewrites references elsewhere in the flow (undoable).
 */
export function RefField({ nodeId, current }: { nodeId: string; current: string }) {
  const id = useId();
  const nodes = useFlowStore((s) => s.nodes);
  const renameRef = useFlowStore((s) => s.renameRef);
  const [draft, setDraft] = useState(current);
  const [prev, setPrev] = useState(current);
  if (current !== prev) {
    // Changed elsewhere (undo/redo): follow it.
    setPrev(current);
    setDraft(current);
  }

  const problem = draft === current ? null : refProblem(draft, nodeId, nodes);

  const commit = () => {
    if (draft === current) return;
    if (renameRef(nodeId, draft) !== null) setDraft(current); // invalid: revert, message was shown
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Reference</Label>
      <div className="flex items-center rounded-lg border font-mono text-xs focus-within:ring-3 focus-within:ring-ring/50 aria-invalid:border-destructive">
        <span className="pl-2.5 text-muted-foreground select-none">{"{{"}</span>
        <Input
          id={id}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => setDraft(e.target.value.trim().toLowerCase())}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setDraft(current);
          }}
          className="h-7 border-0 px-0.5 font-mono text-xs shadow-none focus-visible:ring-0"
        />
        <span className="pr-2.5 text-muted-foreground select-none">{".output}}"}</span>
      </div>
      <p
        id={`${id}-hint`}
        className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      >
        {problem ?? "How other nodes refer to this one. Renaming updates those references."}
      </p>
    </div>
  );
}
