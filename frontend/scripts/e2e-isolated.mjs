#!/usr/bin/env node
/**
 * `npm run test:e2e:ci [-- <playwright args>]`: the Playwright suite on CI's path — fresh Firebase
 * emulators, backend and a production build — on ports used only by this script (see
 * playwright.config.ts, firebase.e2e.json), so it runs next to `npm run dev` without touching it.
 *
 * On Windows, stopping Playwright's web servers leaves processes behind (the Firestore JVM, the
 * Firebase CLI, `next start`, uvicorn), so this frees the isolated ports before and after a run.
 */
import { spawnSync } from "node:child_process";

import { freePorts } from "../../scripts/free-ports.mjs";

const ISOLATED_PORTS = [3010, 8010, 4420, 4520, 8090, 9109, 9170, 9209];
const isWindows = process.platform === "win32";

// On Windows npx is a .cmd, which only runs through cmd.exe: quote the arguments for it, or a
// `-g "a|b"` grep would become a pipe.
const quote = (arg) => (isWindows ? `"${arg.replaceAll('"', '\\"')}"` : arg);

freePorts(ISOLATED_PORTS); // leftovers from an interrupted run
const run = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2).map(quote)], {
  shell: isWindows,
  stdio: "inherit",
  env: { ...process.env, E2E_ISOLATED: "1" },
});
freePorts(ISOLATED_PORTS);
process.exit(run.status ?? 1);
