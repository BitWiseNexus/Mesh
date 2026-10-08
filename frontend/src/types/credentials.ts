/**
 * Saved API keys — mirrors backend/app/schemas/credentials.py. CREDENTIAL_PROVIDERS must match
 * the backend's `CredentialProvider` (enforced by backend/tests/test_frontend_sync.py).
 */

export const CREDENTIAL_PROVIDERS = ["openai", "anthropic", "gemini", "tavily", "http"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

export const PROVIDER_INFO: Record<
  CredentialProvider,
  { label: string; placeholder: string; usedBy: string }
> = {
  openai: { label: "OpenAI", placeholder: "sk-…", usedBy: "Agents on OpenAI models (gpt-…, o3…)" },
  anthropic: { label: "Anthropic", placeholder: "sk-ant-…", usedBy: "Agents on Claude models" },
  gemini: { label: "Google Gemini", placeholder: "AIza…", usedBy: "Agents on Gemini models" },
  tavily: { label: "Tavily", placeholder: "tvly-…", usedBy: "Web Search (Tavily)" },
  http: { label: "HTTP API", placeholder: "Token or API key", usedBy: "API Caller nodes you pick it in" },
};

export interface CredentialInfo {
  credential_id: string;
  provider: CredentialProvider;
  name: string;
  /** The key's last characters, e.g. "…3f9a" — the value itself is never sent back. */
  hint: string;
  created_at: string;
  updated_at: string;
}
