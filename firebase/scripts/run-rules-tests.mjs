#!/usr/bin/env node
/**
 * Runs the security rules tests inside dedicated emulators (`firebase emulators:exec`), then makes
 * sure those emulators are really gone: on Windows the Firestore emulator's JVM outlives
 * emulators:exec, which makes the next run fail with "port taken". The ports below are used only
 * by these tests (see firebase.rules-test.json), so freeing them is safe.
 */
import { execSync, spawnSync } from "node:child_process";

const RULES_TEST_PORTS = [8180, 9299, 4410, 4510, 9160];
const isWindows = process.platform === "win32";

function listeningPids(port) {
  try {
    if (isWindows) {
      return execSync("netstat -ano -p tcp", { encoding: "utf8" })
        .split(/\r?\n/)
        .filter((line) => line.includes("LISTENING") && new RegExp(`:${port}\\s`).test(line))
        .map((line) => line.trim().split(/\s+/).at(-1));
    }
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" }).split(/\s+/);
  } catch {
    return []; // nothing listening (lsof exits non-zero)
  }
}

function freePorts() {
  const pids = new Set(RULES_TEST_PORTS.flatMap(listeningPids).filter((pid) => pid && pid !== "0"));
  for (const pid of pids) {
    if (isWindows) spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore" });
    else spawnSync("kill", ["-9", pid], { stdio: "ignore" });
  }
}

freePorts(); // leftovers from an interrupted run
const run = spawnSync(
  'firebase emulators:exec --config firebase.rules-test.json --project demo-mesh-rules --only firestore,storage "vitest run"',
  { shell: true, stdio: "inherit" },
);
freePorts();
process.exit(run.status ?? 1);
