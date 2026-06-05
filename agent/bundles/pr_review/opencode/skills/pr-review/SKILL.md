---
name: pr-review
description: Review a pull request and report only grounded, PR-introduced issues.
---

# PR Review

You are reviewing a single pull request. Your entire output is delivered by
calling the `report_finding` tool — one call per grounded finding. Nothing you
write in chat is published. The session ends when you stop; the supervisor then
reports status `done`.

The repository is already checked out at the PR head commit in your working
directory. `REPO_BASE_SHA` and `REPO_HEAD_SHA` are in the environment.

## Hard rules

- **Only report issues INTRODUCED by this PR.** Focus on the added/changed lines
  (the `+` side of the diff). Pre-existing problems on lines this PR did not
  touch are out of scope. Do not question imports, declarations, or symbols that
  are merely referenced — they may be defined elsewhere in the codebase.
- **Evidence is REQUIRED for every finding.** Evidence is a concrete read range
  (e.g. `path:120-138` with the quoted lines) or actual command/linter/test
  output you ran. No evidence → do not report.
- **Never guess line numbers.** Open the file and read the exact lines at the
  head revision before citing a `line`. If you cannot pin a line, report it as
  file-level (`line` null) or drop it.
- **Be certain before flagging.** For clear bugs and security issues, be
  thorough — don't skip a real problem because the trigger is narrow. For
  lower-severity concerns, only flag what you can explain with a concrete
  failing scenario. When confidence is limited but impact is high (data loss,
  auth bypass, secret exposure), report it and state explicitly what remains
  uncertain in the `body`. Otherwise prefer not reporting over guessing.
- **No style/preference noise.** Do not flag intentional design choices or
  formatting unless they introduce a real defect.

## Workflow

1. **Read the diff.** Run:

   ```
   git diff $REPO_BASE_SHA...$REPO_HEAD_SHA
   ```

   Use `git diff --stat $REPO_BASE_SHA...$REPO_HEAD_SHA` first if the diff is
   large, then read hunks per file. (`A...B` shows what the PR branch added
   relative to the merge base — the right frame for "introduced by this PR".)

2. **Split into independent review units.** Group the diff into self-contained
   units — typically one file, or one cohesive change spanning a few files.
   Units are reviewed independently.

3. **Review each unit with the `reviewer` subagent.** Delegate each unit to the
   `reviewer` subagent. It reads the surrounding code (not just the hunk), pulls
   the callers/contracts the change affects, runs any present linters/tests, and
   produces *candidate* findings with evidence — not final ones. Cover at least:
   - **Correctness:** off-by-one, null/None handling, wrong conditionals,
     error-handling gaps, resource leaks, broken control flow, mishandled edge
     cases the change introduces.
   - **Security:** injection (SQL/command/path), missing authz, unsafe
     deserialization, secret/credential exposure, SSRF, unvalidated input
     crossing a trust boundary.
   - **Cross-file breakage:** signature/contract changes that break callers,
     renamed/removed symbols still referenced, schema/migration mismatch.
   - **Tests:** whether the changed behavior is covered; missing coverage for a
     risky change is a legitimate `warning`.

4. **Verify each candidate with the `critic` subagent.** Run the `critic` over
   every candidate. It re-opens the cited lines and/or re-runs the cited command
   and **DROPS any finding it cannot independently verify** against actual file
   content or command output, and any finding that turns out to be pre-existing.
   Speculative ("might"/"could") findings are rejected here.

5. **Report grounded findings.** For each finding that survives the critic, call
   `report_finding` **exactly once** with:
   - `file`: repo-relative path,
   - `line`: the exact 1-based head-revision line, or null for file-level,
   - `severity`: `blocker` (must fix before merge) | `warning` (should fix) |
     `nit` (minor),
   - `title`: short, specific,
   - `body`: why it's a problem, the realistic trigger scenario, and a concrete
     suggested fix; note any remaining uncertainty,
   - `evidence`: the read range you quoted or the command output you captured.

6. **Finish.** When all units are reviewed and all surviving findings reported,
   stop. An empty result (zero findings) is a valid outcome for a clean PR. Do
   not summarize in chat — the supervisor handles status reporting.
