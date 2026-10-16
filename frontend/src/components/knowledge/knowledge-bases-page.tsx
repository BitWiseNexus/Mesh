"use client";

import { AlertCircle, Library, MoreHorizontal, Plus, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formatRelativeTime, plural } from "@/lib/format";
import { useDeleteKnowledgeBase, useKnowledgeBases } from "@/lib/knowledge-api";
import { useModels } from "@/lib/models-api";
import type { KnowledgeBase } from "@/types/knowledge";

import { KnowledgeBaseDialog, type KnowledgeBaseDialogState } from "./knowledge-base-dialog";

function KnowledgeBaseCard({
  knowledgeBase: kb,
  modelLabel,
  onEdit,
  onDelete,
}: {
  knowledgeBase: KnowledgeBase;
  modelLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article
      aria-label={kb.name}
      className="relative flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs transition-shadow focus-within:ring-2 focus-within:ring-ring/50 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Library className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium">
            {/* The button's ::after covers the card, so the whole card opens it. */}
            <button
              type="button"
              onClick={onEdit}
              className="text-left outline-none after:absolute after:inset-0 after:rounded-xl"
            >
              {kb.name}
            </button>
          </h2>
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {kb.description || "No description"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${kb.name}`}
                className="relative z-10 -mt-1 -mr-1"
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Settings2 />
              Settings
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
        {plural(kb.document_count, "document")} · {modelLabel} · Edited{" "}
        {formatRelativeTime(kb.updated_at)}
      </p>
    </article>
  );
}

/** `/knowledge`: the user's knowledge bases. */
export function KnowledgeBasesPage() {
  const knowledgeBases = useKnowledgeBases();
  const models = useModels();
  const remove = useDeleteKnowledgeBase();
  const [dialog, setDialog] = useState<KnowledgeBaseDialogState>(null);
  const [confirm, confirmDialog] = useConfirm();

  const modelLabel = (id: string) =>
    models.data?.embedding_models.find((m) => m.id === id)?.label ?? id;

  const onDelete = async (kb: KnowledgeBase) => {
    const ok = await confirm({
      title: `Delete “${kb.name}”?`,
      description: `This deletes it and its ${plural(kb.document_count, "document")}. Flows that search it will stop finding anything until you choose another one. This can't be undone.`,
      confirmLabel: "Delete knowledge base",
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(kb.knowledge_base_id);
      toast.success(`Deleted “${kb.name}”`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't delete the knowledge base.");
    }
  };

  const list = knowledgeBases.data ?? [];
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      {confirmDialog}
      <KnowledgeBaseDialog state={dialog} onOpenChange={(open) => !open && setDialog(null)} />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h1 className="text-2xl font-semibold tracking-tight">Knowledge bases</h1>
            <p className="max-w-xl text-sm text-muted-foreground">
              Documents your flows can search: the Retriever node finds the passages that answer a
              question.
            </p>
          </div>
          <Button onClick={() => setDialog({ mode: "create" })}>
            <Plus />
            New knowledge base
          </Button>
        </div>

        {knowledgeBases.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading knowledge bases">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
        ) : knowledgeBases.isError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border px-6 py-12 text-center"
          >
            <AlertCircle className="size-6 text-destructive" />
            <p className="font-medium">Couldn&apos;t load your knowledge bases</p>
            <p className="max-w-md text-sm text-muted-foreground">{knowledgeBases.error.message}</p>
            <Button variant="outline" onClick={() => void knowledgeBases.refetch()}>
              Try again
            </Button>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <Library className="size-8 text-muted-foreground" />
            <h2 className="font-medium">No knowledge bases yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Create one, add documents to it, and let your agents answer from them.
            </p>
            <Button onClick={() => setDialog({ mode: "create" })}>
              <Plus />
              New knowledge base
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((kb) => (
              <KnowledgeBaseCard
                key={kb.knowledge_base_id}
                knowledgeBase={kb}
                modelLabel={modelLabel(kb.embedding_model)}
                onEdit={() => setDialog({ mode: "edit", knowledgeBase: kb })}
                onDelete={() => void onDelete(kb)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
