import type { FullConfig } from "@playwright/test";

/**
 * Warms up `next dev` before the first test: it compiles each route on its first request, which
 * can take longer than a test's expect timeout on a cold start.
 */
const ROUTES = ["/", "/login", "/flows", "/flows/warmup"];

export default async function globalSetup(config: FullConfig) {
  const base = config.projects[0].use.baseURL!;
  for (const route of ROUTES) {
    try {
      await fetch(base + route, { signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      console.warn(`Warm-up of ${route} failed:`, error);
    }
  }
}
