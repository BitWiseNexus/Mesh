"use client";

import Link from "next/link";
import { useState } from "react";

import {
  KnowledgeBaseDialog,
  type KnowledgeBaseDialogState,
} from "@/components/knowledge/knowledge-base-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { plural } from "@/lib/format";
import { useKnowledgeBases } from "@/lib/knowledge-api";

const CREATE = "__create__";

/**
 * Picks one of the user's knowledge bases (the id is stored). "New knowledge base…" creates one
 * and selects it; a deleted one is flagged.
 */
export function KnowledgeBaseField({
  id,
  value,
  onChange,
  invalid,
  required,
}: {
  id: string;
  value: unknown;
  onChange: (value: string) => void;
  invalid?: boolean;
  required?: boolean;
}) {
  const knowledgeBases = useKnowledgeBases();
  const [dialog, setDialog] = useState<KnowledgeBaseDialogState>(null);
  const list = knowledgeBases.data ?? [];
  const selected = typeof value === "string" && value ? value : null;
  const chosen = list.find((kb) => kb.knowledge_base_id === selected);
  const missing = selected !== null && knowledgeBases.isSuccess && !chosen;

  const items: Record<string, string> = {
    ...Object.fromEntries(list.map((kb) => [kb.knowledge_base_id, kb.name])),
    ...(missing ? { [selected]: "Deleted knowledge base" } : {}),
    [CREATE]: "New knowledge base…",
  };

  return (
    <>
      <KnowledgeBaseDialog
        state={dialog}
        onOpenChange={(open) => !open && setDialog(null)}
        onSaved={(saved) => onChange(saved.knowledge_base_id)}
      />
      <Select
        value={selected}
        items={items}
        onValueChange={(next) => {
          if (next === CREATE) setDialog({ mode: "create" });
          else if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger
          id={id}
          aria-invalid={invalid || missing || undefined}
          aria-required={required || undefined}
          className="w-full"
        >
          <SelectValue
            placeholder={
              knowledgeBases.isPending
                ? "Loading…"
                : list.length
                  ? "Choose a knowledge base"
                  : "No knowledge bases yet"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {list.map((kb) => (
            <SelectItem key={kb.knowledge_base_id} value={kb.knowledge_base_id}>
              {kb.name}
            </SelectItem>
          ))}
          {missing && <SelectItem value={selected}>Deleted knowledge base</SelectItem>}
          {list.length > 0 && <SelectSeparator />}
          <SelectItem value={CREATE}>New knowledge base…</SelectItem>
        </SelectContent>
      </Select>
      {missing ? (
        <p className="text-xs text-destructive">
          This knowledge base was deleted. Choose another one.
        </p>
      ) : chosen ? (
        <p className="text-xs text-muted-foreground">
          {plural(chosen.document_count, "document")}
          {chosen.document_count === 0 && " — add some on the "}
          {chosen.document_count === 0 ? (
            <Link href={`/knowledge/${chosen.knowledge_base_id}`} className="underline">
              knowledge base&apos;s page
            </Link>
          ) : (
            <>
              {" · "}
              <Link href={`/knowledge/${chosen.knowledge_base_id}`} className="underline">
                Open
              </Link>
            </>
          )}
        </p>
      ) : null}
    </>
  );
}
