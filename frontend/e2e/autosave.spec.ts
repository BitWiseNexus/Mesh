import type { Page } from "@playwright/test";

import { expect, test } from "./helpers";

/** Makes the API reject flow saves (PUT /flows/{id}) until the returned function is called. */
async function failSaves(page: Page, how: "abort" | 500) {
  const pattern = /\/flows\/[A-Za-z0-9_-]+$/;
  await page.route(pattern, (route) =>
    route.request().method() !== "PUT"
      ? route.fallback()
      : how === "abort"
        ? route.abort("internetdisconnected")
        : route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ detail: { code: "boom", message: "Server error" } }),
          }),
  );
  // The browser logs failed requests as console errors; they're expected here.
  page.removeAllListeners("console");
  return () => page.unroute(pattern);
}

const nameField = (page: Page) => page.getByRole("textbox", { name: "Flow name" });

test("edits save automatically shortly after you stop editing", async ({ editor, page }) => {
  await editor.open();
  await expect(editor.saveStatus()).toHaveText("Saved");

  await nameField(page).fill("Autosaved flow");
  await expect(editor.saveStatus()).toHaveText("Unsaved changes");
  await expect(editor.saveStatus()).toHaveText("Saved", { timeout: 8000 }); // no Ctrl+S

  await page.reload();
  await expect(nameField(page)).toHaveValue("Autosaved flow");
});

test("leaving the editor saves pending edits", async ({ editor, page }) => {
  await editor.open();
  await editor.drop("Agent", 420, 150);
  await nameField(page).fill("Saved on the way out");
  // Leave immediately, well before the autosave delay.
  await page.getByRole("link", { name: "Flows", exact: true }).click();

  const card = page.getByRole("article", { name: "Saved on the way out" });
  await expect(card).toContainText("3 nodes");
  await page.reload();
  await expect(card).toContainText("3 nodes");
});

test("a failed save shows an error, retries, and recovers", async ({ editor, page }) => {
  await editor.open();
  const restore = await failSaves(page, 500);

  await nameField(page).fill("Saved after an outage");
  await expect(editor.saveStatus()).toContainText("Couldn't save", { timeout: 8000 });

  // Leaving now would lose the edit, so the editor asks first.
  await page.getByRole("link", { name: "Flows", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/flows\/[A-Za-z0-9]+$/);

  await restore();
  await editor.saveStatus().getByRole("button").click(); // retry now
  await expect(editor.saveStatus()).toHaveText("Saved");
  await page.reload();
  await expect(nameField(page)).toHaveValue("Saved after an outage");
});

test("closing the tab with unsaved changes asks for confirmation", async ({ editor, page }) => {
  await editor.open();
  await failSaves(page, "abort");
  await nameField(page).fill("Not saved yet");

  const dialog = page.waitForEvent("dialog");
  void page.close({ runBeforeUnload: true });
  const prompt = await dialog;
  expect(prompt.type()).toBe("beforeunload");
  await prompt.dismiss(); // stay
  await expect(nameField(page)).toHaveValue("Not saved yet");
});

test("unsaved edits are restored after a reload when the save never reached the server", async ({
  editor,
  page,
}) => {
  await editor.open();
  const restore = await failSaves(page, "abort");
  await editor.drop("Agent", 420, 150);
  await nameField(page).fill("Recovered after reload");
  await expect(editor.saveStatus()).toContainText("Couldn't save", { timeout: 8000 });

  await restore();
  page.once("dialog", (d) => d.accept()); // the beforeunload prompt
  await page.reload();

  await expect(page.getByText("Restored unsaved changes from your last session")).toBeVisible();
  await expect(nameField(page)).toHaveValue("Recovered after reload");
  await expect(editor.nodes).toHaveCount(3);
  // The restored edits are unsaved, so autosave pushes them.
  await expect(editor.saveStatus()).toHaveText("Saved", { timeout: 8000 });
  await page.reload();
  await expect(nameField(page)).toHaveValue("Recovered after reload");
});

test("edits based on an older version ask before replacing the saved one", async ({
  editor,
  page,
}) => {
  await editor.open();
  await nameField(page).fill("Saved version");
  await editor.save(); // server is now at version 2

  // Simulate a backup left behind by an older session (based on version 1).
  await editor.draft(); // flushes the debounced backup write so there's something to edit
  const flowId = editor.flowId();
  await page.evaluate((id) => {
    const key = Object.keys(localStorage).find((k) => k.endsWith(`:${id}`))!;
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.state.flow.name = "Edited in an old session";
    stored.state.baseVersion = 1;
    localStorage.setItem(key, JSON.stringify(stored));
  }, flowId);
  await page.reload();

  const banner = page.getByRole("alert", { name: "Unsaved changes found" });
  await expect(banner).toBeVisible();
  await expect(nameField(page)).toHaveValue("Saved version"); // nothing replaced yet
  await banner.getByRole("button", { name: "Restore my changes" }).click();
  await expect(nameField(page)).toHaveValue("Edited in an old session");
  await expect(editor.saveStatus()).toHaveText("Saved", { timeout: 8000 });
});
