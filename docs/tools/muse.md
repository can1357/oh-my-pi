# muse

> Delegate one self-contained task to the installed Muse Code client through `muse exec --json`.

## Source

- Entry: `packages/coding-agent/src/muse/index.ts` (`MuseTool`)
- Runner: `packages/coding-agent/src/muse/exec.ts`
- JSONL parser: `packages/coding-agent/src/muse/protocol.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/muse.md`
- Registration: `packages/coding-agent/src/tools/index.ts`
- Offline smoke script: `packages/coding-agent/scripts/muse-echo-smoke.ts`

## Registration / Visibility

- Requires `muse.enabled = true` and the Muse Code client resolvable (default `muse` on `PATH`; override with the `muse.path` setting). The setting defaults to `false`; enable **Muse Code** under `/settings` → Tools → Available Tools. Live sessions reconcile the tool immediately.
- Metadata: `strict = true`, `loadMode = "discoverable"`, approval tier `exec`, `concurrency = "exclusive"`.
- The tool is rooted at the session's working directory. It takes no workspace override, so a delegated run cannot escape the session's workspace boundary.

## Inputs

| Field             | Type      | Required | Description                                                     |
| ----------------- | --------- | -------- | --------------------------------------------------------------- |
| `prompt`          | `string`  | Yes      | Whole task, 1–200,000 characters. Written to a 0600 prompt file. |
| `max_model_steps` | `integer` | No       | Caps the client's model loop, 1–100.                            |
| `timeout_seconds` | `integer` | No       | Bounds the whole run, 1–3600. Default 900.                      |

## Invocation

The runner spawns exactly `muse exec --json --prompt-file <tmp>/prompt.md --workspace <session-cwd> --no-session-log --user-input-auto-resolve --max-tool-output-bytes 65536 [--max-model-steps N]`. It sets `MUSE_NO_AUTO_UPDATE=1`, points `TMPDIR`/`TMP`/`TEMP` at a temporary directory outside the workspace, and passes stdin as `ignore`. The client keeps its documented approval and sandbox defaults; the runner never adds `--yolo`, `--disable-approval`, `--disable-sandbox`, `--trust-workspace`, network widening, a provider override, or credential input. The client binary comes from `muse.path` (default `muse`), and `timeout_seconds` clamps through the tool timeout registry (`muse`: default 900 s, range 1–3600, under `tools.maxTimeout`).

`--provider echo` exists only behind the runner's explicit `provider: "echo"` seam. The tool never sets it; only the offline smoke script does.

## Outputs

- The terminal answer from the observed `run.terminal.completed` record (`payload.text`). The raw `run.terminal.*` payload is not forwarded.
- Usage from `run.usage` when present: calls, completed/failed/cancelled calls, and per-model token counters.
- Task-activity counts from `task.*` records. `task.lifecycle.failed` and `task.lifecycle.cancelled` are activity; a successful echo run contains two failed reminder tasks and still completes.
- Details add record/skip counts, elapsed milliseconds, and whether the answer hit the host cap.

## Flow and Side Effects

1. Create a `0600` prompt file in a per-run temp directory outside the session workspace.
2. Spawn the client with stdout and stderr piped separately and parse stdout incrementally.
3. Sanitize and bound every string that leaves the parser: the answer (256 KiB), streamed delta previews (8 KiB each), delta diagnostics (64 KiB total), stderr (8 KiB), usage models (16), warnings (32), and seen record IDs (4,096).
4. Deduplicate records by the envelope `id`; skip unknown payload types and unstable payload shapes with a warning, and fail the run when a stdout line is not a usable record envelope (not JSON, failed envelope validation, or over the 8 MiB line cap).
5. Decide status only from `run.terminal.*`: `"completed"` is success, any other terminal value is surfaced as an unverified failure shape, and EOF without a terminal record is `incomplete` even at exit 0.
6. Remove the temp directory on every path.

## Limits and Errors

- Cancellation sends SIGTERM, then SIGKILL after five seconds, and raises `ToolAbortError`. `timeout_seconds` clamps to the `muse` registry entry (default 900 s, max 3600 s) under the configured `tools.maxTimeout`.
- Exit 2 is reported as a usage error with sanitized stderr; exit 1 as a runtime startup failure; other nonzero exits include their status. A client that cannot start raises a `ToolError` naming `muse`.
- The client may ask for approval that a headless run cannot supply; this tool does not change that posture.

## Offline smoke

From the repository root:

```sh
bun packages/coding-agent/scripts/muse-echo-smoke.ts "say hello and finish"
```

This runs the real client with `--provider echo` (no network, no credentials, no paid provider) and prints the sanitized outcome the tool would return.
