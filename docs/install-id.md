# Install ID

A persistent per-install UUID shared across sessions and profiles. It supplies a stable installation identity where provider compatibility protocols, account-scoped device metadata, auth-broker usage reporting, or deduplicated diagnostic pushes require one. The UUID itself is random; it is not derived from hostname, username, hardware, or account data.

## API

Exported from `@oh-my-pi/pi-utils` (`packages/utils/src/dirs.ts`):

| Symbol                                  | Purpose                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `getInstallId(): string`                | Returns the install ID, generating and persisting one on first call. Result is cached in-process for the lifetime of the runtime. |
| `__resetInstallIdCacheForTests(): void` | Clears the in-process cache. Test-only — MUST NOT be called from production code.                                                 |

Generated IDs are lowercase UUID v4 values. Existing persisted values are trimmed, then accepted case-insensitively when they match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` with the regex `i` flag; their case is preserved. The read check does not constrain the UUID version or variant.

## Storage

- Path: `<base-config-root>/install-id` — i.e. `~/.omp/install-id` by default, respecting `PI_CONFIG_DIR`. Resolved against the base config root (`getBaseConfigRoot()`) regardless of the active profile or XDG data/state/cache routing, so every profile using that base root shares one install ID.
- Format: a single UUID line (trailing `\n`).
- Permissions: file is created with mode `0o600`.
- Lifecycle: independent of `~/.omp/agent/`. Wiping agent state (sessions, settings, DB) does NOT regenerate the install ID; only deleting the `install-id` file itself does.

## Generation and lifecycle

1. First call to `getInstallId()` reads the file. If contents parse as a valid UUID, that value is cached and returned.
2. Otherwise the helper calls `crypto.randomUUID()` (Node's CSPRNG-backed UUID v4) to mint a new ID.
3. The new value is written via `open(O_WRONLY | O_CREAT | O_EXCL, 0o600)`. The exclusive-create guard prevents competing creators from overwriting the file; an `EEXIST` loser re-reads it and adopts the value if it is already a valid UUID.
4. If the existing file contained non-empty garbage (failed UUID regex), it is `unlink`ed before the exclusive create so `O_EXCL` does not trip on stale data.
5. Write failures (read-only FS, permission error), or `EEXIST` followed by an unreadable/invalid value, are swallowed: the freshly generated UUID is still cached in-memory so the rest of the process sees a stable value. Later launches retry. An empty existing file is not unlinked, so it can leave successive processes using different in-memory IDs.
6. Subsequent in-process calls return the cached value without touching disk. Mutating the file on disk after the first call has no effect until the process restarts (or tests call `__resetInstallIdCacheForTests`).

## Consumers

| Consumer                                                                                             | Use                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai/src/providers/openai-codex-responses.ts`                                                | Sends the value as the OpenAI Codex compatibility `installationId`, alongside per-session/thread/window IDs.                                                                           |
| `packages/ai/src/providers/anthropic-identity.ts` and `packages/coding-agent/src/session/session-metadata.ts` | Derives Claude-compatible `device_id` metadata from the install ID, scoped by the Anthropic account UUID when one is available. The raw install ID is not used as the device ID. |
| `packages/ai/src/auth-broker/remote-store.ts` | Uses it in default observed-usage attribution sent to the auth broker, alongside hostname and application name; reports can instead carry an originating client's identity. |
| `packages/ai/src/providers/pi-native-client.ts` and `packages/ai/src/auth-gateway/http.ts` | Sends `x-omp-install-id`, `x-omp-hostname`, and `x-omp-app` to the gateway for originating-client usage attribution. The gateway falls back to its own install ID when absent and does not forward these headers upstream. |
| `packages/ai/src/usage/opencode-go.ts` and `packages/catalog/src/provider-models/openai-compat.ts` | Sends it as `x-opencode-session` for OpenCode Go usage polling and OpenCode model discovery, respectively. |
| `packages/coding-agent/src/tools/report-tool-issue.ts`                                               | Includes it as `installId` in auto-QA grievance pushes so the backend can correlate reports from the same installation.                                                                |

New consumers MUST treat the value as opaque. The helper contributes no PII, but a transport can still send it alongside other metadata; each consumer remains responsible for documenting and minimizing its complete payload.

## See also

- [environment-variables.md](environment-variables.md) — `PI_CONFIG_DIR` controls where `install-id` lives.
- [config-usage.md](config-usage.md) — broader config-root layout.
