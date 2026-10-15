import { expect, importFixture, test, TOOLS_FIXTURE, type Editor } from "./helpers";

const width = async (editor: Editor) => (await editor.canvas.boundingBox())!.width;
const center = (box: { x: number; width: number }) => box.x + box.width / 2;

test("the node palette can be hidden, and stays hidden", async ({ editor, page }) => {
  await editor.open();
  const before = await width(editor);
  await editor.palette.getByRole("button", { name: "Hide nodes panel" }).click();
  await expect(editor.palette).toHaveCount(0);
  await expect.poll(() => width(editor)).toBeGreaterThan(before + 200); // the canvas takes the room

  await page.reload();
  await expect(editor.nodes.first()).toBeVisible();
  await expect(editor.palette).toHaveCount(0);
  await page.getByRole("button", { name: "Show nodes panel" }).click();
  await expect(editor.palette).toBeVisible();
});

test("jumping to an issue centres the node in the canvas left beside the settings panel", async ({
  editor,
  page,
}) => {
  await editor.open();
  await editor.drop("API Caller", 900, 650);
  await editor.clickEmptyCanvas(); // settings closed: the canvas is at its widest
  await editor.issuesButton(/error/).click();
  await page.getByRole("menuitem", { name: /URL is required/ }).click();
  await expect(editor.settings).toBeVisible();
  await expect(async () => {
    const node = (await editor.node("API Caller").boundingBox())!;
    const canvas = (await editor.canvas.boundingBox())!;
    expect(Math.abs(center(node) - center(canvas))).toBeLessThan(20);
  }).toPass();
});

test.describe("narrow screens", () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test("side panels float over the canvas", async ({ editor, page }) => {
    await editor.open();
    await expect(editor.palette).toHaveCount(0); // hidden by default
    const full = await width(editor);

    await page.getByRole("button", { name: "Show nodes panel" }).click();
    await expect(editor.palette).toBeVisible();
    expect(await width(editor)).toBe(full); // floats instead of squeezing
    await editor.paletteItem("Agent").click();
    await expect(editor.nodes).toHaveCount(3);
    await expect(editor.palette).toHaveCount(0); // closes after adding

    await expect(editor.settings).toBeVisible(); // the new node is selected
    expect(await width(editor)).toBe(full);
  });

  test("fit view keeps the flow clear of the settings panel", async ({ editor, page }) => {
    await editor.open();
    await importFixture(editor, TOOLS_FIXTURE, 5);
    await editor.node("Lead Agent").click();
    await expect(editor.settings).toBeVisible();
    await page.getByRole("button", { name: "Fit view" }).click();
    await expect(async () => {
      const panel = (await editor.settings.boundingBox())!;
      for (const name of ["Manual Trigger", "Output", "Health API"]) {
        const node = (await editor.node(name).boundingBox())!;
        expect(node.x + node.width).toBeLessThan(panel.x);
        expect(node.x).toBeGreaterThan(0);
      }
    }).toPass();
  });
});
