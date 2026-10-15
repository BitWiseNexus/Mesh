#!/usr/bin/env node
/**
 * Starts the whole local stack with labelled, coloured output:
 *   firebase emulators  →  FastAPI backend (:8000)  →  Next.js frontend (:3000)
 *
 *   npm run dev                  # everything
 *   npm run dev -- --no-emulators   # e.g. when pointing at a real Firebase project
 *
 * - Services start one after another, each once the previous one is ready, so the app can't be
 *   opened while the API or the sign-in service is still starting ("Ready" is printed at the end).
 * - Services that are already running (their port is taken, e.g. started in another terminal) are
 *   reused, not started twice.
 * - A Firebase emulator left behind by an earlier session (on Windows the Firestore JVM often
 *   outlives its CLI) would make the emulators fail to start: it's detected and stopped first.
 * - Ctrl+C stops every process *tree* this script started (on Windows a plain kill leaves the Next
 *   server, Firebase CLI and the Firestore JVM running as orphans).
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const isWindows = process.platform === "win32";
const READY_TIMEOUT_MS = 180_000;

const emulatorConfig = JSON.parse(readFileSync(join(root, "firebase.json"), "utf8")).emulators;
/** Every port an emulator session holds: the configured ones + the CLI's hub, logging, ws. */
const EMULATOR_PORTS = [
  emulatorConfig.auth.port,
  emulatorConfig.firestore.port,
  emulatorConfig.storage.port,
  emulatorConfig.ui.port,
  4400, // hub
  4500, // logging
  9150, // Firestore UI websocket
];

const services = [
  !args.has("--no-emulators") && {
    name: "firebase",
    color: 33, // yellow
    cwd: root,
    command: "firebase emulators:start --project demo-mesh",
    port: 4400, // emulator hub
    // The hub comes up first; the app needs Auth and Firestore.
    ready: () => allOpen([4400, emulatorConfig.auth.port, emulatorConfig.firestore.port]),
  },
  {
    name: "backend",
    color: 36, // cyan
    cwd: join(root, "backend"),
    command: "uv run uvicorn app.main:app --reload --port 8000",
    port: 8000,
    ready: () => httpOk("http://127.0.0.1:8000/health"),
  },
  {
    name: "frontend",
    color: 35, // magenta
    cwd: join(root, "frontend"),
    command: "npm run dev",
    port: 3000,
    ready: () => httpOk("http://127.0.0.1:3000/", { anyStatus: true }),
  },
].filter(Boolean);

const width = Math.max(...services.map((s) => s.name.length));
const children = [];
let shuttingDown = false;

const label = (service) => `\x1b[${service.color}m${service.name.padEnd(width)} │\x1b[0m`;
const note = (service, text) => console.log(`${label(service)} \x1b[2m${text}\x1b[0m`);

function prefixLines(service, stream, target) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) target.write(`${label(service)} ${line}\n`);
  });
  stream.on("end", () => buffer && target.write(`${label(service)} ${buffer}\n`));
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  killPid(child.pid, { group: true });
}

function killPid(pid, { group = false } = {}) {
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(group ? -pid : pid, "SIGTERM"); // group: the tree (spawned detached below)
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

// ── Probes ─────────────────────────────────────────────────────────────────

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

async function allOpen(ports) {
  const open = await Promise.all(ports.map(portInUse));
  return open.every(Boolean);
}

async function httpOk(url, { anyStatus = false } = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return anyStatus || response.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The process listening on `port`: { pid, command } or null. */
function ownerOf(port) {
  if (isWindows) {
    const script =
      `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
      `if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; ` +
      `@{ pid = $c.OwningProcess; command = "$($p.Name) $($p.CommandLine)" } | ConvertTo-Json -Compress }`;
    const out = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    try {
      return out.stdout.trim() ? JSON.parse(out.stdout) : null;
    } catch {
      return null;
    }
  }
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const pid = Number(lsof.stdout?.trim().split("\n")[0]);
  if (!pid) return null;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return { pid, command: ps.stdout?.trim() ?? "" };
}

const looksLikeEmulator = (command) =>
  /cloud-firestore-emulator|cloud-storage-rules-runtime|firebase-tools|emulators:(start|exec)/i.test(
    command,
  );

/**
 * Before starting the emulators: a port of theirs taken while no emulator suite is running means
 * a leftover (the Firestore JVM outliving an earlier session) — stop it, or explain who's there.
 */
async function clearLeftoverEmulators(service) {
  for (const port of EMULATOR_PORTS) {
    if (!(await portInUse(port))) continue;
    const owner = ownerOf(port);
    if (owner && looksLikeEmulator(owner.command)) {
      note(service, `stopping a leftover Firebase emulator on port ${port} (PID ${owner.pid})`);
      killPid(owner.pid);
      for (let i = 0; i < 20 && (await portInUse(port)); i++) await sleep(250);
      continue;
    }
    const who = owner ? `${owner.command.split(" ")[0]} (PID ${owner.pid})` : "another program";
    console.error(
      `\x1b[31mPort ${port} is in use by ${who}, but the Firebase emulators need it.\x1b[0m\n` +
        `Stop that program and run npm run dev again.`,
    );
    process.exit(1);
  }
}

async function waitUntilReady(service, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await service.ready()) return;
    if (child && child.exitCode !== null) return; // its exit handler reports and shuts down
    await sleep(500);
  }
  console.error(
    `\x1b[31m${service.name} wasn't ready after ${READY_TIMEOUT_MS / 1000} s; stopping.\x1b[0m`,
  );
  shutdown(1);
}

// ── Start ──────────────────────────────────────────────────────────────────

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => children.forEach(killTree));

console.log(
  [
    "",
    "  Mesh dev stack starting… (wait for “Ready”)",
    "  • Frontend      http://localhost:3000",
    "  • API docs      http://localhost:8000/docs",
    args.has("--no-emulators") ? "" : "  • Firebase UI   http://127.0.0.1:4000",
    "  Ctrl+C stops everything.",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n"),
);

for (const service of services) {
  if (await portInUse(service.port)) {
    note(service, `already running on port ${service.port} — reusing it`);
    await waitUntilReady(service, null);
    continue;
  }
  if (service.name === "firebase") await clearLeftoverEmulators(service);
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
  await waitUntilReady(service, child);
  if (!shuttingDown) note(service, "ready");
}

if (!shuttingDown) {
  console.log("\n  \x1b[32m✓ Ready\x1b[0m — open http://localhost:3000\n");
}
