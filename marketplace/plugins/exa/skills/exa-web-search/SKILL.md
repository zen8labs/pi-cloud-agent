---
name: exa-web-search
description: Search the live web and fetch page content through Exa MCP tools.
---

# Exa web search

When the user needs current information from the web — news, facts, people,
companies, docs that are not in a library index, or the contents of a known URL —
use Exa MCP tools instead of relying on training data:

1. Call `web_search_exa` with a natural-language query that describes the ideal
   page (not bare keywords). Optionally set `numResults`.
2. When highlights are insufficient or the user gives a URL, call
   `web_fetch_exa` with one or more URLs.

Do not put secrets, tokens, or personal data in tool queries. Prefer one focused
question per search.
