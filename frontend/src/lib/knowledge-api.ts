/** Knowledge bases (backend/app/api/knowledge.py): typed endpoints and TanStack Query hooks. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/components/auth/auth-provider";
import type { ApiClient } from "@/lib/api";
import type { KnowledgeBase, KnowledgeBaseSettings } from "@/types/knowledge";

export function knowledgeApi(api: ApiClient) {
  const path = (id: string) => `/knowledge-bases/${encodeURIComponent(id)}`;
  return {
    list: () => api.get<KnowledgeBase[]>("/knowledge-bases"),
    create: (body: Partial<KnowledgeBaseSettings> & { name: string }) =>
      api.post<KnowledgeBase>("/knowledge-bases", body),
    update: (id: string, body: Partial<KnowledgeBaseSettings>) =>
      api.patch<KnowledgeBase>(path(id), body),
    remove: (id: string) => api.delete(path(id)),
  };
}

export const knowledgeKeys = { list: ["knowledge-bases"] as const };

function useKnowledgeApi() {
  const api = useApi();
  return useMemo(() => knowledgeApi(api), [api]);
}

export function useKnowledgeBases() {
  const knowledge = useKnowledgeApi();
  return useQuery({ queryKey: knowledgeKeys.list, queryFn: knowledge.list });
}

/** Puts a created/changed knowledge base first in the cached list (most recently changed). */
function useRemember() {
  const queryClient = useQueryClient();
  return (saved: KnowledgeBase) =>
    queryClient.setQueryData<KnowledgeBase[]>(knowledgeKeys.list, (list) =>
      list && [saved, ...list.filter((kb) => kb.knowledge_base_id !== saved.knowledge_base_id)],
    );
}

export function useCreateKnowledgeBase() {
  const knowledge = useKnowledgeApi();
  const remember = useRemember();
  return useMutation({ mutationFn: knowledge.create, onSuccess: remember });
}

export function useUpdateKnowledgeBase() {
  const knowledge = useKnowledgeApi();
  const remember = useRemember();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<KnowledgeBaseSettings> & { id: string }) =>
      knowledge.update(id, body),
    onSuccess: remember,
  });
}

export function useDeleteKnowledgeBase() {
  const knowledge = useKnowledgeApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: knowledge.remove,
    onSuccess: (_, id) =>
      queryClient.setQueryData<KnowledgeBase[]>(knowledgeKeys.list, (list) =>
        list?.filter((kb) => kb.knowledge_base_id !== id),
      ),
  });
}
