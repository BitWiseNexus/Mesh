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
import { parseTemplate } from "./references";
import { findReferencedNode, upstreamNodeIds } from "./refs";

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
    case "knowledge_base":
      return typeof value === "string" ? null : "must be a knowledge base";
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
  const toolEdges = edges.filter((e) => e.type === "tool_connection");
  const dataEdges = edges.filter((e) => (e.type ?? "data") === "data");
  const attachedTools = new Set(toolEdges.map((e) => e.target));
  const inToolCycle = toolCycleNodes(toolEdges);

  for (const node of nodes) {
    const def = NODE_REGISTRY[node.type];

    if (def.deprecated) {
      issues.push({
        id: `deprecated:${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${name(node)}: ${def.deprecated}`,
      });
    } else if (def.comingSoon) {
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

    // A node used as a tool is invoked by its agent; it can't also be a step in the flow.
    if (
      attachedTools.has(node.id) &&
      dataEdges.some((e) => e.source === node.id || e.target === node.id)
    ) {
      issues.push({
        id: `tool-and-step:${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${name(node)} is attached to an agent as a tool, so it can't also be connected as a step`,
      });
    }

    if (inToolCycle.has(node.id)) {
      issues.push({
        id: `tool-cycle:${node.id}`,
        severity: "error",
        nodeId: node.id,
        message: `${name(node)} is part of a loop of tool attachments (agents can't use each other in a circle)`,
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
        continue;
      }
      if (field.templated && typeof value === "string") {
        const refProblem = referenceProblem(value, node, nodes, edges, name);
        if (refProblem) {
          issues.push({
            id: `reference:${node.id}:${field.key}`,
            severity: "error",
            nodeId: node.id,
            field: field.key,
            message: `${name(node)}: ${field.label} ${refProblem}`,
          });
        } else if (ambiguousInput(value, node, nodes, dataEdges)) {
          issues.push({
            id: `ambiguous-input:${node.id}:${field.key}`,
            severity: "warning",
            nodeId: node.id,
            field: field.key,
            message: `${name(node)}: ${field.label} uses {{input}}, but several nodes feed into it, so {{input}} holds all their outputs — pick one with Insert`,
          });
        }
      }
    }
  }

  // Errors first, otherwise keep canvas order.
  return issues.sort((a, b) => Number(a.severity === "warning") - Number(b.severity === "warning"));
}

/**
 * The first problem with the {{references}} in a templated value, or null. A reference must be
 * well-formed and point at a node whose output exists by the time this node runs.
 */
function referenceProblem(
  value: string,
  node: CanvasNode,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  name: (n: CanvasNode) => string,
): string | null {
  let upstream: Set<string> | null = null; // computed lazily: most fields have no references
  for (const part of parseTemplate(value)) {
    if (part.kind === "invalid") return `has an invalid reference ${part.raw}`;
    if (part.kind !== "ref") continue;
    const token = `{{${part.node}.output}}`;
    const target = findReferencedNode(part.node, nodes);
    if (!target) return `refers to ${token}, but no node is called “${part.node}”`;
    if (target.id === node.id) return `refers to this node's own output (${token})`;
    upstream ??= new Set(upstreamNodeIds(node.id, edges));
    if (!upstream.has(target.id)) {
      return `refers to ${name(target)}, which doesn't run before this node`;
    }
  }
  return null;
}

/**
 * With several incoming connections, `{{input}}` is an object keyed by each sender's ref. A bare
 * `{{input}}` (or `{{input.x}}` where x isn't a sender) is then almost certainly not what was meant.
 */
function ambiguousInput(
  value: string,
  node: CanvasNode,
  nodes: CanvasNode[],
  dataEdges: CanvasEdge[],
): boolean {
  const senders = new Set(dataEdges.filter((e) => e.target === node.id).map((e) => e.source));
  if (senders.size < 2) return false;
  const senderRefs = new Set(nodes.filter((n) => senders.has(n.id)).map((n) => n.ref ?? n.id));
  return parseTemplate(value).some(
    (p) => p.kind === "input" && (p.path.length === 0 || !senderRefs.has(p.path[0])),
  );
}

/** Ids of nodes on a cycle of tool attachments (A uses B as a tool, B uses A, …). */
function toolCycleNodes(toolEdges: CanvasEdge[]): Set<string> {
  const inCycle = new Set<string>();
  for (const start of new Set(toolEdges.map((e) => e.source))) {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      for (const e of toolEdges) {
        if (e.source !== current) continue;
        if (e.target === start) inCycle.add(start);
        if (!seen.has(e.target)) {
          seen.add(e.target);
          queue.push(e.target);
        }
      }
    }
  }
  return inCycle;
}

/** Groups issues by node id. */
export function issuesByNode(issues: FlowIssue[]): Record<string, FlowIssue[]> {
  const map: Record<string, FlowIssue[]> = {};
  for (const issue of issues) {
    if (issue.nodeId) (map[issue.nodeId] ??= []).push(issue);
  }
  return map;
}
