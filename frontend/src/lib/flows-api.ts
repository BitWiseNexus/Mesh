/** Typed wrappers for the backend `/flows` API (see backend/app/api/flows.py). */
import type { ApiClient } from "@/lib/api";
import type { Flow } from "@/types/flow";

export interface FlowSummary {
  flow_id: string;
  name: string;
  description: string;
  node_count: number;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface StoredFlow extends Flow {
  flow_id: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export type FlowContent = Omit<Flow, "flow_id">;

export function flowsApi(api: ApiClient) {
  const path = (id: string) => `/flows/${encodeURIComponent(id)}`;
  return {
    list: () => api.get<FlowSummary[]>("/flows"),
    get: (id: string) => api.get<StoredFlow>(path(id)),
    create: (flow: FlowContent) => api.post<StoredFlow>("/flows", flow),
    /** Full save. With `expectedVersion`, a newer save elsewhere → ApiError 409 `version_conflict`. */
    replace: (id: string, flow: FlowContent, expectedVersion?: number) =>
      api.put<StoredFlow>(path(id), { ...flow, expected_version: expectedVersion ?? null }),
    updateMeta: (id: string, meta: { name?: string; description?: string }) =>
      api.patch<StoredFlow>(path(id), meta),
    remove: (id: string) => api.delete(path(id)),
    duplicate: (id: string) => api.post<StoredFlow>(`${path(id)}/duplicate`),
  };
}

export const flowKeys = {
  all: ["flows"] as const,
  list: () => [...flowKeys.all, "list"] as const,
  detail: (id: string) => [...flowKeys.all, "detail", id] as const,
};

/** Strips server-only fields so a flow can be sent back as content. */
export function toFlowContent(flow: Flow): FlowContent {
  return {
    schema_version: flow.schema_version,
    name: flow.name,
    description: flow.description,
    nodes: flow.nodes,
    edges: flow.edges,
  };
}
