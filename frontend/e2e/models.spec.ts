import { expect, test } from "./helpers";

test("the model field suggests models for the providers you have keys for", async ({
  editor,
  page,
}) => {
  await editor.open();
  await editor.drop("Agent", 420, 150);
  const model = editor.settings.getByRole("combobox", { name: /^Model/ });

  // No keys anywhere (the test server has none): new agents use the test model.
  await expect(model).toHaveValue("mock/echo");
  await expect(editor.settings.getByText("Test model: needs no API key.")).toBeVisible();
  await editor.settings.getByRole("button", { name: "Show models" }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveText(["mock/echo", "mock/tools"]);
  await expect(page.getByText("Add an API key to use OpenAI, Anthropic, Google Gemini")).toBeVisible();
  await page.keyboard.press("Escape");

  // Any model name can be typed; one without a key is flagged.
  await model.fill("claude-sonnet-5");
  await page.keyboard.press("Escape");
  await expect(editor.settings.getByText(/No Anthropic key yet/)).toBeVisible();

  // Add an Anthropic key from the agent's API key field: its models appear, and new agents use it.
  await editor.settings.getByRole("combobox", { name: "API key" }).click();
  await page.getByRole("option", { name: "Add a key…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "Anthropic" }).click();
  await dialog.getByLabel("Key").fill("sk-ant-test-key-1234");
  await dialog.getByRole("button", { name: "Add key" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor.settings.getByText("Uses your saved Anthropic key.")).toBeVisible();

  await model.fill("");
  await editor.settings.getByRole("button", { name: "Show models" }).click();
  await expect(options.first()).toHaveText("claude-sonnet-5"); // recommended first
  await expect(page.getByRole("group", { name: "Anthropic" })).toBeVisible();
  await options.filter({ hasText: "claude-opus-5-5" }).click();
  await expect(model).toHaveValue("claude-opus-5-5");

  await editor.drop("Agent", 420, 650);
  await expect(editor.settings.getByRole("combobox", { name: /^Model/ })).toHaveValue("claude-sonnet-5");
  const draft = await editor.draft();
  expect(draft.nodes.filter((n: { type: string }) => n.type === "agent_node").map((n: { data: { model: string } }) => n.data.model)).toEqual([
    "claude-opus-5-5",
    "claude-sonnet-5",
  ]);
});
