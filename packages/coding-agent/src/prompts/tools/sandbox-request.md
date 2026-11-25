Ask the user to let sandboxed commands and file tools write to, read, or connect to one exact path or host, or to let omp perform one action outside the sandbox (`exec`). The user decides in a dialog; you can never grant access yourself.

Use when a contained command or a tool failed (or will fail) because of the sandbox: a write outside the writable roots or to a protected path, a read of a path outside the readable roots, a refused host, or a tool refused with a `sandbox_request` to make. Use the exact `kind` and `target` a refusal names. Not for a permission error the sandbox did not cause (a file's own mode or owner), for an unreadable (`denyRead`) path, for a write in read-only mode, or for a host while the network is off or one that is an IP address or local name: those cannot be granted.

Fill every field so the user can decide without guessing:
- `intent`: what you are doing and why this exact path or host is needed, in the user's terms (e.g. "Build the docs site: `mkdocs build` writes its output to ../site."). NEVER "need access", "permission required", or a restatement of the target.
- `command`: the command that needs it, verbatim.
- `alternative`: what you will do if the user denies (e.g. "Build into ./site inside the workspace instead.").
- `target`: the narrowest target. The directory actually written, not its parent, `~`, or `/`; the file or directory actually read; the exact hostname (no scheme, port, or wildcard); for `exec`, the target the refusal names, verbatim. An `exec` grant lasts for this session only.

Rules:
- One request per target. Do not bundle, do not ask for a broader path to cover several.
- `denied`: do not ask again for that target and do not work around it (other paths, other tools, disabling the sandbox). Continue with your alternative or tell the user what is blocked.
- `instructed`: nothing was granted; follow the user's instructions.
- `granted`: re-run the command or tool call.
- `refused`: the request never reached the user; the result says why. Do not retry the same request.
