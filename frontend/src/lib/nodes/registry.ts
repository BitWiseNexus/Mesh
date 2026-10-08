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

import { NODE_TYPES, type NodeCategory, type NodeData, type NodeType } from "@/types/flow";

import catalog from "./catalog.json";

/**
 * Node types come from the backend's node catalog (backend/app/nodes/catalog.py, the single source
 * of truth for labels, handles, fields, defaults and availability), via the generated
 * `catalog.json`. This module only adds presentation: icons and card summaries.
 *
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
  /** Empty values are reported by flow validation and block running the flow. */
  required?: boolean;
  /** Accepts {{references}} to other nodes' outputs: gets the reference picker + validation. */
  templated?: boolean;
} & (
  | { kind: "text"; suggestions?: string[] }
  | { kind: "textarea"; rows?: number }
  | { kind: "code"; language: string; rows?: number }
  | { kind: "number"; min?: number; max?: number; step?: number }
  | { kind: "select"; options: { value: string; label: string }[] }
  | { kind: "switch" }
  | { kind: "json"; rows?: number; shape?: "object" | "array" }
  /** The id of one of the user's knowledge bases. */
  | { kind: "knowledge_base" }
  /** The id of one of the user's saved API keys for one of `providers`; empty = automatic. */
  | { kind: "credential"; providers: string[] }
);

export interface NodeDefinition {
  type: NodeType;
  category: NodeCategory;
  label: string;
  description: string;
  /** Base of new nodes' reference names (`agent`, then `agent_2`, …). */
  refPrefix: string;
  /** What `{{ref.output}}` holds once the node has run (the engine's output contract). */
  outputHint: string;
  icon: LucideIcon;
  /** Target handles (left/top of the node). */
  inputs: HandleDef[];
  /** Source handles (right/bottom of the node). */
  outputs: HandleDef[];
  defaultData: NodeData;
  fields: FieldDef[];
  /**
   * Not executable yet (lands after the first runnable release, Phases 3–6). Shown in the palette
   * with a "Soon" badge and can't be added; existing instances are flagged by flow validation.
   * Remove the flag when the node's executor ships.
   */
  comingSoon?: boolean;
  /**
   * Retired type: hidden from the palette but still loads and renders; flow validation reports
   * this message (what replaced it).
   */
  deprecated?: string;
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

/** A node type as described by the generated catalog (everything except presentation). */
export type CatalogNode = Omit<NodeDefinition, "icon" | "summary">;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Presentation only. Everything else about a node type lives in the backend catalog. */
const PRESENTATION: Record<
  NodeType,
  { icon: LucideIcon; summary?: (data: NodeData) => string | undefined }
> = {
  trigger_manual: { icon: Play },
  trigger_webhook: { icon: Webhook, summary: (d) => str(d.method) },
  trigger_cron: { icon: Clock, summary: (d) => str(d.cron) },
  trigger_email: { icon: MailOpen },
  agent_node: { icon: Bot, summary: (d) => str(d.model) },
  agent_supervisor: { icon: Network, summary: (d) => str(d.model) },
  tool_web_search: { icon: Search, summary: (d) => str(d.provider) },
  tool_web_scraper: { icon: Globe },
  tool_python: { icon: Code },
  tool_http: {
    icon: Plug,
    summary: (d) => [str(d.method), str(d.url)].filter(Boolean).join(" ") || undefined,
  },
  kb_upload: { icon: FileUp },
  kb_retriever: { icon: DatabaseZap },
  kb_notion: { icon: BookOpen },
  kb_gdrive: { icon: HardDrive },
  logic_if: {
    icon: GitBranch,
    summary: (d) => {
      const op = str(d.operator)?.replaceAll("_", " ");
      return op ? [str(d.field), op, str(d.value)].filter(Boolean).join(" ") : undefined;
    },
  },
  logic_loop: {
    icon: Repeat,
    summary: (d) => (typeof d.max_iterations === "number" ? `max ${d.max_iterations}×` : undefined),
  },
  hitl_approval: { icon: ShieldCheck },
  action_email: { icon: Mail, summary: (d) => str(d.to) },
  action_slack: { icon: MessageSquare, summary: (d) => str(d.channel) },
  action_telegram: { icon: Send },
  action_http_response: {
    icon: Reply,
    summary: (d) => (typeof d.status_code === "number" ? String(d.status_code) : undefined),
  },
  action_db_write: { icon: Database, summary: (d) => str(d.collection) },
  output_display: { icon: MonitorPlay },
};

const CATALOG_NODES = catalog.nodes as unknown as CatalogNode[];

function buildRegistry(): Record<NodeType, NodeDefinition> {
  const byType = new Map(CATALOG_NODES.map((n) => [n.type, n]));
  const unknown = CATALOG_NODES.map((n) => n.type).filter((t) => !NODE_TYPES.includes(t));
  const missing = NODE_TYPES.filter((t) => !byType.has(t));
  if (unknown.length || missing.length) {
    // The frontend's NODE_TYPES and the generated catalog disagree: regenerate catalog.json and/or
    // update types/flow.ts. Failing loudly beats rendering a half-broken palette.
    throw new Error(`Node catalog mismatch — unknown: [${unknown}], missing: [${missing}]`);
  }
  return Object.fromEntries(
    CATALOG_NODES.map((n) => [n.type, { ...n, ...PRESENTATION[n.type] }]),
  ) as Record<NodeType, NodeDefinition>;
}

export const NODE_REGISTRY: Record<NodeType, NodeDefinition> = buildRegistry();

export const getNodeDefinition = (type: NodeType): NodeDefinition => NODE_REGISTRY[type];

/** Palette entries grouped by category, in palette order (retired types are left out). */
export const NODES_BY_CATEGORY: { category: CategoryDefinition; nodes: NodeDefinition[] }[] =
  Object.values(CATEGORIES).map((category) => ({
    category,
    nodes: Object.values(NODE_REGISTRY).filter(
      (n) => n.category === category.id && !n.deprecated,
    ),
  }));

/** Display name for a node: user label override, else the registry label. */
export const nodeDisplayName = (type: NodeType, data: NodeData): string =>
  data.label?.trim() || NODE_REGISTRY[type].label;

/** A fresh copy of a node type's default config. */
export const createDefaultData = (type: NodeType): NodeData =>
  structuredClone(NODE_REGISTRY[type].defaultData);

export type NodeRole = "start" | "end" | "step";

/** Triggers start a flow; nodes with an input but no outputs (Output) end it. */
export const nodeRole = (type: NodeType): NodeRole => {
  const def = NODE_REGISTRY[type];
  if (def.category === "trigger") return "start";
  if (def.outputs.length === 0 && def.inputs.some((h) => h.kind === "data")) return "end";
  return "step";
};
