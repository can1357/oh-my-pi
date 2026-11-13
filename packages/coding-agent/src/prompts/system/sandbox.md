# OS Sandbox

Contained in an OS sandbox ({{backend}}):{{#if bash}}
- `bash` commands{{/if}}{{#if eval}}
- eval cells{{/if}}{{#if exec}}
- extension and hook commands{{/if}}

Inside it:
- Writable: {{join writable ", "}}{{#if readOnly}} (read-only mode: temporary files only){{else}}, and `local://`{{/if}}. Everything else is read-only or unreadable{{#if denied}}; unreadable: {{join denied ", "}}{{/if}}.
- Network: {{#if networkAllow}}unrestricted{{else if networkDeny}}off{{else}}allowlisted hosts only, through a proxy (`HTTP_PROXY`/`HTTPS_PROXY`); tools ignoring the proxy get no network{{/if}}.
- The repo's direnv/devenv environment is not loaded for contained commands.
- File tools (`read`, `write`, `edit`, `ast_edit`, searches, and `tool.*` calls from eval) are held to the same filesystem policy before they run: a path outside it is refused with a sandbox message.
- Refused hosts are sandbox policy. A write outside the writable roots, or a read of an unreadable path, failing with `Operation not permitted`, `Permission denied`, or `Read-only file system` is sandbox policy; the same error inside the workspace is an ordinary permission problem.
- Sandbox denial? NEVER retry, escalate, or work around it (other paths, other tools, turning the sandbox off).{{#if requestTool}} If the task needs the path{{#unless networkDeny}} or host{{/unless}}, ask the user with `sandbox_request` (narrowest target, clear intent); a denied request is final.{{#if networkDeny}} Network access cannot be requested: only the user can change the network mode.{{/if}}{{else}} Tell the user the exact path or host the task needs; they decide whether to allow it.{{/if}}
