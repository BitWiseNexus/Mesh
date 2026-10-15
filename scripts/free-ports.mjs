/**
 * Stops whatever listens on the given TCP ports (and its child processes). Used by the test
 * runners that start their own emulators/servers on dedicated ports: on Windows those processes
 * (the Firestore JVM in particular) outlive `firebase emulators:exec` and Playwright's web servers,
 * and the next run then fails with "port taken". Only ever pass ports nothing else uses.
 */
import { execSync, spawnSync } from "node:child_process";

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

export function freePorts(ports) {
  const pids = new Set(ports.flatMap(listeningPids).filter((pid) => pid && pid !== "0"));
  for (const pid of pids) {
    if (isWindows) spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore" });
    else spawnSync("kill", ["-9", pid], { stdio: "ignore" });
  }
}
