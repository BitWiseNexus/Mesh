"use client";

import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useCredentials, useDeleteCredential } from "@/lib/credentials-api";
import { formatRelativeTime } from "@/lib/format";
import { CREDENTIAL_PROVIDERS, PROVIDER_INFO, type CredentialInfo } from "@/types/credentials";

import { CredentialDialog, type CredentialDialogState } from "./credential-dialog";

/** `/settings/api-keys`: the user's saved keys, grouped by service. */
export function ApiKeysPage() {
  const credentials = useCredentials();
  const remove = useDeleteCredential();
  const [dialog, setDialog] = useState<CredentialDialogState>(null);
  const [confirm, confirmDialog] = useConfirm();

  const onDelete = async (credential: CredentialInfo) => {
    const ok = await confirm({
      title: `Delete “${credential.name}”?`,
      description:
        "Nodes set to use this key will stop working until you choose another one. This can't be undone.",
      confirmLabel: "Delete key",
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(credential.credential_id);
      toast.success(`Deleted “${credential.name}”`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't delete the key.");
    }
  };

  const list = credentials.data ?? [];
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      {confirmDialog}
      <CredentialDialog state={dialog} onOpenChange={(open) => !open && setDialog(null)} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">
              <Link href="/flows" className="hover:text-foreground">
                Flows
              </Link>{" "}
              / Settings
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Keys your flows use when they run: agents use your key for their model&apos;s
              provider, Web Search uses your Tavily key. They&apos;re stored encrypted and never
              shown again.
            </p>
          </div>
          <Button onClick={() => setDialog({ mode: "create" })}>
            <Plus />
            Add key
          </Button>
        </div>

        {credentials.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : credentials.isError ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load your keys: {credentials.error.message}
          </p>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
            <KeyRound className="size-8 text-muted-foreground" />
            <h2 className="font-medium">No API keys yet</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Add a key for OpenAI, Anthropic or Gemini to run agents on real models. Without one,
              the server&apos;s keys are used if it has any — or try the mock/echo model.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {CREDENTIAL_PROVIDERS.filter((p) => list.some((c) => c.provider === p)).map((p) => (
              <section key={p} aria-label={PROVIDER_INFO[p].label}>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                  {PROVIDER_INFO[p].label}
                </h2>
                <ul className="divide-y rounded-xl border">
                  {list
                    .filter((c) => c.provider === p)
                    .map((c) => (
                      <li key={c.credential_id} className="flex items-center gap-3 px-4 py-3">
                        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{c.name}</div>
                          <div className="text-xs text-muted-foreground">
                            <code>{c.hint}</code> · updated {formatRelativeTime(c.updated_at)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${c.name}`}
                          onClick={() => setDialog({ mode: "edit", credential: c })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${c.name}`}
                          onClick={() => void onDelete(c)}
                        >
                          <Trash2 />
                        </Button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
