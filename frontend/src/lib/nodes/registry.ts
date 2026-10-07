import {
  BookOpen,
  Bot,
  Clock,
  Code,
  Database,
  DatabaseZap,
  FileUp,
  Globe,
  GitBranch,
  HardDrive,
  type LucideIcon,
  Mail,
  MailOpen,
  MessageSquare,
  MonitorPlay,
  Network,
  Play,
  Plug,
  Repeat,
  Reply,
  Search,
  Send,
  ShieldCheck,
  Webhook,
} from "lucide-react";

import type { NodeCategory, NodeData, NodeType } from "@/types/flow";

/**
 * Handle conventions (ids are shared with the backend engine):
 * - `in` / `out`       data flow (target / source)
 * - `tools`            agent-side source handle for `tool_connection` edges
 * - `tool`             tool-side target handle for `tool_connection` edges
 * - branch outputs     `true`/`false` (If), `loop`/`done` (Loop), `approved`/`rejected` (Approval)
 */
export type HandleKind = "data" | "tool";

export interface HandleDef {
  id: string;
  kind: HandleKind;
  label?: string;
}

/** A config field rendered by the node config panel. `key` is the property in `node.data`. */
export type FieldDef = {
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
} & (
  | { kind: "text"; suggestions?: string[] }
  | { kind: "textarea"; rows?: number }
  | { kind: "code"; language: string; rows?: number }
  | { kind: "number"; min?: number; max?: number; step?: number }
  | { kind: "select"; options: { value: string; label: string }[] }
  | { kind: "switch" }
  | { kind: "json"; rows?: number }
);

export interface NodeDefinition {
  type: NodeType;
  category: NodeCategory;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Target handles (left/top of the node). */
  inputs: HandleDef[];
  /** Source handles (right/bottom of the node). */
  outputs: HandleDef[];
  defaultData: NodeData;
  fields: FieldDef[];
  /** One-line summary shown on the canvas node. */
  summary?: (data: NodeData) => string | undefined;
}

export interface CategoryDefinition {
  id: NodeCategory;
  label: string;
  /** Accent colour (CSS colour value) for node chrome and palette. */
  color: string;
}

export const CATEGORIES: Record<NodeCategory, CategoryDefinition> = {
  trigger: { id: "trigger", label: "Triggers", color: "oklch(0.68 0.17 150)" },
  agent: { id: "agent", label: "Agents", color: "oklch(0.6 0.2 285)" },
  tool: { id: "tool", label: "Tools", color: "oklch(0.7 0.15 60)" },
  knowledge: { id: "knowledge", label: "Knowledge", color: "oklch(0.63 0.14 230)" },
  logic: { id: "logic", label: "Logic & Human", color: "oklch(0.64 0.18 340)" },
  action: { id: "action", label: "Actions & Output", color: "oklch(0.63 0.19 30)" },
};

const IN: HandleDef = { id: "in", kind: "data" };
const OUT: HandleDef = { id: "out", kind: "data" };
const TOOLS: HandleDef = { id: "tools", kind: "tool", label: "Tools" };
const TOOL: HandleDef = { id: "tool", kind: "tool" };

const trigger = () => ({ category: "trigger" as const, inputs: [], outputs: [OUT] });
const step = (category: NodeCategory) => ({ category, inputs: [IN], outputs: [OUT] });
const toolOnly = () => ({ category: "tool" as const, inputs: [TOOL], outputs: [] });
/** Actions pass their result on so they can be chained. */
const action = () => ({ category: "action" as const, inputs: [IN], outputs: [OUT] });

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

// Suggestions only — any LiteLLM model string is accepted. Revisit when the LLM layer lands (3.8).
const MODEL_SUGGESTIONS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const TEMPLATE_HELP = "Use {{input}} for the previous node's output, or {{node_id.output}}.";

const options = (...values: string[]) => values.map((value) => ({ value, label: value }));

const agentFields = (extra: FieldDef[]): FieldDef[] => [
  { key: "model", label: "Model", kind: "text", suggestions: MODEL_SUGGESTIONS },
  {
    key: "system_prompt",
    label: "System prompt",
    kind: "textarea",
    rows: 6,
    placeholder: "You are a helpful assistant…",
  },
  { key: "temperature", label: "Temperature", kind: "number", min: 0, max: 2, step: 0.1 },
  ...extra,
];

export const NODE_REGISTRY: Record<NodeType, NodeDefinition> = {
  // ── Triggers ────────────────────────────────────────────────────────────
  trigger_manual: {
    type: "trigger_manual",
    ...trigger(),
    label: "Manual Trigger",
    description: "Start the flow with a button click, optionally with input text.",
    icon: Play,
    defaultData: { input: "" },
    fields: [
      {
        key: "input",
        label: "Default input",
        kind: "textarea",
        help: "Text passed into the flow when you press Run.",
      },
    ],
  },
  trigger_webhook: {
    type: "trigger_webhook",
    ...trigger(),
    label: "Webhook",
    description: "Start the flow when an HTTP request hits this flow's URL.",
    icon: Webhook,
    defaultData: { method: "POST", secret: "" },
    fields: [
      { key: "method", label: "Method", kind: "select", options: options("POST", "GET", "PUT") },
      {
        key: "secret",
        label: "Secret",
        kind: "text",
        help: "Optional. Callers must send it in the X-Mesh-Secret header.",
      },
    ],
    summary: (d) => str(d.method),
  },
  trigger_cron: {
    type: "trigger_cron",
    ...trigger(),
    label: "Schedule",
    description: "Run on a cron schedule.",
    icon: Clock,
    defaultData: { cron: "0 9 * * *", timezone: "UTC" },
    fields: [
      { key: "cron", label: "Cron expression", kind: "text", help: "e.g. 0 9 * * 1-5 = 9:00 on weekdays" },
      { key: "timezone", label: "Timezone", kind: "text", placeholder: "UTC" },
    ],
    summary: (d) => str(d.cron),
  },
  trigger_email: {
    type: "trigger_email",
    ...trigger(),
    label: "Email Listener",
    description: "Start the flow when an email arrives.",
    icon: MailOpen,
    defaultData: { filter_from: "", filter_subject: "" },
    fields: [
      { key: "filter_from", label: "From contains", kind: "text" },
      { key: "filter_subject", label: "Subject contains", kind: "text" },
    ],
  },

  // ── Agents ──────────────────────────────────────────────────────────────
  agent_node: {
    type: "agent_node",
    category: "agent",
    inputs: [IN],
    outputs: [OUT, TOOLS],
    label: "Agent",
    description: "An LLM with a system prompt that can call connected tools.",
    icon: Bot,
    defaultData: { model: "gpt-4o", system_prompt: "", temperature: 0.7, max_tool_steps: 5 },
    fields: agentFields([
      {
        key: "max_tool_steps",
        label: "Max tool steps",
        kind: "number",
        min: 1,
        max: 25,
        step: 1,
        help: "Upper bound on tool calls per run.",
      },
    ]),
    summary: (d) => str(d.model),
  },
  agent_supervisor: {
    type: "agent_supervisor",
    category: "agent",
    inputs: [IN],
    outputs: [OUT, TOOLS],
    label: "Supervisor Agent",
    description: "Delegates sub-tasks to connected worker agents and combines their results.",
    icon: Network,
    defaultData: { model: "gpt-4o", system_prompt: "", temperature: 0.3, max_rounds: 5 },
    fields: agentFields([
      { key: "max_rounds", label: "Max delegation rounds", kind: "number", min: 1, max: 20, step: 1 },
    ]),
    summary: (d) => str(d.model),
  },

  // ── Tools (attached to agents via tool_connection) ──────────────────────
  tool_web_search: {
    type: "tool_web_search",
    ...toolOnly(),
    label: "Web Search",
    description: "Search the web (Tavily or DuckDuckGo).",
    icon: Search,
    defaultData: { provider: "tavily", max_results: 5 },
    fields: [
      {
        key: "provider",
        label: "Provider",
        kind: "select",
        options: [
          { value: "tavily", label: "Tavily" },
          { value: "duckduckgo", label: "DuckDuckGo" },
        ],
      },
      { key: "max_results", label: "Max results", kind: "number", min: 1, max: 20, step: 1 },
    ],
    summary: (d) => str(d.provider),
  },
  tool_web_scraper: {
    type: "tool_web_scraper",
    ...toolOnly(),
    label: "Web Scraper",
    description: "Fetch a URL and extract its readable content.",
    icon: Globe,
    defaultData: { max_chars: 20000 },
    fields: [
      { key: "max_chars", label: "Max characters", kind: "number", min: 500, max: 200000, step: 500 },
    ],
  },
  tool_python: {
    type: "tool_python",
    ...toolOnly(),
    label: "Python Code",
    description: "Run Python code in a sandbox.",
    icon: Code,
    defaultData: { code: "", timeout_seconds: 30 },
    fields: [
      {
        key: "code",
        label: "Code",
        kind: "code",
        language: "python",
        rows: 10,
        placeholder: "def main(input: str) -> str:\n    return input.upper()",
      },
      { key: "timeout_seconds", label: "Timeout (s)", kind: "number", min: 1, max: 300, step: 1 },
    ],
  },
  tool_http: {
    type: "tool_http",
    ...toolOnly(),
    label: "API Caller",
    description: "Call a REST API endpoint.",
    icon: Plug,
    defaultData: { method: "GET", url: "", headers: {}, body: "" },
    fields: [
      {
        key: "method",
        label: "Method",
        kind: "select",
        options: options("GET", "POST", "PUT", "PATCH", "DELETE"),
      },
      { key: "url", label: "URL", kind: "text", placeholder: "https://api.example.com/items" },
      { key: "headers", label: "Headers", kind: "json", rows: 4 },
      { key: "body", label: "Body", kind: "textarea", help: TEMPLATE_HELP },
    ],
    summary: (d) => [str(d.method), str(d.url)].filter(Boolean).join(" ") || undefined,
  },

  // ── Knowledge / RAG ─────────────────────────────────────────────────────
  kb_upload: {
    type: "kb_upload",
    ...step("knowledge"),
    label: "Document Upload",
    description: "Upload PDFs or text into a knowledge base.",
    icon: FileUp,
    defaultData: { knowledge_base_id: null, chunk_size: 1000, chunk_overlap: 200 },
    fields: [
      { key: "chunk_size", label: "Chunk size", kind: "number", min: 100, max: 8000, step: 100 },
      { key: "chunk_overlap", label: "Chunk overlap", kind: "number", min: 0, max: 2000, step: 50 },
    ],
  },
  kb_retriever: {
    type: "kb_retriever",
    category: "knowledge",
    inputs: [IN, TOOL],
    outputs: [OUT],
    label: "Retriever",
    description: "Find relevant chunks in a knowledge base. Works as a step or an agent tool.",
    icon: DatabaseZap,
    defaultData: { knowledge_base_id: null, top_k: 4 },
    fields: [{ key: "top_k", label: "Results (top k)", kind: "number", min: 1, max: 20, step: 1 }],
  },
  kb_notion: {
    type: "kb_notion",
    ...step("knowledge"),
    label: "Notion",
    description: "Load pages from Notion.",
    icon: BookOpen,
    defaultData: { page_ids: [] },
    fields: [{ key: "page_ids", label: "Page IDs", kind: "json", rows: 3, help: "JSON array of page IDs." }],
  },
  kb_gdrive: {
    type: "kb_gdrive",
    ...step("knowledge"),
    label: "Google Drive",
    description: "Load files from Google Drive.",
    icon: HardDrive,
    defaultData: { folder_id: "" },
    fields: [{ key: "folder_id", label: "Folder ID", kind: "text" }],
  },

  // ── Logic / human-in-the-loop ───────────────────────────────────────────
  logic_if: {
    type: "logic_if",
    category: "logic",
    inputs: [IN],
    outputs: [
      { id: "true", kind: "data", label: "True" },
      { id: "false", kind: "data", label: "False" },
    ],
    label: "If / Else",
    description: "Branch based on a condition.",
    icon: GitBranch,
    defaultData: { field: "{{input}}", operator: "contains", value: "" },
    fields: [
      { key: "field", label: "Value to check", kind: "text", help: TEMPLATE_HELP },
      {
        key: "operator",
        label: "Operator",
        kind: "select",
        options: [
          { value: "equals", label: "equals" },
          { value: "not_equals", label: "does not equal" },
          { value: "contains", label: "contains" },
          { value: "not_contains", label: "does not contain" },
          { value: "greater_than", label: "greater than" },
          { value: "less_than", label: "less than" },
          { value: "is_empty", label: "is empty" },
          { value: "is_not_empty", label: "is not empty" },
        ],
      },
      { key: "value", label: "Compare to", kind: "text" },
    ],
    summary: (d) => {
      const op = str(d.operator)?.replaceAll("_", " ");
      return op ? [str(d.field), op, str(d.value)].filter(Boolean).join(" ") : undefined;
    },
  },
  logic_loop: {
    type: "logic_loop",
    category: "logic",
    inputs: [IN],
    outputs: [
      { id: "loop", kind: "data", label: "Loop" },
      { id: "done", kind: "data", label: "Done" },
    ],
    label: "Loop",
    description: "Repeat a branch until a condition is met or the iteration limit is hit.",
    icon: Repeat,
    defaultData: { max_iterations: 5, until: "" },
    fields: [
      { key: "max_iterations", label: "Max iterations", kind: "number", min: 1, max: 100, step: 1 },
      {
        key: "until",
        label: "Stop when output contains",
        kind: "text",
        help: "Leave empty to always run the maximum number of iterations.",
      },
    ],
    summary: (d) => (typeof d.max_iterations === "number" ? `max ${d.max_iterations}×` : undefined),
  },
  hitl_approval: {
    type: "hitl_approval",
    category: "logic",
    inputs: [IN],
    outputs: [
      { id: "approved", kind: "data", label: "Approved" },
      { id: "rejected", kind: "data", label: "Rejected" },
    ],
    label: "Approval Gate",
    description: "Pause the flow until a person approves or rejects.",
    icon: ShieldCheck,
    defaultData: { message: "Please review", allow_edit: true },
    fields: [
      { key: "message", label: "Message to reviewer", kind: "textarea", rows: 3 },
      { key: "allow_edit", label: "Reviewer can edit the content", kind: "switch" },
    ],
  },

  // ── Actions / outputs ───────────────────────────────────────────────────
  action_email: {
    type: "action_email",
    ...action(),
    label: "Send Email",
    description: "Send an email (Resend).",
    icon: Mail,
    defaultData: { to: "", subject: "", body: "{{input}}" },
    fields: [
      { key: "to", label: "To", kind: "text", placeholder: "someone@example.com" },
      { key: "subject", label: "Subject", kind: "text" },
      { key: "body", label: "Body", kind: "textarea", rows: 5, help: TEMPLATE_HELP },
    ],
    summary: (d) => str(d.to),
  },
  action_slack: {
    type: "action_slack",
    ...action(),
    label: "Slack Message",
    description: "Post a message to a Slack channel.",
    icon: MessageSquare,
    defaultData: { channel: "", text: "{{input}}" },
    fields: [
      { key: "channel", label: "Channel", kind: "text", placeholder: "#general" },
      { key: "text", label: "Message", kind: "textarea", rows: 4, help: TEMPLATE_HELP },
    ],
    summary: (d) => str(d.channel),
  },
  action_telegram: {
    type: "action_telegram",
    ...action(),
    label: "Telegram Message",
    description: "Send a Telegram message.",
    icon: Send,
    defaultData: { chat_id: "", text: "{{input}}" },
    fields: [
      { key: "chat_id", label: "Chat ID", kind: "text" },
      { key: "text", label: "Message", kind: "textarea", rows: 4, help: TEMPLATE_HELP },
    ],
  },
  action_http_response: {
    type: "action_http_response",
    ...action(),
    label: "HTTP Response",
    description: "Reply to the webhook caller.",
    icon: Reply,
    defaultData: { status_code: 200, body: "{{input}}" },
    fields: [
      { key: "status_code", label: "Status code", kind: "number", min: 100, max: 599, step: 1 },
      { key: "body", label: "Body", kind: "textarea", rows: 4, help: TEMPLATE_HELP },
    ],
    summary: (d) => (typeof d.status_code === "number" ? String(d.status_code) : undefined),
  },
  action_db_write: {
    type: "action_db_write",
    ...action(),
    label: "Database Write",
    description: "Write a document to a Firestore collection.",
    icon: Database,
    defaultData: { collection: "", document: "{{input}}" },
    fields: [
      { key: "collection", label: "Collection", kind: "text" },
      { key: "document", label: "Document", kind: "textarea", rows: 4, help: TEMPLATE_HELP },
    ],
    summary: (d) => str(d.collection),
  },
  output_display: {
    type: "output_display",
    category: "action",
    inputs: [IN],
    outputs: [],
    label: "Output",
    description: "Show the result in the run panel.",
    icon: MonitorPlay,
    defaultData: {},
    fields: [],
  },
};

export const getNodeDefinition = (type: NodeType): NodeDefinition => NODE_REGISTRY[type];

/** Registry entries grouped by category, in palette order. */
export const NODES_BY_CATEGORY: { category: CategoryDefinition; nodes: NodeDefinition[] }[] =
  Object.values(CATEGORIES).map((category) => ({
    category,
    nodes: Object.values(NODE_REGISTRY).filter((n) => n.category === category.id),
  }));

/** Display name for a node: user label override, else the registry label. */
export const nodeDisplayName = (type: NodeType, data: NodeData): string =>
  data.label?.trim() || NODE_REGISTRY[type].label;

/** A fresh copy of a node type's default config. */
export const createDefaultData = (type: NodeType): NodeData =>
  structuredClone(NODE_REGISTRY[type].defaultData);
