# Install ID

A persistent per-install UUID that identifies a single oh-my-pi installation across sessions. Used as a stable correlation key for server-side dedup of telemetry-style pushes (currently the auto-QA grievance flush from `report_tool_issue`).

## API

Exported from `@pk-nerdsaver-ai/pi-utils` (`packages/utils/src/dirs.ts`):

| Symbol                                  | Purpose                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `getInstallId(): string`                | Returns the install ID, generating and persisting one on first call. Result is cached in-process for the lifetime of the runtime. |
| `__resetInstallIdCacheForTests(): void` | Clears the in-process cache. Test-only — MUST NOT be called from production code.                                                 |

Generated IDs are lowercase RFC 4122 UUIDs. Existing persisted values are accepted case-insensitively when they match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` with the regex `i` flag, and are returned exactly as stored.

## Storage

- Path: `<base-config-root>/install-id` — i.e. `~/.ompk/install-id` by default, respecting `PI_CONFIG_DIR`. Resolved against the base config root (`getBaseConfigRoot()`) regardless of the active profile, so every profile on a host shares one install ID (install identity is per-install, not per-profile).
- Format: a single UUID line (trailing `\n`).
- Permissions: file is created with mode `0o600`.
- Lifecycle: independent of `~/.ompk/agent/`. Wiping agent state (sessions, settings, DB) does NOT regenerate the install ID; only deleting the `install-id` file itself does.

## Generation and lifecycle

1. First call to `getInstallId()` reads the file. If contents parse as a valid UUID, that value is cached and returned.
2. Otherwise the helper calls `crypto.randomUUID()` (Node's CSPRNG-backed UUID v4) to mint a new ID.
3. The new value is written via `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)`. The exclusive-create guard means two processes hitting first-call simultaneously cannot both succeed — the loser sees `EEXIST`, re-reads the winner's file, and adopts that ID.
4. If the existing file contained non-empty garbage (failed UUID regex), it is `unlink`ed before the exclusive create so `O_EXCL` does not trip on stale data.
5. Any other write failure (read-only FS, permission error) is swallowed: the freshly generated UUID is still cached in-memory so the rest of the process sees a stable value, and subsequent process launches will retry persistence.
6. Subsequent in-process calls return the cached value without touching disk. Mutating the file on disk after the first call has no effect until the process restarts (or tests call `__resetInstallIdCacheForTests`).

## Consumers

- `packages/coding-agent/src/tools/report-tool-issue.ts` — included as `installId` in the auto-QA grievance push body so the backend can deduplicate repeated reports from the same install. See `dev.autoqaPush.*` settings and `PI_AUTO_QA_PUSH_*` env vars.

New consumers MUST treat the value as opaque and MUST NOT derive PII from it; the helper does not mix in hostname, username, or any other host-identifying entropy.

## See also

- [environment-variables.md](environment-variables.md) — `PI_CONFIG_DIR` controls where `install-id` lives.
- [config-usage.md](config-usage.md) — broader config-root layout.
