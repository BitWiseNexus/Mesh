"use client";

import { Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { Popover, PopoverContent } from "@/components/ui/popover";
import { pickableTypes, placementFor } from "@/lib/flow/connect";
import { CATEGORIES, NODE_REGISTRY } from "@/lib/nodes/registry";
import { cn } from "@/lib/utils";
import { useCanvasUi, type PickerRequest } from "@/stores/canvas-ui-store";
import { useFlowStore } from "@/stores/flow-store";

const TITLES = {
  add: "Add a node",
  connect: "Connect a new node",
  split: "Insert into the connection",
};

function PickerList({ request, onDone }: { request: PickerRequest; onDone: () => void }) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // What fits is decided when the picker opens (the flow can't change while it's open).
  const [types] = useState(() => pickableTypes(request.link, useFlowStore.getState().nodes));
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return types
      .map((type) => NODE_REGISTRY[type])
      .filter(
        (def) =>
          !q ||
          `${def.label} ${def.description} ${CATEGORIES[def.category].label}`.toLowerCase().includes(q),
      );
  }, [types, query]);

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, active]);

  const pick = (index: number) => {
    const def = results[index];
    if (!def) return;
    const { nodes, addNode } = useFlowStore.getState();
    addNode(def.type, placementFor(request.link, nodes, def.type, request.point), request.link);
    onDone();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (results.length ? (i + step + results.length) % results.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(active);
    }
  };

  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        DOMRect.fromRect({ x: request.client.x, y: request.client.y, width: 0, height: 0 }),
    }),
    [request.client],
  );
  const title = TITLES[request.link?.kind ?? "add"];

  return (
    <PopoverContent
      anchor={anchor}
      side="right"
      align="start"
      sideOffset={8}
      initialFocus={input}
      aria-label={title}
      className="w-72 gap-0 p-0"
    >
      <div className="border-b p-2">
        <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">{title}</p>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search nodes…"
            role="combobox"
            aria-label="Search nodes to add"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
            className="h-8 w-full rounded-md border bg-transparent pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
      </div>
      <ul id={listId} role="listbox" aria-label="Nodes" className="max-h-80 overflow-y-auto p-1">
        {results.map((def, i) => {
          const Icon = def.icon;
          const color = CATEGORIES[def.category].color;
          return (
            <li
              key={def.type}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(i)}
              style={{ "--node-accent": color } as CSSProperties}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-(--node-accent)/15 text-(--node-accent)">
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{def.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{def.description}</span>
              </span>
            </li>
          );
        })}
        {results.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">No nodes match “{query}”.</li>
        )}
      </ul>
    </PopoverContent>
  );
}

/**
 * Searchable list of the node types that fit where the user is adding one: on empty canvas, at
 * the end of a connection dropped on empty canvas, or inside a connection. Opened through
 * `useCanvasUi().openPicker`; rendered once by FlowCanvas.
 */
export function NodePicker() {
  const request = useCanvasUi((s) => s.picker);
  const close = useCanvasUi((s) => s.closePicker);
  return (
    <Popover open={request !== null} onOpenChange={(open) => !open && close()}>
      {/* key: a fresh list (query, highlighted item, types) for every request */}
      {request && <PickerList key={JSON.stringify(request)} request={request} onDone={close} />}
    </Popover>
  );
}
