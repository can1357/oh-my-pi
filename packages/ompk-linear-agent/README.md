# ompk-linear-agent

Cloudflare Worker that registers as a Linear Agent ("ompk"), receives webhooks
when an issue reaches the queue-admission state, reads the `model:<combo-id>`
label off the issue, and queues a job for a local relay to execute — then
posts the result back to Linear as a comment.

The same Worker, queue, and relay also back the **account-wide GitHub App
integration**: `@ompk` mentions on GitHub Issues and Pull Requests enter the
identical job pipeline through `/github/webhook` (see
[GitHub App integration](#github-app-integration-ompk-on-issuesprs)).

## Pieces

- `src/index.ts` — Cloudflare entrypoint (binds the real Linear + GitHub APIs and the Durable Object queue)
- `src/worker.ts` — request handlers (`/webhook`, `/github/webhook`, `/poll`, `/result`, `/heartbeat`, `/reconcile`, `/fence-check`, `/status`)
- `src/dispatch-policy.ts` — Linear webhook dispatch authorization + replay dedupe key
- `src/linear.ts` — Linear webhook signature verification + GraphQL calls
- `src/github.ts` — GitHub App JWT/installation tokens, webhook HMAC verification, REST calls
- `src/github-dispatch.ts` — `@ompk` mention parsing + event authorization helpers
- `src/queue-core.ts` / `src/queue-do.ts` — atomic, lease-fenced job queue (Durable Object)
- `relay/relay.ts` — Windows-side long-poll relay that runs jobs via `omp --print`

## Dispatch authorization

A signed webhook is necessary but not sufficient. A job is queued only when
ALL of the following hold (see `docs/multi-agent-fork-collaboration.md`):

- the event is an `Issue` `create`/`update` carrying a `linear-delivery` id;
- the issue carries exactly one `Queue/*` label and it is `Queue/Queued`
  (the dispatcher-selected admission state);
- the issue is assigned to `LINEAR_AGENT_USER_ID`;
- the issue's project is in `ALLOWED_PROJECT_IDS`;
- the `model:<combo-id>` label is in `ALLOWED_MODELS`.

Deliveries are deduplicated on `delivery id + issue revision`, and at most one
active job may exist per issue. Missing allowlist configuration fails closed.

## GitHub App integration (@ompk on Issues/PRs)

A single GitHub App installed account-wide on `kingkillery` gives `@ompk`
Copilot-style mention behavior across every repository. GitHub events flow
into this package's Durable Object queue and relay; only the adapter
differs from Linear. Anthropic execution keeps using the relay machine's
existing CLI OAuth login (`omp login` / `omp auth-broker`) — no
`ANTHROPIC_API_KEY` anywhere, and no OAuth credential ever leaves the relay
host.

> **Deployed topology (2026-08):** the GitHub App `pk-ompk` (App ID 4503460)
> points at a dedicated instance of this Worker, `pk-ompk-github`
> (`https://pk-ompk-github.pkkidking.workers.dev/github/webhook`), deployed
> with `wrangler deploy --name pk-ompk-github`. The pre-existing
> `ompk-linear-agent` Worker runs an older, separate Linear implementation
> with a different secret contract and was deliberately left untouched; its
> Linear-facing behavior is unaffected. On the `pk-ompk-github` instance the
> Linear secrets are random placeholders, so Linear webhooks fail closed.

### Create the App (manual, one-time)

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**:

- **Webhook URL**: `https://<worker-host>/github/webhook`
- **Webhook secret**: a fresh random value (becomes `GITHUB_WEBHOOK_SECRET`)
- **Repository permissions**: Contents *read & write*, Issues *read & write*,
  Pull requests *read & write*, Metadata *read-only*
- **Subscribed events**: Issues, Issue comment, Pull request,
  Pull request review, Pull request review comment
- Generate a **private key** (PEM) and note the **App ID**.

Install the App on the `kingkillery` account with **All repositories** —
that is the account-wide switch; new repos are covered automatically. Note
the installation id from the installation URL
(`.../settings/installations/<id>`).

### Configure the Worker

```sh
npx wrangler secret put GITHUB_WEBHOOK_SECRET   # webhook signing secret
npx wrangler secret put GITHUB_APP_ID           # numeric App id
npx wrangler secret put GITHUB_APP_PRIVATE_KEY  # PKCS#8 PEM (literal \n accepted)
# edit wrangler.toml [vars]: GITHUB_INSTALLATION_ID, GITHUB_ACCOUNT_LOGIN,
# GITHUB_MENTION_HANDLE (default "ompk"), GITHUB_MODEL (combo id jobs run with)
npx wrangler deploy
```

The App's private key exists only as a Worker secret; the relay never sees
it. GitHub calls authenticate exclusively with short-lived (1 h)
installation tokens minted by the Worker.

### GitHub dispatch authorization

A signed webhook is necessary but not sufficient. A GitHub job is queued only
when ALL of the following hold (`src/worker.ts` + `src/github-dispatch.ts`,
each check fails closed):

- the `X-Hub-Signature-256` HMAC verifies against `GITHUB_WEBHOOK_SECRET`;
- the delivery carries `X-GitHub-Delivery` and a supported event:
  `issues.opened`, `issue_comment.created`, `pull_request.opened`,
  `pull_request_review.submitted`, `pull_request_review_comment.created`;
- the payload's installation id equals `GITHUB_INSTALLATION_ID` and the
  installation account equals `GITHUB_ACCOUNT_LOGIN`;
- the body/title/comment contains a real `@ompk` mention outside code fences
  and inline code, authored by a non-bot user;
- the author is trusted: `OWNER`/`MEMBER`/`COLLABORATOR` association, or a
  collaborator whose permission resolves to `write`/`maintain`/`admin`;
- the target is not a fork-originated PR (head repo must equal base repo);
- `GITHUB_MODEL` is configured (503 otherwise).

Duplicate protection: jobs dedupe on a redelivery-stable key
(`github:issue_comment:<comment-id>`, `github:review:<review-id>`,
`github:pr_opened:<repo>#<n>`, …) — GitHub redeliveries change the delivery
GUID but reuse these ids, so retries and manual redeliveries no-op. At most
one active job exists per `<repo>#<number>`; a second mention while one is
active refreshes the prompt under the same attempt rules as Linear.

### GitHub job execution

1. The Worker admits the job (`source: "github"`) with repo metadata
   (`owner/repo`, number, default branch, PR head ref, installation id).
2. The relay's `/poll` grant carries the metadata plus a fresh installation
   token. The relay clones the repo into a per-job workspace under
   `OMPK_RELAY_GITHUB_ROOT` (default `<workspace>/github-workspaces`),
   checks out the PR head branch — or a new `ompk/issue-<n>-<jobid>` branch
   off the default branch for issues — and runs `omp` there. Linear jobs
   keep using the static `OMPK_RELAY_WORKSPACE`.
3. The child env carries `GH_TOKEN` plus a git `insteadOf` rewrite, so `git
   push` and `gh pr create` inside the run authenticate as the App
   installation. The pre-push fence guard applies unchanged.
4. The relay scrubs the installation token from all reported output, then
   posts `/result`; the Worker mints a NEW installation token at result time
   and posts the outcome as an issue/PR comment (tokens expire after 1 h, so
   completion never reuses the leased one). Reconcile parking and
   dead-letter comments follow the same path.

The leased token expires after 1 h; the default job timeout (30 min) fits
inside that budget. Raising `OMPK_RELAY_JOB_TIMEOUT_MS` past ~55 min will
break pushes late in a GitHub job.

### Anthropic authentication (unchanged)

The relay host authenticates models exactly like the interactive CLI:

```sh
omp login            # interactive Anthropic OAuth; stores tokens in AuthStorage
# or, for a shared/headless relay host:
omp auth-broker login anthropic && omp auth-broker serve
```

`omp` resolves credentials from local auth storage / the broker at spawn
time. Nothing GitHub-related touches them, and they never appear in Worker
secrets, webhook payloads, or job output.

### Manual infrastructure checklist

Repository code cannot create these; they are one-time account operations:

1. Create the GitHub App (settings above) and generate its private key.
2. Install it account-wide on `kingkillery` (**All repositories**).
3. Set the three `GITHUB_*` Worker secrets + `wrangler.toml` vars; deploy.
4. Run the relay on a host that has `omp` logged in to Anthropic.
5. Send a test mention and watch `wrangler tail` + `/status`.

## Queue semantics

The queue is a single Durable Object (`JobQueue`); admission, leasing,
heartbeats, and completion are serialized. Every lease issues an
`attemptId` + `leaseToken`; completion requires both, so a stale relay can
never overwrite a newer attempt or repeat the Linear comment (duplicate
completion of the accepted attempt is acknowledged idempotently).

Liveness follows the reconcile contract from
`docs/multi-agent-fork-collaboration.md`:

- The relay heartbeats every `heartbeatMs` (10 min, carried on the lease
  grant); each fenced beat re-arms the 30-minute lease.
- A lease that misses two heartbeats (or expires) is parked in `reconcile`
  by the poll-time sweep or the Durable Object storage alarm — it is never
  re-granted directly, and its issue claim is retained. Each parking is
  mirrored to the Linear issue as a comment.
- Reconcile resolves only by: a fenced heartbeat (runner was alive —
  restored to `leased`), a fenced late completion (finished work is kept),
  a relay startup sweep attesting it has no live children, or an
  admin-credential resolution after out-of-band confirmation.
- Confirmed-terminated jobs requeue while attempts remain (5 total) and
  dead-letter as `failed` once the budget is exhausted; dead letters post
  the last error plus recovery action to the issue.

Failures are classified for retry (`failureClass` on the result):

- The relay marks timeouts, spawn errors, and allowlist mismatches as
  `transient`; a clean non-zero `omp` exit is `permanent` (deterministic
  until proven otherwise), and an absent class fails closed as permanent.
- A transient failure inside the attempt budget returns the job to
  `pending` behind a backoff gate (30s / 2m / 5m / 15m / 30m by attempt),
  posts nothing to Linear (no per-retry noise), and invalidates the
  attempt's fence; the gate never blocks later jobs in the queue. On
  budget exhaustion the failure comment carries the budget note.

Attempt identity and prompt refresh:

- Every grant stamps a logical attempt key,
  `linear:<organizationId>:<issueId>:<attempt>` (`unknown` when the webhook
  carried no organization), exposed in `/status` for audit and
  cross-referencing; the unguessable fence stays separate.
- An authorized issue revision arriving while a job is active refreshes the
  prompt instead of being dropped: a `pending` job takes it immediately, an
  in-flight job stages it for the next grant (the running attempt keeps the
  prompt it started with). Latest revision wins; identical content and
  replayed deliveries no-op as duplicates.

Branch-mutation fencing:

- The relay exports the fence triple (`OMPK_FENCE_JOB` / `_ATTEMPT` /
  `_TOKEN`, plus `OMPK_FENCE_URL`) and a `core.hooksPath` override
  (`GIT_CONFIG_*`) into the `omp` child, pointing at
  `relay/git-hooks/pre-push`. Every `git push` in the child tree first
  validates the fence against `POST /fence-check` (unauthenticated by
  design: the fence triple is the credential, and the runner env must never
  carry relay bearer tokens). Superseded, resolved, or terminal fences —
  and network partitions — block the push fail-closed; a reconcile-parked
  fence remains valid because the original runner still owns the attempt.
  The override shadows repo-local hooks for the child, which is intended
  for a headless runner workspace.

## Flow

1. The dispatcher assigns the issue to the `ompk` agent, adds
   `model:<combo-id>` (e.g. `model:qwen3.5plus`) and `Queue/Queued`.
2. Linear sends a webhook to `/webhook`; the Worker verifies the signature,
   authorizes the dispatch as above, and admits a job into the Durable Object
   queue.
3. The relay polls `/poll` with `RELAY_TOKEN`, receives the job plus its lease
   identity and heartbeat cadence, checks the model against its own
   `OMPK_RELAY_MODELS` allowlist, and spawns
   `omp --print --yolo --model <combo-id> -- <prompt>` — argv only, never a
   shell. While the job runs it posts fenced heartbeats to `/heartbeat`; a
   409 means the lease was lost, so the relay kills the child and discards
   the result.
4. The relay posts the result (with `attemptId` + `leaseToken`) to `/result`;
   the Worker validates the fence and comments on the Linear issue once. On
   startup the relay posts `{ runner, startupSweep: true }` to `/reconcile`,
   attesting it has no live children so its parked jobs can requeue.

`/status` requires the separate `STATUS_TOKEN` admin credential and returns
redacted operational metadata only — never prompts, outputs, or tokens.

## Deploy runbook

Run in order from `packages/ompk-linear-agent/`:

```sh
bun install        # from repo root, once
npx wrangler secret put LINEAR_WEBHOOK_SECRET   # Linear OAuth app webhook signing secret
npx wrangler secret put LINEAR_API_TOKEN        # the app's developer/actor=app token
npx wrangler secret put RELAY_TOKEN             # shared secret for the relay
npx wrangler secret put STATUS_TOKEN            # separate admin credential for /status
# edit wrangler.toml [vars]: LINEAR_AGENT_USER_ID, ALLOWED_PROJECT_IDS, ALLOWED_MODELS
npx wrangler deploy                             # applies the v1 JobQueue DO migration
```

Post-deploy verification:

```sh
curl -s https://<worker-host>/                          # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" https://<worker-host>/status   # 401 (no credential)
```

Then set the Linear OAuth app's **Redirect URI** and **Webhook URL** to the
deployed Worker's `/oauth/callback` and `/webhook` paths, and confirm
production deliveries carry the `linear-delivery` header (send a test webhook
and check `wrangler tail`): dispatch fails closed without it.

The legacy `JOBS` KV namespace is no longer read or bound. **In-flight KV
jobs are not migrated** — drain or accept their loss before deleting:

```sh
npx wrangler kv namespace delete --namespace-id f10e089956604618b922c46d0dc70f24
```

## Runtime smoke

Unit tests cover the queue state machine under serialized ops; the smoke
drives the real workerd runtime (auth, DO serialization, fencing) end to end.

```sh
# terminal 1 — secrets live in .dev.vars (never committed)
npx wrangler dev

# terminal 2 — basic mode: health + auth + signature rejection + 404s
LINEAR_WEBHOOK_SECRET=... RELAY_TOKEN=... STATUS_TOKEN=... bun scripts/dev-smoke.ts

# full mode additionally exercises webhook→poll→result→status against a REAL
# scratch Linear issue (completion posts a comment to it), including
# concurrent-poll exclusivity, a forged-token 409, and idempotent duplicates:
SMOKE_ISSUE_ID=<scratch-issue-uuid> LINEAR_WEBHOOK_SECRET=... RELAY_TOKEN=... STATUS_TOKEN=... bun scripts/dev-smoke.ts
```

The full-mode issue must satisfy the dispatch policy (assigned to the agent
user, allowlisted project + model, `Queue/Queued` label).

## Run the relay

```sh
cd packages/ompk-linear-agent
WORKER_URL=https://ompk-linear-agent.pkkidking.workers.dev \
RELAY_TOKEN=<same value as the RELAY_TOKEN secret> \
OMPK_RELAY_MODELS=qwen3.5plus,minimax-m3 \
bun run relay
```

Required env vars: `RELAY_TOKEN`, `OMPK_RELAY_MODELS` (comma-separated model
allowlist; jobs naming any other model are reported back as failures without
executing). Optional: `RELAY_NAME` (defaults to hostname),
`OMPK_RELAY_WORKSPACE` (cwd `omp` runs in, defaults to the relay's own cwd),
`OMPK_RELAY_POLL_MS` (default 5000), `OMPK_RELAY_JOB_TIMEOUT_MS` (default
30 min), `OMPK_RELAY_OMP_BIN` (absolute path to the `omp` executable when
PATH resolution can't find it), `OMPK_RELAY_GITHUB_ROOT` (parent directory
for per-job GitHub clones, defaults to `<workspace>/github-workspaces`;
each GitHub job clones fresh and is deleted afterwards).

### Relay security posture

The relay runs `omp` with `--yolo`: argv-only dispatch and the model
allowlists bound the mechanical blast radius, but a hostile issue body still
steers the agent's behavior inside its workspace. Treat relay workspaces as
untrusted-input surfaces:

- always set `OMPK_RELAY_WORKSPACE` to a dedicated scratch checkout — never a
  workspace holding credentials, production configuration, or work you cannot
  lose (the default is only the relay's own cwd);
- run the relay under a low-privilege user where practical;
- keep `OMPK_RELAY_MODELS` minimal.

## Automation boundary

This Worker implements the *manual admission* mode of
[docs/multi-agent-fork-collaboration.md](../../docs/multi-agent-fork-collaboration.md):
a human dispatcher sets `Queue/Queued` and the assignee before anything runs.

Of the fuller automation contract described there, the liveness, retry,
identity, and branch-fencing pieces are now implemented: fenced heartbeats,
reconcile parking (never a direct re-grant), runner startup attestation,
reconcile/dead-letter surfacing as issue comments, transient-failure
retries with the documented backoff schedule, per-grant logical attempt
keys, in-flight prompt refresh, and the pre-push fence guard on branch
mutations. Still intentionally unimplemented until built and verified: the
`Queue/Reconcile` / `Queue/Dead Letter` label mirroring (comments only
today) and the append-only transition audit log.

## Testing

```sh
bun --cwd=packages/ompk-linear-agent test test   # queue, policy, worker, relay contract tests
bun --cwd=packages/ompk-linear-agent run check:types
```

## Current scope / known gaps

- The relay always runs jobs on whatever machine it's started on. Dispatching
  a job to a different mesh host (mac/hetzner/pi) would mean wrapping the
  argv-based `spawn` call in an SSH exec (see the `pkmesh` skill) — not
  implemented yet since jobs don't carry a target-host field.
- Retry classification is coarse: every clean non-zero `omp` exit is treated
  as permanent, including provider 5xx surfaced as exit codes. Refining it
  means parsing runner output, which is deliberately out of scope for now.
- The startup sweep assumes `omp` children died with the relay process. On
  hosts where a child can outlive the relay, verify manually before relying
  on the attestation.
