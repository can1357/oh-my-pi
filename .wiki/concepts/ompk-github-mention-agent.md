---
type: Concept
title: "@ompk GitHub mention agent and relay isolation"
description: Claude/Copilot-style @ompk mention agent — from a repo-scoped Actions prototype to an account-wide GitHub App adapter on the ompk-linear-agent worker — plus the relay execution-isolation tranche (container-per-job, credential-free setup hook, clone cache) and its review fixes.
tags: [ompk-linear-agent, github-app, mention-agent, relay, isolation, security, cloudflare-worker]
timestamp: 2026-08-06T00:00:00Z
status: implemented
---

# @ompk GitHub mention agent and relay isolation

Mentioning `@ompk` in an issue/PR comment, review, or body — or assigning an issue to it — now runs the OMPK coding agent against that thread, Claude Code / Copilot-style. The feature landed in two architectures, the second replacing the first, followed by an execution-isolation tranche on the relay.

## Phase 1: repo-scoped Actions prototype

`29cab8001` shipped `.github/workflows/ompk-mention.yml` plus `scripts/ompk-mention-agent.ts` (~860 lines, ~650 lines of tests):

- **Mention matching** follows GitHub html-pipeline `MentionFilter` semantics; code blocks and spans are ignored, so backticked `@ompk` never triggers.
- **Trust gate:** only `OWNER`/`MEMBER`/`COLLABORATOR` associations or a live write+ permission check may trigger a run.
- **Structural delivery:** the driver creates `ompk/issue-<n>` work branches itself. Fork PRs are **refused before any checkout**, so no fork-controlled source ever executes with secrets.
- **M2 verification gate:** the agent must emit a digest-bound `AssignmentContract` and a mandatory `assignment-result/v1` block. `verifyAssignmentResult()` then re-runs the parent-authored checks — clean worktree, baseline-diff changed files, non-empty report, commits pushed — before any success outcome. Criterion commands are shell-quote-hardened; a verified reply is posted as a comment, and failed verification fails the run.

`8598733fe` hardened the prototype without changing behavior:

- Extracted `runMentionAgent(event, payload, deps)` from `main()`. Only the two external seams — the `gh` CLI and the agent process — are injectable; git and the M2 verifier's parent-authored checks always run for real.
- Added trigger-path integration tests over a real git fixture: verified answer-only run, missing result block, fabricated success over unpushed commits (caught by the real verifier), and fork-PR refusal before any checkout or agent spawn.
- Parameterized the mention handle via `vars.OMPK_MENTION_HANDLE`, one knob shared by the workflow prefilter and the driver. Documented that the `issues.assigned` path needs a real GitHub user/App login while text mentions work without one.
- Corrected a stale "credential stripping" claim in the workflow header: the implemented model is refusal before checkout.

## Phase 2: account-wide GitHub App adapter

`0ac15e66a` replaced the Actions prototype (deleted outright — a repo-scoped workflow and an account-wide App would double-fire) with a `/github/webhook` route on the `ompk-linear-agent` Cloudflare Worker:

- HMAC webhook verification, code-fence-aware mention parsing, trust policy (association or collaborator permission), fork rejection, and redelivery-stable dedupe.
- GitHub App JWT and installation tokens are minted in the Worker; results, reconcile, and dead-letter comments are posted with fresh tokens rather than stored credentials.
- The relay gained per-job clone/branch workspaces, `GH_TOKEN` + `insteadOf` auth for agent pushes, and installation-token scrubbing of all reported output.
- The job envelope was generalized with `source` (`linear` | `github`) and a GitHub target, so one queue/relay pipeline serves both Linear and GitHub triggers.
- Deployed as the dedicated worker `pk-ompk-github`; the pre-existing `ompk-linear-agent` worker (different secret contract) was left untouched.

## Relay isolation tranche

`a44130ae3` closed the top gaps vs Copilot/Codex/Claude cloud-environment handling identified in the SOTA review. All of it is in `packages/ompk-linear-agent/relay/relay.ts`:

- **Container-per-job:** setting `OMPK_RELAY_CONTAINER_IMAGE` gates `podman run --rm` with a workspace bind-mount, tmpfs `HOME`, memory/pids limits, and an explicit env allowlist (fence + git + `GH_TOKEN` only) — never the host `process.env`. Off by default; bare mode is byte-compatible with the pre-tranche relay.
- **Repo setup hook:** `.ompk/setup.sh` runs pre-agent with a credential-free environment (no `GH_TOKEN`, git-config, or fence vars), bounded by `OMPK_RELAY_SETUP_TIMEOUT_MS`. Failures surface scrubbed and truncated.
- **Clone cache:** per-repo bare mirrors under `.mirrors/` with dissociated reference clones; any cache failure falls back to a full clone.

Deferred by design: egress filtering (`--network=host` in v1), concurrency > 1, and in-container model auth (needs an auth-broker on the VM). 128 tests passed at merge.

## Review P1 fixes

`8be25d693` resolved the follow-up review's priority findings:

- **Container teardown:** attempt-scoped container names (`--name`) with a detached runtime kill plus an awaited `podman rm --force` retry, so fence loss or timeout reliably destroys the OCI container — not just the CLI process.
- **Redaction boundary:** the streaming redactor now holds back secret-prefix boundaries at the capture cut, eliminating token-prefix leaks after truncation (a token split across the truncation boundary previously leaked its prefix). Boundary tests included.

A six-finding audit was resolved and the final reviewer pass was clean.

## Conventions and decisions worth reusing

- **Refuse before checkout, not strip-after-clone.** Fork-controlled code never executes in a secret-bearing context; the security boundary is drawn before any source is materialized.
- **Agents cannot self-certify.** The M2 gate pattern — agent emits a machine-checkable result block, the parent re-runs the checks — generalizes to any delegated-execution flow.
- **Minimal injectable seams.** Dependency-inject only external processes (`gh`, agent spawn); keep verification logic real even in tests, and integrate over a real git fixture.
- **Default-off, byte-compatible rollout.** New isolation layers ship disabled and leave the existing path untouched (`OMPK_RELAY_CONTAINER_IMAGE` unset = old relay, byte-for-byte).
- **Setup hooks are credential-free.** Repo-controlled code (`.ompk/setup.sh`) runs before credentials enter the environment, with its own timeout and scrubbed failure output.
- **Streaming redaction must be boundary-aware.** When truncating captured output, hold back any trailing prefix of a known secret pattern; truncation points are a leak surface.

## Source links

- [Knowledge bundle index](../index.md)
- [Bundle update log](../log.md)
- [Recent History — 2026-08](recent-history-2026-08.md)
- [Remote workspace](remote-workspace.md) — the separate local Docker sandbox job system
- `packages/ompk-linear-agent/README.md` — operator-facing worker/relay documentation
