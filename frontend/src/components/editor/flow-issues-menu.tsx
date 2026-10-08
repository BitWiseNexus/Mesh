"use client";

import { useReactFlow } from "@xyflow/react";
import { CircleAlert, CircleCheck, Plus, TriangleAlert } from "lucide-react";

import { FIT_VIEW_OPTIONS } from "@/components/canvas/flow-canvas";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FlowIssue } from "@/lib/flow/validate";
import { cn } from "@/lib/utils";
import { useFlowStore } from "@/stores/flow-store";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Toolbar indicator summarising flow validation, with a menu to jump to (or fix) each issue. */
export function FlowIssuesMenu() {
  const issues = useFlowStore((s) => s.issues);
  const { fitView, screenToFlowPosition } = useReactFlow();

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;

  if (issues.length === 0) {
    return (
      <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-500" />
        Ready to run
      </span>
    );
  }

  const addTrigger = () => {
    const { nodes, addNode } = useFlowStore.getState();
    let position;
    if (nodes.length > 0) {
      const leftmost = nodes.reduce((a, b) => (b.position.x < a.position.x ? b : a));
      position = { x: leftmost.position.x - 360, y: leftmost.position.y };
    } else {
      const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
      const center = rect
        ? screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
        : { x: 0, y: 0 };
      position = { x: center.x - 120, y: center.y - 30 };
    }
    addNode("trigger_manual", position);
    requestAnimationFrame(() => void fitView({ ...FIT_VIEW_OPTIONS, duration: 300 }));
  };

  const focusIssue = (issue: FlowIssue) => {
    if (issue.fix === "add_trigger") return addTrigger();
    if (!issue.nodeId) return;
    useFlowStore.getState().selectNode(issue.nodeId);
    void fitView({ nodes: [{ id: issue.nodeId }], maxZoom: 1, duration: 300 });
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
