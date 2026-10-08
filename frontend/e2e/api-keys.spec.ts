import { ECHO_FIXTURE, expect, importFixture, openDashboard, test } from "./helpers";

test("manage API keys: add, rename, replace, delete — the secret is never shown", async ({
  page,
}) => {
  await openDashboard(page);
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("menuitem", { name: "API keys" }).click();
  await expect(page.getByRole("heading", { name: "API keys", exact: true })).toBeVisible();
  await expect(page.getByText("No API keys yet")).toBeVisible();

  // Add an Anthropic key.
  await page.getByRole("button", { name: "Add key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "Anthropic" }).click();
  await expect(dialog.getByLabel("Name")).toHaveValue("Anthropic"); // default name follows
  await dialog.getByLabel("Name").fill("Work Claude");
  await dialog.getByLabel("Key").fill("sk-ant-secret-value-7f3a");
  await dialog.getByRole("button", { name: "Add key" }).click();
  await expect(dialog).toHaveCount(0);

  const anthropic = page.getByRole("region", { name: "Anthropic" });
  await expect(anthropic).toContainText("Work Claude");
  await expect(anthropic).toContainText("…7f3a");
  await expect(page.locator("body")).not.toContainText("sk-ant-secret-value");

  // Rename and replace the value.
  await page.getByRole("button", { name: "Edit Work Claude" }).click();
  await dialog.getByLabel("Name").fill("Team Claude");
  await dialog.getByLabel("New key (optional)").fill("sk-ant-rotated-key-9b21");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(anthropic).toContainText("Team Claude");
  await expect(anthropic).toContainText("…9b21");

  // It survives a reload (it's on the server), then delete it.
  await page.reload();
  await expect(page.getByRole("region", { name: "Anthropic" })).toContainText("Team Claude");
  await page.getByRole("button", { name: "Delete Team Claude" }).click();
  await page.getByRole("button", { name: "Delete key" }).click();
  await expect(page.getByText("No API keys yet")).toBeVisible();
});

test("choose an agent's API key, adding one from the node settings", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  await editor.node("Echo Agent").click();

  const field = editor.settings.getByRole("combobox", { name: "API key" });
  await expect(field).toHaveText(/^Automatic/);
  await field.click();
  await page.getByRole("option", { name: "Add a key…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Key").fill("sk-openai-test-key-1234"); // OpenAI is the first choice
  await dialog.getByRole("button", { name: "Add key" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(field).toHaveText(/^OpenAI \(OpenAI …1234\)/);
  await editor.save();
  const draft = await editor.draft();
  const agent = draft.nodes.find((n: { id: string }) => n.id === "node_a");
  expect(agent.data.credential_id).toMatch(/^[A-Za-z0-9]{20}$/);

  // Back to automatic.
  await field.click();
  await page.getByRole("option", { name: "Automatic" }).click();
  await expect(field).toHaveText(/^Automatic/);
});
