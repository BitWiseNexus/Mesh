import { afterEach, describe, expect, it, vi } from "vitest";

import { followRun, type RunEvent, type runsApi } from "./runs-api";

type Api = ReturnType<typeof runsApi>;
type Connection = (onEvent: (e: RunEvent) => void) => Promise<void>;

const at = "2026-01-01T00:00:00Z";
const ev = (seq: number): RunEvent => ({ type: "log", seq, at, level: "info", message: `m${seq}` });
const finished = (seq: number): RunEvent => ({ type: "run_finished", seq, at, status: "succeeded" });
const seqOf = (e: RunEvent) => ("seq" in e ? e.seq : -1);

function fakeApi(connections: Connection[]) {
  const afters: number[] = [];
  const api = {
    stream: vi.fn(async (_id: string, onEvent: (e: RunEvent) => void, opts: { after?: number } = {}) => {
      afters.push(opts.after ?? 0);
      const next = connections.shift();
      if (!next) throw new Error("no more connections");
      await next(onEvent);
    }),
  } as unknown as Api;
  return { api, afters };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("followRun", () => {
  it("follows one stream to the end", async () => {
    const { api } = fakeApi([async (on) => [ev(1), ev(2), finished(3)].forEach(on)]);
    const seen: number[] = [];
    await followRun(api, "r", (e) => seen.push(seqOf(e)));
    expect(seen).toEqual([1, 2, 3]);
  });

  it("reconnects after a drop, resuming after the last event without duplicates", async () => {
    vi.useFakeTimers();
    const { api, afters } = fakeApi([
      async (on) => [ev(1), ev(2)].forEach(on), // ends early (e.g. a proxy timeout)
      async (on) => [ev(2), ev(3), finished(4)].forEach(on), // replayed from Last-Event-ID
    ]);
    const seen: number[] = [];
    const done = followRun(api, "r", (e) => seen.push(seqOf(e)));
    await vi.runAllTimersAsync();
    await done;
    expect(afters).toEqual([0, 2]);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("finishes on a snapshot (the run is no longer live)", async () => {
    const snapshot = { type: "snapshot", run: { run_id: "r" } } as RunEvent;
    const { api } = fakeApi([async (on) => on(snapshot)]);
    const seen: RunEvent[] = [];
    await followRun(api, "r", (e) => seen.push(e));
    expect(seen).toEqual([snapshot]);
  });

  it("gives up after repeated failed connections", async () => {
    vi.useFakeTimers();
    const fail: Connection = async () => {
      throw new Error("offline");
    };
    const { api } = fakeApi([fail, fail, fail]);
    const done = followRun(api, "r", () => {}, { attempts: 3 });
    const assertion = expect(done).rejects.toThrow("offline");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("stops quietly when aborted", async () => {
    const controller = new AbortController();
    const { api } = fakeApi([
      async (on) => {
        on(ev(1));
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    ]);
    await expect(
      followRun(api, "r", () => {}, { signal: controller.signal }),
    ).resolves.toBeUndefined();
  });
});
