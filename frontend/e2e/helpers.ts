import { randomUUID } from "node:crypto";
import path from "node:path";

import { test as base, expect, type Locator, type Page } from "@playwright/test";

export { expect };

export const PASSWORD = "correct-horse-1";
export const FIXTURE = path.join(__dirname, "fixtures", "support-flow.mesh.json");

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

/** A unique user per call, so tests never collide in the shared Auth emulator. */
export const newUser = (name = "Ada Lovelace"): TestUser => ({
  name,
  email: `e2e-${randomUUID().slice(0, 8)}@mesh.test`,
  password: PASSWORD,
});

/** Creates an account through the login page (assumes the page is on /login). */
export async function signUpViaUi(page: Page, user: TestUser) {
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
}

export async function signInViaUi(page: Page, user: Pick<TestUser, "email" | "password">) {
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

export async function signOutViaUi(page: Page) {
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Mesh" })).toBeVisible();
}

/** Opens the dashboard, signing up `user` first when redirected to the login page. */
export async function openDashboard(page: Page, user: TestUser = newUser()) {
  await page.goto("/flows");
  // The redirect to /login happens client-side once Firebase reports no session, so wait for
  // whichever screen actually appears rather than trusting the initial URL.
  const loginHeading = page.getByRole("heading", { name: "Sign in to Mesh" });
  const flowsHeading = page.getByRole("heading", { name: "Flows", exact: true });
  await expect(loginHeading.or(flowsHeading)).toBeVisible();
  if (await loginHeading.isVisible()) {
    await signUpViaUi(page, user);
    await expect(flowsHeading).toBeVisible();
  }
  return user;
}

/** Page object for the flow editor. */
export class Editor {
  readonly nodes: Locator;
  readonly edges: Locator;
  readonly palette: Locator;
  readonly settings: Locator;
  readonly toolbar: Locator;
  readonly canvas: Locator;

  constructor(readonly page: Page) {
    this.nodes = page.locator(".react-flow__node");
    this.edges = page.locator(".react-flow__edge");
    this.palette = page.getByRole("complementary", { name: "Node palette" });
    this.settings = page.getByRole("complementary", { name: "Node settings" });
    this.toolbar = page.locator("header");
    this.canvas = page.locator(".react-flow");
  }

  /** Signs up a fresh user (unless signed in), creates a new flow and opens it. */
  async open(user: TestUser = newUser()) {
    await openDashboard(this.page, user);
    await this.page.getByRole("button", { name: "New flow" }).first().click();
    await this.page.waitForURL(/\/flows\/[A-Za-z0-9]+$/);
    await expect(this.nodes.first()).toBeVisible();
    return user;
  }

  /** The id of the open flow, from the URL. */
  flowId(): string {
    return new URL(this.page.url()).pathname.split("/").at(-1)!;
  }

  /** The toolbar's save-status region ("Saved", "Unsaved changes", "Saving…", …). */
  saveStatus() {
    return this.page.getByRole("status", { name: "Save status" });
  }

  /**
   * Saves now (Ctrl+S skips autosave's idle delay) and waits until everything is saved. React
   * applies discrete-event updates synchronously, so right after an edit the status already shows
   * "Unsaved changes" and can't pass this check early.
   */
  async save() {
    await this.page.keyboard.press("Control+s");
    await expect(this.saveStatus()).toHaveText("Saved");
  }

  node(text: string | RegExp) {
    return this.page.locator(".react-flow__node", { hasText: text });
  }

  paletteItem(label: string) {
    return this.palette.locator("button", { hasText: new RegExp(`^${label}`) }).first();
  }

  /**
   * Drags a node type from the palette onto the canvas at (x, y) relative to the canvas and, unless
   * `expectAdded` is false, waits for the node to appear (the settings panel opening after a drop
   * resizes the canvas, so back-to-back drags must not race it).
   */
  async drop(label: string, x: number, y: number, { expectAdded = true } = {}) {
    const before = await this.nodes.count();
    // force: React Flow's own layers sit above the pane and fail Playwright's hit-test; also lets
    // us attempt drags of aria-disabled ("Soon") palette items.
    await this.paletteItem(label).dragTo(this.canvas, { targetPosition: { x, y }, force: true });
    if (expectAdded) await expect(this.nodes).toHaveCount(before + 1);
  }

  handle(nodeText: string | RegExp, handleId: string, type: "source" | "target") {
    return this.node(nodeText).locator(`.react-flow__handle.${type}[data-handleid="${handleId}"]`);
  }

  async connect(from: Locator, to: Locator) {
    const a = (await from.boundingBox())!;
    const b = (await to.boundingBox())!;
    await this.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 });
    await this.page.mouse.up();
  }

  /** Clicks empty canvas (bottom-left, clear of nodes and controls). */
  async clickEmptyCanvas() {
    await this.page.locator(".react-flow__pane").click({ position: { x: 300, y: 820 } });
  }

  issuesButton(name: string | RegExp) {
    return this.toolbar.getByRole("button", { name });
  }

  async readyToRun() {
    await expect(this.toolbar.getByText("Ready to run")).toBeVisible();
  }

  /** The open flow's local backup (after forcing the debounced write). */
  async draft() {
    await this.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    return this.page.evaluate((flowId) => {
      const key = Object.keys(localStorage).find(
        (k) => k.startsWith("mesh:flow-draft:") && k.endsWith(`:${flowId}`),
      );
      return key ? JSON.parse(localStorage.getItem(key)!).state.flow : null;
    }, this.flowId());
  }
}

/** Imports the fixture flow into the open flow (confirming the replace dialog). */
export async function importFixture(editor: Editor) {
  await editor.page.locator("input[name=import-into-flow]").setInputFiles(FIXTURE);
  await editor.page.getByRole("button", { name: "Replace" }).click();
  await expect(editor.nodes).toHaveCount(4);
  // Wait for the dialog (and its fading backdrop) to be gone: forced drops would land on it.
  await expect(editor.page.getByRole("alertdialog")).toHaveCount(0);
}

/**
 * `test` with an `editor` fixture (a page object for the current page) that fails the test on any
 * console error or uncaught exception.
 */
export const test = base.extend<{ editor: Editor }>({
  editor: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await use(new Editor(page));
    expect(errors, "console errors").toEqual([]);
  },
});
