import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, Deps } from "./deps";
import { internalRoutes } from "./internal";
import { metaRoutes } from "./meta";
import { runRoutes } from "./runs";
import { sessionRoutes } from "./sessions";

/**
 * The controller's HTTP surface, in three groups:
 *
 *   /runs, /sessions   the operator API the dashboard drives
 *   /internal          the sandbox's outbound callbacks, authenticated per run
 *   /config, /repos    what the dashboard needs to render
 *
 * There is no authentication on the operator API in this phase. That is a
 * deliberate gap, not an oversight: this runs on a developer's machine or behind
 * a private network, and adding a half-designed auth layer would give a false
 * sense of protection. Anything exposed publicly needs a real one first — see
 * docs/operations.md.
 */
export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("config", deps.config);
    c.set("database", deps.database);
    c.set("log", deps.log);
    await next();
  });

  // The dashboard is a separate origin and consumes the SSE stream from the
  // browser, so it needs CORS. Internal routes authenticate themselves and are
  // unaffected. A lone "*" means any origin; Hono only treats it as a wildcard
  // as a bare string, not as an array element.
  const corsOrigins = deps.config.web.corsOrigins;
  app.use(
    "*",
    cors({ origin: corsOrigins.includes("*") ? "*" : corsOrigins, credentials: false }),
  );

  app.onError((error, c) => {
    deps.log.error("unhandled request error", { path: c.req.path, error });
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/runs", runRoutes());
  app.route("/sessions", sessionRoutes());
  app.route("/internal", internalRoutes());
  app.route("/", metaRoutes());

  return app;
}
