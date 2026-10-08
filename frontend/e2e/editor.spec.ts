import { expect, importFixture, newUser, openDashboard, signUpViaUi, test } from "./helpers";

test("home → sign up → empty dashboard → new flow opens on the starter template", async ({
  editor,
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Backend: online")).toBeVisible();
  await page.getByRole("link", { name: "Go to your flows" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fflows$/);
  await signUpViaUi(page, newUser());
  await expect(page).toHaveURL(/\/flows$/);
  await expect(page.getByRole("heading", { name: "Create your first flow" })).toBeVisible();
  await page.getByRole("button", { name: "New flow" }).first().click();
  await expect(page).toHaveURL(/\/flows\/[A-Za-z0-9]+$/);

  await expect(editor.nodes).toHaveCount(2);
  await expect(editor.edges).toHaveCount(1);
  await expect(editor.node("Manual Trigger").getByText("start", { exact: true })).toBeVisible();
  await expect(editor.node("Output").getByText("end", { exact: true })).toBeVisible();
  await editor.readyToRun();
});

test("palette searches and won't add 'Soon' nodes", async ({ editor, page }) => {
  await editor.open();
  await expect(editor.palette.locator("button[draggable=true]")).toHaveCount(9);
  await expect(editor.palette.getByText("Soon", { exact: true })).toHaveCount(12); // + 2 retired, hidden

  await page.getByLabel("Search nodes").fill("slack");
  const slack = editor.paletteItem("Slack Message");
  await expect(slack).toHaveAttribute("aria-disabled", "true");
  await slack.click({ force: true }); // force: Playwright won't click aria-disabled buttons
  await editor.drop("Slack Message", 500, 600, { expectAdded: false });
  await expect(editor.nodes).toHaveCount(2);
});

test("build a flow by dropping and connecting nodes", async ({ editor }) => {
  await editor.open();
  await editor.drop("Agent", 420, 150);
  await editor.drop("Web Search", 420, 700);
  await expect(editor.nodes).toHaveCount(4);
  await expect(editor.issuesButton("2 warnings")).toBeVisible();
  await expect(editor.node("Web Search").getByLabel("1 issue")).toBeVisible();

  await editor.connect(editor.handle("Manual Trigger", "out", "source"), editor.handle("Agent", "in", "target"));
  await editor.connect(editor.handle("Agent", "out", "source"), editor.handle("Output", "in", "target"));
  await editor.connect(editor.handle("Agent", "tools", "source"), editor.handle("Web Search", "tool", "target"));
  await expect(editor.edges).toHaveCount(4);
  await editor.readyToRun();
  const draft = await editor.draft();
  expect(draft.edges.map((e: { type: string }) => e.type).sort()).toEqual([
    "data",
    "data",
    "data",
    "tool_connection",
  ]);

  // Tools handle → data input is refused, with an explanation.
  await editor.connect(editor.handle("Agent", "tools", "source"), editor.handle("Output", "in", "target"));
  await expect(editor.page.getByText("An agent's Tools handle only connects to tools")).toBeVisible();
  await expect(editor.edges).toHaveCount(4);
});

test("configure nodes from the settings panel", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor);

  await editor.node("Lead Parser").click();
  await editor.settings.getByLabel("Name").fill("Lead Triage");
  await expect(editor.node("Lead Triage")).toBeVisible();

  const temperature = editor.settings.getByLabel("Temperature");
  await temperature.fill("5");
  await expect(temperature).toHaveAttribute("aria-invalid", "true");
  await expect(editor.issuesButton("1 error")).toBeVisible();
  await temperature.fill("0.4");
  await editor.readyToRun();

  await editor.node("Web Search").click();
  await editor.settings.getByRole("combobox").click();
  await page.getByRole("option", { name: "DuckDuckGo" }).click();
  await expect(editor.node("Web Search")).toContainText("duckduckgo");

  const draft = await editor.draft();
  const agent = draft.nodes.find((n: { type: string }) => n.type === "agent_node");
  expect(agent.data).toMatchObject({ label: "Lead Triage", temperature: 0.4 });
});

test("issues menu jumps to the node with the problem", async ({ editor, page }) => {
  await editor.open();
  await editor.drop("API Caller", 700, 650);
  await expect(editor.issuesButton("1 error · 1 warning")).toBeVisible();

  await editor.clickEmptyCanvas();
  await editor.issuesButton(/error/).click();
  await page.getByRole("menuitem", { name: /URL is required/ }).click();
  await expect(editor.settings.getByText("API Caller", { exact: true })).toBeVisible();
  await expect(editor.settings.getByRole("textbox", { name: /^URL/ })).toHaveAttribute("aria-invalid", "true");

  await editor.settings.getByRole("textbox", { name: /^URL/ }).fill("https://api.example.com/leads");
  await expect(editor.issuesButton("1 warning")).toBeVisible();
  await editor.settings.getByRole("button", { name: "Delete" }).click();
  await editor.readyToRun();
});

test("missing trigger: one-click fix, and deletes undo as one step", async ({ editor, page }) => {
  await editor.open();
  await editor.node("Manual Trigger").click();
  await page.keyboard.press("Delete");
  await expect(editor.edges).toHaveCount(0);

  await editor.issuesButton("1 error").click();
  await page.getByRole("menuitem", { name: /Add a trigger/ }).click();
  await expect(editor.node("Manual Trigger")).toHaveCount(1);

  await editor.clickEmptyCanvas();
  await page.keyboard.press("Control+z"); // removes the added trigger
  await expect(editor.nodes).toHaveCount(1);
  await page.keyboard.press("Control+z"); // restores the deleted trigger *and* its edge
  await expect(editor.nodes).toHaveCount(2);
  await expect(editor.edges).toHaveCount(1);
  await editor.readyToRun();
});

test("saved changes are on the server: they survive a reload (Ctrl+S)", async ({
  editor,
  page,
}) => {
  await editor.open();
  await editor.toolbar.getByLabel("Flow name").fill("Lead router");
  await editor.drop("Agent", 420, 150);
  await editor.save();

  await editor.drop("Web Search", 420, 700);
  await editor.settings.getByLabel("Max results").fill("7");
  await editor.save(); // Ctrl+S works while typing in a field

  await page.reload();
  await expect(editor.nodes).toHaveCount(4);
  await expect(editor.toolbar.getByLabel("Flow name")).toHaveValue("Lead router");
  await editor.node("Web Search").click();
  await expect(editor.settings.getByLabel("Max results")).toHaveValue("7");
});

test("export, and import into the open flow", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor);
  await expect(editor.edges).toHaveCount(3);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByLabel("Export JSON").click(),
  ]);
  expect(download.suggestedFilename()).toBe("support-lead-ai-assistant.mesh.json");
  const exported = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
  expect(exported).toMatchObject({ schema_version: 1, name: "Support Lead AI Assistant" });
  expect(exported.nodes).toHaveLength(4);

  // The import replaced this flow's content but kept its identity: saving updates the same flow.
  const flowId = editor.flowId();
  await editor.save();
  await page.reload();
  await expect(editor.nodes).toHaveCount(4);
  expect(editor.flowId()).toBe(flowId);
});

test("theme toggle switches to dark mode", async ({ editor, page }) => {
  await editor.open();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("flows containing retired node types still open, and explain what replaced them", async ({
  editor,
  page,
}) => {
  await openDashboard(page);
  const flow = {
    name: "Old Notion flow",
    nodes: [
      { id: "t", type: "trigger_manual", data: {}, position: { x: 0, y: 0 } },
      { id: "n", type: "kb_notion", data: { page_ids: ["abc"] }, position: { x: 400, y: 0 } },
    ],
    edges: [{ id: "e", source: "t", target: "n", sourceHandle: "out", targetHandle: "in" }],
  };
  await page.locator("input[name=import-flow-file]").setInputFiles({
    name: "old.mesh.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(flow)),
  });
  await expect(editor.node("Notion")).toBeVisible();
  await expect(editor.palette.getByText("Notion", { exact: true })).toHaveCount(0); // not addable
  await editor.issuesButton("1 error").click();
  await expect(page.getByRole("menuitem", { name: /knowledge-base source/ })).toBeVisible();
});
