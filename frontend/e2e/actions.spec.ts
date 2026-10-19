import path from "node:path";

import { expect, importFixture, test } from "./helpers";

test("Send Email: Test mode shows the email; without a key, sending explains why it can't", async ({
  editor,
  page,
}) => {
  await editor.open();
  await importFixture(editor, path.join(__dirname, "fixtures", "email-flow.mesh.json"), 2);
  await editor.readyToRun();

  const runPanel = page.getByRole("region", { name: "Run" });
  const status = runPanel.getByRole("status", { name: "Run status" });
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(status).toHaveText("Succeeded", { timeout: 15_000 });
  const email = runPanel.getByRole("listitem", { name: "Mail the team output" });
  await expect(email).toContainText('"sent": false');
  await expect(email).toContainText('"subject": "Digest for Monday"');
  await expect(email).toContainText("Ada <ada@example.com>");
  await runPanel.getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel.getByRole("list", { name: "Run log" })).toContainText(
    "Test mode: “Digest for Monday” to team@example.com, Ada <ada@example.com> wasn't sent",
  );

  // For real: this test backend has no Resend key, and neither does the new user.
  await editor.node("Mail the team").click();
  await expect(editor.settings.getByRole("combobox", { name: /^Resend key/ })).toBeVisible();
  await editor.settings
    .getByRole("switch", { name: "Test mode: show the email instead of sending it" })
    .click();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(status).toHaveText("Failed", { timeout: 15_000 });
  await expect(runPanel.getByRole("tab", { name: "Output" })).toBeVisible();
  await runPanel.getByRole("tab", { name: "Output" }).click();
  await expect(runPanel).toContainText("No Resend API key: add one under API keys");
});
