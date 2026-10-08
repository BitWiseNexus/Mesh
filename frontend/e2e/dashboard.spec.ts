import { expect, FIXTURE, openDashboard, test } from "./helpers";

const card = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("article", { name, exact: true });

async function cardAction(page: import("@playwright/test").Page, name: string, action: string) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

test("create, rename, duplicate, search and delete flows", async ({ editor, page }) => {
  await editor.open();
  await editor.drop("Agent", 420, 150);
  await editor.save();
  await page.getByRole("link", { name: "Flows", exact: true }).click();

  const untitled = card(page, "Untitled flow");
  await expect(untitled).toContainText("3 nodes");
  await expect(untitled).toContainText("Edited just now");

  // Rename (+ description) through the dialog.
  await cardAction(page, "Untitled flow", "Rename");
  const dialog = page.getByRole("dialog", { name: "Rename flow" });
  await dialog.getByLabel("Name").fill("Lead router");
  await dialog.getByLabel("Description").fill("Routes inbound leads to the right team");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, "Lead router")).toContainText("Routes inbound leads");

  // Duplicate.
  await cardAction(page, "Lead router", "Duplicate");
  await expect(card(page, "Lead router (copy)")).toContainText("3 nodes");
  await expect(page.getByText("2 flows")).toBeVisible();

  // Search.
  await page.getByLabel("Search flows").fill("copy");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByLabel("Search flows").fill("nothing matches");
  await expect(page.getByText("No flows match")).toBeVisible();
  await page.getByLabel("Search flows").fill("");

  // Delete (cancel first, then confirm) — and it stays deleted after a reload.
  await cardAction(page, "Lead router (copy)", "Delete");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await cardAction(page, "Lead router (copy)", "Delete");
  await page.getByRole("button", { name: "Delete flow" }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(card(page, "Lead router")).toBeVisible();

  // Open from the card.
  await card(page, "Lead router").getByRole("link").click();
  await expect(page).toHaveURL(/\/flows\/[A-Za-z0-9]+$/);
  await expect(editor.toolbar.getByLabel("Flow name")).toHaveValue("Lead router");
});

test("import a flow file from the dashboard", async ({ editor, page }) => {
  await openDashboard(page);
  await page.locator("input[name=import-flow-file]").setInputFiles(FIXTURE);
  await expect(page).toHaveURL(/\/flows\/[A-Za-z0-9]+$/);
  await expect(editor.nodes).toHaveCount(4);
  await expect(editor.toolbar.getByLabel("Flow name")).toHaveValue("Support Lead AI Assistant");
});

test("saving over a newer version from another tab is caught", async ({ editor, page, context }) => {
  await editor.open();
  const url = page.url();

  // Tab 2 opens the same flow and saves a change first.
  const other = await context.newPage();
  await other.goto(url);
  await other.getByLabel("Flow name").fill("Saved in tab 2");
  await other.getByRole("button", { name: "Save", exact: true }).click();
  await expect(other.getByText("Saved", { exact: true })).toBeVisible();

  // Tab 1 is still on the old version. The browser logs the expected 409 as a console error.
  page.removeAllListeners("console");
  await editor.toolbar.getByLabel("Flow name").fill("Saved in tab 1");
  await editor.toolbar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("This flow was changed in another tab or device.")).toBeVisible();

  await page.getByRole("button", { name: "Reload" }).click();
  await expect(editor.toolbar.getByLabel("Flow name")).toHaveValue("Saved in tab 2");
  // After reloading, saving works again.
  await editor.toolbar.getByLabel("Flow name").fill("Merged by hand");
  await editor.save();
});

test("offers to import a flow drafted in this browser before the dashboard existed", async ({
  page,
}) => {
  await openDashboard(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "mesh:flow-draft",
      JSON.stringify({
        version: 2,
        state: {
          flow: {
            name: "Old local draft",
            nodes: [
              { id: "n1", type: "trigger_manual", data: {}, position: { x: 0, y: 0 } },
              { id: "n2", type: "output_display", data: {}, position: { x: 400, y: 0 } },
            ],
            edges: [{ id: "e", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" }],
          },
        },
      }),
    ),
  );
  await page.reload();
  const banner = page.getByRole("status").filter({ hasText: "saved in this browser" });
  await expect(banner).toContainText("Old local draft");
  await banner.getByRole("button", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/flows\/[A-Za-z0-9]+$/);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);

  await page.goto("/flows");
  await expect(card(page, "Old local draft")).toBeVisible();
  await expect(page.getByText("saved in this browser")).toBeHidden(); // offered only once
});
