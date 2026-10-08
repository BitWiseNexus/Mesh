"use client";

import Link from "next/link";
import { useState } from "react";

import { CredentialDialog, type CredentialDialogState } from "@/components/credentials/credential-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCredentials } from "@/lib/credentials-api";
import {
  CREDENTIAL_PROVIDERS,
  PROVIDER_INFO,
  type CredentialProvider,
} from "@/types/credentials";

const AUTOMATIC = "__automatic__";
const ADD = "__add__";

/**
 * Picks one of the user's saved keys for a `credential` field. Empty (null) = automatic: the
 * user's key for the right provider, else the server's. "Add a key…" creates one and selects it.
 */
export function CredentialField({
  id,
  providers,
  value,
  onChange,
  invalid,
}: {
  id: string;
  providers: string[];
  value: unknown;
  onChange: (value: string | null) => void;
  invalid?: boolean;
}) {
  const credentials = useCredentials();
  const [dialog, setDialog] = useState<CredentialDialogState>(null);
  const allowed = CREDENTIAL_PROVIDERS.filter((p) => providers.includes(p)) as CredentialProvider[];
  const options = (credentials.data ?? []).filter((c) => allowed.includes(c.provider));
  const selected = typeof value === "string" && value ? value : null;
  const missing = selected !== null && credentials.isSuccess && !options.some((c) => c.credential_id === selected);
  const automatic =
    allowed.length === 1 ? `Automatic (your ${PROVIDER_INFO[allowed[0]].label} key)` : "Automatic";

  const items: Record<string, string> = {
    [AUTOMATIC]: allowed.includes("http") ? "None" : automatic,
    ...Object.fromEntries(
      options.map((c) => [c.credential_id, `${c.name} (${PROVIDER_INFO[c.provider].label} ${c.hint})`]),
    ),
    ...(missing ? { [selected]: "Deleted key" } : {}),
  };

  return (
    <>
      <CredentialDialog
        state={dialog}
        onOpenChange={(open) => !open && setDialog(null)}
        onSaved={(saved) => onChange(saved.credential_id)}
      />
      <Select
        value={selected ?? AUTOMATIC}
        items={items}
        onValueChange={(next) => {
          if (next === ADD) setDialog({ mode: "create", providers: allowed });
          else onChange(next === AUTOMATIC || next === null ? null : String(next));
        }}
      >
        <SelectTrigger id={id} aria-invalid={invalid || missing || undefined} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTOMATIC}>{items[AUTOMATIC]}</SelectItem>
          {options.map((c) => (
            <SelectItem key={c.credential_id} value={c.credential_id}>
              {items[c.credential_id]}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={ADD}>Add a key…</SelectItem>
        </SelectContent>
      </Select>
      {missing && (
        <p className="text-xs text-destructive">
          This key was deleted. Choose another one, or{" "}
          <Link href="/settings/api-keys" className="underline">
            manage your keys
          </Link>
          .
        </p>
      )}
    </>
  );
}
