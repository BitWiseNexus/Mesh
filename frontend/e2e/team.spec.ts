import path from "node:path";

import { expect, importFixture, test } from "./helpers";

test("a Supervisor hands work to its team and combines the answers", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, path.join(__dirname, "fixtures", "team-flow.mesh.json"), 5);
  await editor.readyToRun();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  const runPanel = page.getByRole("region", { name: "Run" });
  await expect(runPanel.getByRole("status", { name: "Run status" })).toHaveText("Succeeded", {
    timeout: 15_000,
  });
  const calls = runPanel
    .getByRole("listitem", { name: "Team Lead output" })
    .getByRole("list", { name: "Tool calls" });
  await expect(calls.getByRole("listitem")).toHaveCount(2);
  await expect(calls).toContainText("writer");
  await expect(calls).toContainText("researcher");
  await expect(runPanel.getByRole("listitem", { name: "Writer output" })).toContainText(
    "Copy for: Plan the launch",
  );
  const plan = runPanel.getByRole("listitem", { name: "Plan output" });
  await expect(plan).toContainText("Copy for: Plan the launch");
  await expect(plan).toContainText("Facts for: Plan the launch");

  // Without workers, the editor warns.
  await editor.node("Writer").click();
  await page.keyboard.press("Delete");
  await editor.node("Researcher").click();
  await page.keyboard.press("Delete");
  await expect(editor.issuesButton("1 warning")).toBeVisible();
  await editor.issuesButton("1 warning").click();
  await expect(page.getByRole("menu")).toContainText(
    "“Team Lead” has no worker agents — connect agents to its Tools handle",
  );
});
