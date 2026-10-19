import path from "node:path";

import { expect, importFixture, test } from "./helpers";

const FIXTURE = path.join(__dirname, "fixtures", "webhook-flow.mesh.json");

test("a webhook's URL starts runs, which the run history lists", async ({
  editor,
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await editor.open();
  await importFixture(editor, FIXTURE, 4);
  await editor.readyToRun();
  await editor.save(); // the URL runs the flow as last saved

  await editor.node("Signup hook").click();
  const urlField = editor.settings.getByRole("textbox", { name: "Webhook URL" });
  const url = await urlField.inputValue();
  expect(url).toMatch(new RegExp(`/hooks/${editor.flowId()}/node_w$`));
  await editor.settings.getByRole("button", { name: "Copy curl command" }).click();
  await expect(page.getByText("Copied the curl command")).toBeVisible();
  const curl = await page.evaluate(() => navigator.clipboard.readText());
  expect(curl).toBe(
    `curl -X POST '${url}' -H 'X-Mesh-Secret: s3cret' -H 'Content-Type: application/json' --data-raw '{"name": "Test"}'`,
  );

  // Callers need the secret and the configured method.
  expect((await page.request.post(url, { data: { name: "Eve" } })).status()).toBe(401);
  expect((await page.request.get(url, { headers: { "X-Mesh-Secret": "s3cret" } })).status()).toBe(
    405,
  );
  const call = await page.request.post(url, {
    data: { name: "Ada" },
    headers: { "X-Mesh-Secret": "s3cret" },
  });
  expect(call.status()).toBe(202);
  expect(await call.json()).toEqual({ run_id: expect.any(String), status: "queued" });

  // The run is in the history (named after its trigger: the flow has two) and shows on the canvas.
  const historyButton = page.getByRole("button", { name: "Run history" });
  const finished = page.getByRole("menuitem", { name: /^Succeeded run/ });
  await expect(async () => {
    await page.keyboard.press("Escape");
    await historyButton.click();
    await expect(finished).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(finished).toContainText("Signup hook");
  await finished.click();
  const runPanel = page.getByRole("region", { name: "Run" });
  await expect(runPanel.getByRole("listitem", { name: "Greeting output" })).toContainText(
    "Hello Ada",
  );
  const request = runPanel.getByRole("listitem", { name: "Signup hook output" });
  await expect(request).toContainText('"name": "Ada"');
  await expect(request).not.toContainText("s3cret"); // the flow never sees the secret
});

test("running a webhook flow from the editor uses the Test body", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, FIXTURE, 4);
  await editor.readyToRun();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByRole("menuitem", { name: "Signup hook" }).click();
  const runPanel = page.getByRole("region", { name: "Run" });
  await expect(runPanel.getByRole("status", { name: "Run status" })).toHaveText("Succeeded", {
    timeout: 15_000,
  });
  await expect(runPanel.getByRole("listitem", { name: "Greeting output" })).toContainText(
    "Hello Test",
  );
  await runPanel.getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel.getByRole("list", { name: "Run log" })).toContainText(
    "Started without a request: the Test body stands in for the request body",
  );
});
