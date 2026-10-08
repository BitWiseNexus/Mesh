"use client";

import { Braces, CornerDownRight } from "lucide-react";
import type { RefObject } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatInput, formatReference } from "@/lib/flow/references";
import { upstreamNodeIds } from "@/lib/flow/refs";
import { NODE_REGISTRY, nodeDisplayName } from "@/lib/nodes/registry";
import { useFlowStore } from "@/stores/flow-store";

/** Rendered only while the menu is open, so the upstream walk doesn't run on every edit. */
function PickerItems({ nodeId, onInsert }: { nodeId: string; onInsert: (token: string) => void }) {
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const upstream = upstreamNodeIds(nodeId, edges)
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n) => n !== undefined);
  const senders = new Set(
    edges.filter((e) => (e.type ?? "data") === "data" && e.target === nodeId).map((e) => e.source),
  ).size;
  const hasInputs = senders > 0;
  // A node attached to an agent's Tools handle gets its input from the agent's tool call.
  const isTool = edges.some((e) => e.type === "tool_connection" && e.target === nodeId);

  return (
    <>
      {isTool && (
        <>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Filled in by the agent</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onInsert(formatInput(["value"]))} className="items-start">
              <CornerDownRight className="mt-0.5" />
              <span className="min-w-0 flex-1">
                A named value
                <span className="block text-xs text-muted-foreground">
                  Rename “value”: each name becomes a parameter the agent fills in
                </span>
              </span>
              <code className="text-xs text-muted-foreground">{formatInput(["value"])}</code>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onInsert(formatInput())} className="items-start">
              <CornerDownRight className="mt-0.5" />
              <span className="min-w-0 flex-1">
                Everything the agent passes
                <span className="block text-xs text-muted-foreground">One text parameter, “input”</span>
              </span>
              <code className="text-xs text-muted-foreground">{formatInput()}</code>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {upstream.length > 0 && <DropdownMenuSeparator />}
        </>
      )}
      {hasInputs && (
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onInsert(formatInput())}>
            <CornerDownRight />
            <span className="flex-1">
              Previous node&apos;s output
              {senders > 1 && (
                <span className="block text-xs text-muted-foreground">
                  All {senders} inputs, keyed by name
                </span>
              )}
            </span>
            <code className="text-xs text-muted-foreground">{formatInput()}</code>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      )}
      {hasInputs && upstream.length > 0 && <DropdownMenuSeparator />}
      {(!isTool || upstream.length > 0) && <DropdownMenuGroup>
        <DropdownMenuLabel>Output of an earlier node</DropdownMenuLabel>
        {upstream.length === 0 ? (
          <DropdownMenuItem disabled>Connect this node after another one first</DropdownMenuItem>
        ) : (
          upstream.map((n) => {
            const Icon = NODE_REGISTRY[n.type].icon;
            const token = formatReference(n.ref ?? n.id);
            return (
              <DropdownMenuItem key={n.id} onClick={() => onInsert(token)} className="items-start">
                <Icon className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{nodeDisplayName(n.type, n.data)}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {NODE_REGISTRY[n.type].outputHint}
                  </span>
                </span>
                <code className="text-xs text-muted-foreground">{token}</code>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuGroup>}
    </>
  );
}

/**
 * "Insert reference" menu for a templated field: lists the outputs available when this node runs.
 * Focus returns to `fieldRef` after choosing, so typing can continue right after the insertion.
 */
export function ReferencePicker({
  nodeId,
  fieldLabel,
  fieldRef,
  onInsert,
}: {
  nodeId: string;
  fieldLabel: string;
  fieldRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  onInsert: (token: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Insert reference into ${fieldLabel}`}
        title="Insert a value from an earlier node"
        className="flex items-center gap-1 rounded px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Braces className="size-3.5" />
        Insert
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80" finalFocus={fieldRef}>
        <PickerItems nodeId={nodeId} onInsert={onInsert} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
