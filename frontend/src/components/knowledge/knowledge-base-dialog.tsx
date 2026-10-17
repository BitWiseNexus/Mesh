"use client";

import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { useCreateKnowledgeBase, useUpdateKnowledgeBase } from "@/lib/knowledge-api";
import { useModels, type EmbeddingModelOption } from "@/lib/models-api";
import {
  chunkSettingsProblem,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_KB_DESCRIPTION_LENGTH,
  MAX_KB_NAME_LENGTH,
  MIN_CHUNK_SIZE,
  type KnowledgeBase,
} from "@/types/knowledge";

export type KnowledgeBaseDialogState =
  | { mode: "create" }
  | { mode: "edit"; knowledgeBase: KnowledgeBase }
  | null;

const KEY_NOTE: Record<EmbeddingModelOption["key"], string> = {
  saved: "uses your saved key",
  server: "uses the server's key",
  none: "no API key yet",
  not_needed: "no API key needed",
};

function KnowledgeBaseForm({
  state,
  onDone,
}: {
  state: Exclude<KnowledgeBaseDialogState, null>;
  onDone: (saved: KnowledgeBase) => void;
}) {
  const models = useModels();
  const create = useCreateKnowledgeBase();
  const update = useUpdateKnowledgeBase();
  const editing = state.mode === "edit" ? state.knowledgeBase : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  // null: the suggested default (known once the model list has loaded).
  const [model, setModel] = useState<string | null>(editing?.embedding_model ?? null);
  const [size, setSize] = useState(String(editing?.chunk_size ?? DEFAULT_CHUNK_SIZE));
  const [overlap, setOverlap] = useState(String(editing?.chunk_overlap ?? DEFAULT_CHUNK_OVERLAP));

  const options = models.data?.embedding_models ?? [];
  const chosen = model ?? models.data?.default_embedding_model ?? null;
  // A model that isn't offered any more (e.g. the mock one, in production) still shows.
  const items: Record<string, string> = Object.fromEntries([
    ...(chosen && !options.some((o) => o.id === chosen) ? [[chosen, chosen]] : []),
    ...options.map((o) => [o.id, `${o.label} — ${KEY_NOTE[o.key]}`]),
  ]);
  const locked = !!editing && editing.document_count > 0;
  const chunkProblem = chunkSettingsProblem(Number(size), Number(overlap));
  const pending = create.isPending || update.isPending;
  const valid = name.trim() && !chunkProblem;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const settings = {
      name: name.trim(),
      description: description.trim(),
      chunk_size: Number(size),
      chunk_overlap: Number(overlap),
      ...(chosen && !locked ? { embedding_model: chosen } : {}),
    };
    try {
      const saved = editing
        ? await update.mutateAsync({ id: editing.knowledge_base_id, ...settings })
        : await create.mutateAsync(settings);
      toast.success(editing ? `Saved “${saved.name}”` : `Created “${saved.name}”`);
      onDone(saved);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't save the knowledge base.");
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="kb-name">Name</Label>
        <Input
          id="kb-name"
          value={name}
          maxLength={MAX_KB_NAME_LENGTH}
          autoFocus
          required
          placeholder="Product docs"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kb-description">Description</Label>
        <Textarea
          id="kb-description"
          value={description}
          maxLength={MAX_KB_DESCRIPTION_LENGTH}
          rows={2}
          placeholder="What's in it?"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="kb-model">Embedding model</Label>
        <Select
          value={chosen}
          items={items}
          disabled={locked}
          onValueChange={(next) => next && setModel(String(next))}
        >
          <SelectTrigger id="kb-model" className="w-full">
            <SelectValue placeholder={models.isPending ? "Loading…" : "Choose a model"} />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(items).map(([id, label]) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {locked
            ? "Fixed: its documents were embedded with this model."
            : "Turns text into vectors for search. It can't be changed once documents are added."}
        </p>
      </div>
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1.5 text-sm font-medium">Chunks</legend>
        <div className="space-y-1.5">
          <Label htmlFor="kb-chunk-size" className="text-xs font-normal text-muted-foreground">
            Size (characters)
          </Label>
          <Input
            id="kb-chunk-size"
            type="number"
            min={MIN_CHUNK_SIZE}
            max={MAX_CHUNK_SIZE}
            step={100}
            value={size}
            aria-invalid={!!chunkProblem || undefined}
            onChange={(e) => setSize(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="kb-chunk-overlap" className="text-xs font-normal text-muted-foreground">
            Overlap (characters)
          </Label>
          <Input
            id="kb-chunk-overlap"
            type="number"
            min={0}
            step={50}
            value={overlap}
            aria-invalid={!!chunkProblem || undefined}
            onChange={(e) => setOverlap(e.target.value)}
          />
        </div>
        <p className={`col-span-2 text-xs ${chunkProblem ? "text-destructive" : "text-muted-foreground"}`}>
          {chunkProblem ??
            (editing && editing.document_count > 0
              ? "Changes apply to documents added from now on."
              : "Documents are split into chunks of this size; the overlap keeps sentences that span two chunks findable.")}
        </p>
      </fieldset>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!valid || pending}>
          {pending && <Loader2 className="animate-spin" />}
          {editing ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Create a knowledge base, or change one's name, description and settings. */
export function KnowledgeBaseDialog({
  state,
  onOpenChange,
  onSaved,
}: {
  state: KnowledgeBaseDialogState;
  onOpenChange: (open: boolean) => void;
  /** After a successful save (e.g. to select a knowledge base just created). */
  onSaved?: (saved: KnowledgeBase) => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.mode === "edit" ? "Knowledge base settings" : "New knowledge base"}</DialogTitle>
          <DialogDescription>
            A collection of documents your flows can search with the Retriever node.
          </DialogDescription>
        </DialogHeader>
        {/* key: fresh form state per knowledge base */}
        {state && (
          <KnowledgeBaseForm
            key={state.mode === "edit" ? state.knowledgeBase.knowledge_base_id : "new"}
            state={state}
            onDone={(saved) => {
              onOpenChange(false);
              onSaved?.(saved);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
