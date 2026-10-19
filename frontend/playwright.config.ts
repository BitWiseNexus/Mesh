import { defineConfig, devices } from "@playwright/test";

/**
 * Isolated mode (`npm run test:e2e:ci`, E2E_ISOLATED=1): CI's path — fresh emulators, backend and a
 * production build — on ports of its own (firebase.e2e.json, API 8010, app 3010), so it can run
 * next to `npm run dev` without touching its servers or data.
 */
const ISOLATED = !!process.env.E2E_ISOLATED;
/** Test a production build (`next build && next start`) instead of `next dev`. */
const PRODUCTION_BUILD = !!process.env.CI || ISOLATED;

const PORT = Number(process.env.E2E_PORT ?? (ISOLATED ? 3010 : 3000));
const API_PORT = ISOLATED ? 8010 : 8000;
const EMULATORS = ISOLATED
  ? { config: "firebase.e2e.json", hub: 4420, auth: 9109, firestore: 8090, storage: 9209 }
  : { config: "firebase.json", hub: 4400, auth: 9099, firestore: 8080, storage: 9199 };

/** Read by the tests (e2e/helpers.ts), e.g. for fixtures that call the API. */
process.env.E2E_API_URL = `http://127.0.0.1:${API_PORT}`;

/**
 * End-to-end tests for the editor. Uses Playwright's bundled Chromium by default
 * (`npx playwright install chromium` once); set PLAYWRIGHT_CHANNEL=msedge or =chrome to use a
 * locally installed browser instead. Starts (or reuses, e.g. from `npm run dev` at the repo root) the
 * Firebase emulators, the FastAPI backend and `next dev` — the full stack. The frontend must use
 * NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // Every worker drives the whole local stack (dev server, API, emulators); more than ~4 at once
  // exhausts Windows socket buffers (ERR_NO_BUFFER_SPACE).
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // CI: annotations on the PR + an HTML report uploaded as an artifact when the job fails.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
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
      command: `firebase emulators:start --config ${EMULATORS.config} --only auth,firestore,storage --project demo-mesh`,
      cwd: "..",
      url: `http://127.0.0.1:${EMULATORS.hub}/emulators`,
      reuseExistingServer: !ISOLATED,
      timeout: 120_000,
    },
    {
      command: `uv run uvicorn app.main:app --port ${API_PORT}`,
      cwd: "../backend",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !ISOLATED,
      timeout: 120_000,
      env: ISOLATED
        ? {
            USE_FIREBASE_EMULATORS: "true",
            FIRESTORE_EMULATOR_HOST: `127.0.0.1:${EMULATORS.firestore}`,
            FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${EMULATORS.auth}`,
            FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${EMULATORS.storage}`,
            CORS_ORIGINS: JSON.stringify([`http://localhost:${PORT}`]),
            // Never send real email from tests, whatever backend/.env holds.
            RESEND_API_KEY: "",
          }
        : undefined,
    },
    {
      // CI tests a production build (closer to what users get, no on-demand compiles); locally the
      // dev server is reused so tests run against your working copy. `next build` writes to .next
      // and `next dev` to .next/dev, so both can coexist.
      command: PRODUCTION_BUILD
        ? `npm run build && npm run start -- --port ${PORT}`
        : `npm run dev -- --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !ISOLATED,
      timeout: 300_000, // includes `next build` in CI
      env: ISOLATED
        ? {
            NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
            NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "true",
            NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-mesh",
            NEXT_PUBLIC_AUTH_EMULATOR_HOST: `127.0.0.1:${EMULATORS.auth}`,
            NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: `127.0.0.1:${EMULATORS.firestore}`,
            NEXT_PUBLIC_STORAGE_EMULATOR_HOST: `127.0.0.1:${EMULATORS.storage}`,
          }
        : undefined,
    },
  ],
});
