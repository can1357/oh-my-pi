---
title: Tool Approvals
description: How omp decides whether to allow, deny, or prompt before a tool runs, including tiers, modes, per-tool overrides, and CLI flags.
coverage: A
---

Tool approval decides whether `omp` allows a tool call, blocks it, or pauses for your confirmation before it runs. The decision combines a **tier** declared by the tool with a **user policy** you set, resolved in a fixed order. You can change the global policy with a mode, override individual tools, or pass runtime flags on the CLI.

## Approval tiers

Every tool declares an `approval` tier that classifies what kind of action it performs:

| Tier | Behavior | Examples |
|---|---|---|
| `read` | Reads data or updates UI-only session metadata. Always safe to auto-approve. | `read`, `grep`, `list` |
| `write` | Mutates workspace or session state but does not execute arbitrary code. | `edit`, `write`, MCP server tools |
| `exec` | Executes code, shells out, drives a browser, spawns agents, or performs similarly broad actions. | `bash`, browser tools, subagent tools |

Tools without an `approval` declaration are treated as `exec`. This is the safe default for unknown custom tools — they always require confirmation in non-yolo modes. MCP server tools default to `write`.

A tier can also be a function or an object that overrides the global mode for dangerous patterns:

```ts
// Tier only
approval: "read";

// Tier by arguments
approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

// Tier with a forced-prompt override
approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";
```

## Approval modes

The global mode is set with `tools.approvalMode`:

| Mode | Auto-approves | Prompts for |
|---|---|---|
| `always-ask` | `read` | `write`, `exec` |
| `write` | `read`, `write` | `exec` |
| `yolo` (default) | `read`, `write`, `exec` | none |

### CLI flags

Two CLI flags force `yolo` mode for the session:

- `--auto-approve` — auto-approves all tool calls in this session.
- `--yolo` — equivalent.

Both are runtime overrides that take precedence over the configured `tools.approvalMode`. For ACP (`omp acp`), the equivalent flag is also accepted:

```bash
omp acp --yolo
omp acp --auto-approve
omp acp --approval-mode yolo
omp acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

## Per-tool overrides

`tools.approval` lets you set a per-tool policy (`allow`, `deny`, or `prompt`) that applies in every mode. The map is keyed by tool name:

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem__delete: deny
```

Invalid values for `tools.approval.<tool>` are ignored. Tools without an entry fall through to the active mode.

## Resolution order

For every tool call, the decision is computed in this order:

1. Compute the tool's tier from `tool.approval(args)`. A function form is called with the tool's arguments. If the tool does not declare `approval`, the tier defaults to `exec`.
2. If `tools.approval.<tool>` is set, normalize it. Invalid values are dropped.
3. In `yolo` mode, the user policy is used when present. Otherwise the call is allowed. Safety `override` reasons do **not** force a prompt in `yolo`.
4. In non-yolo modes, if the tool's decision sets `override: true`, `deny` is blocked and all other cases prompt, even if the user policy says `allow`. A tool can therefore force-prompt for dangerous patterns regardless of the global mode.
5. Otherwise, a valid user policy wins.
6. Otherwise, the active mode auto-approves or prompts by tier.

The standard approval prompt includes:

- `Allow tool: <name>`
- `Origin: MCP server tool` for unannotated `mcp__...` tools
- `Reason: <reason>` when the tool decision supplies one
- tool-specific details such as command, path, code, browser action, or subagent assignment

## Safety overrides

A tool can force a prompt with an object-form approval:

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` uses this for critical destructive patterns such as `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, and host shutdown commands. These surface as `reason` in the approval prompt, but in `yolo` mode they are auto-approved unless a user policy for the tool is `prompt` or `deny`.

## Bash command approval patterns

Bash is the most common `exec` tool, and the source has explicit support for per-command approval patterns. The `bash` tool declares its approval tier as a function of its arguments, so dangerous patterns force a prompt even when the user has not configured anything special. Patterns that trigger a forced-prompt include:

- `rm -rf /` and other recursive destruction of the root filesystem
- Fork bombs
- Remote-fetch-then-execute (downloading a script and piping it to a shell)
- Writes to `/etc/passwd`
- Host shutdown commands

A rejected, cancelled, or unsupported prompt rejects or cancels the tool call; `omp` does not silently allow it.

## Subagents

Subagents run headless with `tools.approvalMode: yolo` so they do not stall waiting for UI. The parent `task` approval is the authorization boundary. User `tools.approval.<tool>` settings continue to control whether a tool is allowed, prompted, or blocked.

## ACP sessions

ACP (`omp acp`) uses the same settings resolver as normal launches. Global `~/.omp/agent/config.yml` applies, project config for the session's `cwd` applies, and any `--config <file>` overlays passed to the ACP server process apply to sessions created by that process.

To auto-approve ACP tool calls, set the mode in global or project config:

```yaml
tools:
  approvalMode: yolo
```

Or launch the ACP server with a runtime override or a one-process config overlay as shown in [CLI flags](#cli-flags).

`tools.approvalMode: yolo` fully applies to ACP when explicitly configured or supplied by a runtime flag. It skips `omp`'s approval prompts and also skips the ACP client permission gate for `bash`, `edit`, `delete`, and `move` unless `tools.approval.<tool>` is `prompt` or `deny`. The schema default is `yolo`, but default-config ACP sessions still keep the client permission gate; set `tools.approvalMode: yolo` explicitly when the client wants unattended execution.

When ACP approval is required, `omp` routes it through the ACP client instead of the terminal TUI. Client-gated `bash`, `edit`, `delete`, and `move` calls use ACP `session/request_permission`; generic approval prompts use form elicitation when the client advertises `elicitation.form`.

:::tip
ACP does not currently define a `session/new`, `session/load`, or `session/resume` approval-policy field. ACP clients that need per-session yolo should launch a separate `omp acp` process with a flag or with a session-specific `--config` overlay.
:::

## Secrets and outbound obfuscation

Approval controls whether a tool **runs**. A complementary control is the `secrets` block, which prevents sensitive values (API keys, tokens, passwords) from being sent to LLM providers. With obfuscation enabled, outbound text messages to the model have secret values replaced with deterministic placeholders such as `#AB12#`, `#AB12:L#`, or `#GITHUBTOKEN_AB12:L#` before the request leaves the process. Reversible placeholders are restored when building display or resume context.

Enable it in `config.yml`:

```yaml
secrets:
  enabled: true
```

Secrets are collected from two sources:

- **Environment variables** whose names match common secret patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) with values at least 8 characters long
- **`secrets.yml` files** at `~/.omp/agent/secrets.yml` (global) or `<cwd>/.omp/secrets.yml` (project); project entries override global entries with matching `content`

Each entry has a `type` (`plain` or `regex`), the matching `content`, an optional `mode` (`obfuscate` is the default and reversible; `replace` is one-way and not restored), and optional `replacement`, `flags`, and `friendlyName` fields:

```yaml
# ~/.omp/agent/secrets.yml

# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"

# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Friendly name adds semantic context to the placeholder
- type: plain
  content: github_pat_abc123def456
  friendlyName: GitHub Token
```

:::note
Secrets obfuscation is a privacy control, not a permission gate. It changes what the model sees in text, not whether a tool runs. For tool authorization, use the `tools.approval` map and `tools.approvalMode` above.
:::

The hash base for placeholders is an HMAC of the secret under a private per-install key stored at `~/.omp/agent/secret-placeholder.key`. A case hint suffix labels the casing of the redacted value: `:U` all uppercase, `:L` all lowercase, `:C` capitalized, `:M` mixed. The same secret always produces the same placeholder within an install.
