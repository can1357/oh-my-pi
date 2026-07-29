# Forgejo Support Handoff — nimuebot (roboomp)

## Context

We deployed roboomp (the `oh-my-pi` triage+fix bot) to our Pi cluster on lxc209 (10.0.105.210). The bot is running as `nimuebot` and handles both GitHub and Forgejo (`git.theiahd.nl`). All changes are in the `djdembeck/oh-my-pi` fork on `main`, relative to upstream `can1357/oh-my-pi`.

## What was implemented

### Core: Forgejo platform support (9 commits, ~1095 lines diff across 13 files)

The approach was parameterization, not abstraction — no `PlatformClient` ABC, no `ForgejoClient`. Forgejo is GitHub-compatible at the API level, so we add env vars and platform detection.

**Architecture:** Two containers — `robomp` (orchestrator, never holds PATs) + `gh-proxy` (holds PATs, HMAC-gated). Platform detection routes API/git requests to the right host/token.

### Files changed

| File | What changed |
|---|---|
| `config.py` | `api_base`, `git_host`, `forgejo_token` fields in `Settings` + `_ProxyEnvLoader` |
| `github_client.py` | `GitHubClient.__init__` accepts `base_url` + `auth_prefix`; new `get_review_comment()` for #7935 workaround |
| `db.py` | `platform` column in events table; migration; `EventRow.platform` field |
| `github_events.py` | Auto-detect Forgejo from `X-Gitea-Delivery` headers; accept `pull_request_comment` event type + `reviewed` action; extract review content from Forgejo's `payload.review` structure |
| `server.py` | Platform detection at webhook receipt; store `platform` with event |
| `proxy_client.py` | `platform` param in `GitHubProxyClient` + `ProxyGitTransport`; HMAC-signed `platform` in query params |
| `proxy/server.py` | Per-request `GitHubClient` with platform-aware token/base_url/auth_prefix; `git_host` parameterized for clone/push URLs |
| `queue.py` | `_platform_github()` + `_platform_transport()` create per-event proxy clients; sandbox transport swapped per-event |
| `tasks.py` | Forgejo #7935 workaround (fetch review comment via API when empty); Forgejo review payload extraction |
| `worker.py` | Enable `review_mode` for `handle_review` task (agent gets `pr_review_comment` + `submit_pr_review` tools) |
| `docker-compose.yml` | `ROBOMP_API_BASE`, `ROBOMP_GIT_HOST` in robomp; `FORGEJO_TOKEN` in gh-proxy |
| `.env.example` | Documented Forgejo config section |
| `github_backend.py` | `get_review_comment` added to Protocol |

## Known issues & areas for cleanup

### 1. Duplicate code in `_platform_github()` and `_platform_transport()`
Both methods in `queue.py` create a `GitHubProxyClient`/`ProxyGitTransport` with the same `base_url`/`key` extraction. Could be factored into a shared helper or a factory.

### 2. Forgejo `issue.get("pull_request")` null check — applied in 5 files
The `if "pull_request" in issue:` → `if issue.get("pull_request") is not None:` fix was needed in `github_events.py` (2x), `github_client.py` (3x — `is_pull_request` field, `list_issues` filter, timeline event filter), and `server.py` (1x). These should ALL be upstreamed — Forgejo/Gitea always sends `pull_request: null` on issues.

### 3. `sqlite3.Row` `.get()` usage
The subagent used `row.get("platform", "github")` but `sqlite3.Row` doesn't have `.get()`. Fixed with `row["platform"] if "platform" in row.keys() else "github"`. This pattern appears 4x in `db.py` — could use a helper.

### 4. Background issue index sync doesn't pass platform
The periodic issue index sync (`issue_index.py`) calls `github.list_issue_index_entries()` through the shared `GitHubProxyClient` which defaults to `platform="github"`. Forgejo repos fail with 404 during background sync. Webhook-driven events work fine because they get per-event platform routing. The fix would be to make the issue index sync platform-aware (check if repo is on Forgejo or GitHub based on `ROBOMP_API_BASE`/`ROBOMP_GIT_HOST` settings).

### 5. Forgejo review comment payload structure
Forgejo sends review summary comments as `pull_request_comment` with `action: "reviewed"` and content in `payload.review.content` (not `payload.comment.body`). The routing in `github_events.py` and payload extraction in `tasks.py` handle both formats, but the code could be cleaner with a normalized payload adapter.

### 6. Forgejo review comment reply
`handle_review` now enables `review_mode=True` so the agent can use `pr_review_comment` (staged inline comments) and `submit_pr_review`. This works on both platforms. However, for direct threaded replies to specific comments (like mira-pr-tools does with `POST /pulls/{pr}/comments/{id}/replies`), there's no support yet. roboomp stages NEW inline comments at file/line positions rather than replying to existing comment threads.

### 7. `_ProxyEnvLoader` has duplicate blank-disable validators
`forgejo_token` has its own `_blank_forgejo_disables` validator in `_ProxyEnvLoader` that duplicates the `_blank_token_disables` pattern from `Settings`. Could share.

### 8. `AXONHUB_API_KEY_PI` env var alias
The infra compose maps `AXONHUB_API_KEY_PI` as an alias for `AXONHUB_API_KEY` because the auto-synced `models.yml` (from `update-axonhub-models.sh`) references `AXONHUB_API_KEY_PI`. This is an infra-specific hack, not in the oh-my-pi repo.

### 9. `scripts/secrets` bugs (infra repo, not oh-my-pi)
- `rot()` had unbound `tmp` variable under `set -u` — fixed
- `sync-file` didn't pass `--input-type dotenv` to sops decrypt, silently copying ciphertext — fixed
- Missing shebang (`#!/usr/bin/env bash`) — added

## Production readiness checklist for PR

- [ ] Deduplicate `_platform_github()` / `_platform_transport()` in queue.py
- [ ] Factor out `sqlite3.Row` safe access pattern in db.py
- [ ] Make issue index sync platform-aware (or at least not crash on Forgejo repos)
- [ ] Consider a payload normalization layer for Forgejo vs GitHub webhook payloads
- [ ] Add tests for Forgejo-specific event routing (pull_request:null, pull_request_comment, action:reviewed)
- [ ] Consider whether `review_mode=True` for `handle_review` is the right approach vs a more granular tool permission system
- [ ] Verify backwards compatibility: all changes default to GitHub behavior when no Forgejo env vars set

## Infra repo changes (not in oh-my-pi)

The infrastructure repo (`djdembeck/infrastructure`) has:
- `dal2/lxc209/robomp/docker-compose.yml` — adapted compose with AxonHub provider config
- `dal2/lxc209/robomp/.env.sops` — SOPS-encrypted secrets (HMAC keys are real, tokens need filling)
- `dal2/lxc209/robomp/.env.example` — documented config template
- `dal2/lxc209/robomp/models.container.yml` — AxonHub provider config (though now auto-synced via script)
- `dal2/lxc209/robomp/sync-models.sh` — wrapper for periodic model sync
- `dal2/lxc209/borgmatic/config.yaml` — backup config
- Traefik + AdGuard + borgmatic target entries
- `scripts/secrets` fixes (shebang, rot, sync-file)
