import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, importFixture, openDashboard, test } from "./helpers";

test("create, change and delete knowledge bases", async ({ page }) => {
  await openDashboard(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge bases", exact: true })).toBeVisible();
  await expect(page.getByText("No knowledge bases yet")).toBeVisible();

  // Create: the embedding model defaults to one that works without keys (the test server has none).
  await page.getByRole("button", { name: "New knowledge base" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New knowledge base" });
  await dialog.getByLabel("Name").fill("Product docs");
  await dialog.getByLabel("Description").fill("Manuals and FAQ");
  await expect(dialog.getByRole("combobox", { name: "Embedding model" })).toContainText(
    /Mock embeddings/,
  );
  const size = dialog.getByLabel("Size (characters)");
  await size.fill("100");
  await expect(dialog.getByText(/Chunk size must be a whole number from 200 to 4000/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
  await size.fill("500");
  await dialog.getByLabel("Overlap (characters)").fill("100");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByRole("article", { name: "Product docs" });
  await expect(card).toContainText("Manuals and FAQ");
  await expect(card).toContainText("0 documents · Mock embeddings");

  // Change it: name, and the embedding model (allowed while it has no documents).
  await card.getByRole("button", { name: "Actions for Product docs" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Knowledge base settings" });
  await expect(settings.getByLabel("Size (characters)")).toHaveValue("500");
  await settings.getByLabel("Name").fill("Support docs");
  await settings.getByRole("combobox", { name: "Embedding model" }).click();
  await page.getByRole("option", { name: /OpenAI text-embedding-3-small — no API key yet/ }).click();
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings).toHaveCount(0);
  const renamed = page.getByRole("article", { name: "Support docs" });
  await expect(renamed).toContainText("OpenAI text-embedding-3-small");

  // It's on the server.
  await page.reload();
  await expect(renamed).toContainText("0 documents · OpenAI text-embedding-3-small");

  await renamed.getByRole("button", { name: "Actions for Support docs" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete knowledge base" }).click();
  await expect(page.getByText("No knowledge bases yet")).toBeVisible();
  await page.reload();
  await expect(page.getByText("No knowledge bases yet")).toBeVisible();
});

const file = (name: string, content: string | Buffer, mimeType = "application/octet-stream") => ({
  name,
  mimeType,
  buffer: Buffer.isBuffer(content) ? content : Buffer.from(content),
});

test("upload, list and delete a knowledge base's documents", async ({ page }) => {
  await openDashboard(page);
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "New knowledge base" }).first().click();
  await page.getByRole("dialog").getByLabel("Name").fill("Docs");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Docs", exact: true })).toBeVisible();
  await expect(page.getByText("No documents yet")).toBeVisible();

  // Several files at once: the image is refused before uploading, the fake PDF by the server; the
  // rest are processed into chunks (mock embeddings: the test server has no API keys).
  await page.locator("input[name=upload-documents]").setInputFiles([
    file("faq.md", "# FAQ\n\nYes, it works offline."),
    file("photo.png", "png"),
    file("guide.pdf", readFileSync(path.join(__dirname, "fixtures", "guide.pdf"))),
    file("fake.pdf", "not a pdf"),
  ]);
  await expect(page.getByText("“photo.png”: upload PDF, plain-text (.txt) or Markdown (.md) files.")).toBeVisible();
  await expect(page.getByText("“fake.pdf”: “fake.pdf” isn't a valid PDF file.")).toBeVisible();
  const documents = page.getByRole("region", { name: "Documents" }).getByRole("listitem");
  await expect(documents).toHaveCount(2);
  await expect(documents.first()).toContainText("guide.pdf"); // newest first
  await expect(page.getByRole("listitem", { name: "faq.md" })).toContainText("Ready · 1 chunk");
  await expect(page.getByRole("listitem", { name: "guide.pdf" })).toContainText("Ready · 1 chunk");
  await expect(page.getByText(/^2 documents ·/)).toBeVisible();

  // A document without text fails, with the reason; Retry processes it again.
  await page.locator("input[name=upload-documents]").setInputFiles([file("blank.md", "   \n\n  ")]);
  const blank = page.getByRole("listitem", { name: "blank.md" });
  await expect(blank).toContainText("Failed");
  await expect(blank).toContainText("No text found in this document.");
  await blank.getByRole("button", { name: "Retry blank.md" }).click();
  await expect(blank).toContainText("Failed"); // processed again: still nothing to find
  await page.getByRole("button", { name: "Delete blank.md" }).click();
  await page.getByRole("button", { name: "Delete document" }).click();
  await expect(documents).toHaveCount(2);

  // Drag and drop works too.
  const drop = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Plain notes"], "notes.txt", { type: "text/plain" }));
    return transfer;
  });
  await page.getByText("Drop PDF, text or Markdown files here").dispatchEvent("drop", { dataTransfer: drop });
  await expect(documents).toHaveCount(3);

  // The embedding model is fixed now that there are documents.
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Knowledge base settings" });
  await expect(settings.getByRole("combobox", { name: "Embedding model" })).toBeDisabled();
  await expect(settings.getByText("Fixed: its documents were embedded with this model.")).toBeVisible();
  await settings.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Delete faq.md" }).click();
  await page.getByRole("button", { name: "Delete document" }).click();
  await expect(documents).toHaveCount(2);
  await expect(page.getByText(/^2 documents ·/)).toBeVisible();
  await page.reload();
  await expect(documents).toHaveCount(2);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Knowledge" }).click();
  await expect(page.getByRole("article", { name: "Docs" })).toContainText("2 documents");
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete knowledge base" }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByText("No knowledge bases yet")).toBeVisible();
});

test("a flow searches a knowledge base with the Retriever, as a step and as an agent's tool", async ({
  editor,
  page,
}) => {
  // A knowledge base with two documents.
  await openDashboard(page);
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "New knowledge base" }).first().click();
  await page.getByRole("dialog").getByLabel("Name").fill("Help center");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: "Help center", exact: true }).click();
  await page.locator("input[name=upload-documents]").setInputFiles([
    file("passwords.md", "To reset your password, open the login page and choose Forgot password."),
    file("billing.md", "Invoices are emailed on the first day of each month."),
  ]);
  const documents = page.getByRole("region", { name: "Documents" }).getByRole("listitem");
  await expect(documents.filter({ hasText: "Ready" })).toHaveCount(2);

  // A flow using it: the Retriever as a step, and attached to an agent as a tool.
  await page.goto("/flows");
  await page.getByRole("button", { name: "New flow" }).first().click();
  await expect(editor.nodes).toHaveCount(2);
  await importFixture(editor, path.join(__dirname, "fixtures", "retriever-flow.mesh.json"), 6);
  await expect(editor.issuesButton("2 errors")).toBeVisible(); // no knowledge base chosen yet

  const field = editor.settings.getByRole("combobox", { name: /^Knowledge base/ });
  await editor.node("Docs search").click();
  // "New knowledge base…" creates one and selects it.
  await field.click();
  await page.getByRole("option", { name: "New knowledge base…" }).click();
  await page.getByRole("dialog", { name: "New knowledge base" }).getByLabel("Name").fill("Empty one");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(field).toContainText("Empty one");
  await expect(editor.settings.getByText(/0 documents — add some/)).toBeVisible();
  // …but the step should search the help center.
  await field.click();
  await page.getByRole("option", { name: "Help center" }).click();
  await expect(editor.settings.getByText(/2 documents · Open/)).toBeVisible();
  await expect(field).not.toHaveAttribute("aria-invalid"); // chosen: no longer flagged
  await editor.node("Docs tool").click();
  await field.click();
  await page.getByRole("option", { name: "Help center" }).click();
  await editor.readyToRun();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  const runPanel = page.getByRole("region", { name: "Run" });
  await expect(runPanel.getByRole("status", { name: "Run status" })).toHaveText("Succeeded", {
    timeout: 15_000,
  });
  // The step found the passwords document (top 1)…
  const answer = runPanel.getByRole("listitem", { name: "Answer output", exact: true });
  await expect(answer).toContainText("Forgot password");
  await expect(answer).toContainText("passwords.md");
  await expect(answer).not.toContainText("Invoices");
  // …and the agent called it as a tool with its own query (mock/tools: the user message).
  const helper = runPanel.getByRole("listitem", { name: "Helper output" });
  await expect(helper.getByRole("list", { name: "Tool calls" })).toContainText("docs_tool");
  await expect(runPanel.getByRole("listitem", { name: "Helper answer output" })).toContainText(
    "Forgot password",
  );

  // A knowledge base that gets deleted is flagged where flows use it.
  const flowUrl = page.url();
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "Actions for Help center" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete knowledge base" }).click();
  await expect(page.getByRole("article", { name: "Help center" })).toHaveCount(0);
  await page.goto(flowUrl);
  await editor.node("Docs search").click();
  await expect(field).toContainText("Deleted knowledge base");
  await expect(editor.settings.getByText("This knowledge base was deleted.")).toBeVisible();
});

test("a flow adds text to a knowledge base, which then lists it as a searchable document", async ({
  editor,
  page,
}) => {
  await openDashboard(page);
  await page.goto("/knowledge");
  await page.getByRole("button", { name: "New knowledge base" }).first().click();
  await page.getByRole("dialog").getByLabel("Name").fill("Notes");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("article", { name: "Notes" })).toBeVisible();

  await page.goto("/flows");
  await page.getByRole("button", { name: "New flow" }).first().click();
  await expect(editor.nodes).toHaveCount(2);
  await importFixture(editor, path.join(__dirname, "fixtures", "add-to-kb-flow.mesh.json"), 3);
  await editor.node("Save note").click();
  await editor.settings.getByRole("combobox", { name: /^Knowledge base/ }).click();
  await page.getByRole("option", { name: "Notes" }).click();
  await editor.readyToRun();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  const runPanel = page.getByRole("region", { name: "Run" });
  await expect(runPanel.getByRole("status", { name: "Run status" })).toHaveText("Succeeded", {
    timeout: 15_000,
  });
  await expect(runPanel.getByRole("listitem", { name: "Output output" })).toContainText(
    '"name": "Office notes.md"',
  );
  await runPanel.getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel.getByRole("list", { name: "Run log" })).toContainText(
    "“Office notes.md” is searchable (1 chunk)",
  );

  await page.goto("/knowledge");
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("listitem", { name: "Office notes.md" })).toContainText(
    "Ready · 1 chunk",
  );
});
