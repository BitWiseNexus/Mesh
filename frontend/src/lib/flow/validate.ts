/**
 * Live flow validation shown while editing. Pure and cheap (O(nodes + edges)), so it can run on
 * every graph change. The backend graph compiler (step 3.1) must enforce the same `error` rules.
 *
 * - error   → the flow can't run (Run is blocked)
 * - warning → the flow runs, but part of it will never execute or is likely a mistake
 */
import { NODE_REGISTRY, nodeDisplayName, type FieldDef } from "@/lib/nodes/registry";
import type { NodeData } from "@/types/flow";

import type { CanvasEdge, CanvasNode } from "./graph";

export type IssueSeverity = "error" | "warning";

export interface FlowIssue {
  /** Stable id, e.g. `unreachable:node_1a2b3c4d`. */
  id: string;
  severity: IssueSeverity;
  message: string;
  nodeId?: string;
  /** Config field the issue refers to (highlighted in the config panel). */
  field?: string;
  /** A one-click fix the UI can offer. */
  fix?: "add_trigger";
}

const isEmpty = (value: unknown): boolean =>
  value == null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

export const isMissingRequired = (field: FieldDef, data: NodeData): boolean =>
  field.required === true && isEmpty(data[field.key]);

/** Problem with a non-empty field value (type, range, allowed options), or null. */
export function fieldValueProblem(field: FieldDef, value: unknown): string | null {
  if (isEmpty(value)) return null; // emptiness is handled by `required`
  switch (field.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      const { min, max } = field;
      if (min != null && max != null && (value < min || value > max)) {
        return `must be between ${min} and ${max}`;
      }
      if (min != null && value < min) return `must be at least ${min}`;
      if (max != null && value > max) return `must be at most ${max}`;
      return null;
    }
    case "json":
      if (field.shape === "object" && (typeof value !== "object" || Array.isArray(value))) {
        return "must be a JSON object";
      }
      if (field.shape === "array" && !Array.isArray(value)) return "must be a JSON array";
      return null;
    case "select":
      return field.options.some((o) => o.value === value) ? null : "has an unsupported value";
    case "switch":
      return typeof value === "boolean" ? null : "must be on or off";
    default:
      return typeof value === "string" ? null : "must be text";
  }
}

export function validateFlow(nodes: CanvasNode[], edges: CanvasEdge[]): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const name = (n: CanvasNode) => `“${nodeDisplayName(n.type, n.data)}”`;
  const triggers = nodes.filter((n) => NODE_REGISTRY[n.type].category === "trigger");

  if (triggers.length === 0) {
    issues.push({
      id: "no-trigger",
      severity: "error",
      message: "Add a trigger so the flow has a starting point",
      fix: "add_trigger",
    });
  }

  // Reachable = on an execution path from a trigger, or attached as a tool to such a node.
  const reachable = new Set(triggers.map((n) => n.id));
  const queue = [...reachable];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of edges) {
      if (e.source === current && !reachable.has(e.target)) {
        reachable.add(e.target);
        queue.push(e.target);
      }
    }
  }
  const attachedTools = new Set(
    edges.filter((e) => e.type === "tool_connection").map((e) => e.target),
  );

  for (const node of nodes) {
    const def = NODE_REGISTRY[node.type];

    if (def.comingSoon) {
      issues.push({
        id: `unavailable:${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${name(node)}: ${def.label} nodes aren't available yet`,
      });
    }

    if (def.category === "tool" && !attachedTools.has(node.id)) {
      issues.push({
        id: `unattached:${node.id}`,
        severity: "warning",
        nodeId: node.id,
        message: `${name(node)} isn't attached to an agent's Tools handle`,
      });
    } else if (triggers.length > 0 && !reachable.has(node.id)) {
      issues.push({
        id: `unreachable:${node.id}`,
        severity: "warning",
        nodeId: node.id,
        message: `${name(node)} isn't connected to a trigger and will never run`,
      });
    }

    if (
      node.type === "logic_loop" &&
      !edges.some((e) => e.source === node.id && e.sourceHandle === "loop")
    ) {
      issues.push({
        id: `empty-loop:${node.id}`,
        severity: "warning",
        nodeId: node.id,
        message: `${name(node)} has nothing connected to its Loop output`,
      });
    }

    for (const field of def.fields) {
      const value = node.data[field.key];
      if (isMissingRequired(field, node.data)) {
        issues.push({
          id: `required:${node.id}:${field.key}`,
          severity: "error",
          nodeId: node.id,
          field: field.key,
          message: `${name(node)}: ${field.label} is required`,
        });
        continue;
      }
      const problem = fieldValueProblem(field, value);
      if (problem) {
        issues.push({
          id: `invalid:${node.id}:${field.key}`,
          severity: "error",
          nodeId: node.id,
          field: field.key,
          message: `${name(node)}: ${field.label} ${problem}`,
        });
      }
    }
  }

  // Errors first, otherwise keep canvas order.
  return issues.sort((a, b) => Number(a.severity === "warning") - Number(b.severity === "warning"));
}

/** Groups issues by node id. */
export function issuesByNode(issues: FlowIssue[]): Record<string, FlowIssue[]> {
  const map: Record<string, FlowIssue[]> = {};
  for (const issue of issues) {
    if (issue.nodeId) (map[issue.nodeId] ??= []).push(issue);
  }
  return map;
}
