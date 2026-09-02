---
title: Editor Integration
description: Run omp inside editors over the Agent Client Protocol, or hand the draft to your `$EDITOR` from the TUI.
coverage: B
---

omp speaks the [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) over stdio, which means an editor that implements ACP can drive the same agent you run in the terminal — and, separately, the TUI itself can hand its current draft to your external editor.

## ACP: editor-drivable agent

`omp acp` runs Oh My Pi as an ACP server over JSON-RPC. It is meant to be spawned by an ACP client — for example, Zed's `agent_servers` config — not invoked by hand.

```text
omp acp
```

When spawned by an editor, the editor sends JSON-RPC frames on stdin and reads responses on stdout. `omp acp` will not print banners on stdout (that is the transport), but when stdin is a TTY it logs to stderr to say the JSON-RPC server is waiting and point you at the log directory:

```text
omp acp: ACP server speaking JSON-RPC over stdio.
This command is meant to be spawned by an ACP client (e.g. Zed's "agent_servers" config), not run directly.
Waiting for protocol frames on stdin; logs: ~/.omp/logs/
```

### A minimal Zed entry

Add an `omp` agent server to your editor's ACP config; the command is `omp` and the args include `acp`:

```json
{
  "agent_servers": {
    "omp": {
      "command": "omp",
      "args": ["acp"]
    }
  }
}
```

Other ACP clients follow the same shape — point them at the `omp` binary with `acp` as the first arg.

### What routes through the editor

When the editor advertises capabilities, tool I/O routes through the protocol and writes are gated by the editor's permission flow. Concretely, the omp tool surface maps to ACP as follows:

| omp tool                      | ACP route                           |
| --- | --- |
| `bash`                        | `terminal/create + terminal/output` |
| `read`                        | `fs/read_text_file`                 |
| `write`                       | `fs/write_text_file`                |
| `edit`, `bash`                | `session/request_permission`        |

Destructive tools pause for a permission prompt inside the editor — the same prompt you see in the TUI, answered in the editor's UI; "answer once and forget" applies to both surfaces. Prompt cards such as the option picker surface over ACP, so editors get the picker without writing one. The full reference lives at [omp.sh/docs/sdk](https://omp.sh/docs/sdk).

### Editor-driven workflows

- **Buffer-aware reads** — the agent reads the editor's open buffer (not just disk) so its view matches what you are looking at.
- **Editor-save writes** — file writes go through the editor's save path.
- **Editor-spawned shells** — `bash` tool calls run in the editor's integrated terminal.
- **Single model of trust** — destructive tool prompts answer the same way in the TUI and the editor; no second agent to keep in sync.

### Re-opening for interactive auth

`omp acp` accepts a single editor-only flag, `--acp-terminal-auth`. Passing it makes the same command drop ACP serving and open the full interactive TUI instead, after stripping any `--mode` flag. ACP clients that cannot render an interactive login use it to hand authentication back to a real terminal; the user runs the auth flow, then the editor re-spawns `omp acp` without the flag.

## Four entry points

The same engine ships four wrappers:

| Entry point | Surface |
| --- | --- |
| `omp` | Interactive TUI |
| `omp -p <prompt>` | One-shot, prints a single response and exits |
| Node SDK | Embed the session in your own process |
| `omp --mode rpc` / `omp acp` | Another program over stdio (JSON-RPC, ACP) |

`omp acp` is the ACP-flavored stdio entry; `--mode rpc` is the lower-level JSON-RPC entry for tools that want raw prompt/abort/model control.

## External editor from the TUI

The TUI also hands its draft to your external editor. Press **Ctrl+G** to pop the current draft into `$VISUAL`, falling back to `$EDITOR`. The keybinding is `app.editor.external` and the chord is `Ctrl+G` by default; remap it from `/settings` → [Keybindings](/oh-my-pi/configuration/keybindings/).

```bash
VISUAL="code -w" omp           # opens the draft in VS Code and waits
EDITOR="vim" omp               # falls back to vim when VISUAL is unset
```

The draft loads into the editor with the working file's directory as the editor's working directory, so editor-relative paths (LSP, project search, formatter-on-save) behave the same as usual. When the editor exits, the TUI takes the buffer back as the next message.
