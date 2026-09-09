/**
 * Cloudflare Worker (free plan): send /_api on the public hostname to EC2.
 *
 * Origin Rules cannot override DNS on the free plan. A Worker route can.
 *
 * Dashboard: Workers & Pages → Create → paste this file → Deploy.
 * Triggers → Routes → Add:
 *   zen8agent.theprimitiveworks.com/_api*
 *
 * The Worker strips /_api so Caddy/the controller see /healthz, /auth, /runs, …
 * redirect: "manual" keeps GitHub OAuth 302s visible to the browser.
 */

const ORIGIN_HOST = "zen8agent-api.theprimitiveworks.com";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const origin = new URL(request.url);
    origin.hostname = ORIGIN_HOST;
    origin.pathname = incoming.pathname.replace(/^\/_api/, "") || "/";

    const init = {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      // Required when forwarding a streamed body (POST JSON, OAuth, sandbox callbacks).
      init.duplex = "half";
    }
    return fetch(origin, init);
  },
};
