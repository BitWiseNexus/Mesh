/** Knowledge bases (backend/app/api/knowledge.py): typed endpoints and TanStack Query hooks. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/components/auth/auth-provider";
import type { ApiClient } from "@/lib/api";
import type { KnowledgeBase, KnowledgeBaseSettings, KnowledgeDocument } from "@/types/knowledge";

export function knowledgeApi(api: ApiClient) {
  const path = (id: string) => `/knowledge-bases/${encodeURIComponent(id)}`;
  return {
    list: () => api.get<KnowledgeBase[]>("/knowledge-bases"),
    create: (body: Partial<KnowledgeBaseSettings> & { name: string }) =>
      api.post<KnowledgeBase>("/knowledge-bases", body),
    update: (id: string, body: Partial<KnowledgeBaseSettings>) =>
      api.patch<KnowledgeBase>(path(id), body),
    remove: (id: string) => api.delete(path(id)),
    get: (id: string) => api.get<KnowledgeBase>(path(id)),
    documents: (id: string) => api.get<KnowledgeDocument[]>(`${path(id)}/documents`),
    upload: (id: string, file: File) => {
      const body = new FormData();
      body.append("file", file);
      return api.request<KnowledgeDocument>(`${path(id)}/documents`, { method: "POST", body });
    },
    removeDocument: (id: string, documentId: string) =>
      api.delete(`${path(id)}/documents/${encodeURIComponent(documentId)}`),
    retryDocument: (id: string, documentId: string) =>
      api.post<KnowledgeDocument>(`${path(id)}/documents/${encodeURIComponent(documentId)}/retry`),
  };
}

export const knowledgeKeys = {
  list: ["knowledge-bases"] as const,
  detail: (id: string) => ["knowledge-bases", id] as const,
  documents: (id: string) => ["knowledge-bases", id, "documents"] as const,
};

/** Documents still on their way to being searchable. */
const inProgress = (documents: KnowledgeDocument[] | undefined) =>
  !!documents?.some((d) => d.status === "pending" || d.status === "processing");

function useKnowledgeApi() {
  const api = useApi();
  return useMemo(() => knowledgeApi(api), [api]);
}

export function useKnowledgeBases() {
  const knowledge = useKnowledgeApi();
  return useQuery({ queryKey: knowledgeKeys.list, queryFn: knowledge.list });
}

/** Caches a created/changed knowledge base, first in the list (most recently changed). */
function useRemember() {
  const queryClient = useQueryClient();
  return (saved: KnowledgeBase) => {
    queryClient.setQueryData(knowledgeKeys.detail(saved.knowledge_base_id), saved);
    queryClient.setQueryData<KnowledgeBase[]>(knowledgeKeys.list, (list) =>
      list && [saved, ...list.filter((kb) => kb.knowledge_base_id !== saved.knowledge_base_id)],
    );
  };
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

export function useKnowledgeBase(id: string) {
  const knowledge = useKnowledgeApi();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: knowledgeKeys.detail(id),
    queryFn: () => knowledge.get(id),
    // Shown straight away when coming from the list.
    initialData: () =>
      queryClient
        .getQueryData<KnowledgeBase[]>(knowledgeKeys.list)
        ?.find((kb) => kb.knowledge_base_id === id),
  });
}

/** A knowledge base's documents; refreshed every few seconds while some are being processed. */
export function useDocuments(id: string) {
  const knowledge = useKnowledgeApi();
  return useQuery({
    queryKey: knowledgeKeys.documents(id),
    queryFn: () => knowledge.documents(id),
    refetchInterval: (query) => (inProgress(query.state.data) ? 3000 : false),
  });
}

/** After documents change, the knowledge base's count (and "edited") changes too. */
function useRefreshKnowledgeBase(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.detail(id), exact: true });
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.list, exact: true });
  };
}

export function useUploadDocument(id: string) {
  const knowledge = useKnowledgeApi();
  const queryClient = useQueryClient();
  const refresh = useRefreshKnowledgeBase(id);
  return useMutation({
    mutationFn: (file: File) => knowledge.upload(id, file),
    onSuccess: (document) => {
      queryClient.setQueryData<KnowledgeDocument[]>(knowledgeKeys.documents(id), (list) =>
        list ? [document, ...list] : [document],
      );
      refresh();
    },
  });
}

export function useDeleteDocument(id: string) {
  const knowledge = useKnowledgeApi();
  const queryClient = useQueryClient();
  const refresh = useRefreshKnowledgeBase(id);
  return useMutation({
    mutationFn: (documentId: string) => knowledge.removeDocument(id, documentId),
    onSuccess: (_, documentId) => {
      queryClient.setQueryData<KnowledgeDocument[]>(knowledgeKeys.documents(id), (list) =>
        list?.filter((d) => d.document_id !== documentId),
      );
      refresh();
    },
  });
}

/** Processes a (failed) document again. */
export function useRetryDocument(id: string) {
  const knowledge = useKnowledgeApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => knowledge.retryDocument(id, documentId),
    onSuccess: (document) =>
      queryClient.setQueryData<KnowledgeDocument[]>(knowledgeKeys.documents(id), (list) =>
        list?.map((d) => (d.document_id === document.document_id ? document : d)),
      ),
  });
}
