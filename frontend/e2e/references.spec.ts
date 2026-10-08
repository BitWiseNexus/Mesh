import { expect, importFixture, test } from "./helpers";

test("insert, rename and validate references between nodes", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor); // Manual Trigger → Lead Parser (agent) → Output, + Web Search

  // An If / Else after the agent.
  await editor.drop("If / Else", 700, 650);
  await editor.connect(
    editor.handle("Lead Parser", "out", "source"),
    editor.handle("If / Else", "in", "target"),
  );

  // The settings panel shows the If node's own reference name.
  await editor.node("If / Else").click();
  await expect(editor.settings.getByLabel("Reference", { exact: true })).toHaveValue("if");

  // The picker offers only nodes that run earlier.
  const field = editor.settings.getByRole("textbox", { name: /^Value to check/ });
  await field.fill("Lead: ");
  await editor.settings.getByRole("button", { name: "Insert reference into Value to check" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /Lead Parser/ })).toContainText("{{agent.output}}");
  await expect(menu.getByRole("menuitem", { name: /Manual Trigger/ })).toContainText(
    "{{trigger.output}}",
  );
  await expect(menu.getByRole("menuitem", { name: /Web Search/ })).toHaveCount(0); // a tool, not upstream
  await menu.getByRole("menuitem", { name: /Lead Parser/ }).click();
  await expect(field).toHaveValue("Lead: {{agent.output}}");
  await expect(field).toBeFocused(); // keep typing right after the insertion

  // Renaming the agent's reference rewrites it everywhere.
  await editor.node("Lead Parser").click();
  const ref = editor.settings.getByLabel("Reference", { exact: true });
  await ref.fill("lead_parser");
  await ref.press("Enter");
  await editor.node("If / Else").click();
  await expect(editor.settings.getByRole("textbox", { name: /^Value to check/ })).toHaveValue(
    "Lead: {{lead_parser.output}}",
  );

  // Taken names are refused inline.
  await editor.node("Lead Parser").click();
  await ref.fill("trigger");
  await expect(editor.settings.getByText("Another node is already called “trigger”.")).toBeVisible();
  await ref.press("Escape");
  await expect(ref).toHaveValue("lead_parser");

  // A reference to a missing node is an error.
  await editor.node("If / Else").click();
  await editor.settings.getByRole("textbox", { name: /^Value to check/ }).fill("{{ghost.output}}");
  await expect(editor.issuesButton("1 error")).toBeVisible();
  await expect(editor.settings.getByRole("list", { name: "Problems with this node" })).toContainText(
    "no node is called “ghost”",
  );

  // Refs are saved with the flow.
  await editor.settings.getByRole("textbox", { name: /^Value to check/ }).fill("{{lead_parser.output}}");
  await editor.save();
  await page.reload();
  await editor.node("Lead Parser").click();
  await expect(editor.settings.getByLabel("Reference", { exact: true })).toHaveValue("lead_parser");
  await editor.readyToRun();
});
