import { join } from "node:path";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config";
import type { AppUserRow } from "../db/schema";
import {
  installPluginForUser,
  isOperator,
  listCatalogForUser,
  publishPlugin,
  seedMarketplacePlugins,
  setInstallMode,
  setReviewStatus,
  setUserVariables,
  uninstallPluginForUser,
} from "../plugins/marketplace";
import { beginPluginOAuth, finishPluginOAuth } from "../plugins/oauth";
import type { AppEnv } from "./deps";
import { redirectToOAuthStart, takeOAuthCallback } from "./oauth-cookie";

const OAUTH_STATE_COOKIE = "pca_plugin_oauth_state";

const reviewSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(["draft", "approved", "yanked"]),
});

const installModeSchema = z.object({
  name: z.string().min(1),
  installMode: z.enum(["default_off", "default_on", "required"]),
});

const installSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

const uninstallSchema = z.object({
  name: z.string().min(1),
});

const configureSchema = z.object({
  name: z.string().min(1),
  variables: z.record(z.string(), z.string()),
});

const publishSchema = z.object({
  /** Relative path under PLUGIN_MARKETPLACE_ROOT, e.g. "context7". */
  plugin: z.string().min(1),
  reviewStatus: z.enum(["draft", "approved"]).default("draft"),
  installMode: z.enum(["default_off", "default_on", "required"]).default("default_off"),
});

export function pluginRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const user = c.get("user");
    const operator = isOperator(c.get("config"), user?.login);
    const plugins = await listCatalogForUser(c.get("database"), user?.id ?? null, operator);
    return c.json({ plugins, isOperator: operator });
  });

  app.get("/oauth/callback", async (c) => {
    const { state, code, error, savedState } = takeOAuthCallback(c, OAUTH_STATE_COOKIE);
    if (error) {
      return redirectToPlugins(c, "denied", oauthErrorMessage(c));
    }
    if (!state || !code || state !== savedState) {
      return redirectToPlugins(c, "invalid_state");
    }
    try {
      const user = c.get("user");
      if (!user) return redirectToPlugins(c, "authentication_required");
      const result = await finishPluginOAuth(
        c.get("database"),
        c.get("config"),
        state,
        code,
        user.id,
      );
      return redirectToPlugins(c, "connected", undefined, result.pluginName);
    } catch (cause) {
      c.get("log").warn("plugin OAuth failed", { error: cause });
      return redirectToPlugins(
        c,
        "failed",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  });

  app.get("/:name/oauth/connect", async (c) =>
    redirectToOAuthStart(c, OAUTH_STATE_COOKIE, (userId) =>
      beginPluginOAuth(c.get("database"), c.get("config"), c.req.param("name"), userId),
    ),
  );

  app.post("/seed", async (c) => {
    if (!operatorOk(c.get("config"), c.get("user"))) {
      return c.json({ error: "operator access required" }, 403);
    }
    await seedMarketplacePlugins(c.get("database"), c.get("config"));
    const plugins = await listCatalogForUser(
      c.get("database"),
      c.get("user")?.id ?? null,
      true,
    );
    return c.json({ ok: true, plugins });
  });

  app.post("/publish", async (c) => {
    if (!operatorOk(c.get("config"), c.get("user"))) {
      return c.json({ error: "operator access required" }, 403);
    }
    const body = publishSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const source = join(c.get("config").plugins.marketplaceRoot, body.data.plugin);
    return awaitJson(c, () =>
      publishPlugin(
        c.get("database"),
        c.get("config"),
        source,
        body.data.reviewStatus,
        body.data.installMode,
        c.get("user")?.id ?? null,
      ),
    );
  });

  app.post("/review", async (c) => {
    if (!operatorOk(c.get("config"), c.get("user"))) {
      return c.json({ error: "operator access required" }, 403);
    }
    const body = reviewSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return awaitOk(c, () =>
      setReviewStatus(
        c.get("database"),
        body.data.name,
        body.data.version,
        body.data.status,
        c.get("user")?.id ?? null,
      ),
    );
  });

  app.post("/install-mode", async (c) => {
    if (!operatorOk(c.get("config"), c.get("user"))) {
      return c.json({ error: "operator access required" }, 403);
    }
    const body = installModeSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return awaitOk(c, () =>
      setInstallMode(
        c.get("database"),
        body.data.name,
        body.data.installMode,
        c.get("user")?.id ?? null,
      ),
    );
  });

  app.post("/install", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const body = installSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return awaitOk(c, () =>
      installPluginForUser(c.get("database"), user.id, body.data.name, body.data.enabled),
    );
  });

  app.post("/uninstall", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const body = uninstallSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return awaitOk(c, () => uninstallPluginForUser(c.get("database"), user.id, body.data.name));
  });

  app.post("/configure", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const body = configureSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.message }, 400);
    return awaitOk(c, () =>
      setUserVariables(
        c.get("database"),
        c.get("config"),
        user.id,
        body.data.name,
        body.data.variables,
      ),
    );
  });

  return app;
}

function operatorOk(config: Config, user: AppUserRow | null): boolean {
  return isOperator(config, user?.login);
}

function redirectToPlugins(
  c: Context<AppEnv>,
  result: string,
  message?: string,
  plugin?: string,
) {
  const params = new URLSearchParams({ oauth: result });
  if (message) params.set("message", message);
  if (plugin) params.set("plugin", plugin);
  return c.redirect(`${c.get("config").web.url}/plugins?${params.toString()}`);
}

function oauthErrorMessage(c: Context<AppEnv>): string {
  const code = c.req.query("error")?.trim();
  const description = c.req.query("error_description")?.trim();
  if (description && code) return `${description} (${code})`;
  return description || code || "authorization denied";
}

async function awaitOk(
  c: { json: (body: unknown, status?: number) => Response },
  action: () => Promise<void>,
): Promise<Response> {
  try {
    await action();
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function awaitJson(
  c: { json: (body: unknown, status?: number) => Response },
  action: () => Promise<unknown>,
): Promise<Response> {
  try {
    return c.json(await action());
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}
