import { getConfig } from "./config";
import { createWebSession, upsertAppUser } from "./db/auth";
import { closeDatabase, createDatabase } from "./db/client";
import { listLlmConnections, setDefaultLlmConnection } from "./db/llm-connections";
import { saveApiKeyConnection } from "./llm/connections";

const config = getConfig();
const database = createDatabase(config.databaseUrl);

try {
  const user = await upsertAppUser(database, {
    githubUserId: "browser-e2e-user",
    login: "browser-e2e-user",
    displayName: "Browser E2E User",
  });
  const existing = (await listLlmConnections(database, user.id)).find(
    (connection) => connection.provider === "browser-e2e-provider",
  );
  const connection =
    existing ??
    (await saveApiKeyConnection(database, config, {
      userId: user.id,
      displayName: "Browser E2E model",
      provider: "browser-e2e-provider",
      api: "openai-completions",
      baseUrl: "https://model.example.test/v1",
      model: "gpt-5.4",
      apiKey: "browser-e2e-key",
      contextWindow: 196_608,
      maxTokens: 32_000,
      isDefault: true,
    }));
  if (!connection.isDefault) await setDefaultLlmConnection(database, user.id, connection.id);

  const cookie = await createWebSession(database, user.id, config.auth.sessionSecret);
  process.stdout.write(
    `E2E_SESSION_COOKIE=${cookie}\nE2E_MODEL_CONNECTION_ID=${connection.id}\n`,
  );
} finally {
  await closeDatabase(database);
}
