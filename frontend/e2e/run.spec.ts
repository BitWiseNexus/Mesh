import type { Page } from "@playwright/test";

import {
  BRANCH_FIXTURE,
  ECHO_FIXTURE,
  expect,
  importFixture,
  test,
  TOOLS_FIXTURE,
  type Editor,
} from "./helpers";

const runPanel = (page: Page) => page.getByRole("region", { name: "Run" });
const runStatus = (page: Page) => page.getByRole("status", { name: "Run status" });
const runButton = (page: Page) => page.getByRole("button", { name: "Run", exact: true });
const nodeStatus = (editor: Editor, node: string, status: string) =>
  editor.node(node).getByRole("img", { name: `Run status: ${status}` });

/** Sets the Manual Trigger's default input (what a run starts with). */
async function setTriggerInput(editor: Editor, text: string) {
  await editor.node("Manual Trigger").click();
  await editor.settings.getByRole("textbox", { name: /^Default input/ }).fill(text);
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("runs Manual Trigger → Agent → Output and streams the reply live", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  await editor.readyToRun();
  // mock/echo streams a word every 30 ms: 40 words keep the agent busy long enough to watch.
  const input = words(40);
  await setTriggerInput(editor, input);
  await runButton(page).click();

  await expect(runPanel(page)).toBeVisible();
  await expect(nodeStatus(editor, "Echo Agent", "Running")).toBeVisible();
  await expect(nodeStatus(editor, "Manual Trigger", "Succeeded")).toBeVisible();
  await expect(page.locator('[data-run-state="active"]')).toHaveCount(1); // trigger → agent
  // Tokens show up while the agent is still running.
  const agentOutput = runPanel(page).getByRole("listitem", { name: "Echo Agent output" });
  await expect(agentOutput).toContainText("Echo: word0");
  await expect(runStatus(page)).toHaveText("Running…");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await expect(runStatus(page)).toHaveText("Succeeded", { timeout: 15_000 });
  for (const node of ["Manual Trigger", "Echo Agent", "Output"]) {
    await expect(nodeStatus(editor, node, "Succeeded")).toBeVisible();
  }
  await expect(page.locator('[data-run-state="delivered"]')).toHaveCount(2);
  await expect(runPanel(page).getByRole("listitem", { name: "Output output" })).toContainText(
    `Echo: ${input}`,
  );

  await runPanel(page).getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel(page).getByRole("list", { name: "Run log" })).toContainText("Run finished");
  // Running saved the edited input first (runs execute the saved flow).
  await expect(editor.saveStatus()).toHaveText("Saved");

  // The panel can be closed and brought back.
  await runPanel(page).getByRole("button", { name: "Close run panel" }).click();
  await expect(runPanel(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Show run panel" }).click();
  await expect(runStatus(page)).toHaveText("Succeeded");
});

test("Stop cancels a running flow", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  await setTriggerInput(editor, words(300)); // ~9 s of streaming
  await runButton(page).click();
  await expect(nodeStatus(editor, "Echo Agent", "Running")).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(runStatus(page)).toHaveText("Stopped");
  await expect(nodeStatus(editor, "Echo Agent", "Stopped")).toBeVisible();
  await expect(editor.node("Output").getByRole("img", { name: /^Run status/ })).toHaveCount(0);
  await expect(runButton(page)).toBeEnabled();
});

test("Run is disabled while the flow has errors", async ({ editor, page }) => {
  await editor.open();
  await editor.node("Manual Trigger").click();
  await page.keyboard.press("Delete");
  await expect(editor.issuesButton("1 error")).toBeVisible();
  await expect(runButton(page)).toBeDisabled();
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("Fix the flow's errors before running it.")).toBeVisible();
  await expect(runPanel(page)).toHaveCount(0);
});

test("an agent calls tools: another agent and an API", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, TOOLS_FIXTURE, 5);
  await editor.readyToRun();
  await runButton(page).click();

  await expect(runStatus(page)).toHaveText("Succeeded", { timeout: 15_000 });
  // Tools light up on the canvas once called, and their attachments show as used.
  for (const tool of ["Writer", "Health API"]) {
    await expect(nodeStatus(editor, tool, "Succeeded")).toBeVisible();
  }
  await expect(page.locator('.react-flow__edge [data-run-state="delivered"]')).toHaveCount(4);

  const lead = runPanel(page).getByRole("listitem", { name: "Lead Agent output" });
  const calls = lead.getByRole("list", { name: "Tool calls" });
  await expect(calls.getByRole("listitem")).toHaveCount(2);
  await expect(calls).toContainText("writer");
  await expect(calls).toContainText("health_api");
  // The sub-agent streamed its own reply into its own row.
  await expect(runPanel(page).getByRole("listitem", { name: "Writer output" })).toContainText(
    "Write about cats",
  );
  const result = runPanel(page).getByRole("listitem", { name: "Output output" });
  await expect(result).toContainText("Tool results: writer: Write about cats");
  await expect(result).toContainText('"status": "ok"'); // the real /health response

  await runPanel(page).getByRole("tab", { name: "Logs" }).click();
  const log = runPanel(page).getByRole("list", { name: "Run log" });
  await expect(log).toContainText("calls writer");
  await expect(log).toContainText("health_api returned");
});

test("explains why a flow can't run yet", async ({ editor, page }) => {
  await editor.open();
  page.removeAllListeners("console"); // the browser logs the expected 422 as a console error
  await importFixture(editor, BRANCH_FIXTURE, 3);
  await editor.readyToRun();
  await runButton(page).click();

  await expect(runStatus(page)).toHaveText("Failed");
  await expect(page.locator("#run-error")).toHaveText("Some nodes in this flow can't run yet.");
  await runPanel(page).getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel(page).getByRole("list", { name: "Run log" })).toContainText(
    "“If / Else”: If / Else nodes can't run yet",
  );
  await expect(runButton(page)).toBeEnabled();
});
