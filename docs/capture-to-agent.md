# Capture-to-Agent Workflow

Tag an agent on anything visible on your screen. A capture (screen region,
window, full screen, selected text, or browser context) plus a natural-language
instruction becomes a task that executes inside an existing oh-my-pk agent
session, with progress and collaboration mirrored into a shared Telegram chat.
Replies in Telegram continue the same underlying session.

```
Capture client (overlay / HTTP client)
        ↓  POST /api/capture/tasks
Capture gateway + orchestrator      (packages/desktop-tag/src/capture)
        ↓  AgentSessionGateway commands
Existing oh-my-pk runner + session  (packages/coding-agent)
        ↓  summarized events
Telegram collaboration bridge       (CollaborationAdapter)
```

## Architecture and how it maps onto existing code

The feature reuses existing infrastructure rather than introducing a new
runtime:

| Concern | Reused component |
| --- | --- |
| Agent execution | `AgentSession` via `createAgentSession` (`packages/coding-agent/src/sdk.ts`) |
| Transport-neutral command/event surface | `AgentSessionGateway` (`packages/coding-agent/src/gateway/`) — the execution core explicitly designed for Slack/Telegram-style adapters |
| Session persistence & resume | `SessionManager` JSONL session files; resume via `SessionManager.open(sessionFile)` and `resolveResumableSession` |
| Desktop capture | `CaptureService` (`packages/desktop-tag/src/context.ts`) |
| Runner/executor routing | `CapabilityRegistry` + `routeContext` (`packages/desktop-tag/src/router.ts`) |
| HTTP/WS gateway | `TagGatewayServer` (`packages/desktop-tag/src/gateway.ts`, loopback-only `Bun.serve`) |
| Durable structured state | `bun:sqlite` (repo convention: stats, mnemopi, auth) |
| Multimodal input | `ImageContent` prompts (`AgentSession.prompt(text, { images })`) |

New modules, all under `packages/desktop-tag/src/capture/`:

- `types.ts` — `CaptureTaskRequest`, `CaptureRun`, `CollaborationAdapter`,
  `CaptureRunnerAdapter`, and hand-rolled runtime validation.
- `store.ts` — `CaptureStore` (SQLite): capture requests, runs, screenshot
  asset metadata, run events, collaboration message links, Telegram update
  dedup, and an audit log. Screenshot bytes live on disk under the capture
  data dir; the database stores references only.
- `runner.ts` — `PiRunnerAdapter`: creates or resumes agent sessions through
  `AgentSessionGateway`, streams projected runner events, flushes and
  persists the session file on every turn end so resume works after restarts.
- `orchestrator.ts` — `CaptureOrchestrator`: validation, idempotency, status
  transitions, screenshot handling, routing, follow-up queueing, event
  fan-out, retention sweeps, metrics.
- `telegram.ts` — `TelegramBridge` (`CollaborationAdapter`): root task
  message, throttled progress edits, result replies, webhook + long-poll
  ingestion, commands, authorization, attachment download.
- `http.ts` — `CaptureHttpRouter`: REST + SSE endpoints mounted by
  `TagGatewayServer` under `/api/capture/`.
- `config.ts` — environment-based configuration.
- `redact.ts` — outbound credential redaction for collaboration surfaces.

## Session continuity model

Every capture task either creates a new session or resumes an existing one.
The durable mapping lives in the `capture_runs` table:

```
capture run id ↔ request id ↔ session id + session file ↔ runner id ↔
telegram chat id + topic id + root message id
```

- Session content itself is persisted by the existing `SessionManager` as a
  JSONL file; the capture store only records the mapping.
- On every turn end the runner adapter flushes the session and reports the
  final `sessionId`/`sessionFile`, which the orchestrator writes back to the
  run row.
- A Telegram reply resolves its run via `capture_collab_messages` (reply-to a
  message the bridge posted) or falls back to the latest run in that
  chat/topic, then resumes `SessionManager.open(sessionFile)` and appends the
  reply as a normal user turn.
- The mapping survives process, bot, runner, and gateway restarts because
  everything is in SQLite + session JSONL files; nothing depends on in-memory
  state. Telegram update ids are also claimed durably, so webhook redelivery
  after a restart cannot duplicate turns.
- Follow-ups that arrive while a turn is executing are queued (FIFO) and
  dispatched into the same session as the previous turn settles.

## Local development

```bash
bun install
# start the capture gateway + overlay
bun --cwd=packages/desktop-tag src/cli.ts            # http://127.0.0.1:18087

# run the capture test suite
bun --cwd=packages/desktop-tag test test/capture-*.test.ts
```

The overlay at the gateway URL provides the capture UI: pick a capture mode
(screen/window/region/browser), type an instruction, choose a session
("New session" or continue an existing one), choose a runner, toggle Telegram
sharing, and submit. `Create agent task` uses the async capture workflow;
`Tag it (interactive)` keeps the original synchronous overlay flow with
per-action approvals.

Inside the omp TUI, the existing `/tag` command and `Ctrl+Alt+T` shortcut
(from `src/extension.ts`) still capture into the current interactive session.

## Configuration

Environment variables (see `.env.capture.example` at the repo root):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAPTURE_ENABLED` | `true` | Enable the capture workflow on the gateway |
| `CAPTURE_DATA_DIR` | `~/.omp/agent/capture` | SQLite database + screenshot assets |
| `CAPTURE_ASSET_RETENTION_DAYS` | `14` | Screenshot retention window |
| `CAPTURE_MAX_UPLOAD_MB` | `20` | Screenshot upload limit |
| `CAPTURE_DEFAULT_AGENT_ROLE` | `task` | Role recorded for new runs |
| `CAPTURE_DEFAULT_RUNNER_ID` | — | Skip auto-routing and pin a runner |
| `CAPTURE_GLOBAL_SHORTCUT` | `Ctrl+Shift+Space` | Advertised capture shortcut (client-side) |
| `CAPTURE_GATEWAY_TOKEN` | — | Bearer token required on capture endpoints |
| `CAPTURE_AUTO_APPROVE` | `true` | Auto-approve tools in headless capture sessions |
| `TELEGRAM_CAPTURE_ENABLED` | `false` | Enable the Telegram bridge |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | — | Secret for `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_ALLOWED_CHAT_IDS` | — | Comma-separated chat allowlist (empty = deny all) |
| `TELEGRAM_ALLOWED_USER_IDS` | — | Optional additional user allowlist |
| `TELEGRAM_DEFAULT_CHAT_ID` | — | Chat used when a task does not name one |
| `TELEGRAM_LONG_POLL` | `true` | Poll `getUpdates` instead of requiring a webhook |

## Telegram bot setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Add the bot to your team chat (or forum), and get the chat id (e.g. via
   `getUpdates` or @userinfobot). Put it in `TELEGRAM_ALLOWED_CHAT_IDS` and
   `TELEGRAM_DEFAULT_CHAT_ID`.
3. Set `TELEGRAM_CAPTURE_ENABLED=true` and `TELEGRAM_BOT_TOKEN=...`.
4. Default mode is long-polling — no inbound connectivity needed. To use a
   webhook instead, expose `/api/capture/telegram/webhook` through a tunnel
   that rewrites `Host` to loopback, set the webhook with your
   `TELEGRAM_WEBHOOK_SECRET` as `secret_token`, and set
   `TELEGRAM_LONG_POLL=false`.

Bot behavior: each capture task posts a root message (instruction, runner,
short session label, status) plus a screenshot preview reply. Progress is
posted by editing the root message (status + current activity, throttled).
The result is posted as a reply. Replying to any of the task's messages —
or posting in the task's forum topic — continues the same session.

Commands: `/status`, `/stop`, `/resume`, `/session`, `/runner`,
`/new <instruction>`, `/help`. Commands are only honored from allowlisted
chats/users.

## API

All routes are served by the loopback gateway (`TagGatewayServer`).

```
POST /api/capture/tasks                  create a capture task (202 → { task })
GET  /api/capture/tasks                  list recent tasks
GET  /api/capture/tasks/:id              task + persisted events
POST /api/capture/tasks/:id/follow-up    { text, images?, participant? }
POST /api/capture/tasks/:id/cancel       cancel active execution
GET  /api/capture/sessions               sessions known to the capture workflow
GET  /api/capture/runners                registered runners/executors
GET  /api/capture/events/:id             server-sent events (replay + live)
POST /api/capture/telegram/webhook       Telegram webhook (secret-token auth)
```

`POST /api/capture/tasks` accepts a `CaptureTaskRequest`
(`packages/desktop-tag/src/capture/types.ts`). Screenshots are either inline
base64 (`screenshot.data`), a stored asset reference (`screenshot.storageRef`),
or captured server-side by the gateway itself (`capture: { mode, region? }`)
for same-machine clients like the overlay. `routing.sessionId` resumes an
existing session; omitting it creates a new one. `collaboration.disabled`
skips Telegram for that task.

## Security model

- The gateway binds loopback only; non-loopback `Host`/`Origin` values are
  rejected. `CAPTURE_GATEWAY_TOKEN` adds bearer auth on top.
- Nothing is captured or uploaded without an explicit client submission.
- Screenshot uploads are MIME-restricted (PNG/JPEG), size-limited, stored
  under generated ids (client-supplied paths are never used), and deleted by
  the retention sweep.
- Telegram access is allowlist-only (`TELEGRAM_ALLOWED_CHAT_IDS` empty means
  deny all); user allowlisting is available on top. The webhook validates the
  Telegram secret token with a constant-time comparison; update ids are
  claimed durably to defeat replay.
- Collaboration surfaces only ever receive summarized events: instruction,
  status, friendly tool labels, and the final assistant message — never raw
  tool payloads, environment variables, or model reasoning. Outbound text
  passes a credential redaction pass (`redact.ts`) and length caps.
- Session file paths are never exposed over HTTP or Telegram (short session
  labels only).
- Task creation, follow-ups, cancellations, and rejected Telegram access are
  written to the `capture_audit` table.
- `CAPTURE_AUTO_APPROVE=true` (default) lets headless capture sessions run
  tools without interactive approval. Set it to `false` for
  approval-restricted environments — side-effecting tools will then fail
  rather than execute.

## Failure handling

- Runner dispatch failures, missing workspaces, and screenshot failures mark
  the run `failed` with a clear error (audited, mirrored to Telegram).
- Telegram being unreachable never blocks execution; delivery failures are
  counted (`metrics.collaborationDeliveryFailures`) and logged.
- Replies after completion resume the persisted session; simultaneous replies
  queue in order; duplicate webhook updates are dropped durably.
- Retries are idempotent: task creation by `requestId`, Telegram inbound by
  `update_id`, follow-ups by optional idempotency key.

## Observability

Structured logs (`pi-utils` logger) cover run transitions, routing decisions,
Telegram delivery, and retention sweeps, keyed by run id and short session
label. `CaptureOrchestrator.metrics` exposes counters (requests, dedups,
starts, completions, failures, cancellations, follow-ups, delivery failures).
The `capture_events` table doubles as a tool-use capture record per run:
routing decision, selected runner, tools invoked (summarized), errors, user
follow-ups, and final outcome — suitable for future routing/evaluation
training data.

## Adding another collaboration surface

Telegram is one adapter, not a hardcoded dependency. Implement
`CollaborationAdapter` (`publishTask`, `publishEvent`, `publishResult`,
`parseInboundMessage`), persist your surface's message ↔ run links with
`CaptureStore.recordCollabMessage`, and register the adapter with
`CaptureOrchestrator.registerCollaborationAdapter`. Slack/Discord/Teams/web
chat adapters can follow the same pattern; inbound messages should resolve a
run and call `orchestrator.followUp` with an idempotency key.

## Troubleshooting

- **No Telegram messages**: check `TELEGRAM_CAPTURE_ENABLED`, the bot token,
  and that the task's chat (or `TELEGRAM_DEFAULT_CHAT_ID`) is set. Delivery
  failures appear in logs as `Collaboration adapter delivery failed`.
- **Bot ignores replies**: the chat id must be in
  `TELEGRAM_ALLOWED_CHAT_IDS`; check logs for
  `Telegram update from non-allowlisted chat`.
- **Follow-up says "no persisted session"**: the original run failed before
  the agent produced a turn, so there is no session file to resume; start a
  new task with `/new`.
- **`tsgo`/typecheck noise from other packages**: pre-existing; scope checks
  to `packages/desktop-tag`.
- **Native addon errors in tests**: build once with
  `bun --cwd=packages/natives run build`.

## Follow-up plan: mobile share-sheet support

The gateway API is already transport-agnostic, so a mobile client only needs:

1. A share-sheet extension (iOS/Android) that receives an image or text
   selection and POSTs a `CaptureTaskRequest` (`source.type: "selected-text"`
   or a screenshot) to the capture gateway over a trusted channel (Tailscale,
   WireGuard, or an authenticated relay) using `CAPTURE_GATEWAY_TOKEN`.
2. `collaboration.telegramChatId` defaulting per user, so results land in the
   shared space; the phone needs no long-lived connection.
3. Optionally, a `GET /api/capture/events/:id` SSE view for in-app progress.
