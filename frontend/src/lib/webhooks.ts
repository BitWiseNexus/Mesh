import { API_URL } from "@/lib/api";
import type { CanvasEdge, CanvasNode } from "@/lib/flow/graph";

/** The header a Webhook trigger's secret is sent in (backend `app/services/webhooks.py`). */
export const SECRET_HEADER = "X-Mesh-Secret";

/** Where a Webhook trigger listens: `/hooks/{flowId}/{nodeId}` on the API (no sign-in). */
export function webhookUrl(flowId: string, nodeId: string, apiUrl = API_URL): string {
  return `${apiUrl}/hooks/${encodeURIComponent(flowId)}/${encodeURIComponent(nodeId)}`;
}

/** Single-quoted for POSIX shells: `'` becomes `'\''`. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A curl command (bash/zsh) that calls the webhook the way it's configured, with `body`. */
export function curlCommand({
  url,
  method,
  secret,
  body,
}: {
  url: string;
  method: string;
  secret: string;
  body: string;
}): string {
  const parts = ["curl", "-X", method, shellQuote(url)];
  if (secret.trim()) parts.push("-H", shellQuote(`${SECRET_HEADER}: ${secret.trim()}`));
  if (method !== "GET") {
    const text = body.trim() || "{}";
    const type = isJson(text) ? "application/json" : "text/plain";
    // --data-raw: -d would read a file for a body starting with "@".
    parts.push("-H", shellQuote(`Content-Type: ${type}`), "--data-raw", shellQuote(text));
  }
  return parts.join(" ");
}

/** Whether an HTTP Response node follows `triggerId` (along data edges): then a request to the
 * trigger waits for that node's answer (backend `app/api/webhooks.py`). */
export function answersFrom(
  triggerId: string,
  nodes: Pick<CanvasNode, "id" | "type">[],
  edges: Pick<CanvasEdge, "source" | "target" | "type">[],
): boolean {
  const types = new Map(nodes.map((n) => [n.id, n.type]));
  const seen = new Set([triggerId]);
  const queue = [triggerId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of edges) {
      if ((e.type ?? "data") !== "data" || e.source !== current || seen.has(e.target)) continue;
      if (types.get(e.target) === "action_http_response") return true;
      seen.add(e.target);
      queue.push(e.target);
    }
  }
  return false;
}
