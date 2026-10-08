/**
 * Flow graph wire format — mirrors backend/app/schemas/flow.py and node_types.py.
 * Node type strings must match the backend `NodeType` enum exactly
 * (enforced by backend/tests/test_frontend_sync.py).
 */

export const NODE_CATEGORIES = ["trigger", "agent", "tool", "knowledge", "logic", "action"] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export const NODE_TYPES = [
  // Triggers
  "trigger_manual",
  "trigger_webhook",
  "trigger_cron",
  "trigger_email",
  // Agents
  "agent_node",
  "agent_supervisor",
  // Tools
  "tool_web_search",
  "tool_web_scraper",
  "tool_python",
  "tool_http",
  // Knowledge / RAG
  "kb_upload",
  "kb_retriever",
  "kb_notion",
  "kb_gdrive",
  // Logic / human-in-the-loop
  "logic_if",
  "logic_loop",
  "hitl_approval",
  // Actions / outputs
  "action_email",
  "action_slack",
  "action_telegram",
  "action_http_response",
  "action_db_write",
  "output_display",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = ["data", "tool_connection"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Free-form per-node config. `label` overrides the node's display name. */
export type NodeData = { label?: string } & Record<string, unknown>;

export interface FlowNode {
  id: string;
  type: NodeType;
  /** Readable unique name for template references, e.g. `agent` in `{{agent.output}}`. */
  ref?: string;
  data: NodeData;
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  animated?: boolean;
}

export interface Flow {
  schema_version: number;
  flow_id: string | null;
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
