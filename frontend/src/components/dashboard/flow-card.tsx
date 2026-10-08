"use client";

import { Copy, MoreHorizontal, Pencil, Trash2, Workflow } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import type { FlowSummary } from "@/lib/flows-api";
import { formatRelativeTime, plural } from "@/lib/format";

interface FlowCardProps {
  flow: FlowSummary;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function FlowCard({ flow, onRename, onDuplicate, onDelete }: FlowCardProps) {
  return (
    <article
      aria-label={flow.name}
      className="group relative flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs transition-shadow focus-within:ring-2 focus-within:ring-ring/50 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Workflow className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium">
            {/* The link's ::after covers the card, so the whole card is clickable. */}
            <Link
              href={`/flows/${flow.flow_id}`}
              className="outline-none after:absolute after:inset-0 after:rounded-xl"
            >
              {flow.name}
            </Link>
          </h2>
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {flow.description || "No description"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${flow.name}`}
                className="relative z-10 -mt-1 -mr-1"
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={onRename}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="mt-auto text-xs text-muted-foreground">
        {plural(flow.node_count, "node")} ·{" "}
        <time dateTime={flow.updated_at} title={new Date(flow.updated_at).toLocaleString()}>
          Edited {formatRelativeTime(flow.updated_at)}
        </time>
      </p>
    </article>
  );
}

export function FlowCardSkeleton() {
  return (
    <div className="flex h-32 flex-col gap-3 rounded-xl border p-4" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      </div>
      <Skeleton className="mt-auto h-3 w-1/3" />
    </div>
  );
}
