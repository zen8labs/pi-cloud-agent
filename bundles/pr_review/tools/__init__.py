"""pr_review custom tools.

The single ``report_finding`` tool is now an **OpenCode plugin tool**
(``report_finding.js``, a ``tool()`` from ``@opencode-ai/plugin``), staged into
``.opencode/tool/`` by the in-sandbox supervisor and loaded directly by OpenCode
— it is no longer a hand-rolled stdio MCP server launched as a Python module.
This package therefore holds no runtime Python tool code; it exists so the
``bundles.pr_review.tools`` namespace stays importable.
"""
