/**
 * Cloudflare Worker (free plan): send /_api on the public hostname to EC2.
 *
 * AWS security groups on this instance allow 80 (HTTP) and 22, not 443.
 * Caddy therefore serves plain HTTP. The Worker must fetch http:// (not
 * https://) and zen8agent-api must be DNS-only (grey cloud). If that record
 * is orange-clouded, Cloudflare still dials origin :443 and you get 522.
 *
 * Dashboard: Workers & Pages → edit this Worker → Deploy.
 * Route: zen8agent.theprimitiveworks.com/_api*
 */

const ORIGIN = "http://zen8agent-api.theprimitiveworks.com";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const origin = new URL(incoming.pathname.replace(/^\/_api/, "") || "/", ORIGIN);
    origin.search = incoming.search;

    const init = {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }
    return fetch(origin, init);
  },
};
