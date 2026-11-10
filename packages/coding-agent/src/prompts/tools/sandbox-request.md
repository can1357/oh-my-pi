Ask the user to let sandboxed commands and file tools write to, read, or connect to one exact path or host. The user decides in a dialog; you can never grant access yourself.

Use when a contained command or a file tool (`write`, `edit`, `read`, …) failed (or will fail) because of the sandbox: a write outside the writable roots, a read of an unreadable path, a refused host. Not for ordinary permission errors inside the workspace.

Fill every field so the user can decide without guessing:
- `intent`: what you are doing and why this exact path or host is needed, in the user's terms (e.g. "Build the docs site: `mkdocs build` writes its output to ../site."). NEVER "need access", "permission required", or a restatement of the target.
- `command`: the command that needs it, verbatim.
- `alternative`: what you will do if the user denies (e.g. "Build into ./site inside the workspace instead.").
- `target`: the narrowest target. The directory actually written, not its parent, `~`, or `/`; the file or directory actually read; the exact hostname (no scheme, port, or wildcard).

Rules:
- One request per target. Do not bundle, do not ask for a broader path to cover several.
- `denied`: do not ask again for that target and do not work around it (other paths, other tools, disabling the sandbox). Continue with your alternative or tell the user what is blocked.
- `instructed`: nothing was granted; follow the user's instructions.
- `granted`: re-run the command or tool call.
- `refused`: the request never reached the user; the result says why. Do not retry the same request.
