import type { Page } from "@playwright/test";

import {
  BRANCH_FIXTURE,
  expect,
  importFixture,
  LOOP_FIXTURE,
  test,
  type Editor,
} from "./helpers";

const runPanel = (page: Page) => page.getByRole("region", { name: "Run" });
const runStatus = (page: Page) => page.getByRole("status", { name: "Run status" });
const runButton = (page: Page) => page.getByRole("button", { name: "Run", exact: true });
const nodeStatus = (editor: Editor, node: string, status: string) =>
  editor.node(node).getByRole("img", { name: `Run status: ${status}` });

async function run(editor: Editor) {
  await runButton(editor.page).click();
  await expect(runStatus(editor.page)).toHaveText("Succeeded", { timeout: 15_000 });
}

test("If / Else takes one branch and skips the other; past runs can be replayed", async ({
  editor,
  page,
}) => {
  await editor.open();
  await importFixture(editor, BRANCH_FIXTURE, 4);
  await editor.readyToRun();

  await run(editor); // input "yes please" contains "yes"
  await expect(nodeStatus(editor, "Approved", "Succeeded")).toBeVisible();
  await expect(nodeStatus(editor, "Rejected", "Skipped")).toBeVisible();
  await expect(page.locator('.react-flow__edge [data-run-state="skipped"]')).toHaveCount(1);
  await runPanel(page).getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel(page).getByRole("list", { name: "Run log" })).toContainText(
    "“yes please” contains “yes” → true",
  );

  // Second run, the other way.
  await editor.node("Manual Trigger").click();
  await editor.settings.getByRole("textbox", { name: /^Default input/ }).fill("no thanks");
  await run(editor);
  await expect(nodeStatus(editor, "Rejected", "Succeeded")).toBeVisible();
  await expect(nodeStatus(editor, "Approved", "Skipped")).toBeVisible();

  // History: newest first; open the first run again.
  await page.getByRole("button", { name: "Run history" }).click();
  const runs = page.getByRole("menuitem", { name: /^Succeeded run/ });
  await expect(runs).toHaveCount(2);
  await runs.last().click();
  await expect(runPanel(page).getByLabel("Run from history")).toContainText("Run from");
  await expect(runPanel(page).getByLabel("Run from history")).toContainText(
    "an earlier version of this flow", // the trigger input was edited (and saved) since
  );
  await expect(nodeStatus(editor, "Approved", "Succeeded")).toBeVisible();
  await expect(nodeStatus(editor, "Rejected", "Skipped")).toBeVisible();
  await expect(runPanel(page).getByRole("listitem", { name: "Approved output" })).toContainText(
    "yes please",
  );
});

test("a Loop repeats its body, then continues on Done", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, LOOP_FIXTURE, 4);
  await editor.readyToRun();
  await run(editor);

  const shout = runPanel(page).getByRole("listitem", { name: "Shout output" });
  await expect(shout).toContainText("pass 3");
  await expect(shout).toContainText("go!!!");
  await expect(runPanel(page).getByRole("listitem", { name: "Output output" })).toContainText(
    "go!!!",
  );
  await expect(nodeStatus(editor, "Loop", "Succeeded")).toBeVisible();
  await expect(nodeStatus(editor, "Shout", "Succeeded")).toBeVisible();

  await runPanel(page).getByRole("tab", { name: "Logs" }).click();
  const log = runPanel(page).getByRole("list", { name: "Run log" });
  await expect(log).toContainText("Iteration 3 of up to 3");
  await expect(log).toContainText("Done after 3 iterations (the maximum)");
});
