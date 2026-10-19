"use client";

import { Copy, Terminal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { answersFrom, curlCommand, SECRET_HEADER, webhookUrl } from "@/lib/webhooks";
import { useFlowStore } from "@/stores/flow-store";
import type { NodeData } from "@/types/flow";

const str = (value: unknown) => (typeof value === "string" ? value : "");

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text);
  toast.success(`Copied the ${what}`);
}

/** A Webhook trigger's URL, with copy buttons (settings panel). */
export function WebhookUrl({ nodeId, data }: { nodeId: string; data: NodeData }) {
  const flowId = useFlowStore((s) => s.flowId);
  const answers = useFlowStore((s) => answersFrom(nodeId, s.nodes, s.edges));
  if (!flowId) {
    return (
      <p className="text-xs text-muted-foreground">Save the flow to get this trigger&apos;s URL.</p>
    );
  }

  const url = webhookUrl(flowId, nodeId);
  const method = str(data.method) || "POST";
  const secret = str(data.secret).trim();
  const curl = () => copy(curlCommand({ url, method, secret, body: str(data.test_body) }), "curl command");

  return (
    <div className="space-y-1.5">
      <Label htmlFor="webhook-url">Webhook URL</Label>
      <div className="flex gap-1.5">
        <Input
          id="webhook-url"
          readOnly
          value={url}
          className="font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="Copy webhook URL"
          onClick={() => copy(url, "webhook URL")}
        >
          <Copy />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {answers
          ? `A ${method} request here runs the flow as last saved, and the caller gets what its HTTP Response node sends (if that takes too long: 202 with the run's id).`
          : `A ${method} request here runs the flow as last saved and answers right away with the run's id — add an HTTP Response node to send something else.`}{" "}
        The run shows up in Run history.{" "}
        {secret
          ? `Send the secret in the ${SECRET_HEADER} header.`
          : "Anyone with the URL can call it: add a secret to require one."}
      </p>
      <Button variant="ghost" size="sm" className="-ml-2" onClick={curl}>
        <Terminal />
        Copy curl command
      </Button>
    </div>
  );
}
