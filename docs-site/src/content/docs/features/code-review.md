---
title: Code Review
description: Prioritized review with a ship/no-ship verdict via /review.
coverage: B
---

`/review` runs a structured code review of a diff and returns prioritized findings plus a ship/no-ship verdict. It works by fan-out: it builds a review prompt, then the spawned reviewer agents (one to many, scaled by diff size) carry out the work and emit structured `ReviewFinding` items and a `ReviewSummary`.

## Running /review

Invoke `/review` mode-less to be prompted for what to review. The interactive menu lists:

1. A PR detected from recent conversation (up to 3 — see [PR review](#pr-review))
2. Review against a base branch (PR style)
3. Review uncommitted changes
4. Review a specific commit
5. Custom review instructions (when no extra instructions were given on the command line)

In a headless session (`ctx.hasUI` is false) the command skips the menu and renders a headless review prompt directly, optionally focused by the arguments you passed.

You can pass extra plain-text instructions after `/review` to focus the review (for example `/review focus on auth changes`). When extra instructions are present, the Custom menu item is hidden.

You can also pass a PR reference directly on the command line — GitHub PR URLs or `pr://<owner>/<repo>/<number>` URIs — and `/review` jumps straight to PR review for that PR without showing the menu.

## How reviewer agents are chosen

The command always instructs the spawned agents to use `agent: "reviewer"` with a `tasks` array. The number of reviewer agents is computed from the diff:

| Size | Total lines changed | Files | Reviewer agents |
| --- | --- | --- | --- |
| Tiny | < 100 or ≤ 2 files | — | 1 |
| Small | < 500 | — | 1–2 |
| Medium | < 2,000 | — | 2–4 |
| Large | < 5,000 | — | 4–8 |
| Huge | ≥ 5,000 | — | 8–16 |

Files are grouped by locality — same directory/module, related functionality, tests with their implementation files — so each reviewer owns a coherent slice.

When the diff is `> 50_000` characters or touches more than `20` files, the inline diff is replaced with a per-file preview (`first ~100 lines per file`, minimum 5) and reviewer agents are told to run `git diff` / `git show` for their assigned files. For uncommitted changes, the instruction is to run both `git diff -- <path>` and `git diff --cached -- <path>`.

Build output, source maps, vendored code, images, fonts, and binary files are excluded automatically — they appear in the prompt under an "Excluded Files" section with the reason.

## Structured findings

Each reviewer emits `ReviewFinding` items and a final `ReviewSummary`:

```ts
interface ReviewFinding {
  title: string;
  body: string;
  priority: number;
  confidence: number;
  file_path: string;
  line_start: number;
  line_end: number;
}

interface ReviewSummary {
  overall_correctness: "correct" | "incorrect";
  explanation: string;
  confidence: number;
}
```

The orchestrator instructs reviewers to yield findings incrementally and never call a separate finding tool — `priority` and `confidence` are numeric scores carried on each finding, and `overall_correctness` is the ship/no-ship verdict (`"correct"` / `"incorrect"`) on the whole diff.

## PR review

When you review a PR, `/review` calls `gh pr view` to fetch PR metadata and the diff, then runs the same reviewer fan-out against the diff. PR refs are parsed from the command line:

- GitHub PR URLs: `https://github.com/<owner>/<repo>/pull/<number>`
- `pr://<owner>/<repo>/<number>` URIs (also `/diff`, `/diff/<i>`, or `/diff/all`)

When the command runs in an interactive UI, the most recent PR refs found in conversation context (up to `3`) are offered as menu shortcuts, so a PR discussed in chat can be reviewed without re-typing the URL. See [GitHub Integration](/oh-my-pi/features/github/) for the `pr://` URL scheme and the `pr_create` / `pr_checkout` / `pr_push` ops.

For large PRs (`> 50_000` chars of diff or `> 20` files), the reviewer is told to fetch its slice with `gh pr diff` for the assigned files; for normal PRs the diff is inlined.

## Custom review

Choosing Custom (or invoking `/review` with extra instructions in headless mode) prompts for instructions in an editor, then runs the reviewer fan-out against the current uncommitted diff using the first ~60 characters of the instructions as the review title.

## Follow-up flow

`/review` only builds and returns the prompt — the actual reviewer agent work runs through the same `task` tool fan-out as a regular subagent. To follow up on a finding or chase a deeper review, use `hub` to message the reviewer agent (its id is shown in the spawn summary). See [Subagents](/oh-my-pi/features/subagents/) for the hub messaging and artifact URLs.
