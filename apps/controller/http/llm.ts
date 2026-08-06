import {
  createLlmConnectionSchema,
  type LlmConnectionsResponse,
} from "@pi-cloud-agent/protocol";
import { Hono } from "hono";
import {
  deleteLlmConnection,
  listLlmConnections,
  setDefaultLlmConnection,
} from "../db/llm-connections";
import {
  listLlmConnectionSummaries,
  saveApiKeyConnection,
  testLlmEndpoint,
  toSummary,
} from "../llm/connections";
import {
  isOAuthProvider,
  type OAuthFlowEvent,
  type OAuthFlowManager,
  oauthProviderNames,
} from "../llm/oauth";
import type { AppEnv } from "./deps";

export function llmRoutes(oauth: OAuthFlowManager): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/connections", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const response: LlmConnectionsResponse = {
      connections: await listLlmConnectionSummaries(c.get("database"), user.id),
    };
    return c.json(response);
  });

  app.get("/oauth/providers", (c) => c.json({ providers: oauthProviderNames() }));

  app.post("/connections/oauth/:provider/start", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const provider = c.req.param("provider");
    if (!isOAuthProvider(provider)) return c.json({ error: "unsupported OAuth provider" }, 422);
    const flowId = oauth.start(user.id, provider);
    return c.json({ flowId, eventsUrl: `/llm/oauth/${flowId}/events` }, 201);
  });

  app.get("/oauth/:flowId/events", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const flowId = c.req.param("flowId");

    const encoder = new TextEncoder();
    let closed = false;
    let closeStream: () => void = () => undefined;
    let unsubscribe: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (event: OAuthFlowEvent) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (event.type === "complete" || event.type === "error") closeStream();
        };
        const active = oauth.subscribe(flowId, user.id, write);
        if (!active) {
          controller.error(new Error("OAuth flow not found"));
          return;
        }
        unsubscribe = active.unsubscribe;
        closeStream = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          controller.close();
        };
        for (const event of active.events) write(event);
        c.req.raw.signal.addEventListener("abort", closeStream, { once: true });
      },
      cancel() {
        closed = true;
        unsubscribe();
      },
    });
    return c.body(stream, 200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
  });

  app.post("/oauth/:flowId/input", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const body = await c.req.json().catch(() => null);
    const value =
      typeof body === "object" && body !== null ? (body as { value?: unknown }).value : null;
    if (typeof value !== "string") return c.json({ error: "value is required" }, 422);
    if (!oauth.submit(c.req.param("flowId"), user.id, value)) {
      return c.json({ error: "OAuth flow is not waiting for input" }, 409);
    }
    return c.json({ ok: true });
  });

  app.post("/connections/test", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const parsed = createLlmConnectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "invalid connection", issues: parsed.error.issues }, 422);
    try {
      await testLlmEndpoint(parsed.data);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 422);
    }
  });

  app.post("/connections", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const parsed = createLlmConnectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "invalid connection", issues: parsed.error.issues }, 422);

    const existing = await listLlmConnections(c.get("database"), user.id);
    const row = await saveApiKeyConnection(c.get("database"), c.get("config"), {
      ...parsed.data,
      userId: user.id,
      isDefault: parsed.data.isDefault || existing.length === 0,
    });
    c.get("log").info("model connection saved", {
      userId: user.id,
      connectionId: row.id,
      provider: row.provider,
      model: row.model,
    });
    return c.json(toSummary(row), 201);
  });

  app.post("/connections/:id/default", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const modelId = c.req.query("modelId");
    const updated = await setDefaultLlmConnection(
      c.get("database"),
      user.id,
      c.req.param("id"),
      modelId,
    );
    if (!updated) return c.json({ error: "model connection or model not found" }, 404);
    return c.json({ ok: true });
  });

  app.delete("/connections/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const deleted = await deleteLlmConnection(c.get("database"), user.id, c.req.param("id"));
    if (!deleted) return c.json({ error: "model connection not found" }, 404);
    const remaining = await listLlmConnections(c.get("database"), user.id);
    const firstRemaining = remaining[0];
    if (firstRemaining && !remaining.some((connection) => connection.isDefault)) {
      await setDefaultLlmConnection(c.get("database"), user.id, firstRemaining.id);
    }
    return c.json({ ok: true });
  });

  return app;
}
