"use client";

import { ChevronDown, Loader2, Play, Square } from "lucide-react";
import { useMemo } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NODE_REGISTRY, nodeDisplayName } from "@/lib/nodes/registry";
import { useFlowStore } from "@/stores/flow-store";
import { isRunActive, useRunStore } from "@/stores/run-store";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Run / Stop. With several triggers, Run asks which one starts the run. */
export function RunButton({
  onRun,
  onStop,
}: {
  onRun: (triggerId?: string) => void;
  onStop: () => void;
}) {
  const errors = useFlowStore((s) => s.issues.filter((i) => i.severity === "error").length);
  // A string, so dragging nodes doesn't re-render the toolbar.
  const triggersKey = useFlowStore((s) =>
    JSON.stringify(
      s.nodes
        .filter((n) => NODE_REGISTRY[n.type].category === "trigger")
        .map((n) => [n.id, nodeDisplayName(n.type, n.data)]),
    ),
  );
  const triggers = useMemo(() => JSON.parse(triggersKey) as [string, string][], [triggersKey]);
  const phase = useRunStore((s) => s.phase);

  if (isRunActive(phase)) {
    return phase === "starting" ? (
      <Button size="sm" disabled>
        <Loader2 className="animate-spin" />
        Starting…
      </Button>
    ) : (
      <Button size="sm" variant="outline" onClick={onStop}>
        <Square />
        Stop
      </Button>
    );
  }

  if (errors > 0) {
    return (
      <Hint label={`Fix ${plural(errors, "error")} to run this flow`}>
        {/* span wrapper: disabled buttons don't emit the pointer events tooltips need */}
        <span tabIndex={0}>
          <Button size="sm" disabled>
            <Play />
            Run
          </Button>
        </span>
      </Hint>
    );
  }

  if (triggers.length > 1) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" />}>
          <Play />
          Run
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Start from</DropdownMenuLabel>
            {triggers.map(([id, name]) => (
              <DropdownMenuItem key={id} onClick={() => onRun(id)}>
                <Play />
                {name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Hint label="Run the flow (Ctrl+Enter)">
      <Button size="sm" onClick={() => onRun()}>
        <Play />
        Run
      </Button>
    </Hint>
  );
}
