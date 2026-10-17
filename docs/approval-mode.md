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

| Mode                 | Auto-approves           | Prompts for     |
| -------------------- | ----------------------- | --------------- |
| `always-ask`         | `read`                  | `write`, `exec` |
| `always-ask-cached`  | approved targets, folders, and session-approved tools | `write`, `exec`, new `read` targets |
| `write`              | `read`, `write`         | `exec`          |
| `yolo` (default)     | `read`, `write`, `exec` | none            |

`--approval-mode <mode>` overrides the configured mode for the session. `--auto-approve` and `--yolo` force yolo execution even when an explicit `--approval-mode` is also supplied; tool/user denies and explicit tool prompt policies still apply.

### Ask and remember (`always-ask-cached`)

The **Ask and remember** mode (`always-ask-cached`) turns file operations and shell commands into one approval per target. A prompt asks *what* to remember — the directory around the call, or the exact file — and a **Remember** checkbox beside the answers decides *where the grant lives*:

- **Remember: This Session** (the default). The grant is kept in memory for the conversation it was approved in: nothing is written to disk, `/new`, a session switch, or another session in the same process starts without it, and two open omp instances never share these grants.
- **Remember: Always.** The same grant is written to `approval-cache.db` under the active agent directory (`~/.omp/agent/approval-cache.db`, or the profile's equivalent), where it outlives every instance and covers later sessions. A grant is honored when either tier holds it.

Prompts, per call class:

- The first `read`, `write`, or `edit` touching a file prompts (`Reason: target not yet approved`) unless that file, or the folder holding it, is already approved.
- Folder grants cover the folder's own entries, one level deep: a file directly inside it is covered, while a subfolder and everything below it is not — approving `~/Desktop` still prompts for `~/Desktop/TestFolder` and for files inside it, each needing its own approval. Nothing a folder grant holds ever reaches back up: a subfolder's grant covers only that subfolder's entries.
- Every prompt that offers `Approve Directory` names that folder and lists its own entries, directories marked with a trailing slash, so a folder is never approved unseen: the dock's summarised prompt shows the first few entries, and the expanded prompt (`Ctrl+O`) up to 24 with the rest counted. Subfolders are listed as entries only — approving the folder does not enter them.
- Reads of public web URLs (`http://`, `https://`, or a `www.` host) never prompt and are never remembered — their contents are already public. A host that only resolves inside this machine or network does prompt: `localhost`, a private or link-local address (`127.0.0.1`, `10.…`, `192.168.…`, `169.254.…`, `::1`, `fe80:…`), a reserved suffix (`.local`, `.internal`), or a bare intranet name. Registered internal URLs (`xd://…`, `local://…`) still prompt once per normalized URL.
- `bash` prompts on every call unless the shell itself is approved for the session (`Approve bash for session`) — commands are never remembered by their text, and a folder grant does not cover them: the shell is an exec tool like `eval`, `browser`, or `task`.
- The answers are offered as a menu in terminals without a native dialog: the dock lists the checkbox first, then `Approve Directory (<folder>)`, `Approve <tool> for session` (on calls with no directory of their own), `Approve File` (or `Approve` for a URL target), `Approve Once`, and `Deny` — a call whose only target is a directory offers just `Approve Directory` and `Approve Once` — and the arrows move the highlight, `Enter` confirms it (on the checkbox it toggles instead), `Esc` denies, and no key is bound to an individual answer — only choosing and confirming can approve. `Ctrl+O` swaps the details between summarised and full — the option and its hint appear only when the full prompt adds something the summary row does not, and `Ctrl+O` keeps its tool-output meaning when it does not — and page keys scroll them; anything typed goes to the composer and sending it denies the call, as before. Tern's native surface shows the same answers as buttons — `Details`, the remember checkbox, `Approve Directory`, `Approve <tool> for session`, `Approve File`, `Approve Once`, `Deny` — and a click takes one.
- The exact answer is named for what it remembers, and appears only when it has something of its own to name: a directory read (e.g. `read ~/Desktop`) answers through `Approve Directory` alone — the exact answer would have repeated that grant, and the folder offered is the directory itself, never the parent that holds every sibling — `Approve File` appears only when the exact target really is a file, and a URL target keeps the plain `Approve`. `Approve Once` approves the call and records nothing; it is what a call with nothing recordable shows in place of a plain `Approve` (a shell command is only covered by its own by-name grant). The checkbox is hidden when the call has neither a file nor a folder to record (e.g. `eval`).
- Every grant records the capability it authorized, and covers that tier and the lower ones: approving a *write* also covers reads of that target, while approving a *read* never allows a write or an exec call of it — a folder grant included, so a folder approved by reading a directory still asks before writing in it.
- Which answers appear is gated by what the call can record: the directory row needs a folder candidate (the folder around the files the call names), the exact row needs a cache target that is not the call's whole directory, and the by-name tool row needs a call that is not a file read/write and has no directory of its own. Calls with no filesystem path (`bash`, `eval`, `browser`, `task`, URLs) show no directory row, and a command shows only `Approve <tool> for session`, `Approve Once`, and `Deny`.
- The exact `Approve File` answer always remembers the exact file it touched — granting a folder is what the directory answer (or a command's folder scope) is for.
- Hosts without the checkbox (RPC, ACP, collab guests) get the two scopes with both lifetimes spelled out — `Approve Directory: <folder>`, `Approve File`, `Always Approve Directory: <folder>`, `Always Approve File`, `Deny`. Prompts that offer grants also carry `Approve Once`, a call with no directory of its own adds `Approve <tool> for session`, a call whose only target is a directory keeps just the directory and once answers, and a URL target spells its cross-instance form out as `Always Approve`. Hosts built against the earlier `"once" | "session" | "deny"` answers keep working: `"once"` approves the call only, `"session"` approves it with the grant the prompt named, and `"deny"` denies.
- Denying leaves no entry, so the next attempt prompts again.
- Searches are reads of the place they search: `grep` and `glob` report the folder (or file) they walk, so the grant a `read` of that place would need covers them too, and a search is never a way around a read prompt. A recursive search — `grep` anywhere, `glob` with a `**` or bare pattern — reads below subfolders, which a folder grant does not reach, so it carries a tree grant of its own; approving that tree also records the folder grant it includes. A root list such as `src;other` is keyed root by root, exactly as the search fans it out. Read-tier tools that name nothing (`glob` over a web URL, listings) stay auto-approved. Exec tools with no cache target or folder scope keep prompting on every call: `bash`, `eval`, `browser`, `task`, `computer`, and any tool an extension registers without `approvalCacheTargets`/`approvalCacheScopes` — until the by-name answer (`Approve <tool> for session`) remembers the tool alone, no arguments, in this instance only.
- Prompts forced by a tool's own `policy: prompt`/`override` or by `tools.approval.<tool>: prompt` stay per-call: only approvals raised by the mode itself are recorded, and those keep plain Approve/Deny. That covers bash critical-command overrides (`rm -rf /`, fork bombs, …) and `bash.patterns` `prompt` rules. Provider safety checks ask every call too: a prompt with one pending keeps plain Approve/Deny even when the mode raised it, so nothing about it is remembered.
- A read of `file.ts:120-140` and a write to `file.ts` share one entry: the selector (`:120-140`, `:raw`, `:img`, `?q=`) is peeled, the path resolves against the session cwd, and case is folded on case-insensitive platforms. Registered internal URLs (`xd://…`, `local://…`) are keyed by their normalized URL.
- `--auto-approve`/`--yolo` still force yolo execution and bypass the cache entirely.

The global cache is a SQLite database: one `grants` row per key holding `tool`, `approved_at`, and `scope` (`directory` for folder grants; NULL for exact ones). Revoke global grants in omp itself — Settings → Interaction → Approvals → **Forget Remembered Approvals** empties the database and forgets the session's grants with it — or by deleting rows from any SQLite client, `DELETE FROM grants WHERE key = ?` (or `DELETE FROM grants`) against `approval-cache.db`, or by deleting the file; connections are short-lived, so a running session picks the change up on its next approval check and no restart is needed. A pre-existing `approval-cache.json` is imported on first use and removed (kept as `approval-cache.json.bak` only if it cannot be read), so the database is the only cache on disk. Session grants cannot be revoked from outside the process; quit omp or restart the session to forget them.

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
6. With no explicit policy, the active mode auto-approves or prompts by tier. In `always-ask-cached`, that mode step instead allows a read/write call whose `approvalCacheTargets` are all approved and prompts otherwise; approving records them.

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

In the interactive UI the prompt docks above the composer until answered with a list of choices — **Approve** and **Deny** for a prompt a policy forced, plus the grant answers when the Ask and remember mode raised it: **Approve Directory**, **Approve File**/**Approve**, **Approve `<tool>` for session**, **Approve Once**, and the **Remember** checkbox. With an empty composer the arrow keys move between the choices and `Enter` takes the highlighted one (the checkbox row toggles in place); no key approves a call outright, so an `Enter` meant for the composer can never answer a prompt, and `Esc` denies. That `Enter` is ignored for the first half second after the prompt appears, since it is also the follow-up key, pressed mid-run exactly when prompts appear. The composer keeps its cursor and takes typing, to deny and steer instead: while it holds a draft, every key edits it, `Enter` sends it — denying every pending approval and any the same batch asks for before the message is delivered, then steering the turn with it, so the agent learns why instead of guessing at a bare denial — and `Ctrl+C` clears it rather than denying. To leave the composer its room, the prompt summarizes the tool's details to one row (each detail's first line, `…` when more is left out), always built from the input that will run; `Ctrl+O` (`app.tools.expand`, or Details in Tern) shows every detail in full, and `PgUp`/`PgDn` scroll them. Tern shows the choices as buttons, and a click takes one; RPC, ACP, and other hosts without an approval dialog get a select with the same choices and the full details.

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

`approvalCacheTargets` feeds `always-ask-cached`: the returned keys are checked against the grant file before the mode prompts, and recorded when the user approves, keyed by the capability tier the call resolved to — a grant covers its tier and the lower ones, so approving a read never authorizes a write of the same target. Both public registration surfaces declare these hooks (`ToolDefinition` and `CustomTool`), so an extension tool takes part in the same grants. Path-based tools (`read`, `write`, `edit`) derive them through `approvalTargetKey` so a selector-stripped, cwd-resolved path (or normalized internal URL) is the unit of approval; `grep`/`glob` report the folder, tree, or file they search so a read grant covers them too. Tools that omit it never get cached grants; `read` omits it for public web URLs, so those reads are never gated or remembered either.

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
