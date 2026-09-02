---
title: Live Collaboration
description: Share a running session by link or QR code — full-control or view-only — and let guests prompt, interrupt, and watch from their own terminal or browser.
coverage: A
---

`/collab` shares your running session with other omp instances in real time. Guests render the same session natively in their own TUI — streaming assistant text, tool-call cards, footer state, `/dump` — and can prompt and interrupt the agent, while the host machine runs the agent and every tool. A browser client means guests do not even need omp installed.

## Quick start

In the session you want to share:

```text
/collab
```

omp prints both join forms and their QR codes:

```text
Collab session started!
 • Join from another terminal: omp join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

The browser line is click-to-join: the relay serves the web guest client at `/`, and the room id plus key ride in the URL fragment. From another omp — any directory, any machine — either form works:

```bash
omp join "my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…"
```

or, inside a running session:

```text
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

`omp join <link>` launches the interactive TUI and immediately joins; it requires an interactive terminal and behaves exactly like running `/join`. The guest's previous session is restored on `/leave` or when the host stops sharing.

## Commands

| Command | Effect |
| --- | --- |
| `/collab` | Start sharing full-control (or re-print the link/QR when already hosting) |
| `/collab <relay>` | Start sharing through a specific relay (`relay.example.com`, `ws://localhost:7475`) |
| `/collab view` | Start sharing read-only (or re-print the link/QR when already hosting) |
| `/collab status` | Show link + participants |
| `/collab stop` | Stop sharing |
| `/join <link>` | Join a shared session as a guest |
| `/leave` | Leave (guest) or stop sharing (host) |

## Link format

`/join` and `omp join` accept several forms:

```text
<roomId>.<key>                                          → default relay (wss://my.omp.sh)
host[:port]/r/<roomId>.<key>                            → custom relay, wss:// inferred
https://host[:port]/r/<roomId>.<key>                    → direct relay URL, normalized to wss://
wss://host[:port]/r/<roomId>.<key>                      → direct websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                    → plain ws, localhost only
https://host[:port]/#<link>                             → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>          → web UI wrapper with the relay link in the fragment
```

For `http(s)` browser wrappers with a parseable fragment, the fragment wins, so `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` opens the web UI at `web.example` while joining `wss://relay.example.com/r/<roomId>`. Legacy `<roomId>#<key>` forms (and `%23`-mangled deep links) are still accepted; new links dot-join the secret because a raw `#` cannot appear inside a URL fragment.

The trailing secret is base64url-encoded and comes in two strengths:

- **Full link** — 48 bytes: the 32-byte AES-256-GCM room key followed by a 16-byte write token. Grants prompting, interrupting, and subagent control.
- **View-only link** — the bare 32-byte key, no write token. Grants live read access only.

## End-to-end encryption

Every session payload — entries, events, state, prompts — is sealed with AES-256-GCM before it touches the socket. The relay sees only room ids and connection counts, opaque ciphertext frames and their sizes, and a 4-byte routing prefix. Possession of the link is the trust boundary.

:::caution
A full link reads **and steers** the session; a view-only link reads it. Share both like secrets — anyone holding the full link can prompt your agent and interrupt it on your machine.
:::

## What guests can do

The trust level is enforced by the link itself: the host verifies the 16-byte write token at join and rejects writes from peers without it (they appear as read-only in the participants list, and the join notice says so).

Guests with a **full link** can:

- read the entire session, including the back-transcript at join time,
- prompt the agent (their prompts render with a name badge on every participant's transcript),
- interrupt the agent with `Esc`,
- use the Agent Hub against the host's subagents: live table and progress, chat, kill, revive, and transcript viewing.

Guests with a **view-only link** can read everything live — back-transcript, streaming text, tool cards, subagent transcripts — but the host rejects prompting, interrupting, and agent control from them.

Everything that mutates the host session or machine is host-only: `/model`, `/compact`, `/resume`, `/branch`, bash (`!`), python (`$`), skills, and so on. Guests keep a small local allowlist: `/dump`, `/export`, `/copy`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/exit`, `/quit`.

:::note
Known limit: a turn already streaming when a guest joins becomes visible from its next message boundary.
:::

## Web client

A standalone browser client (`packages/collab-web`) joins the same links with no omp install on the guest side. The relay serves it at `/`, which is what makes the `/collab` deep link click-to-join: `https://<relay>/#<link>` loads the client and auto-connects from the fragment. It renders the live transcript (streaming text, thinking, tool cards), a subagent panel with on-demand transcripts, and a composer with the same guest powers — prompt, interrupt, hub actions. The client talks only to the relay, and the key stays in the URL fragment.

Set `collab.webUrl` when the browser UI is hosted separately from the websocket relay. When empty, `/collab` derives `http(s)://host[:port]` from `collab.relayUrl`; explicit web UI URLs must use `https://` except for `http://localhost` development origins.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `collab.relayUrl` | `wss://my.omp.sh` | Relay used by `/collab` when no relay is passed inline |
| `collab.webUrl` | empty | Browser UI URL for `/collab` links; empty derives from the relay; explicit `http://` allowed only for localhost |
| `collab.displayName` | OS username | Name shown to other participants |
| `share.serverUrl` | `https://my.omp.sh/s` | Share viewer/upload base used by `/share` (links are `<base>/<id>#<key>`) |
| `share.redactSecrets` | `true` | Run the secret obfuscator over `/share` snapshots before upload |

Change them with `omp config set <key> <value>`; see [Settings](/oh-my-pi/configuration/settings/).

## Self-hosting the relay

The relay is a small content-blind Go service. It keeps no state beyond live connections and exposes:

- `GET /` — the static collab-web guest client (target of the `/collab` deep link),
- `GET /r/<roomId>?role=host|guest` — WebSocket upgrade,
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob upload, viewer page, and blob fetch,
- `GET /healthz` — liveness.

Point `collab.relayUrl` (and `collab.webUrl`, if you serve the client elsewhere) at your instance.
