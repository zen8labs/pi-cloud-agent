import { type Context, Hono, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createWebSession, deleteWebSession } from "../db/auth";
import type { AppUserRow } from "../db/schema";
import { isOperator } from "../plugins/marketplace";
import { beginVcsConnection, finishGithubLogin } from "../vcs/connections";
import type { AppEnv } from "./deps";

const AUTH_STATE_COOKIE = "pca_github_auth_state";
const SESSION_COOKIE = "pca_session";
type SameSite = "Lax" | "None";

export function userOwns(user: AppUserRow | null, ownerId: string | null): boolean {
  return user ? user.id === ownerId : ownerId === null;
}

export async function requireAuthenticatedUser(c: Context<AppEnv>, next: Next): Promise<void> {
  if (!c.get("user")) {
    c.res = c.json({ error: "authentication required" }, 401);
    return;
  }
  await next();
}

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/github/connect", async (c) => {
    try {
      const started = await beginVcsConnection(
        c.get("database"),
        c.get("config"),
        "github",
        null,
        c.req.query("returnTo") === "settings" ? "settings" : null,
      );
      setCookie(
        c,
        AUTH_STATE_COOKIE,
        started.state,
        cookieOptions(c.req.url.startsWith("https://"), 600, "Lax"),
      );
      return c.redirect(started.url);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
    }
  });

  app.get("/github/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const savedState = getCookie(c, AUTH_STATE_COOKIE);
    deleteCookie(c, AUTH_STATE_COOKIE, { path: "/" });
    if (!state || !code || state !== savedState) return redirect(c, "invalid_auth_state");

    try {
      const result = await finishGithubLogin(c.get("database"), c.get("config"), state, code);
      const session = await createWebSession(
        c.get("database"),
        result.userId,
        c.get("config").auth.sessionSecret,
      );
      setCookie(
        c,
        SESSION_COOKIE,
        session,
        cookieOptions(
          c.req.url.startsWith("https://"),
          30 * 24 * 60 * 60,
          c.req.url.startsWith("https://") ? "None" : "Lax",
        ),
      );
      return c.redirect(
        result.returnTo === "settings"
          ? `${c.get("config").web.url}/settings?connection=connected`
          : `${c.get("config").web.url}/chat`,
      );
    } catch (error) {
      c.get("log").warn("GitHub authentication failed", { error });
      return redirect(c, "authentication_failed");
    }
  });

  app.get("/me", (c) => {
    const user = c.get("user");
    if (!user && !c.get("config").auth.requireUser) {
      return c.json({
        id: "local-test",
        login: "local",
        displayName: "Local test user",
        avatarUrl: null,
        isOperator: isOperator(c.get("config"), "local"),
      });
    }
    if (!user) return c.json({ error: "authentication required" }, 401);
    return c.json({
      id: user.id,
      login: user.login,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      isOperator: isOperator(c.get("config"), user.login),
    });
  });

  app.post("/logout", async (c) => {
    await deleteWebSession(
      c.get("database"),
      getCookie(c, SESSION_COOKIE),
      c.get("config").auth.sessionSecret,
    );
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}

function cookieOptions(secure: boolean, maxAge: number, sameSite: SameSite) {
  return {
    httpOnly: true,
    sameSite,
    secure,
    path: "/",
    maxAge,
  };
}

function redirect(c: Parameters<typeof setCookie>[0], result: string) {
  return c.redirect(`${c.get("config").web.url}/?auth=${encodeURIComponent(result)}`);
}
