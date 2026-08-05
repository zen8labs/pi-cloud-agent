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
const MODEL_CONNECTION = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Test gateway",
  provider: "openai-compatible",
  api: "openai-completions",
  baseUrl: "https://gateway.example/v1",
  model: "gpt-5.4",
  models: [{ id: "gpt-5.4", contextWindow: 196_608, maxTokens: 32_000 }],
  contextWindow: 196_608,
  maxTokens: 32_000,
  isDefault: true,
};

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

async function ensureRepository(page: Page) {
  const custom = page.getByPlaceholder("owner/repo");
  if (await custom.isVisible()) {
    await custom.fill("acme/widgets");
  }
}

async function mockModelConnection(page: Page) {
  await page.route("**/llm/connections", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connections: [MODEL_CONNECTION] }),
    });
  });
}

test("the chat shell renders session history in the sidebar", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/chat");
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await expect(
    page.getByRole("complementary").getByRole("link", { name: "New task" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("settings exposes user-owned model connection choices", async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect ChatGPT plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Claude plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add custom model" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("settings scrolls expanded model connection forms", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Add custom model" }).click();

  const settings = page.getByTestId("settings-scroll");
  await expect(settings).toHaveClass(/overflow-y-auto/);
  expect(
    await settings.evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
});

test("ChatGPT connection sends the OAuth URL to the popup", async ({ page }) => {
  await page.route("**/llm/connections/oauth/chatgpt/start", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ flowId: "test-flow", eventsUrl: "/llm/oauth/test-flow/events" }),
    });
  });
  await page.route("**/llm/oauth/test-flow/events", async (route) => {
    const event = {
      type: "auth",
      event: { type: "auth_url", url: "https://chatgpt.com/oauth/test" },
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(event)}\n\n`,
    });
  });

  await page.goto("/settings");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect ChatGPT plan" }).click();
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toContain("chatgpt.com/oauth/test");
  await popup.close();
});

test("OAuth completion clears the connecting state", async ({ page }) => {
  await page.route("**/llm/connections/oauth/chatgpt/start", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        flowId: "complete-flow",
        eventsUrl: "/llm/oauth/complete-flow/events",
      }),
    });
  });
  await page.route("**/llm/oauth/complete-flow/events", async (route) => {
    const event = { type: "complete", connection: {} };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(event)}\n\n`,
    });
  });

  await page.goto("/settings");
  const connect = page.getByRole("button", { name: "Connect ChatGPT plan" });
  await connect.click();
  await expect(connect).toHaveText("Connect ChatGPT plan");
});

test("model connection form derives provider and gates required fields", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Add custom model" }).click();

  await expect(page.getByLabel("Provider ID")).toHaveCount(0);
  const save = page.getByRole("button", { name: "Save" });
  const testConnection = page.getByRole("button", { name: "Test" });
  await expect(save).toBeDisabled();
  await expect(testConnection).toBeDisabled();

  await page.getByLabel(/Name/).fill("My gateway");
  await page.getByLabel(/Base URL/).fill("https://gateway.example/v1");
  await page.getByLabel(/Model/).fill("example-model");
  await expect(save).toBeDisabled();

  await page.getByLabel(/API key/).fill("secret-key");
  await expect(save).toBeEnabled();
  await expect(testConnection).toBeEnabled();
  await page.route("**/llm/connections/test", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  await testConnection.click();
  await expect(page.getByRole("status")).toHaveText("Connection test succeeded.");
  await page.getByRole("button", { name: "Endpoint type details" }).click();
  await expect(page.getByRole("tooltip")).toContainText("derived from this choice");
});

test("the new-session form gates submit on a repo and a prompt", async ({ page }) => {
  await mockModelConnection(page);
  await page.goto("/chat");
  const start = page.getByRole("button", { name: "Start" });
  await expect(page.getByRole("textbox", { name: "Repository" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Profile" })).toBeVisible();
  await expect(start).toBeDisabled();

  // A configured repository is already selected. Credential-free CI exposes
  // the custom path instead, so only that environment needs a path filled in.
  await ensureRepository(page);
  await page.getByPlaceholder(/Describe the task/).fill(PROMPT);
  await expect(start).toBeEnabled();
});

test("a run reaches a terminal state and the session page shows it", async ({ page }) => {
  await mockModelConnection(page);
  const errors = watchConsole(page);
  await page.goto("/chat");
  await ensureRepository(page);
  await page.getByPlaceholder(/Describe the task/).fill(PROMPT);
  await page.getByRole("button", { name: "Start" }).click();

  // The first navigation may compile the dynamic session route in a cold dev server.
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]+/, { timeout: 30_000 });
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

test("the model picker shows the model name and sits after the branch picker", async ({
  page,
}) => {
  await mockModelConnection(page);
  await page.goto("/chat");
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText("gpt-5.4");
  const controls = page.locator('[role="combobox"]');
  const branchIndex = await controls.evaluateAll((items) =>
    items.findIndex((item) => item.getAttribute("aria-label") === "Branch"),
  );
  const modelIndex = await controls.evaluateAll((items) =>
    items.findIndex((item) => item.getAttribute("aria-label") === "Model"),
  );
  expect(branchIndex).toBeGreaterThanOrEqual(0);
  expect(modelIndex).toBeGreaterThan(branchIndex);
});
