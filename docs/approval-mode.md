# Tool approval mode

Tool approval has three inputs:

1. **Tool declaration** — every tool may declare an `approval` tier:
   - `read`: reads data or updates UI-only session metadata.
   - `write`: mutates workspace/session state but does not execute arbitrary code.
   - `exec`: executes code, shells out, drives a browser, spawns agents, or performs similarly broad actions.
2. **Tool policy** — object-form declarations may set `policy: allow | deny | prompt`, optionally with `override`, a reason, and a `policyKey` for a dispatched sub-tool. This is used for argument-dependent safety/pattern rules.
3. **User policy** — `tools.approval.<toolName>: allow | deny | prompt` overrides the active mode, but cannot bypass a tool's own deny/prompt policy or a non-yolo safety override.

Tools without an `approval` declaration, and decisions without a valid tier, use `exec`. This is the safe default for unknown custom tools. MCP server tools declare `write`, regardless of their MCP annotations.

When an execute-time caller supplies neither settings nor `autoApprove`, approval resolution fails closed to `always-ask` with no user grants. A live extension wrapper can inherit its runner's session settings when context is omitted.

## Modes

Configure with `tools.approvalMode`:

| Mode                | Auto-approves                                          | Prompts for                 |
| ------------------- | ------------------------------------------------------ | --------------------------- |
| `always-ask`        | `read`                                                 | `write`, `exec`             |
| `always-ask-cached` | `read` without file targets, granted files and folders | file reads, `write`, `exec` |
| `write`             | `read`, `write`                                        | `exec`                      |
| `yolo` (default)    | `read`, `write`, `exec`                                | none                        |

`--approval-mode <mode>` overrides the configured mode for the session. `--auto-approve` and `--yolo` force yolo execution even when an explicit `--approval-mode` is also supplied; tool/user denies and explicit tool prompt policies still apply.

### Ask and remember (`always-ask-cached`)

Ask and remember prompts like `always-ask`, and also before a tool reads a file it has not been granted. Its prompts can remember what the call touched:

- **Approve Directory: `<folder>`** grants the folder around the call. A folder grant covers the files directly inside it, never a subfolder or anything below one. The prompt names the folder and lists its entries (directories end in `/`): the first few in the dock, up to 24 in the expanded prompt (`Ctrl+O`). Larger folders show the rest as a count.
- **Approve File** (or **Approve** for a directory or URL target) grants the exact targets.
- **Approve Once** approves this call only.

The **Remember across sessions** toggle above these answers decides where a grant lives. When it is off, the grant stays in memory for this conversation only: `/new`, a session switch, and other sessions in the same process start without it. When it is on, the grant is written to `approval-cache.db` in the agent directory and covers every later session. Hosts without the dialog (RPC, ACP, collab guests) get both lifetimes as separate choices: `Approve File`, `Always Approve File`, and so on.

- Grants record the capability tier they authorized. A write grant also covers reads of the same target; a read grant never covers a write or exec call.
- The tools that read files report the files and folders they touch: `read`, `grep`, `glob`, `ast_grep`, `find`, and the legacy `read`/`grep`/`find`/`ls` shims. A recursive search reaches below subfolders, so it needs a tree grant of its own; approving one also records the folder grant it includes. A root list such as `src;other` is keyed one root at a time.
- Other read-tier tools (`lsp`, `debug`, `github`, `todo`, …) stay auto-approved as in `always-ask`. This mode decides when you are asked; it does not sandbox reads.
- Reads of public web URLs are never gated. URLs whose host is `localhost`, a private, loopback, or link-local IP literal, a single-label name, or a `.local`/`.internal` name are gated like files. Hostnames are not resolved, so a public name that points at a private address is not detected. Internal URLs (`xd://…`, `local://…`) are keyed by their normalized form.
- An exec or write call that reports no targets (`bash`, `eval`, `browser`, `task`, MCP tools) prompts as in `always-ask`, with the usual **Approve `<tool>` for this session** choice.
- A read of `file.ts:120-140` and a write to `file.ts` share one key: selectors are peeled, the path is resolved against the session cwd and through symlinks (including a symlinked parent of a file that does not exist yet), and on Windows case is folded.
- Grant answers appear only on prompts the mode raised. Prompts forced by a tool policy, an `override` (bash critical commands), a `tools.approval.<tool>: prompt` rule, or a pending provider safety check keep plain Approve/Deny and record nothing.
- `/forget-approvals` clears the database and every conversation's session grants for the active agent directory. Deleting rows (`DELETE FROM grants`) or the file works too; every check reads the database fresh, so no restart is needed.

## User overrides

`tools.approval` is honored in every mode:

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem_delete: deny
```

For MCP tools, key the policy by the exact final registered name. The ordinary form is
`mcp__<sanitized_server>_<sanitized_tool>`. A redundant `<server>_` prefix is removed from the tool name,
so server `echo` tool `echo_it` is registered as `mcp__echo_it`. Names longer than 64 characters are
capped with a deterministic hash suffix; use the final capped name rather than the uncapped pattern. See
[MCP tool naming](./mcp-server-tool-authoring.md#naming-and-collision-domain).

The sanitizer lowercases names and retains letters, digits, and underscores. For MCP names changed by the older digit-stripping sanitizer, a legacy `deny` or `prompt` key is inherited only when no current-name policy applies; legacy `allow` is never inherited.

A decision's `policyKey` selects `tools.approval.<policyKey>` first, falling back to the invoking tool's policy when the keyed policy is missing or invalid. For example, `write` to a mounted `xd://lsp` device consults `tools.approval.lsp` before `tools.approval.write` and uses the device operation's tier.

Resolution per tool call:

1. Evaluate `tool.approval(args)`; omitted/malformed decisions default to tier `exec`.
2. A tool-declared `policy: deny` always denies. A user `deny` is checked next and also always denies.
3. In `yolo`, an explicit tool `allow`/`prompt` policy wins; otherwise the valid user policy wins, or the call is allowed. The `override` flag alone does not force a prompt in `yolo`.
4. In non-yolo modes, an `override: true` decision allows only an accompanying tool `policy: allow`; every other non-denied case prompts.
5. Without an override, an explicit tool `allow`/`prompt` policy wins, then a valid user policy wins.
6. With no explicit policy, the active mode auto-approves or prompts by tier. In `always-ask-cached`, a call whose `approvalCacheTargets` are all granted is allowed instead.

Policy strings are trimmed and case-normalized. Invalid user values are ignored.

Approval is resolved again after extension `tool_call` handlers revise the input, against the arguments that will actually execute. A deny blocks execution before a prompt; a call that still requires a prompt fails rather than silently allowing it when no interactive UI is available.

## Safety overrides

A tool can force a prompt with object-form approval:

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` uses this for critical destructive patterns such as `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, and host shutdown commands. It also supports configured `bash.patterns` rules: `deny` is absolute, `prompt` forces a prompt, and `allow` explicitly allows a matching simple command at the `write` tier. Reasons appear in the approval prompt. In `yolo`, a bare critical override is ignored, but an explicit tool/user `prompt` or `deny` policy is still enforced.
For standalone bash commands, critical detection takes precedence over matching `allow`/`prompt` pattern returns (but not `deny`), replacing them with that bare safety override.

`bash.allowCompoundCommands` is off by default. When enabled, it recognizes only flat chains joined by `&&` whose segments consist of literal arguments. Rules remain ordered within each segment: the first matching rule wins for that segment. Explicit restrictions are combined conservatively across the chain: any matching `deny` wins, otherwise any matching `prompt` wins. A restriction matching the complete chain but no individual segment remains a whole-chain veto.

All matching whole-chain restrictions are considered, so a later whole-chain deny overrides an earlier prompt. The opt-in requires a positively identified POSIX-quoting shell through the centralized shell classifier. Cmd, PowerShell, fish, and unknown shells retain legacy approval behavior.

These explicit chain and segment restrictions are resolved before the existing raw and canonical critical-command checks. After those checks, a chain whose segments all explicitly resolve to `allow` receives the `write`-tier allow; if any segment is unmatched, bash instead retains its standalone `exec` approval tier with no explicit policy. The generic resolver then applies `tools.approval.bash`, followed by the active approval mode, exactly as it would for a standalone command. An unmatched segment therefore prompts only when that existing tool-wide policy or mode requires it. Expansions, assignments, other control flow, redirections, globbing, newlines, malformed syntax, and shell-state-changing builtins do not qualify and retain legacy approval behavior.

This pattern policy controls approval for the `bash` tool; it is not process or filesystem containment. An approved command retains the shell's ambient filesystem, network, and subprocess access. The `eval` tool also declares the `exec` tier and can spawn a shell via subprocess, so a `bash.patterns` `deny` rule does not apply to the same command run through `eval` — under `yolo`, that `exec` call resolves to `allow`. To gate the shell `eval` can reach, add a `tools.approval.eval` policy (`prompt` or `deny`) alongside `bash.patterns`.

### Computer safety

The disabled-by-default Eval [`computer` API](./computer-use.md) chooses its tier per call:

- direct helpers (`computer.windows()`, `win.screenshot()`, `win.ax()`, `el.bounds()`, `computer.clipboard.read()`, …) use `read` when the invoked method is inspection-only and `exec` for input, focus, mutation, and `clipboard.write`; read calls also run under the worker's read-only guard;
- `computer.run(fnOrCode, options)` uses `read` only for `read_only: true` (JavaScript trailing option or Python keyword); `read_only: false`, a missing field, malformed arguments, or any other value uses `exec`.

The approval prompt shows `read-only` when applicable, followed by the resolved JavaScript (truncated to 2,000 characters by the standard formatter). For `computer.run`, `read_only: true` also enables the worker's desktop guard: input, focus, mutation, and clipboard writes throw. It is not static analysis or a general JavaScript sandbox.

Separately, provider-originated computer-use calls may carry `pendingSafetyChecks` metadata. Any pending check forces an interactive prompt regardless of yolo or per-tool `allow`. The prompt lists each safety-check code, message, and sanitized/truncated data. Without an interactive UI, the call fails closed with `pending provider safety checks but no interactive UI is available`.

Tool approval does not authorize the underlying real-world action. On-screen text is untrusted and cannot override direct user instructions. Consequential actions still require point-of-risk confirmation of the exact target, scope, and values unless the user's direct message already authorized them.

## Per-tool prompt details

Tools can add approval-prompt body lines with `formatApprovalDetails(args)`. The standard prompt includes:

- `Allow tool: <name>`
- `Origin: MCP server tool` for unannotated `mcp__...` tools
- `Reason: <reason>` when the tool decision supplies one
- tool-specific details such as command, path, code, browser action, or subagent assignment

In the interactive UI the prompt docks above the composer until answered with a list of choices: **Approve**, **Approve `<tool>` for this session**, and **Deny**. With an empty composer the arrow keys move between them and `Enter` takes the highlighted one (Approve on mount); `Ctrl+Enter` (or `Ctrl+Q`; rebind `app.approval.approve`) approves this call outright and `Esc` denies. `Enter` and the approve key are ignored for the first half second, so a key meant for the composer (or the follow-up key, pressed mid-run) as the prompt appears cannot answer it. The session choice approves later calls of the same tool (or `xd://` device) at the same tier until the session ends or changes; it is offered only for prompts the approval mode raised, never for critical-command overrides, explicit `prompt` policies, or provider safety checks, which ask every time. The composer keeps its cursor and takes typing, to deny and steer instead: while it holds a draft, the highlight sits on Deny, relabeled **Deny and send message**, the arrows and `Enter` edit and send the draft, and `Ctrl+C` clears it rather than denying. Sending a message while calls wait (from the composer, Tern, or a collab guest) denies every pending approval, and any the same tool batch asks for before the message is delivered, then steers the turn with that message, so the agent learns why instead of guessing at a bare denial. To leave the composer its room, the prompt summarizes the tool's details to one row (each detail's first line, `…` when more is left out), always built from the input that will run; `Ctrl+O` (`app.tools.expand`, or Details in Tern) shows every detail in full, and `PgUp`/`PgDn` scroll them. In Tern, a click on a choice takes it. RPC, ACP, and other hosts without an approval dialog get a select with the same choices and the full details.

An Ask and remember prompt with grants lists the **Remember across sessions** toggle and the grant choices above **Approve Once**, which is highlighted on mount. `Enter` on the toggle flips it, and the grant labels switch to their **Always …** forms. `Ctrl+Enter` still approves only this call.

## Defining approval on tools

Built-in and custom tools share the same shape:

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision =
  | ToolTier
  | {
      tier: ToolTier;
      reason?: string;
      override?: boolean;
      policy?: "allow" | "deny" | "prompt";
      policyKey?: string;
    };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
approvalCacheTargets?: (args: unknown) => readonly string[] | undefined;
```

`approvalCacheTargets` returns the keys `always-ask-cached` checks and records for a call: absolute file paths (derive them with `approvalTargetKey` so selectors, cwd, and symlinks resolve the same way the built-in tools do) or normalized internal URLs. `ToolDefinition` and `CustomTool` accept the same hook. A tool that omits it is resolved by tier alone, as in `always-ask`.

Examples:

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";

approval: (args) =>
  isForbidden(args)
    ? { tier: "exec", policy: "deny", reason: "Blocked by tool policy" }
    : "write";
```

## ACP sessions

ACP (`omp acp`) uses the same settings resolver as normal OMP launches. Global `~/.omp/agent/config.yml` applies, project config for the ACP session `cwd` applies, and any `--config <file>` overlays passed to the ACP server process apply to sessions created by that process.

To auto-approve ACP tool calls, set the mode in global or project config:

```yaml
tools:
  approvalMode: yolo
```

Or launch the ACP server with a runtime override or a one-process config overlay:

```bash
omp acp --yolo
omp acp --auto-approve
omp acp --approval-mode yolo
omp acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

Precedence is the normal settings precedence: runtime flags (`--approval-mode`, `--auto-approve`, `--yolo`) override `--config` overlays, which override project config, which overrides global config. ACP does not currently define a `session/new`, `session/load`, or `session/resume` approval-policy field, so ACP clients that need per-session yolo should launch a separate `omp acp` process with one of the flags above or with a session-specific `--config` overlay.

`tools.approvalMode: yolo` fully applies to ACP when explicitly configured or supplied by a runtime flag: it skips ordinary tier-based OMP prompts and the ACP client gate unless the resolved tool or user policy requires a prompt or denies the call. The schema default is also `yolo`, but without an explicit opt-in, unmatched bash commands and destructive file operations still require an ACP client grant.

For `bash`, ACP resolves `bash.patterns`, critical-command overrides, per-tool policies, and the approval mode before requesting permission: `allow` runs without a card, `deny` blocks without a card, and `prompt` uses `session/request_permission`. An “Always allow” choice covers later ordinary `bash` calls in the session; critical commands and explicit prompt patterns still require a card on every call.

For `delete`, `move`, and `edit` patches containing deletion or rename operations, the additional editor-side gate remains operation-category scoped. Ordinary file-content edits do not use that extra gate. Generic approval prompts use form elicitation when the client advertises `elicitation.form`. A rejected, cancelled, or unsupported prompt rejects or cancels the tool call.

## Subagents

Subagents run headless with `tools.approvalMode: yolo` so ordinary tier-based prompts do not stall them. The parent `task` approval is the authorization boundary. Per-tool policies still use the normal resolver: user `deny` remains absolute, and any call that resolves to `prompt` rejects because a headless subagent cannot satisfy it.
