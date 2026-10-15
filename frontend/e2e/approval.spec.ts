import type { Page } from "@playwright/test";

import { APPROVAL_FIXTURE, expect, importFixture, test, type Editor } from "./helpers";

const runPanel = (page: Page) => page.getByRole("region", { name: "Run" });
const runStatus = (page: Page) => page.getByRole("status", { name: "Run status" });
const runButton = (page: Page) => page.getByRole("button", { name: "Run", exact: true });
const nodeStatus = (editor: Editor, node: string, status: string) =>
  editor.node(node).getByRole("img", { name: `Run status: ${status}` });
const approvalCard = (page: Page) => runPanel(page).getByRole("region", { name: "Approval: Editor review" });

async function runUntilWaiting(editor: Editor) {
  await editor.open();
  await importFixture(editor, APPROVAL_FIXTURE, 4);
  await editor.readyToRun();
  await runButton(editor.page).click();
  await expect(runStatus(editor.page)).toHaveText("Waiting for approval", { timeout: 15_000 });
}

test("an Approval Gate pauses the run; the reviewer edits and approves", async ({ editor, page }) => {
  await runUntilWaiting(editor);
  await expect(nodeStatus(editor, "Editor review", "Waiting for approval")).toBeVisible();
  await expect(approvalCard(page)).toContainText("Publish “first draft”?");
  const content = approvalCard(page).getByRole("textbox", { name: "Content to approve" });
  await expect(content).toHaveValue("first draft");
  // The toolbar bell counts it.
  await expect(page.getByRole("button", { name: "1 approval waiting for you" })).toBeVisible();
  // While a run waits, another run could start: Run stays available.
  await expect(runButton(page)).toBeEnabled();

  await content.fill("final draft");
  await expect(approvalCard(page)).toContainText("Edited — continues with your version");
  await approvalCard(page).getByRole("button", { name: "Approve" }).click();

  await expect(runStatus(page)).toHaveText("Succeeded", { timeout: 15_000 });
  await expect(approvalCard(page)).toHaveCount(0);
  await expect(nodeStatus(editor, "Published", "Succeeded")).toBeVisible();
  await expect(nodeStatus(editor, "Discarded", "Skipped")).toBeVisible();
  await expect(runPanel(page).getByRole("listitem", { name: "Published output" })).toContainText(
    "final draft",
  );
  await expect(page.getByRole("button", { name: "Approvals", exact: true })).toBeVisible();
  await runPanel(page).getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel(page).getByRole("list", { name: "Run log" })).toContainText(
    "approved by the reviewer (edited)",
  );
});

test("approvals wait across pages: answer one from the bell", async ({ editor, page }) => {
  await runUntilWaiting(editor);

  // Leave the flow; the dashboard's bell still shows what's waiting.
  await page.getByRole("link", { name: "Flows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Flows", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "1 approval waiting for you" }).click();
  await page.getByRole("menuitem", { name: /Review before publishing/ }).click();

  // The flow opens with that run shown, ready to answer.
  await expect(approvalCard(page)).toContainText("Publish “first draft”?");
  await expect(runStatus(page)).toHaveText("Waiting for approval");
  await approvalCard(page).getByRole("button", { name: "Reject" }).click();

  await expect(runStatus(page)).toHaveText("Succeeded", { timeout: 15_000 });
  await expect(nodeStatus(editor, "Discarded", "Succeeded")).toBeVisible();
  await expect(nodeStatus(editor, "Published", "Skipped")).toBeVisible();
  await expect(runPanel(page).getByRole("listitem", { name: "Discarded output" })).toContainText(
    "first draft",
  );
});

test("a waiting run is listed in the history and can be stopped", async ({ editor, page }) => {
  await runUntilWaiting(editor);
  await page.getByRole("button", { name: "Run history" }).click();
  await expect(page.getByRole("menuitem", { name: /^Waiting for approval run/ })).toHaveCount(1);
  await page.keyboard.press("Escape");

  await runPanel(page).getByRole("button", { name: "Stop run" }).click();
  await expect(runStatus(page)).toHaveText("Stopped");
  await expect(approvalCard(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approvals", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run history" }).click();
  await expect(page.getByRole("menuitem", { name: /^Stopped run/ })).toHaveCount(1);
});
