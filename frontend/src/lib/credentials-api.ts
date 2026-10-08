/** Saved API keys (backend/app/api/credentials.py): typed endpoints and TanStack Query hooks. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/components/auth/auth-provider";
import type { ApiClient } from "@/lib/api";
import type { CredentialInfo, CredentialProvider } from "@/types/credentials";

export function credentialsApi(api: ApiClient) {
  const path = (id: string) => `/credentials/${encodeURIComponent(id)}`;
  return {
    list: () => api.get<CredentialInfo[]>("/credentials"),
    create: (body: { provider: CredentialProvider; name: string; value: string }) =>
      api.post<CredentialInfo>("/credentials", body),
    update: (id: string, body: { name?: string; value?: string }) =>
      api.patch<CredentialInfo>(path(id), body),
    remove: (id: string) => api.delete(path(id)),
  };
}

export const credentialKeys = { list: ["credentials"] as const };

function useCredentialsApi() {
  const api = useApi();
  return useMemo(() => credentialsApi(api), [api]);
}

export function useCredentials() {
  const credentials = useCredentialsApi();
  return useQuery({ queryKey: credentialKeys.list, queryFn: credentials.list });
}

/** Writes a created/updated key into the cached list (newest first). */
function useRemember() {
  const queryClient = useQueryClient();
  return (saved: CredentialInfo) =>
    queryClient.setQueryData<CredentialInfo[]>(credentialKeys.list, (list) => {
      if (!list) return list;
      const exists = list.some((c) => c.credential_id === saved.credential_id);
      return exists
        ? list.map((c) => (c.credential_id === saved.credential_id ? saved : c))
        : [saved, ...list];
    });
}

export function useCreateCredential() {
  const credentials = useCredentialsApi();
  const remember = useRemember();
  return useMutation({ mutationFn: credentials.create, onSuccess: remember });
}

export function useUpdateCredential() {
  const credentials = useCredentialsApi();
  const remember = useRemember();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; value?: string }) =>
      credentials.update(id, body),
    onSuccess: remember,
  });
}

export function useDeleteCredential() {
  const credentials = useCredentialsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: credentials.remove,
    onSuccess: (_, id) =>
      queryClient.setQueryData<CredentialInfo[]>(credentialKeys.list, (list) =>
        list?.filter((c) => c.credential_id !== id),
      ),
  });
}
