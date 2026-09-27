# Telegram bridge

Drive omp sessions from Telegram. Each session gets its own **topic** in one
paired chat: send text in a topic and it reaches that session; answers, thinking,
tool steps and agent questions come back into the same topic. The bridge is
native — no daemon, no child `omp --mode rpc-ui` processes — and runs either
inside the interactive TUI (`/telegram`) or as the foreground `omp telegram`
process. Both forms are the same host: **one host per bot token**.

## What you get

- Started with `/telegram` inside the TUI, the terminal's own session gets a
  topic too, relayed both ways: your Telegram messages arrive in the terminal
  as prompts attributed to you, prompts typed in the terminal appear in the
  topic as quotes, and agent questions can be answered from either side (first
  answer wins).
- One topic per session. `/new` creates a topic and a session; a message in an
  unknown topic _adopts_ it and starts a session named after it.
- Prompting, follow-ups while a turn runs, `/steer`, `/stop`, photos as images,
  documents saved to the bridge inbox and linked in the prompt.
- Rich replies, streamed drafts in private chats, reactions on your message
  (👀 queued, 👨‍💻 working, 👌 done, 🫡 stopped, 💔 failed), and a turn card with a
  stop button.
- Agent questions (`ask`, `select`, `confirm`, `input`, `editor`) answered with
  buttons or plain text right in the topic.
- Mirror topics for interactive sessions running in another omp process: their
  conversation is relayed read-only and text sent there is refused while the
  session lives in its terminal.
- `/telegram` inside the TUI, `omp telegram` and `omp telegram status` outside it.

## 1. Create a bot

1. In Telegram, talk to [@BotFather](https://t.me/BotFather): `/newbot`, pick a
   name and username, copy the token it prints (`<digits>:<secret>`).
2. Put the token in **Interaction → Telegram → Bot Token** (`/settings`), or in
   the `PI_TELEGRAM_BOT_TOKEN` environment variable. The variable wins over the
   configured value, and the token is never printed or logged.

## 2. Give the chat topics

A session is a topic, so the chat the bot works in must support them. Two shapes
work:

- **Forum supergroup.** Create a group, enable **Topics** in its settings, add
  the bot, and make it an administrator with the **Manage Topics** right. In a
  group Telegram hides ordinary messages from non-admins, so the bot does need
  that right. The chat id is negative (`-100…`).
- **Private chat with Threaded Mode.** Open the chat with @BotFather, tap the
  menu button to the left of the message box, pick your bot, then
  **Bot Settings → Threaded Mode**. This switch only exists in that mini-app,
  not in the classic `/mybots` menu. In a private chat the chat id equals your
  own user id.

`omp telegram status` checks both: it prints whether topics are enabled for the
bot and refuses with the fix when they are not.

## 3. Pair

Pairing binds the bot to one chat and one user without hand-editing ids.

1. In the TUI run **`/telegram pair`** (or, headless, start `omp telegram` after
   configuring; an unpaired bot refuses and tells you to pair).
2. The TUI shows a one-time code and, once the bot answers `getMe`, a deep link
   `https://t.me/<bot>?start=<code>`.
3. Open the link, or send `/pair <code>` (or `/start <code>`) to the bot in the
   chat you want to use. The first matching message binds that chat and appends
   its sender to the allowed users, replies in Telegram, and starts the bridge.
4. A wrong code is ignored; the code expires after ten minutes. `/telegram stop`
   cancels a pairing in progress.

**`/telegram unpair`** clears the chat and allowed users and stops the bridge.

## 4. Using it

### TUI commands

| Command                      | Effect                                                        |
| ---------------------------- | ------------------------------------------------------------- |
| `/telegram`                  | Status plus the next step (configure, pair, or start).        |
| `/telegram start`            | Start the bridge for the paired bot.                          |
| `/telegram stop`             | Stop the bridge; sessions stay in the registry and raise again on the next message. |
| `/telegram status`           | State, bot, topic counts, auto-start.                         |
| `/telegram pair`             | Pair a chat with a one-time code.                             |
| `/telegram unpair`           | Forget the chat and allowed users and stop the bridge.        |

A small `telegram:` indicator appears in the status line while the bridge is
running and clears when it stops. Set **Interaction → Telegram → Auto Start** to
start the bridge automatically whenever an interactive session begins (a
configured and paired bot only).

### Bot commands

The menu Telegram shows is:

- `/new [name] [directory]` — create a session and its topic.
- `/sessions` — sessions in the registry and live sessions on this machine.
- `/resume <id part | file.jsonl> [name]` — raise an earlier session.
- `/status` — state of the current session.
- `/steer <text>` — cut into the running turn.
- `/stop` — interrupt the turn (a stop button on the turn card does the same).
- `/rename <name>` — rename the session and its topic.
- `/model <provider/model>` — switch the session's model.
- `/thinking <level>` — set the thinking level.
- `/compact` — compact the context.
- `/close` — close the session and its topic.
- `/help` — the command list.

Plain text in a session topic goes to that session. A document is saved under
the bot's inbox directory and its path is sent with your message.

## 5. Headless

```
omp telegram                 # run the bridge in the foreground
omp telegram --model X       # pin the model used for new sessions
omp telegram status          # config sanity, lock holder, no token
```

`omp telegram` reads the same `telegram.*` settings, acquires the host lock, and
runs until `Ctrl+C` (SIGINT/SIGTERM), then stops cleanly. A refusal — no token,
not paired, topics disabled, or another host already running — prints a clear
message and exits non-zero.

## 6. Security model

- **Chat and user gate.** Every update must come from the paired chat, and (for
  messages and buttons) from a user in `telegram.allowedUserIds`. Anything else
  is logged and ignored, never answered.
- **One host per bot token.** The host holds an OS lock on
  `<state>/<botId>/host` plus a `host.json` next to it. A second host refuses
  and names the holder's pid; the lock is kernel-owned, so a crashed host never
  wedges the bot. Two pollers would fight over one `getUpdates` offset.
- **Second writer.** Before the bridge opens a session file, it checks whether
  the session is live in another omp process; if it is, the bridge refuses and
  names that pid, and an interactive session there is mirrored read-only
  instead. The interactive TUI and the bridge publish presence for this check;
  other modes (`omp -p`, ACP, RPC, SDK embedders) do not.
- **Token handling.** The token is a credential setting: masked in `/settings`,
  redacted from exports, and never printed. Errors that might embed it are
  passed through redaction.

## 7. Where state lives

State lives in the agent state directory (`~/.omp/agent/telegram` by default,
following `PI_CODING_AGENT_DIR` and XDG). Under `telegram/<botId>/`:

- `registry.json` — the topic ↔ session mapping, statuses, and mirror offsets.
- `inbox/<threadId>/` — documents sent to a topic session.
- `host` and `host.json` — the host lock and its holder pid.

## 8. Troubleshooting

- **"topics enabled: no"** — enable Threaded Mode in the @BotFather mini app
  (private chat) or Topics in the group settings (supergroup).
- **"already running (pid N)"** — another omp process owns this bot. Stop it, or
  use that process; `/telegram status` and `omp telegram status` name the pid.
- **Bot stays silent** — check the allow-list and that you are writing in the
  paired chat; a message in the general stream without a `/new` session is
  answered with a hint, not a session.
- **A session is mirrored** — its file is live in another omp process. Use
  `/close` in the mirror to stop mirroring, or wait for that process to exit.
