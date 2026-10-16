import { expect, openDashboard, test } from "./helpers";

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
  await card.getByRole("button", { name: "Product docs", exact: true }).click();
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
