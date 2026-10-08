"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/components/auth/auth-provider";
import {
  flowKeys,
  flowsApi,
  type FlowContent,
  type FlowSummary,
  type StoredFlow,
} from "@/lib/flows-api";

function useFlowsApi() {
  const api = useApi();
  return useMemo(() => flowsApi(api), [api]);
}

const summaryOf = (flow: StoredFlow): FlowSummary => ({
  flow_id: flow.flow_id,
  name: flow.name,
  description: flow.description,
  node_count: flow.nodes.length,
  created_at: flow.created_at,
  updated_at: flow.updated_at,
  version: flow.version,
});

/** Puts a saved flow into the detail cache and upserts it at the top of the list cache. */
function useRememberFlow() {
  const queryClient = useQueryClient();
  return (flow: StoredFlow) => {
    queryClient.setQueryData(flowKeys.detail(flow.flow_id), flow);
    queryClient.setQueryData<FlowSummary[]>(flowKeys.list(), (list) =>
      list
        ? [summaryOf(flow), ...list.filter((f) => f.flow_id !== flow.flow_id)]
        : list,
    );
  };
}

export function useFlowList() {
  const flows = useFlowsApi();
  return useQuery({ queryKey: flowKeys.list(), queryFn: flows.list });
}

export function useFlow(id: string) {
  const flows = useFlowsApi();
  return useQuery({
    queryKey: flowKeys.detail(id),
    queryFn: () => flows.get(id),
    // The editor owns the flow once it's open; refetching would race with local edits.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function useCreateFlow() {
  const flows = useFlowsApi();
  const remember = useRememberFlow();
  return useMutation({
    mutationFn: (content: FlowContent) => flows.create(content),
    onSuccess: remember,
  });
}

export function useDuplicateFlow() {
  const flows = useFlowsApi();
  const remember = useRememberFlow();
  return useMutation({ mutationFn: (id: string) => flows.duplicate(id), onSuccess: remember });
}

export function useSaveFlow() {
  const flows = useFlowsApi();
  const remember = useRememberFlow();
  return useMutation({
    mutationFn: ({ id, content, expectedVersion }: {
      id: string;
      content: FlowContent;
      expectedVersion?: number;
    }) => flows.replace(id, content, expectedVersion),
    onSuccess: remember,
  });
}

export function useRenameFlow() {
  const flows = useFlowsApi();
  const remember = useRememberFlow();
  return useMutation({
    mutationFn: ({ id, name, description }: { id: string; name: string; description: string }) =>
      flows.updateMeta(id, { name, description }),
    onSuccess: remember,
  });
}

/** Deletes optimistically: the card disappears immediately and comes back if the call fails. */
export function useDeleteFlow() {
  const flows = useFlowsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => flows.remove(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: flowKeys.list() });
      const previous = queryClient.getQueryData<FlowSummary[]>(flowKeys.list());
      queryClient.setQueryData<FlowSummary[]>(flowKeys.list(), (list) =>
        list?.filter((f) => f.flow_id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) queryClient.setQueryData(flowKeys.list(), context.previous);
    },
    onSuccess: (_data, id) => queryClient.removeQueries({ queryKey: flowKeys.detail(id) }),
  });
}

/** Fetches the latest saved version of a flow, bypassing (and refreshing) the cache. */
export function useFetchLatestFlow() {
  const flows = useFlowsApi();
  const queryClient = useQueryClient();
  return (id: string) =>
    queryClient.fetchQuery({
      queryKey: flowKeys.detail(id),
      queryFn: () => flows.get(id),
      staleTime: 0,
    });
}
