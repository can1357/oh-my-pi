# Collab: Live Session Sharing

`/collab` shares your running session with other omp instances in real time. Guests render the **same session natively in their own TUI** — streaming assistant text, tool-call cards, footer state (cwd, model, context %, cost), ctrl+o expansion, `/dump` — no terminal mirroring. Guests can prompt and interrupt the agent; the host machine runs the agent and all tools.

## Quick start

Host:

```
/collab
```

prints

```
Collab session started!
 • Join from another terminal: oh-my-pk join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: collab.pkking.computer/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

The browser line is click-to-join (an OSC 8 hyperlink to the full `https://` deep link): the relay serves the web guest client at `/`, and the room id + key ride in the URL fragment. From another omp (any directory, any machine), either form works:

Running `/collab`, `/remote-control`, `/collab view`, or `/remote-control view` starts or displays the active hosting session, rendering both the terminal/browser join links and their corresponding QR codes.

```
/join collab.pkking.computer/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

The guest's previous session is restored on `/leave` (or when the host stops).

### Commands

| Command | Effect |
|---|---|
| `/collab` | Start sharing full-control (or re-print the link/QR when already hosting) |
| `/collab <relay>` | Start sharing through a specific relay (`relay.example.com`, `ws://localhost:7475`) |
| `/collab view` | Start sharing read-only (or re-print the link/QR when already hosting) |
| `/collab status` | Show link + participants |
| `/collab stop` | Stop sharing |
| `/remote-control` | Start a full-control phone/browser remote (same encrypted transport as `/collab`) |
| `/remote-control status` | Show remote-control link, participants, and supported remote actions |
| `/remote-control kanban` | Open the current repository in pk-kanban, preserving Kanban's per-workspace project split |
| `/remote-control stop` | Stop remote control |
| `/join <link>` | Join a shared session as a guest |
| `/leave` | Leave (guest) or stop sharing (host) |

## Link format

Accepted by `/join <link>` and `oh-my-pk join "<link>"`:

```
<roomId>.<key>                                                    → default relay (wss://collab.pkking.computer)
<roomId>#<key>                                                    → legacy bare form
host[:port]/r/<roomId>.<key>                                     → custom relay, wss:// inferred
host[:port]/r/<roomId>#<key>                                     → legacy direct relay form
https://host[:port]/r/<roomId>.<key>                             → direct relay URL, normalized to wss://
wss://host[:port]/r/<roomId>.<key>                               → direct websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                             → direct plain ws, localhost only
https://host[:port]/#<link>                                      → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>                   → browser UI wrapper with relay link in the fragment
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → web UI and relay on different hosts
```

`<link>` / `<relay-link>` are parsed recursively as any accepted link above. For `http(s)` browser wrappers with a parseable fragment, the fragment wins before the HTTP host/path are treated as a relay. This lets `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` open the web UI at `web.example` while joining `wss://relay.example.com/r/<roomId>`. If the fragment is not a complete collab link, parsing falls back to the legacy direct relay form, so `https://relay.example.com/r/<roomId>#<key>` still means relay `relay.example.com`.

The trailing `.<key>` or `#<key>` part is the room secret, base64url-encoded, in one of two strengths:

- **Full link** — 48 bytes: the 32-byte AES-256-GCM room key followed by a 16-byte write token. Grants prompting, interrupting, and subagent control.
- **View-only link** — the bare 32-byte key, no write token. Grants live read access only. Pre-token links parse as view-only.

The room secret is dot-joined in newly generated links because RFC 3986 forbids a raw `#` inside a URL fragment; parsers still accept legacy `#` forms and `%23`-mangled legacy deep links.

## End-to-end encryption

Every session payload (entries, events, state, prompts) is sealed with AES-256-GCM before it touches the socket. The relay sees only:

- room ids and connection counts,
- opaque ciphertext frames and their sizes,
- a 4-byte routing prefix (which guest a frame targets).

Possession of the link is the trust boundary: a full link reads and steers the session, a view-only link reads it. Share both like secrets.

## Guest permission model

Two trust levels, enforced by the link itself — the host verifies the 16-byte write token at join and rejects writes from peers without it (they appear as read-only in the participants list, and the join notice says so).

Guests with a full link can:

- read the entire session (including the back-transcript at join time),
- prompt the agent (rendered with their name badge on every participant's transcript; the LLM sees the prompt text verbatim — names are display-only),
- interrupt the agent (Esc),
- use the Agent Hub against the host's subagents: live table and progress, cwd/project grouping, chat (steers the host's subagent), kill, revive, and transcript viewing (fetched from the host on demand),
- list known host sessions and ask the host TUI to load one; the host validates the requested path against its session index before resuming it and re-syncing every guest.

Guests with a view-only link can read everything live — back-transcript, streaming text, tool cards, subagent transcripts — but the host rejects prompting, interrupting, session listing/loading, and agent control from them.

Everything that mutates the host session or machine is host-only: `/model`, `/compact`, `/resume`, `/branch`, bash (`!`), python (`$`), skills, etc. Guests keep a small local allowlist (`/dump`, `/export`, `/copy`, `/help`, `/hotkeys`, `/theme`, `/settings`, `/leave`, `/collab`, `/remote-control`, `/exit`, `/quit`).

Known v1 limit for guests: a turn already streaming when you join becomes visible from its next message boundary.

## Web client

`packages/collab-web` is a standalone browser client for the same links — no omp install needed on the guest side. The relay serves it at `/`, which is what makes the `/collab` deep link click-to-join: `https://<relay>/#<link>` loads the client and auto-connects from the fragment. It renders the live transcript (streaming text, thinking, tool cards), a subagent panel with on-demand transcripts, and a composer with the same guest powers (prompt, interrupt, hub actions). Run `bun run dev` in the package for a local instance, `bun run mock-host` for an offline scripted host to develop against, and `bun run build` to emit a static `dist/` deployable anywhere (HTTPS required for WebCrypto). The client never talks to anything but the relay, and the key stays in the URL fragment.

Set `collab.webUrl` when the browser UI is hosted separately from the websocket relay. When empty, `/collab` derives `http(s)://host[:port]` from `collab.relayUrl`; explicit web UI URLs must use `https://` except for `http://localhost` development origins. The generated browser URL still carries the relay-specific collab link in the fragment.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `collab.relayUrl` | `wss://collab.pkking.computer` | Relay used by `/collab` when no relay is passed inline |
| `collab.webUrl` | empty | Browser UI URL for `/collab` links; empty derives from relay; explicit `http://` is allowed only for localhost |
| `collab.displayName` | OS username | Name shown to other participants |
| `share.serverUrl` | `https://collab.pkking.computer/s` | Share viewer/upload base used by `/share` (links are `<base>/<id>#<key>`) |
| `share.redactSecrets` | `true` | Run the secret obfuscator over `/share` snapshots before upload |

## Self-hosting the relay

The owned collaboration service is deployed as the `ompk-collab` Cloudflare Worker at `collab.pkking.computer`. It keeps live room coordination in one Durable Object per room and stores sealed share blobs in the configured R2 bucket. The relay never decrypts session content. Share uploads are capped at 1 MB and rate-limited to 12 per Cloudflare client IP per hour.

A host disconnect does not end the room immediately: guests receive a `host-away` control message and the relay holds the room open for a ~45 s grace window. If the host reconnects in time, guests get `host-back` and the session resumes; otherwise the room closes as before (`room-closed`, close code 4001). A new host connection replaces a lingering half-open host socket (closed with 4010) so a host that lost its network can always re-claim its room. The guest client page is served with a strict build-generated Content-Security-Policy (inline scripts allowed by hash only), `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

It exposes:

- `GET /` — the static collab-web guest client (target of the `/collab` deep link),
- `GET /r/<roomId>?role=host|guest` — WebSocket upgrade,
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` blob upload, viewer page, and blob fetch,
- `GET /healthz` — liveness.


## Architecture notes

Hub topology — the host is authoritative, guests never peer:

1. `entry` frames — durable session entries, broadcast pre-blob-externalization so images stay inline (guests cannot resolve host blob refs). Guests append them verbatim (ids preserved) to a replica session file under `~/.omp/collab/<roomId>.jsonl` and into the agent's message array, which is why `/dump` and context estimates work.
2. `event` frames — live agent events, fed straight into the guest's normal event controller; rendering is events-only to prevent double-render.
3. `state` frames — debounced footer snapshots: streaming flag, the host's full model object and thinking level (applied to the guest's replica agent state, so model display and context-window math are native), host context numbers, and participants.
4. `bus` frames — mirrored task-subagent lifecycle/progress EventBus traffic, republished on the guest's local bus so the subagent HUD and status-line count work natively.
5. `agents` frames — agent-registry snapshots feeding a guest-local registry, so the Agent Hub table renders host subagents. Snapshots carry each agent cwd when known so remote dashboards can group agents by repository/project, matching Kanban's workspace boundary.
6. `sessions` / `session-loaded` frames — targeted replies for phone/browser remote session pickers. Writable guests request `list-sessions` (`project` or `all`) and `load-session`; the host only loads paths found in its own session list, then broadcasts a fresh `welcome` snapshot so every guest follows the active session.

Guest→host: `hello`, `prompt`, `abort`, `agent-cmd` (hub chat/kill/revive), `fetch-transcript` (incremental subagent-transcript reads answered by targeted `transcript` frames), `list-sessions`, and `load-session`. The replica loads through the regular `/resume` machinery, so theming, ctrl+o, and transcript behavior are native by construction; the guest process never chdirs to host paths.
