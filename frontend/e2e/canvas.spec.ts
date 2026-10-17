import type { Locator } from "@playwright/test";

import { ECHO_FIXTURE, expect, importFixture, test, TOOLS_FIXTURE, type Editor } from "./helpers";

type DraftNode = { id: string; ref: string; type: string; data: Record<string, unknown> };
type DraftEdge = { source: string; target: string };

/** Moves the pointer over empty canvas (where Ctrl+V pastes). */
const pointAtEmptyCanvas = (editor: Editor) =>
  editor.page.locator(".react-flow__pane").hover({ position: { x: 300, y: 600 } });

test("copy, paste and duplicate nodes with the keyboard", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  // The agent refers to the trigger by name: the copies must refer to each other instead.
  await editor.node("Echo Agent").click();
  await editor.settings
    .getByRole("textbox", { name: /^System prompt/ })
    .fill("Context: {{trigger.output}}");

  await editor.node("Manual Trigger").click();
  await editor.node("Echo Agent").click({ modifiers: ["Control"] });
  await page.keyboard.press("Control+c");
  await expect(page.getByText("Copied 2 nodes")).toBeVisible();

  await pointAtEmptyCanvas(editor);
  await page.keyboard.press("Control+v");
  await expect(editor.nodes).toHaveCount(5);
  await expect(editor.edges).toHaveCount(3); // the edge between the two copies came along
  await editor.readyToRun();

  const draft = await editor.draft();
  const byRef = (ref: string) => draft.nodes.find((n: DraftNode) => n.ref === ref);
  expect(draft.nodes.map((n: DraftNode) => n.ref)).toEqual([
    "trigger",
    "agent",
    "result",
    "trigger_2",
    "agent_2",
  ]);
  expect(byRef("agent_2").data.system_prompt).toBe("Context: {{trigger_2.output}}");
  expect(byRef("agent").data.system_prompt).toBe("Context: {{trigger.output}}");
  expect(
    draft.edges.some(
      (e: DraftEdge) => e.source === byRef("trigger_2").id && e.target === byRef("agent_2").id,
    ),
  ).toBe(true);

  // A paste is one undo step.
  await page.keyboard.press("Control+z");
  await expect(editor.nodes).toHaveCount(3);
  await expect(editor.edges).toHaveCount(2);

  // Ctrl+D duplicates next to the original; a single copy opens in the settings panel.
  await editor.node("Output").click();
  await page.keyboard.press("Control+d");
  await expect(editor.nodes).toHaveCount(4);
  await expect(editor.settings.getByRole("textbox", { name: "Reference" })).toHaveValue("result_2");

  await editor.save();
  await page.reload();
  await expect(editor.nodes).toHaveCount(4);
});

test("paste into another flow keeps free names; fields keep normal paste", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  await editor.node("Echo Agent").click();
  await page.keyboard.press("Control+c");
  await expect(page.getByText("Copied 1 node")).toBeVisible();

  // A second flow (the starter: trigger → output).
  await page.getByRole("link", { name: "Flows", exact: true }).click();
  await page.getByRole("button", { name: "New flow" }).first().click();
  await expect(editor.nodes).toHaveCount(2);
  await pointAtEmptyCanvas(editor);
  await page.keyboard.press("Control+v");
  await expect(editor.nodes).toHaveCount(3);
  await expect(editor.node("Echo Agent")).toBeVisible();
  const draft = await editor.draft();
  expect(draft.nodes.at(-1)).toMatchObject({ ref: "agent", data: { model: "mock/echo" } });

  // Pasting into a text field pastes text, not nodes.
  await editor.node("Echo Agent").click();
  await editor.settings.getByLabel("Name").click();
  await page.keyboard.press("Control+v");
  await expect(editor.nodes).toHaveCount(3);
});

test("right-click menus for nodes, the selection, edges and the canvas", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  const menu = editor.contextMenu();

  // A node: duplicate it, then delete the copy.
  await editor.node("Echo Agent").click({ button: "right" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    /^Copy/,
    /^Cut/,
    /^Duplicate/,
    /^Delete/,
  ]);
  await menu.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await expect(editor.nodes).toHaveCount(4);
  await editor.nodes.last().click({ button: "right" });
  await menu.getByRole("menuitem", { name: /^Delete/ }).click();
  await expect(editor.nodes).toHaveCount(3);

  // Copy from the menu, paste where the canvas was right-clicked (this tab's copy: no clipboard
  // permission needed).
  await editor.node("Output").click({ button: "right" });
  await menu.getByRole("menuitem", { name: /^Copy/ }).click();
  await editor.page.locator(".react-flow__pane").click({ button: "right", position: { x: 300, y: 600 } });
  await menu.getByRole("menuitem", { name: /^Paste here/ }).click();
  await expect(editor.nodes).toHaveCount(4);
  const pasted = (await editor.nodes.last().boundingBox())!;
  const pane = (await editor.page.locator(".react-flow__pane").boundingBox())!;
  expect(Math.abs(pasted.x - (pane.x + 300))).toBeLessThan(15); // top-left at the click (grid snap)

  // An edge: delete it.
  const point = await editor.edgePoint("e2");
  await page.mouse.click(point.x, point.y, { button: "right" });
  await menu.getByRole("menuitem", { name: /^Delete connection/ }).click();
  await expect(editor.edges).toHaveCount(1);

  // Select all, then delete the selection from a node's menu — one undo step.
  await editor.clickEmptyCanvas();
  await page.keyboard.press("Control+a");
  await editor.node("Manual Trigger").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete 4 nodes" }).click();
  await expect(editor.nodes).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(editor.nodes).toHaveCount(4);
  await expect(editor.edges).toHaveCount(1);
});

/**
 * Drags a connection from a handle and drops it at (x, y) in page coordinates, which must be empty
 * canvas (a drop on a node doesn't open the picker).
 */
async function dragConnectionTo(editor: Editor, handle: Locator, x: number, y: number) {
  const box = (await handle.boundingBox())!;
  await editor.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await editor.page.mouse.down();
  await editor.page.mouse.move(x, y, { steps: 15 });
  // A connection is being drawn (the drag started on the handle, not beside it)…
  await expect(editor.page.locator(".react-flow__connectionline")).toBeVisible();
  // …and it ends over empty canvas.
  const target = await editor.page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.className, [x, y]);
  expect(String(target), "the drop point must be empty canvas").toContain("react-flow__pane");
  await editor.page.mouse.up();
}

const picker = (editor: Editor) => editor.page.getByRole("dialog", { name: /node|connection/ });
const options = (editor: Editor) => picker(editor).getByRole("option");

test("drop a connection on empty canvas to add a connected node", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  const agentOut = editor.handle("Echo Agent", "out", "source");
  const agentBox = (await editor.node("Echo Agent").boundingBox())!;

  await dragConnectionTo(editor, agentOut, agentBox.x + 120, agentBox.y + 250);
  await expect(picker(editor)).toContainText("Connect a new node");
  await expect(options(editor).filter({ hasText: "Manual Trigger" })).toHaveCount(0); // no input
  await page.keyboard.type("if");
  await expect(options(editor).first()).toContainText("If / Else");
  await page.keyboard.press("Enter");
  await expect(picker(editor)).toHaveCount(0);
  await expect(editor.nodes).toHaveCount(4);
  await expect(editor.edges).toHaveCount(3);
  let draft = await editor.draft();
  const ifNode = draft.nodes.find((n: { type: string }) => n.type === "logic_if");
  expect(draft.edges.some((e: { source: string; target: string }) => e.target === ifNode.id && e.source === "node_a")).toBe(true);
  // The new node is selected (settings open) and the whole thing is one undo step.
  await expect(editor.settings.getByText("If / Else", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); // leave the settings field focus, if any
  await editor.clickEmptyCanvas();
  await page.keyboard.press("Control+z");
  await expect(editor.nodes).toHaveCount(3);
  await expect(editor.edges).toHaveCount(2);

  // From an agent's Tools handle only tools (and agents) fit; the edge is a tool attachment.
  await dragConnectionTo(editor, editor.handle("Echo Agent", "tools", "source"), agentBox.x + 120, agentBox.y + 250);
  await expect(options(editor)).toHaveText([
    /^Agent/,
    /^Web Search/,
    /^Web Scraper/,
    /^API Caller/,
    /^Retriever/,
  ]);
  await options(editor).filter({ hasText: "Web Search" }).click();
  await expect(editor.nodes).toHaveCount(4);
  draft = await editor.draft();
  expect(draft.edges.at(-1)).toMatchObject({ source: "node_a", type: "tool_connection" });
  await editor.readyToRun();

  // Escape closes the picker without adding anything. (Above the flow: the tool just added sits
  // below the agent, where this used to drop — onto the tool on CI's taller font.)
  await dragConnectionTo(editor, editor.handle("Output", "in", "target"), agentBox.x + 120, agentBox.y - 200);
  await expect(picker(editor)).toContainText("Connect a new node");
  await page.keyboard.press("Escape");
  await expect(picker(editor)).toHaveCount(0);
  await expect(editor.nodes).toHaveCount(4);
});

test("insert nodes into a connection", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  const chain = async () => {
    const draft = await editor.draft();
    const name = (id: string) => draft.nodes.find((n: { id: string }) => n.id === id).ref;
    return draft.edges
      .map((e: { source: string; target: string }) => `${name(e.source)}→${name(e.target)}`)
      .sort();
  };

  // The "+" on a selected edge opens the picker; the node goes between the two ends.
  let point = await editor.edgePoint("e2");
  await page.mouse.click(point.x, point.y);
  await page.getByRole("button", { name: "Insert a node" }).click();
  await expect(picker(editor)).toContainText("Insert into the connection");
  await expect(options(editor).filter({ hasText: "Output" })).toHaveCount(0); // no output handle
  await options(editor).filter({ hasText: "Approval Gate" }).click();
  await expect(editor.nodes).toHaveCount(4);
  expect(await chain()).toEqual(["agent→approval", "approval→result", "trigger→agent"]);

  // Dropping a palette item on an edge inserts it there.
  point = await editor.edgePoint("e1");
  const canvas = (await editor.canvas.boundingBox())!;
  await editor.drop("Agent", point.x - canvas.x, point.y - canvas.y);
  expect(await chain()).toEqual(["agent_2→agent", "agent→approval", "approval→result", "trigger→agent_2"]);

  // Dragging an unconnected node onto an edge inserts it, as one undo step with the move — but
  // only nodes with an input and an output (not tools).
  const target = (await editor.edges.evaluateAll((els) => els.map((e) => e.getAttribute("data-id"))))
    .find((id) => id !== "e1" && id !== "e2")!; // one of the new edges
  const insertHighlight = editor.page.locator('[marker-end="url(#mesh-arrow-insert)"]');
  const dragOnto = async (node: Locator, release = true) => {
    const box = (await node.boundingBox())!;
    point = await editor.edgePoint(target);
    await page.mouse.move(box.x + 60, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 20 });
    if (release) await page.mouse.up();
    return box;
  };
  await editor.drop("Web Scraper", 450, 650);
  await dragOnto(editor.node("Web Scraper"), false);
  await expect(insertHighlight).toHaveCount(0);
  await page.mouse.up();
  await expect(editor.edges).toHaveCount(4);

  await editor.drop("If / Else", 750, 650);
  const ifNode = editor.node("If / Else");
  const box = await dragOnto(ifNode, false);
  await expect(insertHighlight).toHaveCount(1);
  await page.mouse.up();
  await expect(insertHighlight).toHaveCount(0);
  await expect(editor.edges).toHaveCount(5);
  await editor.clickEmptyCanvas();
  await page.keyboard.press("Control+z");
  await expect(editor.edges).toHaveCount(4);
  const after = (await ifNode.boundingBox())!;
  expect(Math.abs(after.x - box.x)).toBeLessThan(2); // moved back too
});

test("add and insert nodes from the right-click menu", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  const menu = editor.contextMenu();

  await editor.page.locator(".react-flow__pane").click({ button: "right", position: { x: 300, y: 600 } });
  await menu.getByRole("menuitem", { name: "Add node…" }).click();
  await expect(picker(editor)).toContainText("Add a node");
  await expect(picker(editor).getByRole("combobox")).toBeFocused();
  await page.keyboard.type("scraper");
  await page.keyboard.press("Enter");
  await expect(editor.node("Web Scraper")).toBeVisible();

  const point = await editor.edgePoint("e1");
  await page.mouse.click(point.x, point.y, { button: "right" });
  await menu.getByRole("menuitem", { name: "Insert node…" }).click();
  await page.keyboard.type("agent");
  await page.keyboard.press("Enter");
  await expect(editor.nodes).toHaveCount(5);
  await expect(editor.edges).toHaveCount(3);
});

test("tidy up lays the flow out (one undo step)", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, ECHO_FIXTURE, 3);
  const box = (name: string) => editor.node(name).boundingBox().then((b) => b!);

  // Drag Output below and to the left of the agent.
  const out = await box("Output");
  await page.mouse.move(out.x + 60, out.y + 20);
  await page.mouse.down();
  await page.mouse.move(out.x - 500, out.y + 250, { steps: 10 });
  await page.mouse.up();
  const positions = async () =>
    Object.fromEntries(
      (await editor.draft()).nodes.map((n: { ref: string; position: unknown }) => [n.ref, n.position]),
    );
  const before = await positions();

  await editor.canvas.getByRole("button", { name: "Tidy up" }).click();
  await expect(async () => {
    const [t, a, o] = [await box("Manual Trigger"), await box("Echo Agent"), await box("Output")];
    expect(Math.abs(t.y - a.y)).toBeLessThan(2);
    expect(Math.abs(o.y - a.y)).toBeLessThan(2);
    expect(t.x < a.x && a.x < o.x).toBe(true);
  }).toPass();
  await expect(editor.saveStatus()).toHaveText("Unsaved changes");

  expect(await positions()).not.toEqual(before);
  await page.keyboard.press("Control+z");
  expect(await positions()).toEqual(before);
});

test("tidy up from the menu puts an agent's tools underneath it", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, TOOLS_FIXTURE, 5);
  await editor.page.locator(".react-flow__pane").click({ button: "right", position: { x: 300, y: 650 } });
  await editor.contextMenu().getByRole("menuitem", { name: "Tidy up" }).click();
  await expect(async () => {
    const lead = (await editor.node("Lead Agent").boundingBox())!;
    for (const tool of ["Writer", "Health API"]) {
      const b = (await editor.node(tool).boundingBox())!;
      expect(b.y).toBeGreaterThan(lead.y + lead.height);
    }
    const [w, h] = [(await editor.node("Writer").boundingBox())!, (await editor.node("Health API").boundingBox())!];
    expect(Math.abs(w.y - h.y)).toBeLessThan(2);
    expect((await editor.node("Manual Trigger").boundingBox())!.y).toBeCloseTo(lead.y, -1);
  }).toPass();
  await expect(page.getByText("Ready to run")).toBeVisible();
});
