/** Storage security rules: all file access goes through the backend for now. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { getBytes, ref, uploadString } from "firebase/storage";
import { afterAll, beforeAll, describe, it } from "vitest";

import { emulatorHost } from "./emulator";

let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = emulatorHost("FIREBASE_STORAGE_EMULATOR_HOST", "127.0.0.1:9299");
  env = await initializeTestEnvironment({
    projectId: "demo-mesh-rules",
    storage: {
      rules: readFileSync(resolve(import.meta.dirname, "../storage.rules"), "utf8"),
      host,
      port,
    },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadString(ref(ctx.storage(), "users/alice/doc.txt"), "hello");
  });
});

afterAll(() => env?.cleanup());

describe("storage", () => {
  it("denies reads and writes from clients, even to the owner's own path", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertFails(getBytes(ref(alice, "users/alice/doc.txt")));
    await assertFails(uploadString(ref(alice, "users/alice/new.txt"), "x"));
    const anonymous = env.unauthenticatedContext().storage();
    await assertFails(getBytes(ref(anonymous, "users/alice/doc.txt")));
  });
});
