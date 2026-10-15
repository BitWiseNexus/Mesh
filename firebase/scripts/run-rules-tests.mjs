#!/usr/bin/env node
/**
 * Runs the security rules tests inside dedicated emulators (`firebase emulators:exec`), then makes
 * sure those emulators are really gone: on Windows the Firestore emulator's JVM outlives
 * emulators:exec, which makes the next run fail with "port taken". The ports below are used only
 * by these tests (see firebase.rules-test.json), so freeing them is safe.
 */
import { spawnSync } from "node:child_process";

import { freePorts } from "../../scripts/free-ports.mjs";

const RULES_TEST_PORTS = [8180, 9299, 4410, 4510, 9160];

freePorts(RULES_TEST_PORTS); // leftovers from an interrupted run
const run = spawnSync(
  'firebase emulators:exec --config firebase.rules-test.json --project demo-mesh-rules --only firestore,storage "vitest run"',
  { shell: true, stdio: "inherit" },
);
freePorts(RULES_TEST_PORTS);
process.exit(run.status ?? 1);
