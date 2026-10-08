export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** An error response from the Mesh API. `code` comes from the backend's `detail.code`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra fields of the backend's `detail` (e.g. `issues` of a refused run). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = `Request failed (${response.status})`;
  let details: Record<string, unknown> = {};
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const { code: detailCode, message: detailMessage, ...rest } = detail;
      code = detailCode ?? code;
      message = detailMessage ?? message;
      details = rest;
    } else if (typeof detail === "string") {
      message = detail;
    }
  } catch {
    // non-JSON error body — keep the generic message
  }
  return new ApiError(response.status, code, message, details);
}

async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Unauthenticated request (e.g. health checks). */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return parse<T>(await fetch(`${API_URL}${path}`, init));
}

export type GetIdToken = (forceRefresh?: boolean) => Promise<string | null>;

export interface ApiClient {
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** The raw response of a successful request (e.g. to read a stream); errors still throw. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  put: <T>(path: string, body?: unknown) => Promise<T>;
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  delete: <T = void>(path: string) => Promise<T>;
}

/** Codes after which a freshly minted ID token may succeed. */
const RETRYABLE_AUTH_CODES = new Set(["token_expired", "invalid_token"]);

/**
 * API client that sends the signed-in user's Firebase ID token. If the backend rejects the token
 * as expired/invalid (e.g. clock skew right at expiry), it forces a token refresh and retries once.
 */
export function createApiClient(getIdToken: GetIdToken, fetchImpl: typeof fetch = fetch): ApiClient {
  const send = async (path: string, init: RequestInit, forceRefresh: boolean) => {
    const token = await getIdToken(forceRefresh);
    if (!token) throw new ApiError(401, "missing_token", "Sign in to continue.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetchImpl(`${API_URL}${path}`, { ...init, headers });
  };

  /** Sends with the current token; on an expired/invalid one, refreshes it and retries once. */
  const sendWithRetry = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await send(path, init, false);
    if (response.status !== 401) return response;
    const error = await toApiError(response);
    if (!RETRYABLE_AUTH_CODES.has(error.code)) throw error;
    return send(path, init, true);
  };

  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> =>
    parse<T>(await sendWithRetry(path, init));

  const fetchRaw = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await sendWithRetry(path, init);
    if (!response.ok) throw await toApiError(response);
    return response;
  };

  const withBody = (method: string) => <T>(path: string, body?: unknown) =>
    request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    request,
    fetch: fetchRaw,
    get: (path) => request(path),
    post: withBody("POST"),
    put: withBody("PUT"),
    patch: withBody("PATCH"),
    delete: (path) => request(path, { method: "DELETE" }),
  };
}
