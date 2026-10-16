#!/usr/bin/env node
/**
 * `npm run test:backend [-- <pytest args>]`: the backend's tests inside throwaway Auth, Firestore
 * and Storage emulators on ports of their own (firebase.test.json), like CI. The API tests wipe the emulator
 * between tests, so they must never run against the `npm run dev` emulators, which hold your flows.
 */
import { spawnSync } from "node:child_process";

import { freePorts } from "./free-ports.mjs";

const BACKEND_TEST_PORTS = [9119, 8095, 9175, 9219, 4430, 4530];
const pytestArgs = process.argv.slice(2).map((a) => JSON.stringify(a)).join(" ");

freePorts(BACKEND_TEST_PORTS); // leftovers from an interrupted run
const run = spawnSync(
  `firebase emulators:exec --config firebase.test.json --only auth,firestore,storage --project demo-mesh "cd backend && uv run pytest -ra ${pytestArgs}"`,
  { shell: true, stdio: "inherit", env: { ...process.env, REQUIRE_EMULATORS: "1" } },
);
freePorts(BACKEND_TEST_PORTS);
process.exit(run.status ?? 1);
