# ACP Development Guide

Rules for developing omp's Agent Client Protocol (ACP) integration
(`packages/coding-agent/src/modes/acp/`). Read this before touching ACP code.

## The failure class this subsystem produces

A tool result is rendered twice, from two different sources:

- the **authoritative body** — `content[].text`, composed by the producer with
  string concatenation, complete by construction because it is what the model
  reads and what a plain-content client renders verbatim;
- the **terminal channel** — `_meta.terminal_output` bytes plus the structural
  fields the mapper reads (`details.notices`, `details.notice`, `details.meta`,
  `details.isError`, `details.cells[].exitCode`).

Zed renders a terminal-bearing tool call *exclusively* through the terminal
(`has_terminals`, `thread_view.rs`), so for those calls the second list is the
only channel that exists. Every bug in this subsystem is one cell of
`producers × facts`: the producer recorded a fact
in the body and not structurally, or structurally in a field the mapper did not
read. Fixing them one producer at a time does not converge — the matrix keeps
growing.

Two mechanisms close the class instead of instances. Both are essential;
neither is optional to keep in mind when adding a producer. Cited elsewhere as
"mechanism 1"/"mechanism 2" (distinct from this doc's own numbered rules below
and from `checkAcpUpdateInvariants`'s own numbered invariants, cited as
"invariant 1"/"invariant 2"/"invariant 3" — three independent numbered lists,
never share a number across them):

1. **A fact baked into text travels with the text.** `OutputSink.dump(notice)`
   composes its annotation into the returned body and never calls `onChunk`, so
   the annotation reaches no live renderer. `OutputSummary.annotation` carries
   the bracketed line verbatim, `BashResult`/`KernelExecutionResult`/
   `ExecutorBackendResult` inherit it, and the tools mirror it into their own
   `details.notices`. Re-deriving that string at a mirror site instead of
   carrying it is what produced two of these bugs.
2. **The mapper reconciles against the body.** `undeliveredBodyLines`
   (`acp-event-mapper.ts`) delivers any line of the producer's authoritative
   final body that never reached the terminal, needing no structural
   declaration to work. Bounded (`MAX_RECONCILED_BODY_LINES`/`_BYTES`): a few
   lines is a synthesized annotation, hundreds is a body that diverged
   wholesale, and re-sending *that* duplicates output on an append-only stream.

## Enforced invariants

Each of these fails a test rather than a review. Do not restate them as prose
advice; extend the mechanism.

| Mechanism | Rejects | Runs at |
| --- | --- | --- |
| `checkAcpUpdateInvariants` (`acp-update-invariants.ts`) | a sibling `content` item beside a `terminal` item when the client negotiated `_meta.terminal_output`; any `_meta.terminal_*` key the client never negotiated; `status: "completed"` paired with a nonzero `_meta.terminal_exit.exit_code` | `AcpAgent#sendUpdate`, plus `mapUpdates()` in `acp-event-mapper.test.ts` |
| `EvalSourceDeliveryAuditor` (`acp-update-invariants.ts`) | a whole frame *sequence* for an **external/legacy tool literally named `eval`** on the untyped generic mapper that never echoes the cell source on any rendered channel — the built-in `eval` tool is routed away from this mapper entirely | `acp-event-mapper.test.ts` |
| `PresentationDeliveryLedger` (`test/helpers/acp-delivery-ledger.ts`) | for the typed `reduceAcpToolView` path: a declared fact whose reducer receipt disagrees with the audience/capability-derived policy; a call's `sourceEcho` that reaches settlement without appearing on any rendered channel (the generalized form of `EvalSourceDeliveryAuditor`) | `driveAcpToolView` — `acp-view-reducer.test.ts`, `bash-presentation-protocol.test.ts`, `eval-e2e-wire.test.ts` |
| `MetaTerminalOutput` brand (`acp-event-mapper.ts`) | a hand-rolled `{terminal_id, data}` literal — `buildMetaTerminalOutput` is the sole constructor, and it is what knows to prepend an eval's source | `tsgo` |
| `buildTerminalMeta` (`acp-event-mapper.ts`) | an ungated `_meta.terminal_*` write — it returns `undefined` unless `terminalMetaCapable` | compile time + the invariant above |
| `toolResultFailed` (`tools/tool-result.ts`) | a second, drifting `result.isError ?? details.isError` derivation; the ACP mapper and the TUI renderers share this one | code review, one call site |
| `asEditDetails`/`AcpEditFields` (`acp-event-mapper.ts`) | a malformed or degenerate `details` shape (wrong-typed snapshot, `null` diagnostics messages) reaching a `diff` frame, or throwing and dropping the whole update; the field lists are `Pick`/`satisfies`-derived from `EditToolPerFileResult`/`EditToolDetails`/`TruncationMeta`/`LimitsMeta`, so a producer rename or retype fails `tsgo` instead of silently degrading every real edit result to plain content | `tsgo`, plus the mutation property test (`acp-producer-wire.test.ts`) that walks every leaf of a real `EditTool` result and mutates it six ways |
| `COVERAGE` (`acp-producer-wire.test.ts`) | an unoccupied producer × outcome cell with no stated reason, a row no cell names, a skipped capability mode with no reason | the matrix's own coverage tests |
| the producer matrix (`acp-producer-wire.test.ts`) | per row × all four capability modes: a wrong status/exit code, a declared producer fact missing from the frame, a repeated run of already-delivered terminal bytes, a fabricated discontinuity claim, a line of the producer's own final body delivered nowhere | `bun test test/acp-producer-wire.test.ts` |
| `acp-probe` | the same append-only property on the real wire (`duplicateTerminalDeliveries`, exit 1 on a repeat); `scripts/acp-stress-matrix.sh` requires its exit code, not just a byte floor | every probe run |

## Rules a mechanism cannot enforce

Cited elsewhere as "doc rule N" (1-8 below) — distinct from "mechanism N" above
and "invariant N" in `acp-update-invariants.ts`'s own header comment.

1. **Never guess the wire shape. Trace it.** Capture real JSON-RPC frames with
   [`acp-probe`](https://github.com/marton78/acp-probe) before forming a
   theory. In-process tests construct `AcpAgent` against a fake client and
   cannot catch framing, stdout pollution, or capability gating that only
   misbehaves after a real `initialize`.
2. **`claude-agent-acp` is the gold standard.** Where the ACP schema is silent
   on a rendering detail, match `claude-agent-acp/src/tools.ts` and
   `src/acp-agent.ts` rather than inventing a nicer shape.
3. **ACP surface changes MUST be probe-tested**, not only unit-tested — see
   "Running the probe" below. Unit tests and probe runs do not substitute for
   each other.
4. **Extend `acp-probe` upstream** (https://github.com/marton78/acp-probe) when
   it lacks something you need; it is not vendored here.
5. **A guard only enforces what the tests calling it exercise.** The invariant
   check lives at `AcpAgent#sendUpdate`, one layer above the mapper — the
   mapper suite reaches it only through its `mapUpdates()` wrapper. Prove a new
   guard by feeding it a known-violating frame from inside the suite that is
   supposed to catch it, not by reading its comment.
6. **A fixture that degenerates the feature under test converts an omission
   into a passing assertion.** An eval fixture with `cells: []` has no source
   to lose; an eval fixture with `exit_code: 0` cannot report a failure; a
   hand-fabricated `details.notices` cannot say whether a real producer sets
   it. Pick data specific enough that the behaviour can fail, and prefer a real
   producer (the matrix) over a fabricated result.
7. **A non-deterministic fixture passes by luck.** Fixed-width, *unique* lines:
   variable widths made a rollover reproduce in two runs out of three, and
   self-similar filler makes the append-only probe fire on legitimate
   deliveries.
8. **`git diff --stat` before trusting an edit.** Formatters in this repo have
   reflowed whole `*.test.ts` files despite `biome.json`. A 2-line change
   showing as a 400-line diff means the formatter clobbered the file — revert
   and reapply the substance by exact string replacement.

## Running the probe against omp

[`acp-probe`](https://github.com/marton78/acp-probe) is standalone, not
vendored. Install once (`git clone` + `bun link`, or run `bun run
src/acp-probe.ts` in place) and point it at omp explicitly:

```bash
acp-probe prompt "Run \`echo hi\` using the bash tool" \
  --cmd packages/coding-agent/scripts/omp --terminal --log /tmp/frames.log
grep -n "tool_call" /tmp/frames.log
```

- `--cmd` must be a single executable — `acp-probe` spawns it directly with no
  shell parsing. `scripts/omp` is the tracked dev launcher; the default
  (non-`--no-subcommand`) mode already appends `acp`, so don't also pass
  `--arg acp`.
- `--isolate` hides real credentials, so a `prompt` there fails with
  `No model selected`. Use it for handshake probing only.
- `stress-output <bytes>` and `kill-mid-tool <text...>` exercise the
  truncation/watermark and dangling-replay classes directly against the real
  wire. The dangling-replay (`kill-mid-tool`) class also has deterministic
  in-process coverage that does not need a real process kill or a live
  provider: `test/acp-deterministic-phase-gate.test.ts` captures a real,
  still-running tool call's durable on-disk journal signature and drives it
  through the production `session/load` replay chain
  (`correlateReplayableToolExecution` -> `hydrateReplayableToolExecution` ->
  `reduceAcpToolView(phase:'replay')`); `test/interactive-mode-journaled-
  dangling-rebuild.test.ts` drives the same capture through the TUI render
  path. `packages/coding-agent/test/acp-live-e2e.test.ts` (run directly with
  `bun test`, or via `scripts/acp-stress-matrix.sh`, a thin fail-fast
  dispatcher with no assertion logic of its own) runs a capability-combo
  grid again: 2 migrated-route byte-equality checks (meta-terminal channel),
  2 fenced/plain-channel byte-equality checks (same assertion, no client
  terminal capability advertised -- the one gap neither those nor the
  deterministic in-process gate covers, since bash/eval's presentation
  route dropped the old `ACP_TEXT_LIMIT` bound), and 4 `kill-mid-tool`
  capability combos (`none`/`terminal`/`meta`/`both`) with a real `SIGKILL`
  -- the crash-recovery race the in-process replay above cannot reproduce.
  This is a genuine end-to-end test, not a shallow smoke check: every row
  asserts byte-exact delivery or a real crash-recovery outcome through the
  actual built CLI, real stdio, real `AgentSideConnection`. It drives all 8
  rows through the deterministic, zero-cost `stress-mock` model
  (`packages/coding-agent/scripts/acp-stress-mock-model.ts`) by default, not
  a live provider, since a live model can silently rewrite the exact
  requested command (observed empirically: a fast/cheap model appended
  `> /dev/null` to a `stress-output` command "to just report the exit
  code" -- a HARNESS_INVALID-shaped failure a naive floor check cannot tell
  apart from a real regression). Set `ACP_STRESS_LIVE_PROVIDER=1` for
  genuine live-provider conformance checking instead -- under that mode it
  still exits non-zero only on a genuine `REGRESSION` classification
  (`acp-live-smoke-classifier.ts`), never on a live provider simply not
  calling the requested tool (`HARNESS_INVALID`). The deterministic
  in-process gate (`bash`/`bash_async`/`bash_auto`/`eval`, exact equality,
  `test/acp-deterministic-phase-gate.test.ts`) is unaffected either way and
  runs as part of any normal `bun test`, no external checkout needed.

Frame logs are the source of truth. Read the literal `content` array, `title`,
`kind` and `_meta` sent for the call you're working on before changing mapper
code.

## Adding a new ACP feature

- Check whether `claude-agent-acp` already implements it — if so, its shape is
  the contract, not the schema's minimum.
- Check `agent-client-protocol/schema` and the SDKs (`acp-ts-sdk`,
  `acp-rust-sdk`) for current wire types before hand-writing JSON.
- Gate new capabilities behind the client's advertised `clientCapabilities`.
- Add the probe subcommand upstream if exercising the feature needs one.
- Land unit coverage in `test/acp-*.test.ts` *and* a matrix row if a real
  producer is involved.

## Do

- Match `claude-agent-acp`'s content-array composition per tool kind. A live
  terminal's content is `[{type: "terminal", terminalId}]` **exclusively**.
- Treat a terminal-bearing call's `content` array as a dead letterbox for
  anything but the terminal item: Zed's `has_terminals` drops every sibling,
  text included, from the live card (they resurface only in
  `ToolCall::to_markdown` export). Deliver extra facts by appending
  `_meta.terminal_output` bytes keyed by that *same* terminal id —
  `on_terminal_provider_event` (`agent_servers/acp.rs`) writes them into
  whatever buffer owns the id, real or display-only (see
  `buildLiveTerminalNoticeMeta`).
- For any execute-kind call with no live client terminal (`eval` always;
  `bash`/`shell`/`exec` when `terminal/create` is unavailable, `pty: true`, or
  `session/load` replay), use the display-only terminal `_meta` convention:
  `_meta.terminal_info = {terminal_id, cwd}` on the `pending` start with
  `content: [{type: "terminal", terminalId}]` keyed by the *tool call's own id*
  (never a connection-specific terminal id, which is meaningless after
  `session/load`), then `_meta.terminal_output` and `_meta.terminal_exit` on
  the final update. This is Zed's own v1 extension
  (`TerminalBuilder::new_display_only`) and exactly what `claude-agent-acp`
  does for its Bash tool. Gate it on
  `clientCapabilities._meta.terminal_output`.
- Wrap command/tool output in a fenced code block whenever a client might lack
  terminal support and would otherwise render raw output as Markdown.
- Verify both the terminal-capable (`--terminal`) and fallback paths for any
  execute-kind change.

## Don't

- Don't rely on mapper unit tests alone as proof a wire-level change works.
- Don't add a second content item duplicating what the client already renders
  (a terminal block plus a text echo; two near-identical text blocks from
  `extractStructuredToolCallContent` and the `extractReadableText` fallback
  both firing).
- Don't run `scripts/build-binary.ts` to "refresh" `~/.bun/bin/omp`.
  `scripts/omp` is a tracked dev launcher that always execs live source;
  building overwrites it with a 126 MB binary and a huge spurious diff.
- Don't commit build artifacts (`dist/`, `.bun-build`, `scripts/omp` swaps).
