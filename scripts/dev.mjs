#!/usr/bin/env node
/**
 * Starts the whole local stack with labelled, coloured output:
 *   firebase emulators  →  FastAPI backend (:8000)  →  Next.js frontend (:3000)
 *
 *   npm run dev                  # everything
 *   npm run dev -- --no-emulators   # e.g. when pointing at a real Firebase project
 *
 * Services that are already running (their port is taken, e.g. started in another terminal) are
 * reused, not started twice. Ctrl+C stops every process *tree* this script started (on Windows a
 * plain kill leaves the Next server, Firebase CLI and the Firestore JVM running as orphans).
 */
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const isWindows = process.platform === "win32";

const services = [
  !args.has("--no-emulators") && {
    name: "firebase",
    color: 33, // yellow
    cwd: root,
    command: "firebase emulators:start --project demo-mesh",
    port: 4400, // emulator hub
  },
  {
    name: "backend",
    color: 36, // cyan
    cwd: join(root, "backend"),
    command: "uv run uvicorn app.main:app --reload --port 8000",
    port: 8000,
  },
  {
    name: "frontend",
    color: 35, // magenta
    cwd: join(root, "frontend"),
    command: "npm run dev",
    port: 3000,
  },
].filter(Boolean);

const width = Math.max(...services.map((s) => s.name.length));
const children = [];
let shuttingDown = false;

function prefixLines(service, stream, target) {
  let buffer = "";
  const label = `\x1b[${service.color}m${service.name.padEnd(width)} │\x1b[0m `;
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) target.write(label + line + "\n");
  });
  stream.on("end", () => buffer && target.write(label + buffer + "\n"));
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM"); // the whole process group (detached below)
    } catch {
      // already gone
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write("\nStopping all services…\n");
  for (const child of children) killTree(child);
  process.exit(code);
}

/** True if something accepts connections on localhost:port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

for (const service of services) {
  if (await portInUse(service.port)) {
    const label = `[${service.color}m${service.name.padEnd(width)} │[0m`;
    console.log(`${label} already running on port ${service.port} — reusing it`);
    continue;
  }
  const child = spawn(service.command, {
    cwd: service.cwd,
    shell: true,
    detached: !isWindows,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  children.push(child);
  prefixLines(service, child.stdout, process.stdout);
  prefixLines(service, child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    process.stderr.write(`\x1b[31m${service.name} exited (code ${code}); stopping the rest.\x1b[0m\n`);
    shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => children.forEach(killTree));

console.log(
  [
    "",
    "  Mesh dev stack starting…",
    "  • Frontend      http://localhost:3000",
    "  • API docs      http://localhost:8000/docs",
    args.has("--no-emulators") ? "" : "  • Firebase UI   http://127.0.0.1:4000",
    "  Ctrl+C stops everything.",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n"),
);
