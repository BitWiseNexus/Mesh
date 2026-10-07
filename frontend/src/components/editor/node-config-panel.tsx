"use client";

import { Copy, Trash2, X } from "lucide-react";
import type { CSSProperties } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { CATEGORIES, NODE_REGISTRY } from "@/lib/nodes/registry";
import { useFlowStore } from "@/stores/flow-store";

import { ConfigField } from "./config-fields";

export function NodeConfigPanel() {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === s.selectedNodeId));
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const deleteNode = useFlowStore((s) => s.deleteNode);
  const selectNode = useFlowStore((s) => s.selectNode);

  if (!node) return null;

  const def = NODE_REGISTRY[node.type];
  const category = CATEGORIES[def.category];
  const Icon = def.icon;

  const copyId = async () => {
    await navigator.clipboard.writeText(node.id);
    toast.success("Node id copied");
  };

  return (
    <aside
      aria-label="Node settings"
      className="flex w-80 shrink-0 flex-col border-l bg-background"
      style={{ "--node-accent": category.color } as CSSProperties}
    >
      <div className="flex items-start gap-3 border-b p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--node-accent)/15 text-(--node-accent)">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{def.label}</h2>
          <p className="text-xs text-muted-foreground">{def.description}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={() => selectNode(null)}>
          <X />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* key: remount field state when switching between nodes */}
        <div key={node.id} className="space-y-4 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="node-label">Name</Label>
            <Input
              id="node-label"
              value={node.data.label ?? ""}
              placeholder={def.label}
              onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
            />
          </div>

          {def.fields.length > 0 && <Separator />}

          {def.fields.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              value={node.data[field.key]}
              onChange={(value) => updateNodeData(node.id, { [field.key]: value })}
            />
          ))}

          {def.category === "tool" && (
            <p className="rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
              Connect an agent&apos;s <strong>Tools</strong> handle to this node to let the agent
              call it.
            </p>
          )}
        </div>
      </ScrollArea>

      <div className="flex items-center gap-2 border-t p-3">
        <button
          type="button"
          onClick={copyId}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-xs text-muted-foreground hover:text-foreground"
          title="Copy node id (use in templates as {{id.output}})"
        >
          <Copy className="size-3 shrink-0" />
          {node.id}
        </button>
        <Button variant="destructive" size="sm" onClick={() => deleteNode(node.id)}>
          <Trash2 />
          Delete
        </Button>
      </div>
    </aside>
  );
}
