"use client";

import {
  AlertCircle,
  Check,
  CircleAlert,
  Clock,
  FileText,
  Loader2,
  RotateCw,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formatBytes, formatRelativeTime, plural } from "@/lib/format";
import {
  useDeleteDocument,
  useDeleteKnowledgeBase,
  useDocuments,
  useKnowledgeBase,
  useRetryDocument,
  useUploadDocument,
} from "@/lib/knowledge-api";
import { useModels } from "@/lib/models-api";
import { cn } from "@/lib/utils";
import {
  DOCUMENT_EXTENSIONS,
  uploadProblem,
  type DocumentStatus,
  type KnowledgeDocument,
} from "@/types/knowledge";

import { KnowledgeBaseDialog } from "./knowledge-base-dialog";

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

const STATUS: Record<DocumentStatus, { label: string; icon: typeof Check; className: string }> = {
  pending: { label: "Waiting to be processed", icon: Clock, className: "text-muted-foreground" },
  processing: { label: "Processing", icon: Loader2, className: "text-sky-600 dark:text-sky-400" },
  ready: { label: "Ready", icon: Check, className: "text-emerald-600 dark:text-emerald-500" },
  failed: { label: "Failed", icon: CircleAlert, className: "text-destructive" },
};

function StatusBadge({ document }: { document: KnowledgeDocument }) {
  const { label, icon: Icon, className } = STATUS[document.status];
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-xs", className)}>
      <Icon className={cn("size-3.5", document.status === "processing" && "animate-spin")} />
      {document.status === "ready" ? `${label} · ${plural(document.chunk_count, "chunk")}` : label}
    </span>
  );
}

function DocumentRow({
  document,
  onRetry,
  onDelete,
}: {
  document: KnowledgeDocument;
  onRetry: () => void;
  onDelete: () => void;
}) {
  return (
    <li aria-label={document.name} className="flex items-center gap-3 px-4 py-3">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{document.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(document.size)} · Added {formatRelativeTime(document.created_at)}
        </p>
        {document.status === "failed" && document.error && (
          <p className="text-xs text-destructive">{document.error}</p>
        )}
      </div>
      <StatusBadge document={document} />
      {document.status === "failed" && (
        <Button variant="ghost" size="sm" onClick={onRetry} aria-label={`Retry ${document.name}`}>
          <RotateCw />
          Retry
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${document.name}`}
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </li>
  );
}

function KnowledgeBaseView({ id }: { id: string }) {
  const knowledgeBase = useKnowledgeBase(id);
  const documents = useDocuments(id);
  const models = useModels();
  const upload = useUploadDocument(id);
  const deleteDocument = useDeleteDocument(id);
  const retryDocument = useRetryDocument(id);
  const deleteKnowledgeBase = useDeleteKnowledgeBase();
  const router = useRouter();
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState<{ key: number; name: string }[]>([]);
  const nextKey = useRef(0);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const kb = knowledgeBase.data;
  if (knowledgeBase.isError) {
    const missing =
      knowledgeBase.error instanceof ApiError && knowledgeBase.error.status === 404;
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="font-medium">
          {missing ? "Knowledge base not found" : "Couldn't load the knowledge base"}
        </p>
        {!missing && (
          <p className="text-sm text-muted-foreground">{knowledgeBase.error.message}</p>
        )}
        <Link href="/knowledge" className="text-sm underline">
          All knowledge bases
        </Link>
      </div>
    );
  }
  if (!kb) {
    return (
      <div className="space-y-3" aria-label="Loading knowledge base">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  /** Uploads one file at a time, so each gets its own result. */
  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      const problem = uploadProblem(file);
      if (problem) {
        toast.error(problem);
        continue;
      }
      const key = nextKey.current++;
      setUploading((rows) => [...rows, { key, name: file.name }]);
      try {
        await upload.mutateAsync(file);
      } catch (error) {
        toast.error(`“${file.name}”: ${errorMessage(error, "couldn't upload it.")}`);
      } finally {
        setUploading((rows) => rows.filter((row) => row.key !== key));
      }
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void uploadFiles([...event.dataTransfer.files]);
  };

  const onDeleteDocument = async (document: KnowledgeDocument) => {
    const ok = await confirm({
      title: `Delete “${document.name}”?`,
      description: "Flows won't find anything from it any more. This can't be undone.",
      confirmLabel: "Delete document",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteDocument.mutateAsync(document.document_id);
      toast.success(`Deleted “${document.name}”`);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't delete the document."));
    }
  };

  const onDeleteKnowledgeBase = async () => {
    const ok = await confirm({
      title: `Delete “${kb.name}”?`,
      description: `This deletes it and its ${plural(kb.document_count, "document")}. Flows that search it will stop finding anything until you choose another one. This can't be undone.`,
      confirmLabel: "Delete knowledge base",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteKnowledgeBase.mutateAsync(kb.knowledge_base_id);
      toast.success(`Deleted “${kb.name}”`);
      router.push("/knowledge");
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't delete the knowledge base."));
    }
  };

  const modelLabel =
    models.data?.embedding_models.find((m) => m.id === kb.embedding_model)?.label ??
    kb.embedding_model;
  const list = documents.data ?? [];

  return (
    <>
      {confirmDialog}
      <KnowledgeBaseDialog
        state={editing ? { mode: "edit", knowledgeBase: kb } : null}
        onOpenChange={(open) => !open && setEditing(false)}
      />
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <p className="text-sm text-muted-foreground">
            <Link href="/knowledge" className="hover:text-foreground">
              Knowledge
            </Link>{" "}
            /
          </p>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{kb.name}</h1>
          {kb.description && (
            <p className="max-w-2xl text-sm text-muted-foreground">{kb.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {plural(kb.document_count, "document")} · {modelLabel} · Chunks of {kb.chunk_size}{" "}
            characters, {kb.chunk_overlap} overlap
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing(true)}>
          <Settings2 />
          Settings
        </Button>
        <Button variant="outline" onClick={() => void onDeleteKnowledgeBase()}>
          <Trash2 />
          Delete
        </Button>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-8 text-center transition-colors",
          dragging && "border-primary bg-primary/5",
        )}
      >
        <Upload className="size-6 text-muted-foreground" />
        <p className="text-sm">
          Drop PDF, text or Markdown files here, or{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => fileInput.current?.click()}
          >
            choose files
          </button>
        </p>
        <p className="text-xs text-muted-foreground">Up to 10 MB each.</p>
        <input
          ref={fileInput}
          type="file"
          name="upload-documents"
          multiple
          accept={DOCUMENT_EXTENSIONS.join(",")}
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = ""; // the same file can be chosen again
            void uploadFiles(files);
          }}
        />
      </div>

      <section aria-label="Documents" className="rounded-xl border">
        {documents.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : documents.isError ? (
          <p className="p-4 text-sm text-destructive">
            Couldn&apos;t load the documents: {documents.error.message}
          </p>
        ) : list.length === 0 && uploading.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No documents yet. Add some to make this knowledge base searchable.
          </p>
        ) : (
          <ul className="divide-y">
            {uploading.map(({ key, name }) => (
              <li key={key} className="flex items-center gap-3 px-4 py-3">
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                <p className="min-w-0 flex-1 truncate text-sm">{name}</p>
                <span className="text-xs text-muted-foreground">Uploading…</span>
              </li>
            ))}
            {list.map((document) => (
              <DocumentRow
                key={document.document_id}
                document={document}
                onRetry={() =>
                  retryDocument.mutate(document.document_id, {
                    onError: (error) =>
                      toast.error(errorMessage(error, "Couldn't retry the document.")),
                  })
                }
                onDelete={() => void onDeleteDocument(document)}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** `/knowledge/[knowledgeBaseId]`: one knowledge base, its documents and uploads. */
export function KnowledgeBasePage() {
  // A page kept hidden by Next (Activity) sees the *current* URL's params: no id → nothing.
  const { knowledgeBaseId } = useParams<{ knowledgeBaseId?: string }>();
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-4 py-8 sm:px-6">
        {knowledgeBaseId && <KnowledgeBaseView key={knowledgeBaseId} id={knowledgeBaseId} />}
      </main>
    </div>
  );
}
