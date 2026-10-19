import { describe, expect, it } from "vitest";

import { answersFrom, curlCommand, webhookUrl } from "./webhooks";

describe("webhookUrl", () => {
  it("points at the trigger on the API", () => {
    expect(webhookUrl("f1", "node_ab12", "https://api.example.com")).toBe(
      "https://api.example.com/hooks/f1/node_ab12",
    );
    expect(webhookUrl("f1", "a b/c", "http://x")).toBe("http://x/hooks/f1/a%20b%2Fc");
  });
});

describe("curlCommand", () => {
  const url = "http://x/hooks/f/n";

  it("sends JSON test bodies as JSON, with the secret", () => {
    expect(curlCommand({ url, method: "POST", secret: " s3 ", body: '{"name": "Ada"}' })).toBe(
      `curl -X POST 'http://x/hooks/f/n' -H 'X-Mesh-Secret: s3' -H 'Content-Type: application/json' --data-raw '{"name": "Ada"}'`,
    );
  });

  it("sends other text as text, quoted for the shell", () => {
    expect(curlCommand({ url, method: "PUT", secret: "", body: "it's @here" })).toBe(
      `curl -X PUT 'http://x/hooks/f/n' -H 'Content-Type: text/plain' --data-raw 'it'\\''s @here'`,
    );
  });

  it("defaults to an empty JSON object, and GET sends no body", () => {
    expect(curlCommand({ url, method: "POST", secret: "", body: "  " })).toContain(
      "--data-raw '{}'",
    );
    expect(curlCommand({ url, method: "GET", secret: "", body: "{}" })).toBe(
      "curl -X GET 'http://x/hooks/f/n'",
    );
  });
});

describe("answersFrom", () => {
  const nodes = [
    { id: "hook", type: "trigger_webhook" as const },
    { id: "a", type: "agent_node" as const },
    { id: "r", type: "action_http_response" as const },
    { id: "other", type: "trigger_manual" as const },
  ];

  it("finds an HTTP Response downstream along data edges", () => {
    const edges = [
      { source: "hook", target: "a" },
      { source: "a", target: "r", type: "data" as const },
    ];
    expect(answersFrom("hook", nodes, edges)).toBe(true);
    expect(answersFrom("other", nodes, edges)).toBe(false);
  });

  it("ignores tool attachments, and survives cycles", () => {
    const edges = [
      { source: "hook", target: "a" },
      { source: "a", target: "hook" },
      { source: "a", target: "r", type: "tool_connection" as const },
    ];
    expect(answersFrom("hook", nodes, edges)).toBe(false);
  });
});
