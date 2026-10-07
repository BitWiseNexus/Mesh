"use client";

import { useReactFlow } from "@xyflow/react";
import { Search } from "lucide-react";
import { useMemo, useState, type CSSProperties, type DragEvent } from "react";

import { DRAG_MIME } from "@/components/canvas/flow-canvas";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { NODES_BY_CATEGORY, type NodeDefinition } from "@/lib/nodes/registry";
import { useFlowStore } from "@/stores/flow-store";

function PaletteItem({ def, color }: { def: NodeDefinition; color: string }) {
  const addNode = useFlowStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  const Icon = def.icon;

  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(DRAG_MIME, def.type);
    event.dataTransfer.effectAllowed = "move";
  };

  // Click adds the node in the middle of the visible canvas.
  const onClick = () => {
    const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
    if (!rect) return;
    const center = screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    addNode(def.type, { x: center.x - 120, y: center.y - 30 });
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title={def.description}
      style={{ "--node-accent": color } as CSSProperties}
      className="flex w-full cursor-grab items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted active:cursor-grabbing"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-(--node-accent)/15 text-(--node-accent)">
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{def.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{def.description}</span>
      </span>
    </button>
  );
}

export function NodePalette() {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NODES_BY_CATEGORY;
    return NODES_BY_CATEGORY.map((g) => ({
      ...g,
      nodes: g.nodes.filter((n) =>
        `${n.label} ${n.description} ${g.category.label}`.toLowerCase().includes(q),
      ),
    })).filter((g) => g.nodes.length > 0);
  }, [query]);

  return (
    <aside aria-label="Node palette" className="flex w-72 shrink-0 flex-col border-r bg-background">
      <div className="border-b p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes…"
            className="pl-8"
            aria-label="Search nodes"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Drag onto the canvas or click to add.</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {groups.map(({ category, nodes }) => (
            <section key={category.id}>
              <h3 className="mb-1 flex items-center gap-2 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <span className="size-2 rounded-full" style={{ background: category.color }} />
                {category.label}
              </h3>
              <div className="space-y-0.5">
                {nodes.map((def) => (
                  <PaletteItem key={def.type} def={def} color={category.color} />
                ))}
              </div>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">No nodes match “{query}”.</p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
