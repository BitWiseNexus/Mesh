"use client";

import { useReactFlow } from "@xyflow/react";
import { CircleAlert, CircleCheck, Plus, TriangleAlert } from "lucide-react";

import { centeredNodePosition, getCanvasCenter } from "@/components/canvas/canvas-utils";
import { useFitView } from "@/components/canvas/use-fit-view";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NODE_WIDTH } from "@/lib/flow/graph";
import type { FlowIssue } from "@/lib/flow/validate";
import { cn } from "@/lib/utils";
import { useFlowStore } from "@/stores/flow-store";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Toolbar indicator summarising flow validation, with a menu to jump to (or fix) each issue. */
export function FlowIssuesMenu() {
  const issues = useFlowStore((s) => s.issues);
  const { screenToFlowPosition } = useReactFlow();
  const fit = useFitView();

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;

  if (issues.length === 0) {
    return (
      <span className="flex items-center gap-1.5 px-2 text-xs whitespace-nowrap text-muted-foreground">
        <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-500" />
        Ready to run
      </span>
    );
  }

  const addTrigger = () => {
    const { nodes, addNode } = useFlowStore.getState();
    // Left of the flow's leftmost node, or in the middle of an empty canvas.
    const leftmost = nodes.length
      ? nodes.reduce((a, b) => (b.position.x < a.position.x ? b : a))
      : null;
    const position = leftmost
      ? { x: leftmost.position.x - NODE_WIDTH - 120, y: leftmost.position.y }
      : centeredNodePosition(getCanvasCenter(screenToFlowPosition));
    addNode("trigger_manual", position);
    fit();
  };

  const focusIssue = (issue: FlowIssue) => {
    if (issue.fix === "add_trigger") return addTrigger();
    if (!issue.nodeId) return;
    useFlowStore.getState().selectNode(issue.nodeId);
    fit({ nodes: [{ id: issue.nodeId }] }); // after the settings panel has opened
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(errors ? "text-destructive" : "text-amber-600 dark:text-amber-500")}
          />
        }
      >
        {errors ? <CircleAlert /> : <TriangleAlert />}
        {[errors && plural(errors, "error"), warnings && plural(warnings, "warning")]
          .filter(Boolean)
          .join(" · ")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {errors ? "Fix errors before running the flow" : "The flow can run, but check these"}
          </DropdownMenuLabel>
          {issues.map((issue) => {
            const isError = issue.severity === "error";
            const Icon = issue.fix ? Plus : isError ? CircleAlert : TriangleAlert;
            return (
              <DropdownMenuItem
                key={issue.id}
                onClick={() => focusIssue(issue)}
                className="items-start whitespace-normal"
              >
                <Icon
                  className={cn(
                    "mt-0.5",
                    isError ? "text-destructive" : "text-amber-600 dark:text-amber-500",
                  )}
                />
                <span>
                  {issue.message}
                  {issue.fix === "add_trigger" && (
                    <span className="block text-xs text-muted-foreground">
                      Click to add a Manual Trigger
                    </span>
                  )}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
