import { expect, type Page, test } from "@playwright/test";

/**
 * The thinnest slice that still crosses every boundary: dashboard render, run
 * creation through the form, the session page folding the event log, and a
 * terminal state reaching the screen.
 *
 * No forge or sandbox credentials are assumed: in CI the run cannot provision,
 * so the reconciler fails it and the test asserts the failure is *shown*, not
 * hidden. With local credentials the same run succeeds instead; both terminal
 * states are accepted, because what is being tested is that the UI reports the
 * truth, not which truth the environment produces.
 */

const PROMPT = "What is this repository about? Answer in one sentence.";

/** Console errors fail the test; the missing favicon is a known, benign 404. */
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) {
      errors.push(message.text());
    }
  });
  return errors;
}

test("the dashboard renders the run list", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  // The footer count only appears after the first successful fetch, so this is
  // also the CORS assertion: no working API, no count.
  await expect(page.getByText(/\d+ of \d+ runs/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("the new-session form gates submit on a repo and a prompt", async ({ page }) => {
  await page.goto("/chat");
  const start = page.getByRole("button", { name: "Start" });
  await expect(page.getByText("Repository", { exact: true })).toBeVisible();
  await expect(page.getByText("Profile", { exact: true })).toBeVisible();
  await expect(start).toBeDisabled();

  // With no configured repos (CI), the custom path is the only one.
  await page.getByRole("combobox").first().selectOption("__custom__");
  await page.getByPlaceholder("owner/repo").fill("acme/widgets");
  await page.getByPlaceholder(/Describe the task/).fill(PROMPT);
  await expect(start).toBeEnabled();
});

test("a run reaches a terminal state and the session page shows it", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/chat");
  await page.getByRole("combobox").first().selectOption("__custom__");
  await page.getByPlaceholder("owner/repo").fill("acme/widgets");
  await page.getByPlaceholder(/Describe the task/).fill(PROMPT);
  await page.getByRole("button", { name: "Start" }).click();

  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]+/);
  await expect(page.getByRole("heading", { name: PROMPT })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();

  // The follow-up composer unlocks exactly when the run leaves an active state:
  // the wait doubles as the assertion that the terminal transition arrived live.
  await expect(page.getByRole("textbox")).toBeEnabled({ timeout: 180_000 });

  const badge = page.getByText(/^(Succeeded|Failed|Cancelled)$/).first();
  await expect(badge).toBeVisible();
  // A failure must come with its reason, not just a red badge.
  if ((await badge.textContent()) === "Failed") {
    await expect(page.getByRole("heading", { name: "Error" })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
