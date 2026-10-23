import path from "node:path";

import { expect, importFixture, test } from "./helpers";

test("a flow writes a row; the Tables pages show it and delete it", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, path.join(__dirname, "fixtures", "table-flow.mesh.json"), 2);
  await editor.readyToRun();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  const runPanel = page.getByRole("region", { name: "Run" });
  await expect(runPanel.getByRole("status", { name: "Run status" })).toHaveText("Succeeded", {
    timeout: 15_000,
  });
  await expect(runPanel.getByRole("listitem", { name: "Save signup output" })).toContainText(
    '"created": true',
  );

  await page.goto("/tables");
  const card = page.getByRole("article", { name: "Signups" });
  await expect(card).toContainText("1 row");
  await card.getByRole("link", { name: "Signups" }).click();
  await expect(page.getByRole("heading", { name: "Signups" })).toBeVisible();

  const rows = page.getByRole("table", { name: "Rows of Signups" });
  await expect(rows.getByRole("columnheader")).toHaveText(["Row", "name", "plan", "Written", ""]);
  const row = rows.getByRole("row").nth(1);
  await expect(row).toContainText('Ada "the Countess"'); // the quotes survived the JSON
  await expect(row).toContainText("pro");

  await row.getByRole("button", { name: /^Delete row / }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete row" }).click();
  await expect(page.getByText("No rows. Flows that write to “Signups” add them here.")).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete table" }).click();
  await expect(page).toHaveURL(/\/tables$/);
  await expect(page.getByRole("heading", { name: "No tables yet" })).toBeVisible();
});
