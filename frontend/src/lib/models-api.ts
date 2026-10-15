/** The models agents can use (backend/app/api/models.py): which providers have a key, defaults. */
"use client";

import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/components/auth/auth-provider";

export interface ProviderModels {
  /** `openai` | `anthropic` | `gemini` | `mock`. */
  id: string;
  name: string;
  /** Where the key comes from: the user's saved keys, the server, nowhere — or not needed. */
  key: "saved" | "server" | "none" | "not_needed";
  /** Bare model-name prefixes that select this provider (`claude-`, `gpt-`, …). */
  prefixes: string[];
  /** Recommended first, then the rest. */
  models: string[];
  recommended: string[];
}

export interface ModelList {
  providers: ProviderModels[];
  /** What new agents get (a provider the user has a key for, else the mock model in dev). */
  default: string;
}

export const modelKeys = { list: ["models"] as const };

export function useModels() {
  const api = useApi();
  return useQuery({
    queryKey: modelKeys.list,
    queryFn: () => api.get<ModelList>("/models"),
    staleTime: 5 * 60_000,
  });
}

/** The provider a model name belongs to: by `provider/…` or a bare-name prefix (`claude-…`). */
export function providerOfModel(
  model: string,
  providers: ProviderModels[],
): ProviderModels | undefined {
  const name = model.trim();
  const slash = name.indexOf("/");
  if (slash > 0) return providers.find((p) => p.id === name.slice(0, slash));
  return providers.find((p) => p.prefixes.some((prefix) => name.startsWith(prefix)));
}

/** Groups for the model picker: providers that can be used (have a key or need none), filtered. */
export function modelGroups(providers: ProviderModels[], query = "") {
  const q = query.trim().toLowerCase();
  return providers
    .filter((p) => p.key !== "none")
    .map((p) => ({ value: p.name, provider: p, items: p.models.filter((m) => m.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0);
}
