# Atlassian

First-party context plugin for Jira and Confluence through Atlassian's hosted Rovo MCP server.

## What it provides

- Read Jira work items, fields, comments, changelogs, and links.
- Read Confluence pages, comments, versions, attachments, and related content.
- Search Jira and Confluence when direct links do not contain enough context.
- Traverse Teamwork Graph relationships to find connected Atlassian objects.

The requested OAuth scopes are read/search only. This plugin does not request Jira or Confluence write, delete, or administration scopes.

## Connect

1. Seed the marketplace with `pnpm plugins:seed`.
2. Open **Plugins**, install **Atlassian**, and choose **Connect**.
3. Approve the Jira and Confluence sites the agent may read.
4. Start a task whose prompt contains the Jira key or URL and any known Confluence URLs.

The controller performs OAuth 2.1 with PKCE, stores the access and refresh tokens encrypted, refreshes them when needed, and sends only the access token in the run's resolved MCP configuration. Atlassian still enforces the connected user's site permissions.

The access token is visible to the untrusted sandbox while a run is active. Its read scope can cover more Jira and Confluence content than the seed URLs in the task. Treat this as a disclosed pilot limitation until MCP traffic is mediated by a trusted proxy with a narrow run capability. Tool results also become model context, so the deployment's model data-handling agreement must cover the Atlassian content users retrieve.

An Atlassian organization administrator may need to allow the deployment's callback domain in Rovo MCP settings. The controller's authorization-server allowlist must include `auth.atlassian.com`.

## Context policy

The bundled skill starts from explicit work-item/page identifiers, follows only relevant relationships, and keeps facts tied to their source. It avoids copying an entire Atlassian workspace into the model context and never invokes write or destructive MCP tools.
