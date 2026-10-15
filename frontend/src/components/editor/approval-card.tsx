"use client";

import { Check, Hourglass, Loader2, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ApprovalRequest } from "@/stores/run-store";

/** The content as editable text: strings as they are, anything else as indented JSON. */
const asText = (content: unknown) =>
  typeof content === "string" ? content : JSON.stringify(content ?? null, null, 2);

export type AnswerApproval = (
  nodeId: string,
  approved: boolean,
  /** Present only when the reviewer changed the content. */
  edit?: { content: unknown },
) => Promise<void>;

/** A waiting Approval Gate: its message, the content, and Approve / Reject. */
export function ApprovalCard({
  nodeId,
  name,
  request,
  onAnswer,
}: {
  nodeId: string;
  name: string;
  request: ApprovalRequest;
  onAnswer: AnswerApproval;
}) {
  const original = asText(request.content);
  const [draft, setDraft] = useState(original);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const editable = request.allowEdit && !request.contentTruncated;

  const answer = async (approved: boolean) => {
    let edit: { content: unknown } | undefined;
    if (editable && draft !== original) {
      if (typeof request.content === "string") {
        edit = { content: draft };
      } else {
        try {
          edit = { content: JSON.parse(draft) };
        } catch {
          setProblem("This content is JSON — fix it before answering, or undo your changes.");
          return;
        }
      }
    }
    setProblem(null);
    setBusy(approved ? "approve" : "reject");
    try {
      await onAnswer(nodeId, approved, edit);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label={`Approval: ${name}`}
      className="rounded-lg border border-amber-500/50 bg-amber-500/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        <Hourglass className="size-3.5" />
        {name} is waiting for your approval
      </div>
      <p className="mt-1.5 text-sm font-medium">{request.message}</p>
      {editable ? (
        <Textarea
          aria-label="Content to approve"
          value={draft}
          rows={Math.min(10, Math.max(3, draft.split("\n").length))}
          onChange={(e) => setDraft(e.target.value)}
          className="mt-2 font-mono text-xs"
        />
      ) : (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-sans text-sm whitespace-pre-wrap break-words">
          {original}
        </pre>
      )}
      {request.contentTruncated && (
        <p className="mt-1 text-xs text-muted-foreground">
          The content is too long to show in full, so it can&apos;t be edited here.
        </p>
      )}
      {problem && <p className="mt-1 text-xs text-destructive">{problem}</p>}
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={busy !== null} onClick={() => void answer(true)}>
          {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void answer(false)}
        >
          {busy === "reject" ? <Loader2 className="animate-spin" /> : <X />}
          Reject
        </Button>
        {editable && draft !== original && (
          <span className="text-xs text-muted-foreground">Edited — continues with your version</span>
        )}
      </div>
    </section>
  );
}
