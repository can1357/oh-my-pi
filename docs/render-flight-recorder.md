# Render gap diagnostics

The TUI keeps a bounded 2,048-event flight recorder. Pending work starts at an
input-driven or background render request; idle time does not count. A completed
plan frame settling work older than two seconds writes one `ui.frame-gap-cause`
warning through the normal logger. The recorder is independent of the optional
FPS status display.

Schema version 1:

- `startMs`, `endMs`, `durationMs`: monotonic milliseconds on the render clock.
- `timeline`: chronological `{atMs, kind, tag, value}` events. Requests, timer and
  immediate scheduling/firing/cancellation, provider steps, deferrals, UTF-8 frame
  writes and completed owned callbacks are retained. `droppedEvents` counts events
  overwritten by the ring; the record never implies a complete timeline when it
  is nonzero.
- `providerInFlightSinceMs`, `providerStep`, `providerAwait`: provider state at
  settlement. This provider interface is synchronous: there are no awaits in the
  provider path. `providerAwait` is consequently null. The timeline distinguishes
  time before provider entry from time composing/writing a provider frame.
- `frameBytes`, `pendingOutputBytes`, `terminalDrain`: frame bytes and pending
  terminal bytes at settlement. An unavailable terminal counter is null/unknown.
- `macrotasks`: count/total milliseconds of completed TUI scheduler and stdin
  callbacks during pending work, and the ten largest tagged sources in the
  retained timeline. This is scoped instrumentation, not a process-wide hook of
  third-party or provider callbacks.
- `eventLoopUtilization`: raw runtime counters. Bun 1.4.4 returns zero counters
  even across sleeps; those zeros do not establish that the loop was idle.

A request uses its explicit `caller`, current loop phase, or component type.
Unlabeled requests additionally capture caller stacks after the pending gap
exceeds two seconds. Ring writes reuse allocated slots; serialization and caller
stacks are restricted to long gaps. Scheduler callback wrappers still have the
normal per-scheduling closure cost.

In interactive mode, SIGUSR2 starts a 30-second CPU profile without a restart.
Further signals during a capture are ignored. The result is written through the
central logs directory helper as `omp.<pid>.<timestamp>.cpuprofile`; failures are
logged as `ui.cpu-profile-failed`. The existing debug profiler uses
`node:inspector/promises` (`Profiler.enable`, `Profiler.start`, `Profiler.stop`).
Bun documents support in [Bun 1.4](https://bun.sh/blog/bun-v1.4) and the
[Session API](https://bun.sh/reference/node/inspector/Session).
