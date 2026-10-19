/**
 * Firestore security rules. The backend (Admin SDK) bypasses rules, so these guard what a signed-in
 * user could do with the Firebase client SDK and their own ID token.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

import { emulatorHost } from "./emulator";

let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = emulatorHost("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8180");
  env = await initializeTestEnvironment({
    // A separate demo project so tests never touch the dev app's data.
    projectId: "demo-mesh-rules",
    firestore: {
      rules: readFileSync(resolve(import.meta.dirname, "../firestore.rules"), "utf8"),
      host,
      port,
    },
  });
});

afterAll(() => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "flows/alice-flow"), { owner_uid: "alice", name: "Alice's flow" });
    await setDoc(doc(db, "flows/bob-flow"), { owner_uid: "bob", name: "Bob's flow" });
    await setDoc(doc(db, "runs/alice-run"), { owner_uid: "alice", status: "running" });
    await setDoc(doc(db, "runs/alice-run/state/checkpoint"), { data: "…", owner_uid: "alice" });
    await setDoc(doc(db, "credentials/alice-openai"), { owner_uid: "alice", ciphertext: "…" });
    await setDoc(doc(db, "users/alice"), { name: "Alice" });
    await setDoc(doc(db, "knowledge_bases/alice-kb"), { owner_uid: "alice", name: "Docs" });
    await setDoc(doc(db, "knowledge_bases/alice-kb/documents/d1"), { name: "faq.md" });
    await setDoc(doc(db, "kb_chunks/c1"), { owner_uid: "alice", kb_id: "alice-kb", text: "…" });
    await setDoc(doc(db, "schedules/alice-flow--1"), { owner_uid: "alice", flow_id: "alice-flow" });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

describe.each(["flows", "runs"] as const)("%s", (name) => {
  const aliceDoc = name === "flows" ? "alice-flow" : "alice-run";

  it("owners can read their own documents", async () => {
    await assertSucceeds(getDoc(doc(as("alice"), name, aliceDoc)));
  });

  it("other users and signed-out visitors can't", async () => {
    await assertFails(getDoc(doc(as("bob"), name, aliceDoc)));
    await assertFails(getDoc(doc(anonymous(), name, aliceDoc)));
  });

  it("list queries must be filtered to the caller's own documents", async () => {
    const own = query(collection(as("alice"), name), where("owner_uid", "==", "alice"));
    await assertSucceeds(getDocs(own));
    await assertFails(getDocs(collection(as("alice"), name))); // unfiltered
    const others = query(collection(as("alice"), name), where("owner_uid", "==", "bob"));
    await assertFails(getDocs(others));
  });

  it("nobody can write from a client, not even the owner", async () => {
    const db = as("alice");
    await assertFails(setDoc(doc(db, name, "new"), { owner_uid: "alice" }));
    await assertFails(updateDoc(doc(db, name, aliceDoc), { name: "changed" }));
    await assertFails(deleteDoc(doc(db, name, aliceDoc)));
  });
});

describe("flows", () => {
  it("reading a missing flow is denied, not an empty result (no existence probing)", async () => {
    await assertFails(getDoc(doc(as("alice"), "flows", "does-not-exist")));
  });
});

describe("runs", () => {
  it("a paused run's saved state is never readable from a client, even by its owner", async () => {
    await assertFails(getDoc(doc(as("alice"), "runs/alice-run/state/checkpoint")));
    await assertFails(getDocs(collection(as("alice"), "runs/alice-run/state")));
  });
});

describe("credentials", () => {
  it("are never readable from a client, even by their owner", async () => {
    await assertFails(getDoc(doc(as("alice"), "credentials", "alice-openai")));
    await assertFails(
      getDocs(query(collection(as("alice"), "credentials"), where("owner_uid", "==", "alice"))),
    );
  });
});

describe("knowledge bases", () => {
  it("their documents and chunks are never readable or writable from a client, even by the owner", async () => {
    const db = as("alice");
    await assertFails(getDoc(doc(db, "knowledge_bases", "alice-kb")));
    await assertFails(
      getDocs(query(collection(db, "knowledge_bases"), where("owner_uid", "==", "alice"))),
    );
    await assertFails(getDoc(doc(db, "knowledge_bases/alice-kb/documents/d1")));
    await assertFails(getDocs(collection(db, "knowledge_bases/alice-kb/documents")));
    await assertFails(
      getDocs(query(collection(db, "kb_chunks"), where("owner_uid", "==", "alice"))),
    );
    await assertFails(setDoc(doc(db, "knowledge_bases", "new"), { owner_uid: "alice" }));
    await assertFails(setDoc(doc(db, "kb_chunks", "new"), { owner_uid: "alice" }));
  });
});

describe("schedules", () => {
  it("are API-only: not even their owner can read or write them", async () => {
    const db = as("alice");
    await assertFails(getDoc(doc(db, "schedules/alice-flow--1")));
    await assertFails(
      getDocs(query(collection(db, "schedules"), where("owner_uid", "==", "alice"))),
    );
    await assertFails(setDoc(doc(db, "schedules", "new"), { owner_uid: "alice" }));
  });
});

describe("everything else", () => {
  it("is denied by default", async () => {
    await assertFails(getDoc(doc(as("alice"), "users", "alice")));
    await assertFails(setDoc(doc(as("alice"), "users", "alice"), { name: "x" }));
    await assertFails(getDoc(doc(as("alice"), "anything", "at-all")));
    await assertFails(setDoc(doc(anonymous(), "anything", "at-all"), { x: 1 }));
  });
});
