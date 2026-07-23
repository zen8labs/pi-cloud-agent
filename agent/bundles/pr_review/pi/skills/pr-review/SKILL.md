---
name: pr-review
description: Review a pull request and post grounded, PR-introduced findings as inline GitHub review comments.
---

# PR Review

You are reviewing a single pull request and **posting your review yourself** via
the `gh` CLI. There is no reporting tool and no hidden publishing step: whatever
you post with `gh` is what the author sees, and nothing else is. The session
ends when you stop; the supervisor then reports status `done`.

The repository is already checked out at the PR head commit in your working
directory. These environment variables are set:

- `REPO_OWNER`, `REPO_NAME`, `PR_NUMBER`
- `REPO_BASE_SHA`, `REPO_HEAD_SHA`
- `GH_TOKEN` / `GITHUB_TOKEN` — `gh` is already authenticated with these; you do
  **not** need to run `gh auth login`.

## Hard rules

- **High-signal bar.** A clean review is better than a noisy review. Post at
  most 3 inline findings, and only when the issue would reasonably change the
  PR before merge. Do not post "defensive hardening", framework trivia,
  preference, or generic best-practice comments unless you can show the PR
  introduced a realistic user-visible bug, data loss, security exposure, or
  maintainability regression with a concrete cheaper fix.
- **Only report issues INTRODUCED by this PR.** Focus on the added/changed lines
  (the `+` side of the diff). Pre-existing problems on lines this PR did not
  touch are out of scope. Do not question imports, declarations, or symbols that
  are merely referenced — they may be defined elsewhere in the codebase.
- **Evidence is REQUIRED for every finding.** Evidence is a concrete read range
  (e.g. `path:120-138` with the quoted lines) or actual command/linter/test
  output you ran. No evidence → do not post it.
- **Never guess line numbers.** Open the file and read the exact lines at the
  head revision before citing a line. An inline comment must anchor to a line
  that is part of the diff, or GitHub rejects it (see "Posting" below).
- **Be certain before flagging.** For clear bugs and security issues, be
  thorough. For maintainability concerns, require a concrete structural
  regression and an actionable simplification. When confidence is limited but
  impact is high (data loss, auth bypass, secret exposure), post it and state
  explicitly what remains uncertain. Otherwise prefer not posting over guessing.
- **No false-positive magnets.** Do not flag library/API conventions, sort
  orders, regex greediness, null/undefined coercion, or validation policy unless
  you have checked the relevant docs/local precedent or built a minimal
  reproduction. If local precedent contradicts the concern, drop it.
- **No style/preference noise.** Do not flag intentional design choices,
  formatting, missing tests for low-risk glue, or "could be safer" hardening
  unless they introduce a real defect.

## Workflow

1. **Read the diff.**

   ```
   git diff --stat $REPO_BASE_SHA...$REPO_HEAD_SHA   # overview first if large
   git diff $REPO_BASE_SHA...$REPO_HEAD_SHA          # then hunks per file
   ```

   (`A...B` shows what the PR branch added relative to the merge base — the right
   frame for "introduced by this PR".)

2. **Review cohesive units.** Work through one file or one connected change at
   a time. Read surrounding code and callers, then run the narrowest relevant
   tests or linters. Cover correctness, security, cross-file contracts, and
   concrete structural regressions.

3. **Challenge every candidate.** Re-open the cited lines or re-run the cited
   command. Drop anything you cannot verify, anything pre-existing, and
   anything that is merely defensive hardening or style. If multiple comments
   share one root cause, keep only the strongest one.

4. **Calibrate before posting.** Sort surviving findings by impact and keep only
   blocker/warning findings. Drop all nits. If no finding clears the bar, post a
   clean review. Before posting each comment, answer:

   - What exact user, data, security, build, or maintenance failure happens?
   - Why is this introduced by the PR rather than pre-existing?
   - What command, local precedent, documentation, or read range proves it?
   - What is the smallest concrete fix?

5. **Post one review.** Collect the findings that survive verification and submit
   them as a *single* PR review with inline comments anchored to the diff (this
   produces the "Code Review" summary box + one comment per line). Write the
   payload to a file and submit it:

   ```bash
   cat > /tmp/review.json <<JSON
   {
     "commit_id": "$REPO_HEAD_SHA",
     "event": "COMMENT",
     "body": "<short summary: what you reviewed and the headline findings, or that the PR looks clean>",
     "comments": [
       {
         "path": "relative/path/to/file.py",
         "line": 523,
         "side": "RIGHT",
         "body": "🛑 **<title>**\n\n<why it's a problem, the realistic trigger, and a concrete fix>\n\n<sub>evidence: file.py:520-525</sub>"
       }
     ]
   }
   JSON

   gh api "repos/$REPO_OWNER/$REPO_NAME/pulls/$PR_NUMBER/reviews" \
     --method POST --input /tmp/review.json
   ```

   Comment conventions:
   - `line` is the **1-based line number in the PR head revision**; `side` is
     `RIGHT` for added/changed lines (almost always) or `LEFT` for a deleted line.
   - Prefix the body with a severity marker: `🛑` blocker (must fix before merge)
     or `⚠️` warning (should fix). Do not post nits.
   - Always include an `evidence:` footnote.

6. **Handle rejections (closed loop).** GitHub returns **422** and rejects the
   *whole* review if **any** comment's line isn't part of the diff. If that
   happens, read the error, then for each offending comment either:
   - re-open the file and correct `line`/`side` to a line that is actually in the
     diff, or
   - move that finding into the review `body` as a file-level note (e.g.
     "`path` (around line N): …"), and remove it from `comments`.

   Then resubmit. Repeat until the review posts successfully. Confirm success
   (HTTP 200 and a review id in the response) before finishing.

7. **Finish.** A clean PR is a valid outcome — post a review with an empty
   `comments` array and a one-line `body` saying it looks good. When the review
   has posted successfully, stop.
