# Daemon completion delivery across automatic restart

## Problem

In OMP `18.1.13`, a supervised daemon configured with `restart: "always"` can exit cleanly after producing a watcher result. `ManagedDaemonBroker.#settle` enters its automatic-restart branch, persists `restarting`, schedules the next generation, and returns before constructing the `daemon-completed` notification. The owner subscription therefore has no completion event to route to the owning Parent session.

The observed Goal #155 failure is exactly this seam: the authority watcher consumed comment `5612974361` once and re-armed generation `13 -> 14`, but the native completion notice and Parent continuation did not occur. Authority parsing, cursor/deduplication, watcher liveness, and re-arm are already proven and remain outside this change.

## Scope

Change only `packages/coding-agent/src/launch/broker.ts` and its focused launch/broker regression coverage.

The broker must emit one completion notification for each naturally settled child generation that is being automatically restarted under the existing `always` or failed-only `on-failure` policy. Explicit stop remains non-completing.

No changes to the AG_ENV authority protocol, watcher polling, Parent wake protocol, provider routing, subscription format, or restart policy at the product call site. The product continues using automatic restart; `restart: "no"` is not a workaround.

## Behavior and data flow

When `#settle` accepts the current generation:

1. Preserve the existing exited-generation snapshot (`pid`, exit code/reason, timestamps, and restart count inputs).
2. Determine whether the existing owner, completion subscription, and non-stop conditions permit a completion notification.
3. Create and persist the `daemon-completed` notification before returning through the automatic-restart path. The notification references the exited generation, not the replacement.
4. Notify the currently registered owner socket using the existing pending-completion and ACK/replay machinery. If no owner socket is available, retain the pending notification for the existing reconnect/recovery path.
5. Keep the current automatic-restart state transition, backoff calculation, restart counter, persistence, and relaunch timer unchanged.
6. Relaunch the replacement generation with the existing daemon record, owner, and subscription identity.

The existing terminal settlement path continues to construct, persist, and notify completion exactly as before. A generation must not produce two completion IDs if concurrent refresh/exit handling re-enters `#settle`; the current generation guard and settled-state guard remain authoritative.

## Error and lifecycle boundaries

- `stopRequested` suppresses completion exactly as it does today.
- No completion subscription or owner means no notification is created.
- Socket absence does not discard a completion; pending persistence and later ACK/replay remain authoritative.
- Notification delivery does not delay or cancel the replacement launch beyond existing broker behavior.
- A failed notification write must not mutate AG_ENV state or fabricate Parent continuation; the broker retains the pending completion for reconnect/replay according to existing client protocol.
- Only the child-generation completion emission boundary changes. Later Parent/session/coordinator attachment and system-notice handling remain observable by existing consumers.

## Deterministic regressions

Add focused broker/launch coverage that exercises real broker lifecycle behavior without an hourly soak:

1. A short-lived supervised daemon with `restart: "always"` and an active completion subscription emits exactly one `daemon-completed` event for the exited generation while a replacement generation is launched.
2. The event identifies the exited generation, while the same daemon owner and completion subscription remain attached to the replacement.
3. ACKing the event prevents duplicate delivery; reconnect/replay preserves an unacknowledged event exactly once.
4. The failed-only `on-failure` restart branch emits completion for a failed child, while a successful child under `on-failure` follows existing terminal behavior.
5. Explicit stop under an automatic-restart configuration does not emit a completion notification.
6. Existing terminal completion and generation/restart regressions remain passing.

Tests use bounded process lifetimes and deterministic broker/client fakes or local child commands. They must not contact providers, depend on a real long-idle interval, or alter AG_ENV acceptance evidence.

## Review and release gate

Implement on managed branch `fix/daemon-completion-before-restart` in an isolated oh-my-pi worktree. Run only focused deterministic tests first, inspect the exact diff, and commit with individually staged files. Obtain an independent Local exact-head PASS for the resulting commit, publish the upstream PR and the applicable `AG_ENV_LOCAL_REVIEW_READY_V1` review packet, then stop for Web review/upstream PR publication authority. Do not rerun Goal #155's `>=1h -> event -> wake/re-arm -> >=1h -> second-event` acceptance soak until the broker fix has passed the normal review/merge gate and is installed locally.

Goal #155 item #7 remains `PARTIAL` until that post-merge installed-binary soak passes.
