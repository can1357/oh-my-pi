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
- `src/worker.ts` — request handlers (`/webhook`, `/github/webhook`, `/poll`, `/result`, `/heartbeat`, `/reconcile`, `/fence-check`, `/github-token`, `/status`)
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
   token for host-side workspace preparation only. It refreshes a bare mirror
   at `<OMPK_RELAY_GITHUB_ROOT>/.mirrors/<owner>-<repo>.git`, then makes the
   per-job clone with `--reference-if-able --dissociate`. Mirror failures log
   a warning and fall back to a full clone; the disposable workspace never
   depends on the mirror after cloning.
3. The relay checks out the PR head branch — or a new
   `ompk/issue-<n>-<jobid>` branch off the default branch for issues. If the
   checkout declares `.ompk/setup.sh`, the relay runs it with `bash` before
   the agent, without GitHub, git-rewrite, relay, or lease-fence credentials.
4. With no `OMPK_RELAY_CONTAINER_IMAGE`, `omp` runs directly in the workspace.
   This **bare mode is intentionally unfenced for network egress** and keeps
   the existing `GH_TOKEN`/credentialed-git behavior for compatibility. Use it
   only when model-written code is trusted to share the relay host network.
5. Setting `OMPK_RELAY_CONTAINER_IMAGE` enables the fenced mode. Each attempt
   gets an internal Podman bridge plus an nftables input fence. Only the
   currently active proxy/broker ports on that bridge are reachable:
   - setup: a CONNECT proxy for GitHub, npm/Yarn, PyPI, and crates.io;
   - agent: a different CONNECT proxy for `api.anthropic.com` and the local
     fence/git broker.
   The setup proxy and all of its established sockets are destroyed before
   the agent proxy starts. DNS answers that resolve an allowlisted hostname to
   private or special-use addresses are rejected. Network, proxy, broker, or
   firewall initialization failure fails the job transiently; fenced mode
   never falls back to `--network=host`.
6. A container receives only a random, attempt-local broker capability in its
   git URL rewrite; it is never sent to GitHub and is not a GitHub credential.
   The host broker calls `POST /github-token` with both the host-only
   `RELAY_TOKEN` bearer and the current fence tuple, injects the resulting JIT
   installation token into the upstream request, and never returns that token
   or the relay bearer to the container. The broker pins smart-HTTP and PR
   requests to the job's `owner/repo`, parses `git-receive-pack` command
   pkt-lines before token issuance, and rejects every target outside
   `refs/heads/ompk/*`; `--no-verify` cannot bypass the server-side check. A
   read-only `gh` compatibility shim supports only `gh pr create` with
   title/body/base/head/draft (and a matching `--repo`); the host broker creates
   the PR and returns only its number, canonical URL, and draft state.
7. The relay scrubs the lease-time installation token from all reported output,
   then posts `/result`; the Worker mints a new installation token at result
   time and posts the outcome as an issue/PR comment. Reconcile parking and
   dead-letter comments follow the same path.

Fenced container mode requires `nft` (or `OMPK_RELAY_NFT_BIN`) to be available
to the relay with permission to create and delete per-attempt `inet` tables.
This requirement is fail-closed: do not grant a host-network fallback.

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
  `relay/git-hooks/pre-push`. Every `git push` first validates the fence
  against `POST /fence-check` (the fence triple is the credential; the runner
  never carries relay bearer tokens). In fenced container mode that request
  goes through the per-job broker, and both the hook and the broker require
  target refs under `refs/heads/ompk/*`; only the broker check is authoritative.
  Superseded, resolved, or terminal fences — and network partitions — block
  the push fail-closed; a reconcile-parked fence remains valid because the
  original runner still owns the attempt. The override shadows repo-local
  hooks for the child, which is intended for a headless runner workspace.

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
executing). Existing optional settings remain: `RELAY_NAME` (hostname),
`OMPK_RELAY_WORKSPACE` (relay cwd), `OMPK_RELAY_POLL_MS` (5000),
`OMPK_RELAY_JOB_TIMEOUT_MS` (30 min), `OMPK_RELAY_OMP_BIN` (`omp`), and
`OMPK_RELAY_GITHUB_ROOT` (`<workspace>/github-workspaces`).

Isolation, setup, and cache settings:

| Environment variable | Default | Effect |
| --- | --- | --- |
| `OMPK_RELAY_CONTAINER_IMAGE` | empty (off) | Runs each setup/agent phase with `podman run --rm`; empty keeps bare-process execution and requires no Podman installation. |
| `OMPK_RELAY_CONTAINER_BIN` | `podman` | Container runtime binary or absolute path used when an image is enabled. |
| `OMPK_RELAY_CONTAINER_MEMORY` | `4g` | Per-container memory limit. Containers also use a fixed 2048 PID limit, tmpfs `HOME`, and an attempt-specific internal network; fenced mode never uses host networking. |
| `OMPK_RELAY_SETUP_TIMEOUT_MS` | `600000` | Hard timeout for a repository's optional `.ompk/setup.sh`. |
| `OMPK_RELAY_GITHUB_ROOT` | `<workspace>/github-workspaces` | Holds disposable job clones plus reusable bare mirrors under `.mirrors/`. |

The container image is operator-provided and must contain `omp`, Bun, Git,
`bash`, `/bin/sh`, and `curl` (the mounted pre-push fence hook uses the latter
two). Model authentication must work without mounting the host credential
store and with agent egress restricted to `api.anthropic.com`. The agent
container receives only its minimal `PATH`/`HOME`, proxy settings, the fence
tuple, and, for GitHub jobs, an attempt-local broker capability plus pinned
repository metadata. It receives no `GH_TOKEN`, installation token, or
`RELAY_TOKEN`. Setup containers receive no fence, broker, or GitHub
credentials.

### Relay security posture

The relay runs `omp` with `--yolo`: argv-only dispatch and the model
allowlists bound the mechanical blast radius, but a hostile issue body still
steers the agent's behavior inside its workspace. Treat relay workspaces as
untrusted-input surfaces:

- always set `OMPK_RELAY_WORKSPACE` to a dedicated scratch checkout — never a
  workspace holding credentials, production configuration, or work you cannot
  lose (the default is only the relay's own cwd);
- run the relay under a low-privilege user where practical;
- keep `OMPK_RELAY_MODELS` minimal;
- enable `OMPK_RELAY_CONTAINER_IMAGE` only on Linux relays where Podman,
  netavark, and the relay's permission to manage per-attempt nftables tables
  have been validated. Initialization fails closed. Leaving the setting empty
  selects compatibility-oriented bare mode, which is explicitly unfenced.

### Linux Podman security canary

Run this against a disposable repository and GitHub App installation before
enabling fenced mode. Exercise both rootful Podman and the intended rootless
relay account. Start an unrelated host service first:

```sh
HOST_CANARY_PORT=18080
python3 -m http.server "$HOST_CANARY_PORT" --bind 0.0.0.0 >/tmp/ompk-host-canary.log 2>&1 &
HOST_CANARY_PID=$!
```

In the disposable repository's setup hook, keep the phase alive long enough
to inspect it and prove that only setup destinations work:

```sh
set -eu
curl -fsS --max-time 15 https://registry.npmjs.org/ >/dev/null
curl -fsS --max-time 15 https://github.com/ >/dev/null
if curl -sS --max-time 10 https://api.anthropic.com/ >/dev/null; then
	echo "agent-only Anthropic endpoint was reachable during setup" >&2
	exit 1
fi
GATEWAY=${NO_PROXY%%,*}
if curl --noproxy '*' -fsS --max-time 3 "http://$GATEWAY:18080/" >/dev/null; then
	echo "host gateway canary was reachable during setup" >&2
	exit 1
fi
sleep 60
```

Use this as the GitHub job's agent-phase shell canary (replace
`WORKER_CANARY_URL` and `FOREIGN_REPO` with real values). A `401`/`404` from
Anthropic is acceptable because it proves the CONNECT and TLS path worked;
curl must not report status `000`.

```sh
set -eu
export WORKER_CANARY_URL=https://ompk-linear-agent.example.workers.dev/
export FOREIGN_REPO=owner/a-different-installed-repository
GATEWAY=${NO_PROXY%%,*}

must_fail() {
	if timeout 5 env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
		"$@" >/dev/null 2>&1; then
		echo "unexpected direct egress: $*" >&2
		exit 1
	fi
}

must_fail curl --noproxy '*' -fsS https://example.com/
must_fail curl --noproxy '*' -fsS "$WORKER_CANARY_URL"
must_fail curl --noproxy '*' -fsS "http://$GATEWAY:18080/"
must_fail curl --noproxy '*' -fsS http://host.containers.internal:18080/
must_fail curl --noproxy '*' -fsS http://127.0.0.1:18080/
must_fail curl --noproxy '*' -fsS http://2130706433:18080/
must_fail curl --noproxy '*' -fsS http://0x7f000001:18080/
must_fail curl --noproxy '*' -g -fsS 'http://[::1]:18080/'
for port in 22 80 443 2375 18080; do
	if timeout 2 bash -c ":</dev/tcp/$GATEWAY/$port" >/dev/null 2>&1; then
		echo "unexpected host gateway port: $GATEWAY:$port" >&2
		exit 1
	fi
done

test "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://api.anthropic.com/)" != 000
if curl -fsS --max-time 10 https://registry.npmjs.org/ >/dev/null; then
	echo "setup-only registry was reachable during agent phase" >&2
	exit 1
fi
BROKER_RESPONSE=$HOME/ompk-broker-canary-response
BROKER_STATUS=$(curl -sS --max-time 5 -o "$BROKER_RESPONSE" -w '%{http_code}' \
	"$OMPK_BROKER_URL/credential")
test "$BROKER_STATUS" = 403
! grep -E 'ghs_[A-Za-z0-9_]+|RELAY_TOKEN|GH_TOKEN' "$BROKER_RESPONSE"
rm -f "$BROKER_RESPONSE"

git checkout -B ompk/podman-canary
git -c user.name=ompk-canary -c user.email=ompk-canary@example.invalid \
	commit --allow-empty -m 'ompk Podman canary'
git push origin HEAD:refs/heads/ompk/podman-canary
gh pr create --draft --repo "$OMPK_GITHUB_REPO" \
	--base "$OMPK_GITHUB_DEFAULT_BRANCH" --head ompk/podman-canary \
	--title 'ompk Podman canary' --body 'Disposable fenced-mode canary.'
! git push --no-verify origin HEAD:refs/heads/main
! git ls-remote "https://github.com/$FOREIGN_REPO.git"
! gh pr create --draft --repo "$FOREIGN_REPO" \
	--base main --head ompk/podman-canary --title forbidden --body forbidden

! env | grep -E '^(RELAY_TOKEN|GH_TOKEN)='
if for environ in /proc/[0-9]*/environ; do
	tr '\0' '\n' <"$environ" 2>/dev/null || true
done | grep -E '^(RELAY_TOKEN|GH_TOKEN)=|ghs_[A-Za-z0-9_]+'; then
	echo "credential found in a container process environment" >&2
	exit 1
fi
! git config --show-origin --list | grep -E 'ghs_[A-Za-z0-9_]+'
! grep -R -E 'ghs_[A-Za-z0-9_]+' /workspace "$HOME" /tmp 2>/dev/null
```

While the agent is running, verify the host view contains no credential:

```sh
CTR=$(podman ps --filter 'name=ompk-' --format '{{.Names}}' | sed -n '1p')
test -n "$CTR"
! podman inspect "$CTR" | grep -E '"(RELAY_TOKEN|GH_TOKEN)"|ghs_[A-Za-z0-9_]+'
! podman logs "$CTR" 2>&1 | grep -E 'ghs_[A-Za-z0-9_]+'
```

After success, timeout, and a deliberately superseded fence, the container,
network, nftables table, proxy ports, and held tunnels must all disappear.
Repeat under the rootless relay account. If that account cannot install the
nftables fence, the expected result is a transient infrastructure failure with
no setup or agent `podman run`; never compensate with `--network=host`.

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
