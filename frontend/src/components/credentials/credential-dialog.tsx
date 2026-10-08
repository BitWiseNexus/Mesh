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
import { ApiError } from "@/lib/api";
import { useCreateCredential, useUpdateCredential } from "@/lib/credentials-api";
import {
  CREDENTIAL_PROVIDERS,
  PROVIDER_INFO,
  type CredentialInfo,
  type CredentialProvider,
} from "@/types/credentials";

export type CredentialDialogState =
  | { mode: "create"; providers?: readonly CredentialProvider[] }
  | { mode: "edit"; credential: CredentialInfo }
  | null;

function CredentialForm({
  state,
  onDone,
}: {
  state: Exclude<CredentialDialogState, null>;
  onDone: (saved: CredentialInfo) => void;
}) {
  const create = useCreateCredential();
  const update = useUpdateCredential();
  const editing = state.mode === "edit" ? state.credential : null;
  const providers = state.mode === "create" ? (state.providers ?? CREDENTIAL_PROVIDERS) : [];
  const [provider, setProvider] = useState<CredentialProvider>(
    editing?.provider ?? providers[0] ?? "openai",
  );
  const [name, setName] = useState(editing?.name ?? PROVIDER_INFO[provider].label);
  const [value, setValue] = useState("");
  const pending = create.isPending || update.isPending;
  const valid = name.trim() && (editing || value.trim());

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    try {
      const saved = editing
        ? await update.mutateAsync({
            id: editing.credential_id,
            name: name.trim(),
            ...(value.trim() ? { value } : {}),
          })
        : await create.mutateAsync({ provider, name: name.trim(), value });
      toast.success(editing ? `Saved “${saved.name}”` : `Added “${saved.name}”`);
      onDone(saved);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't save the API key.");
    }
  };

  const changeProvider = (next: CredentialProvider) => {
    // Keep a custom name; replace the default one.
    if (name === PROVIDER_INFO[provider].label) setName(PROVIDER_INFO[next].label);
    setProvider(next);
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {!editing && (
        <div className="space-y-1.5">
          <Label htmlFor="credential-provider">Service</Label>
          <Select
            value={provider}
            onValueChange={(v) => v && changeProvider(v as CredentialProvider)}
            items={Object.fromEntries(providers.map((p) => [p, PROVIDER_INFO[p].label]))}
          >
            <SelectTrigger id="credential-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_INFO[p].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Used by: {PROVIDER_INFO[provider].usedBy}</p>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="credential-name">Name</Label>
        <Input
          id="credential-name"
          value={name}
          maxLength={100}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="credential-value">{editing ? "New key (optional)" : "Key"}</Label>
        <Input
          id="credential-value"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          maxLength={4096}
          required={!editing}
          autoFocus
          placeholder={
            editing ? `Leave empty to keep ${editing.hint}` : PROVIDER_INFO[provider].placeholder
          }
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Stored encrypted. Mesh never shows it again — only its last characters.
        </p>
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!valid || pending}>
          {pending && <Loader2 className="animate-spin" />}
          {editing ? "Save" : "Add key"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Add or edit a saved API key. `onSaved` gets the saved key (e.g. to select it in a field). */
export function CredentialDialog({
  state,
  onOpenChange,
  onSaved,
}: {
  state: CredentialDialogState;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: CredentialInfo) => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.mode === "edit" ? "Edit API key" : "Add an API key"}</DialogTitle>
          <DialogDescription>
            Keys are used when your flows run — for example by agents calling a model.
          </DialogDescription>
        </DialogHeader>
        {state && (
          <CredentialForm
            // a fresh form for each opening
            key={state.mode === "edit" ? state.credential.credential_id : "new"}
            state={state}
            onDone={(saved) => {
              onSaved?.(saved);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
