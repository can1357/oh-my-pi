# sandbox_request

> Asks the user to let sandboxed commands write to, read, or connect to one exact path or host.

## Source

- Entry: `packages/coding-agent/src/tools/sandbox-request.ts`
- Model-facing prompts: `packages/coding-agent/src/prompts/tools/sandbox-request.md`, result text `packages/coding-agent/src/prompts/tools/sandbox-request-result.md`
- Key collaborators:
   - `packages/coding-agent/src/sandbox/runtime.ts` — `SandboxRuntime.requestAccess`, `grantPath`, `revokePath`, `sessionPaths`, `setAccessApprover`
   - `packages/coding-agent/src/sandbox/access.ts` — approver queue, worker forwarding, `sandboxAccessEffect`
   - `packages/coding-agent/src/ui/tools/sandbox-request.tsx` — call/result card (terminal look: `src/ui/styles/tools/sandbox-request.ts`)

## Inputs

|Field|Type|Required|Description|
|---|---|---|---|
|`kind`|`"write" \| "read" \| "host"`|Yes|Write (change and delete one existing file, or create, change and delete files under a directory), read, or connect to a hostname. On Linux a single file can be changed in place but not deleted or replaced (it is bind-mounted): grant its directory for that.|
|`target`|`string`|Yes|A path (absolute, `~`, or relative to the session cwd) or an exact hostname (no scheme, port or wildcard).|
|`intent`|`string`|Yes|What the agent is doing and why this exact target is needed, written for the user. Blank → refused.|
|`command`|`string`|No|The command that needs the access, verbatim.|
|`alternative`|`string`|No|What the agent does if the user denies.|

## Outputs

- Single-shot result. `content[0].text` states the decision and its consequence (granted: re-run the command; denied: do not retry or work around it; instructed: the user's reply; refused: why the request never reached the user).
- `details: SandboxRequestToolDetails` (`packages/coding-agent/src/tools/sandbox-request.ts`): the runtime's `SandboxAccessOutcome` (`granted` with `scope`, `already-allowed`, `denied`, `instructed` with `instructions`, or `refused` with `reason`) plus `kind`, `intent`, `command?`, `alternative?`.

## Flow

1. Registered only while `sandbox.enabled` is true (after the project-may-only-tighten rule) and something answers access requests (`SandboxRuntime.answersAccessRequests`: the TUI, an RPC host, an installed approver, or a worker whose main session answers them); the tool list follows the setting live. Print mode and ACP never register it.
2. `execute()` calls `SandboxRuntime.for(cwd).requestAccess(...)`:
   - targets are resolved (`~` expanded, relative against cwd, symlinks followed, dangling ones included, `..` applied after each link as the kernel does; hosts lower-cased without a trailing dot); an existing file is granted alone, and a write to a path that does not exist yet is granted as a directory, created empty (a protected path is not created);
   - refused without asking: sandbox off or unavailable, blank intent, control characters in the target, a filesystem root, a path at or under a `denyRead` entry, an invalid host, an IP address, `localhost` or `*.localhost` host not listed verbatim in `sandbox.network.allowedHosts` (only you can list it), a path that reaches a protected path through a dangling symlink, `write` in `read-only` mode, `host` while the effective network mode is `deny`, or no approver installed: an RPC client without `set_sandbox_access_prompts` (the refusal says so), or a worker-thread subagent whose main session has ended;
   - `already-allowed` without asking when the effective policy (or a session grant) covers the target; with network `allow`, every host;
   - otherwise the installed approver (interactive dialog, shared by main-thread subagents and answering requests forwarded from worker-thread subagents; or the RPC client after `set_sandbox_access_prompts`) decides: allow for this session, always allow (absent when the list is locked by env, an override, `--config` or project config), deny, or reply with instructions.
   - an approved path that resolves elsewhere by the time the user answers is refused, not granted;
3. A session grant applies to exactly the target, for the omp process (not a workspace or session; worker-thread subagents receive a replica through the sandbox thread service): merged into every contained policy and into the fingerprint, so sandboxed shells and kernels restart on their next call. An `always` grant appends the target to the global `sandbox.filesystem.allowWrite`/`allowRead` or `sandbox.network.allowedHosts`. Granted write roots are pinned to their real path; one later replaced by a symlink is dropped.
4. Revoking a session grant (`/sandbox` panel, `revoke_sandbox_path`) applies on the next sandboxed call; a running command, background jobs of a host no later call retires, and opted-in MCP servers keep their starting policy.

## Side Effects

- A dialog in every approval mode, including `yolo`; the tool itself needs no tool approval (tier `read`), so there is one prompt.
- An approved write grant creates the target directory when it does not exist (policy entries must exist).
- `always` writes the global config.

## Limits & Caps

- One dialog at a time per realm; identical concurrent requests share one dialog. `concurrency = "exclusive"`: requests in one message are asked one after the other.
- Each caller's abort settles only its own call; a queued request whose callers all aborted never reaches the approver.

## Errors

- Aborted while waiting: `ToolAbortError`.
- Everything else is a result (`refused` carries the reason), not a thrown error.
