"use client";

import { AlertCircle, History, Loader2, Plus, Search, Upload, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useAuth } from "@/components/auth/auth-provider";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { parseFlowJson } from "@/lib/flow/graph";
import { createFlowFromTemplate } from "@/lib/flow/templates";
import { toFlowContent, type FlowSummary } from "@/lib/flows-api";
import { useCreateFlow, useDeleteFlow, useDuplicateFlow, useFlowList } from "@/lib/flows-queries";
import { plural } from "@/lib/format";
import { discardLegacyDraft, findLegacyDraft } from "@/stores/flow-store";
import type { Flow } from "@/types/flow";

import { FlowCard, FlowCardSkeleton } from "./flow-card";
import { RenameFlowDialog } from "./rename-flow-dialog";

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/** Offers to import a flow drafted in this browser before flows were saved to the server. */
function LegacyDraftBanner({ onImport }: { onImport: (flow: Flow) => Promise<void> }) {
  const { user } = useAuth();
  const [draft, setDraft] = useState(() => (user ? findLegacyDraft(user.uid) : null));
  const [busy, setBusy] = useState(false);
  if (!draft) return null;

  const dismiss = () => {
    discardLegacyDraft(draft.key);
    setDraft(null);
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed bg-muted/40 p-4 text-sm"
    >
      <History className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1">
        We found <strong>“{draft.flow.name}”</strong> ({plural(draft.flow.nodes.length, "node")})
        saved in this browser. Import it into your flows?
      </p>
      <Button variant="ghost" size="sm" onClick={dismiss} disabled={busy}>
        Discard
      </Button>
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onImport(draft.flow);
            dismiss();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Loader2 className="animate-spin" />}
        Import
      </Button>
    </div>
  );
}

function EmptyState({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted">
        <Workflow className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold">Create your first flow</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Flows connect triggers, AI agents, tools and actions. Start from a simple template and build
        from there.
      </p>
      <Button onClick={onCreate} disabled={creating}>
        {creating ? <Loader2 className="animate-spin" /> : <Plus />}
        New flow
      </Button>
    </div>
  );
}

export function FlowsDashboard() {
  const router = useRouter();
  const flows = useFlowList();
  const createFlow = useCreateFlow();
  const duplicateFlow = useDuplicateFlow();
  const deleteFlow = useDeleteFlow();
  const [confirm, confirmDialog] = useConfirm();
  const [renaming, setRenaming] = useState<FlowSummary | null>(null);
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = flows.data ?? [];
    return q
      ? list.filter((f) => `${f.name} ${f.description}`.toLowerCase().includes(q))
      : list;
  }, [flows.data, query]);

  const createAndOpen = async (flow: Flow, successMessage?: string) => {
    try {
      const created = await createFlow.mutateAsync(toFlowContent(flow));
      if (successMessage) toast.success(successMessage);
      router.push(`/flows/${created.flow_id}`);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't create the flow."));
      throw error;
    }
  };

  const newFlow = () => void createAndOpen(createFlowFromTemplate("starter")).catch(() => {});

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const result = parseFlowJson(await file.text());
    if (!result.ok) {
      toast.error(`Import failed: ${result.error}`);
      return;
    }
    await createAndOpen(result.flow, `Imported “${result.flow.name}”`).catch(() => {});
  };

  const duplicate = async (flow: FlowSummary) => {
    try {
      const copy = await duplicateFlow.mutateAsync(flow.flow_id);
      toast.success(`Created “${copy.name}”`);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't duplicate the flow."));
    }
  };

  const remove = async (flow: FlowSummary) => {
    const ok = await confirm({
      title: `Delete “${flow.name}”?`,
      description: "This permanently deletes the flow. This can't be undone.",
      confirmLabel: "Delete flow",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteFlow.mutateAsync(flow.flow_id);
      toast.success(`Deleted “${flow.name}”`);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't delete the flow."));
    }
  };

  const count = flows.data?.length ?? 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      {confirmDialog}
      <RenameFlowDialog flow={renaming} onOpenChange={(open) => !open && setRenaming(null)} />
      <input
        ref={fileInput}
        type="file"
        name="import-flow-file"
        accept="application/json,.json"
        className="hidden"
        onChange={importFile}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h1 className="text-2xl font-semibold tracking-tight">Flows</h1>
            <p className="text-sm text-muted-foreground">
              {flows.isSuccess ? plural(count, "flow") : "Your AI workflows"}
            </p>
          </div>
          {count > 0 && (
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search flows…"
                aria-label="Search flows"
                className="pl-8"
              />
            </div>
          )}
          <Button variant="outline" onClick={() => fileInput.current?.click()}>
            <Upload />
            Import
          </Button>
          <Button onClick={newFlow} disabled={createFlow.isPending}>
            {createFlow.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            New flow
          </Button>
        </div>

        <LegacyDraftBanner onImport={(flow) => createAndOpen(flow, `Imported “${flow.name}”`)} />

        {flows.isPending ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading flows">
            {Array.from({ length: 6 }, (_, i) => (
              <FlowCardSkeleton key={i} />
            ))}
          </div>
        ) : flows.isError ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border px-6 py-12 text-center"
          >
            <AlertCircle className="size-6 text-destructive" />
            <p className="font-medium">Couldn&apos;t load your flows</p>
            <p className="text-sm text-muted-foreground">{errorMessage(flows.error, "")}</p>
            <Button variant="outline" onClick={() => void flows.refetch()}>
              Try again
            </Button>
          </div>
        ) : count === 0 ? (
          <EmptyState onCreate={newFlow} creating={createFlow.isPending} />
        ) : visible.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No flows match “{query}”.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((flow) => (
              <FlowCard
                key={flow.flow_id}
                flow={flow}
                onRename={() => setRenaming(flow)}
                onDuplicate={() => void duplicate(flow)}
                onDelete={() => void remove(flow)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
