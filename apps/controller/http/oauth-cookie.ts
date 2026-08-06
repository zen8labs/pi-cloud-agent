import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./deps";

/** Short-lived HttpOnly cookie that binds the browser to an OAuth `state`. */
function setOAuthStateCookie(c: Context<AppEnv>, name: string, state: string): void {
  setCookie(c, name, state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.req.url.startsWith("https://"),
    path: "/",
    maxAge: 600,
  });
}

/** Read callback query params and clear the matching state cookie. */
export function takeOAuthCallback(
  c: Context<AppEnv>,
  cookieName: string,
): {
  state: string;
  code: string;
  error: string | undefined;
  savedState: string | undefined;
} {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const error = c.req.query("error");
  const savedState = getCookie(c, cookieName);
  deleteCookie(c, cookieName, { path: "/" });
  return { state, code, error, savedState };
}

/** Start a browser OAuth redirect after requiring a signed-in user. */
export async function redirectToOAuthStart(
  c: Context<AppEnv>,
  cookieName: string,
  start: (userId: string) => Promise<{ state: string; url: string }>,
): Promise<Response> {
  try {
    const user = c.get("user");
    if (!user) return c.json({ error: "authentication required" }, 401);
    const started = await start(user.id);
    setOAuthStateCookie(c, cookieName, started.state);
    return c.redirect(started.url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 503);
  }
}
