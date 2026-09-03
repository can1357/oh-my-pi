# Install ID

A persistent per-install UUID shared across sessions and profiles. It supplies a stable installation identity where provider compatibility protocols, account-scoped device metadata, auth-broker usage reporting, or deduplicated diagnostic pushes require one. The UUID itself is random; it is not derived from hostname, username, hardware, or account data.

## API

Exported from `@oh-my-pi/pi-utils` (`packages/utils/src/dirs.ts`):

| Symbol                                  | Purpose                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `getInstallId(): string`                | Returns the install ID, generating and persisting one on first call. Result is cached in-process for the lifetime of the runtime. |
| `__resetInstallIdCacheForTests(): void` | Clears the in-process cache. Test-only — MUST NOT be called from production code.                                                 |

Generated IDs are lowercase RFC 4122 UUIDs. Existing persisted values are accepted case-insensitively when they match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` with the regex `i` flag, and are returned exactly as stored.

## Storage

- Path: `<base-config-root>/install-id` — i.e. `~/.omp/install-id` by default, respecting `PI_CONFIG_DIR`. Resolved against the base config root (`getBaseConfigRoot()`) regardless of the active profile, so every profile on a host shares one install ID (install identity is per-install, not per-profile).
- Format: a single UUID line (trailing `\n`).
- Permissions: file is created with mode `0o600`.
- Lifecycle: independent of `~/.omp/agent/`. Wiping agent state (sessions, settings, DB) does NOT regenerate the install ID; only deleting the `install-id` file itself does.

## Generation and lifecycle

1. First call to `getInstallId()` reads the file. If contents parse as a valid UUID, that value is cached and returned.
2. Otherwise the helper calls `crypto.randomUUID()` (Node's CSPRNG-backed UUID v4) to mint a new ID.
3. The new value is written via `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)`. The exclusive-create guard means two processes hitting first-call simultaneously cannot both succeed — the loser sees `EEXIST`, re-reads the winner's file, and adopts that ID.
4. If the existing file contained non-empty garbage (failed UUID regex), it is `unlink`ed before the exclusive create so `O_EXCL` does not trip on stale data.
5. Any other write failure (read-only FS, permission error) is swallowed: the freshly generated UUID is still cached in-memory so the rest of the process sees a stable value, and subsequent process launches will retry persistence.
6. Subsequent in-process calls return the cached value without touching disk. Mutating the file on disk after the first call has no effect until the process restarts (or tests call `__resetInstallIdCacheForTests`).

## Consumers

| Consumer                                                                                             | Use                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai/src/providers/openai-codex-responses.ts`                                                | Sends the value as the OpenAI Codex compatibility `installationId`, alongside per-session/thread/window IDs.                                                                           |
| `packages/ai/src/providers/anthropic.ts` and `packages/coding-agent/src/session/session-metadata.ts` | Derives Claude-compatible `device_id` metadata from the install ID, scoped by the Anthropic account UUID when one is available. The raw install ID is not used as the device ID.       |
| `packages/ai/src/auth-broker/remote-store.ts`                                                        | Includes it in observed-usage reports to the configured auth broker. Those reports also include the hostname; the install-ID helper itself does not generate or combine that metadata. |
| `packages/coding-agent/src/tools/report-tool-issue.ts`                                               | Includes it as `installId` in auto-QA grievance pushes so the backend can correlate reports from the same installation.                                                                |

New consumers MUST treat the value as opaque. The helper contributes no PII, but a transport can still send it alongside other metadata; each consumer remains responsible for documenting and minimizing its complete payload.

## See also

- [environment-variables.md](environment-variables.md) — `PI_CONFIG_DIR` controls where `install-id` lives.
- [config-usage.md](config-usage.md) — broader config-root layout.
