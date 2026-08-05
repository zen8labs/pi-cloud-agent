import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { getAppUserForSession } from "../db/auth";
import { authRoutes } from "./auth";
import type { AppEnv, Deps } from "./deps";
import { internalRoutes } from "./internal";
import { metaRoutes } from "./meta";
import { runRoutes } from "./runs";
import { sessionRoutes } from "./sessions";
import { vcsRoutes } from "./vcs";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The controller's HTTP surface, in three groups:
 *
 *   /runs, /sessions   the operator API the dashboard drives
 *   /internal          the sandbox's outbound callbacks, authenticated per run
 *   /config, /repos, /vcs  dashboard metadata and VCS connections
 *
 * The operator API is user-scoped. GitHub App authorization establishes the
 * local session; dashboard routes resolve ownership from that session. Internal
 * sandbox callbacks remain separately authenticated with their run token.
 */
export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("config", deps.config);
    c.set("database", deps.database);
    c.set("log", deps.log);
    c.set(
      "user",
      await getAppUserForSession(
        deps.database,
        getCookie(c, "pca_session"),
        deps.config.auth.sessionSecret,
      ),
    );
    await next();
  });

  // The dashboard is a separate origin and consumes the SSE stream from the
  // browser, so it needs CORS. Internal routes authenticate themselves and are
  // unaffected. A lone "*" means any origin; Hono only treats it as a wildcard
  // as a bare string, not as an array element.
  const corsOrigins = deps.config.web.corsOrigins;
  app.use("*", cors({ origin: corsOrigins, credentials: true }));

  app.use("*", async (c, next) => {
    const publicPath =
      c.req.path === "/healthz" ||
      c.req.path.startsWith("/auth/") ||
      c.req.path.startsWith("/internal/");
    if (deps.config.auth.requireUser && !c.get("user") && !publicPath) {
      return c.json({ error: "authentication required" }, 401);
    }
    await next();
  });

  // SameSite=None enables a dashboard hosted on another site to send the
  // session cookie. State-changing browser requests must still come from a
  // configured dashboard origin, which prevents cross-site request forgery.
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (
      c.get("user") &&
      UNSAFE_METHODS.has(c.req.method) &&
      origin &&
      !corsOrigins.includes(origin)
    ) {
      return c.json({ error: "invalid request origin" }, 403);
    }
    await next();
  });

  app.onError((error, c) => {
    deps.log.error("unhandled request error", { path: c.req.path, error });
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/auth", authRoutes());
  app.route("/runs", runRoutes());
  app.route("/sessions", sessionRoutes());
  app.route("/internal", internalRoutes(deps.observability));
  app.route("/vcs", vcsRoutes());
  app.route("/", metaRoutes());

  return app;
}
