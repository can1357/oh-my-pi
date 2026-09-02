Read files, directories, archives, SQLite, images, documents, internal resources, and web URLs via `path`.

<instruction>
- MUST collect every bounded target already required for the current step before calling `read`.
- MUST batch independent known local paths, file URLs, and internal URIs in one semicolon-delimited call.
- Join complete `path[:selector]` targets with `;`; keep each target otherwise unchanged.
- NEVER spread known independent targets across assistant turns.
- Read again only for a target discovered by a result or for a failed or truncated target.
- For independent MCP resources, issue separate sibling `read` calls in the same assistant turn.
- MCP resources include `mcp://` and MCP-advertised custom URIs.
- Preserve MCP resource URIs exactly; NEVER split or percent-encode server-provided semicolons.
- For independent HTTP(S) URLs, issue separate sibling `read` calls in the same assistant turn.
- NEVER combine an HTTP(S) URL with another target in a semicolon-delimited `path`.
- SQLite semicolons in SQL, table names, or row keys remain target data.
- Ambiguous literal semicolons → use separate sibling calls instead of corrupting a target.
- Literal semicolons inside batch-compatible internal URIs MUST use `%3B`.
- Example: `artifact://abc123;package.json;src/main.ts:1-200`.
- SHOULD use `read` (not browser) for web content; browser only when `read` can't deliver.
</instruction>

## Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`)
- `:50` / `:50-` — from line 50 | `:50-200` — inclusive | `:50+150` — 150 lines from 50 | `:5-16,960-973` — multiple ranges
- `:raw` — verbatim, no anchors/prefixes | `:2-4:raw` / `:raw:2-4` — range + verbatim
- `:conflicts` — one line per unresolved git merge conflict block
- `:img` — rasterize a local `.svg`/`.svgz` as a PNG image; use when visual layout matters

## Source kinds
- Parseable code, no selector → structural summary (declarations only, body elided). Footer names recovery selector — re-issue ONLY those ranges.
- {{#if IS_HL_MODE}}File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER fabricate the tag.{{/if}}
- Directory → depth-limited dirent listing.
- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`): `file.db` (tables), `file.db:table` (schema+rows), `file.db:table:key` (by PK), `?limit=`/`?where=`/`?q=SELECT`.
- Archives (`.zip` family incl. `.jar`/`.apk`/`.whl`, `.tar` incl. `.tar.{gz,bz2,xz,zst}`, `.rar`, `.7z`, `.iso`, `.cab`, `.deb`/`.rpm`/`.cpio`/`.ar`/`.a`, `.lzh`/`.arj`, `.asar`; single-stream `.gz`/`.bz2`/`.xz`/`.zst`): `archive.ext:path/inside/archive` reads a member.
- Documents → extracted text. Notebooks → editable cells. Images → {{#if INSPECT_IMAGE_ENABLED}}metadata; call `inspect_image`{{else}}decoded inline{{/if}}. SVGs read as text unless `:img` is specified. `:raw` bypasses converters.
- URLs → reader-mode clean text/markdown; `:raw` → untouched HTML. Bare `host:port` needs trailing slash.
- Internal URIs — all schemes take selectors. `artifact://<id>` recovers spilled output; page with `:N-M`/`:raw:N-M`.
- `ssh://host/<path>` reads remote file/dir (UTF-8, ≤1 MiB); bare `ssh://` lists hosts; writable with `write` and searchable with `grep`.
  Literal `:`, `?`, `#` → percent-encode (`%3A`/`%3F`/`%23`). Requires a verified POSIX shell on the remote host. For Windows or other unsupported hosts, use `bash` with a remote SSH command or mount with `sshfs`.

<critical>
Summary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
</critical>
