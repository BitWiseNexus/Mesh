import path from "node:path";

import { expect, importFixture, test } from "./helpers";

const FIXTURE = path.join(__dirname, "fixtures", "schedule-flow.mesh.json");

test("a Schedule trigger shows when it runs next, or why it won't", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, FIXTURE, 3);
  await editor.readyToRun();
  await editor.save();

  await editor.node("Every morning").click();
  const status = editor.settings.getByRole("region", { name: "Schedule status" });
  await expect(status).toContainText("Next runs (Europe/Berlin)");
  const times = status.getByRole("list", { name: "Next runs" }).getByRole("listitem");
  await expect(times).toHaveCount(3);
  for (const time of await times.allTextContents()) {
    expect(time).toMatch(/^(Mon|Tue|Wed|Thu|Fri) \d{1,2} \w{3}, 09:00$/);
  }

  // A cron expression the editor rejects, and the schedule (once saved) explains.
  const cron = editor.settings.getByRole("textbox", { name: /^Cron expression/ });
  await cron.fill("0 9 * * MON#2");
  await expect(editor.settings.getByRole("list", { name: "Problems with this node" })).toContainText(
    "Cron expression has an invalid day of the week: “MON#2”",
  );
  await editor.save();
  await expect(status).toContainText(
    "Not scheduled: The cron expression has an invalid day of the week: “MON#2”.",
  );

  // Every half hour, Kolkata time (UTC+5:30 — so :00 and :30 there).
  await cron.fill("*/30 * * * *");
  const timezone = editor.settings.getByRole("combobox", { name: "Timezone" });
  await timezone.fill("Asia/Kolk");
  await page.getByRole("option", { name: "Asia/Kolkata" }).click();
  await expect(timezone).toHaveValue("Asia/Kolkata");
  await editor.save();
  await expect(status).toContainText("Next runs (Asia/Kolkata)");
  for (const time of await times.allTextContents()) {
    expect(time).toMatch(/, \d{2}:(00|30)$/);
  }

  await editor.settings.getByRole("switch", { name: "Run on this schedule" }).click();
  await editor.save();
  await expect(status).toContainText("Off — switch on “Run on this schedule” to start it.");
  await expect(status.getByRole("list", { name: "Next runs" })).toHaveCount(0);
});

test("running a scheduled flow by hand uses the current time", async ({ editor, page }) => {
  await editor.open();
  await importFixture(editor, FIXTURE, 3);
  await editor.readyToRun();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  const runPanel = page.getByRole("region", { name: "Run" });
  await expect(runPanel.getByRole("status", { name: "Run status" })).toHaveText("Succeeded", {
    timeout: 15_000,
  });
  const year = new Date().getUTCFullYear();
  await expect(runPanel.getByRole("listitem", { name: "Report output" })).toContainText(
    `Report for ${year}-`,
  );
  await runPanel.getByRole("tab", { name: "Logs" }).click();
  await expect(runPanel.getByRole("list", { name: "Run log" })).toContainText(
    "Started by hand, not by the schedule: using the current time",
  );
});
