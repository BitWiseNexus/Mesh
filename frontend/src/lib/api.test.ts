import { describe, expect, it, vi } from "vitest";

import { API_URL, ApiError, createApiClient } from "./api";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(responses: Response[], tokens: Array<string | null> = ["t1", "t2"]) {
  const fetchMock = vi.fn(async () => responses.shift()!);
  const getIdToken = vi.fn(async (force?: boolean) => (force ? tokens[1] : tokens[0]));
  const api = createApiClient(getIdToken, fetchMock as unknown as typeof fetch);
  const authHeader = (call: number) =>
    new Headers((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].headers).get(
      "Authorization",
    );
  return { api, fetchMock, getIdToken, authHeader };
}

describe("createApiClient", () => {
  it("sends the ID token and parses JSON", async () => {
    const { api, fetchMock, authHeader } = setup([json(200, { uid: "u1" })]);
    await expect(api.get("/me")).resolves.toEqual({ uid: "u1" });
    expect(fetchMock).toHaveBeenCalledWith(`${API_URL}/me`, expect.any(Object));
    expect(authHeader(0)).toBe("Bearer t1");
  });

  it("serialises bodies as JSON", async () => {
    const { api, fetchMock } = setup([json(201, { id: "f1" })]);
    await api.post("/flows", { name: "x" });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"x"}');
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("refreshes the token and retries once on an expired session", async () => {
    const { api, getIdToken, authHeader } = setup([
      json(401, { detail: { code: "token_expired", message: "expired" } }),
      json(200, { ok: true }),
    ]);
    await expect(api.get("/me")).resolves.toEqual({ ok: true });
    expect(getIdToken).toHaveBeenLastCalledWith(true);
    expect(authHeader(1)).toBe("Bearer t2");
  });

  it("does not retry other 401s", async () => {
    const { api, fetchMock } = setup([
      json(401, { detail: { code: "missing_token", message: "Sign in to continue." } }),
    ]);
    await expect(api.get("/me")).rejects.toMatchObject({ status: 401, code: "missing_token" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces backend error codes and messages", async () => {
    const { api } = setup([json(404, { detail: { code: "flow_not_found", message: "No such flow" } })]);
    const error = await api.get("/flows/nope").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "flow_not_found", message: "No such flow" });
  });

  it("handles FastAPI validation errors and non-JSON bodies", async () => {
    const { api } = setup([
      json(422, { detail: [{ msg: "field required" }] }),
      new Response("Bad gateway", { status: 502 }),
    ]);
    await expect(api.post("/flows", {})).rejects.toMatchObject({ status: 422, code: "http_422" });
    await expect(api.get("/x")).rejects.toMatchObject({ status: 502, code: "http_502" });
  });

  it("fails fast without a signed-in user", async () => {
    const { api, fetchMock } = setup([], [null, null]);
    await expect(api.get("/me")).rejects.toMatchObject({ status: 401, code: "missing_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps extra detail fields, e.g. a refused run's issues", async () => {
    const issues = [{ id: "not-runnable:if", message: "can't run yet" }];
    const { api } = setup([
      json(422, { detail: { code: "nodes_not_runnable", message: "Nope", issues } }),
    ]);
    await expect(api.post("/flows/f/runs")).rejects.toMatchObject({
      code: "nodes_not_runnable",
      message: "Nope",
      details: { issues },
    });
  });

  it("fetch returns the raw response, with the same auth retry and errors", async () => {
    const { api, authHeader } = setup([
      json(401, { detail: { code: "token_expired", message: "expired" } }),
      new Response("data: x\n\n", { status: 200 }),
      json(404, { detail: { code: "run_not_found", message: "Run not found." } }),
    ]);
    const response = await api.fetch("/runs/r/stream");
    await expect(response.text()).resolves.toBe("data: x\n\n");
    expect(authHeader(1)).toBe("Bearer t2");
    await expect(api.fetch("/runs/r/stream")).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("returns undefined for 204 No Content", async () => {
    const { api } = setup([new Response(null, { status: 204 })]);
    await expect(api.delete("/flows/f1")).resolves.toBeUndefined();
  });
});
