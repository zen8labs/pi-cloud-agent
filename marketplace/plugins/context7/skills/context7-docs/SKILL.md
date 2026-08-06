---
name: context7-docs
description: Fetch up-to-date library documentation through Context7 MCP tools.
---

# Context7 documentation

When the user asks about a library, framework, SDK, or API — especially current
syntax, setup, or migration details — use Context7 MCP tools instead of relying
on training data:

1. Call `resolve-library-id` with the library name (unless the user already gave
   an id like `/org/project`).
2. Call `query-docs` with that library id and a focused question.

Do not put secrets, tokens, or personal data in tool queries. Prefer one
concept per query.
