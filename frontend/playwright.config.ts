import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3000);

/**
 * End-to-end tests for the editor. Uses Playwright's bundled Chromium by default
 * (`npx playwright install chromium` once); set PLAYWRIGHT_CHANNEL=msedge or =chrome to use a
 * locally installed browser instead. Starts (or reuses, e.g. from `npm run dev` at the repo root) the
 * Firebase emulators, the FastAPI backend and `next dev` — the full stack. The frontend must use
 * NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Every worker drives the whole local stack (dev server, API, emulators); more than ~4 at once
  // exhausts Windows socket buffers (ERR_NO_BUFFER_SPACE).
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  // Runs against `next dev`, which compiles routes on demand and slows down under parallel load.
  expect: { timeout: 10_000 },
  // Full-stack flows (sign-up → API → Firestore emulator) against a dev server need headroom.
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // After the device preset, which would otherwise force 1280×720.
        viewport: { width: 1440, height: 900 },
        channel: process.env.PLAYWRIGHT_CHANNEL,
      },
    },
  ],
  webServer: [
    {
      // Auth/Firestore/Storage emulators (offline "demo-mesh" project); needs Java.
      command: "firebase emulators:start --only auth,firestore,storage --project demo-mesh",
      cwd: "..",
      url: "http://127.0.0.1:4400/emulators",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "uv run uvicorn app.main:app --port 8000",
      cwd: "../backend",
      url: "http://localhost:8000/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: `npm run dev -- --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
