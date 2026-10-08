import {
  expect,
  newUser,
  openDashboard,
  signInViaUi,
  signOutViaUi,
  signUpViaUi,
  test,
} from "./helpers";

test("signed-out visitors are sent to sign in and returned afterwards", async ({ page }) => {
  await page.goto("/flows");
  await expect(page).toHaveURL(/\/login\?next=%2Fflows$/);
  await expect(page.getByRole("heading", { name: "Sign in to Mesh" })).toBeVisible();

  await signUpViaUi(page, newUser("Grace Hopper"));
  await expect(page).toHaveURL(/\/flows$/);
  await expect(page.getByRole("button", { name: /^Account: Grace Hopper/ })).toHaveText("GH");
});

test("the old /canvas URL redirects to the dashboard", async ({ page }) => {
  await page.goto("/canvas");
  await expect(page).toHaveURL(/\/login\?next=%2Fflows$/);
});

test("sign out from a flow, sign back in, and land on the same saved flow", async ({ editor, page }) => {
  const user = await editor.open();
  await editor.drop("Agent", 420, 150);
  await editor.save();
  const flowId = editor.flowId();

  await signOutViaUi(page);
  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fflows%2F${flowId}$`));
  await signInViaUi(page, user);
  await expect(page).toHaveURL(new RegExp(`/flows/${flowId}$`));
  await expect(editor.nodes).toHaveCount(3);
});

test("the login form is blank again after signing out", async ({ page }) => {
  await openDashboard(page); // signs up through the login form
  await signOutViaUi(page);
  await expect(page.getByLabel("Email")).toHaveValue("");
  await expect(page.getByLabel("Password")).toHaveValue("");
});

test("each user sees only their own flows", async ({ editor, page }) => {
  await editor.open(newUser("Alice"));
  await editor.save();
  const aliceFlow = editor.flowId();
  await page.goto("/flows");
  await expect(page.getByRole("article")).toHaveCount(1);
  await signOutViaUi(page);

  await openDashboard(page, newUser("Bob"));
  await expect(page.getByRole("heading", { name: "Create your first flow" })).toBeVisible();

  // Even with the URL, Alice's flow looks like it doesn't exist. (The browser logs the expected
  // 404 as a console error, so stop the fixture's console check here.)
  page.removeAllListeners("console");
  await page.goto(`/flows/${aliceFlow}`);
  await expect(page.getByRole("heading", { name: "Flow not found" })).toBeVisible();
});

test("shows friendly errors for bad credentials and taken emails", async ({ page }) => {
  const user = await openDashboard(page);
  await signOutViaUi(page);

  await signInViaUi(page, { email: user.email, password: "wrong-password" });
  await expect(page.locator("#auth-error")).toHaveText("Email or password is incorrect.");

  await signUpViaUi(page, user);
  await expect(page.locator("#auth-error")).toContainText("already exists");
});

test("the next parameter can't redirect off-site", async ({ page }) => {
  await page.goto("/login?next=https://evil.example/phish");
  await signUpViaUi(page, newUser());
  await expect(page).toHaveURL(/localhost:\d+\/flows$/);
});

test("Google sign-in (Auth emulator popup)", async ({ page }) => {
  await page.goto("/login");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  const popup = await popupPromise;

  // The emulator's fake Google account chooser.
  await popup.getByRole("button", { name: /add new account/i }).click();
  await popup.getByLabel(/email/i).fill(newUser().email);
  await popup.getByLabel(/display name/i).fill("Katherine Johnson");
  await popup.getByRole("button", { name: /sign in with google/i }).click();

  await expect(page).toHaveURL(/\/flows$/);
  await expect(page.getByRole("button", { name: /^Account: Katherine Johnson/ })).toBeVisible();
});
