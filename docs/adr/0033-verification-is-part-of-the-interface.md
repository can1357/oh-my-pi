# 0033. A debug protocol defines what the UI is

Status: accepted
Date: 2026-09-02
Area: interface

## Context

When an agent is asked to change an interactive TUI or GUI and "how to verify" is unspecified,
it side-channels a look-alike: it writes a test file that constructs something adjacent to the UI
and asserts something that does not check the change. The smoke test "passes as usable" and the
definition of success has been quietly redefined downward. The post names this the highest-ROI,
lowest-cost investment available: define what verification means and give it a convenient shape
before the work starts, so it becomes part of the development loop instead of an afterthought.

The shape the post shows is two tool calls against a running instance: one injects eight synthetic
key events into a session named `chat`; the other dumps the headless layout tree with component
names, positions, and focusable flags. The interface work in 0030–0032 and 0034 was verified
through that protocol.

## Decision

1. Every interactive surface MUST ship a debug protocol that is:
   - non-destructive: it observes and injects without altering session state beyond what the
     injected input would do;
   - off-screen: it drives an instance on a PTY the agent owns, never the user's terminal;
   - multi-instance: sessions are named and concurrent.
2. The protocol MUST offer at minimum: key, mouse, and paste injection; resize; a layout-tree dump
   (component kinds, ids, rectangles, visibility, focus); text screenshots of the last paint; and
   pixel screenshots where rendering is not purely textual.
3. Injected input MUST enter the same event path as real terminal input, so focus routing, quit
   chords, and overlay dismissal behave as in production.
4. The protocol is the machine-readable definition of what the UI is. Acceptance for a UI change
   is stated in its terms (this tree, this screen, after these keys), not in terms of a unit test
   that approximates them.
5. A TUI change MUST be exercised through the protocol on a real PTY before it is claimed done:
   every input path it touches, resize, and clean quit/restore.
6. The concrete shape (custom tool, Python package, socket API) is replaceable; the guarantees
   above are not.

## Consequences

- The agent's verification step has a prescribed, low-friction form, so it is performed rather
  than simulated. "Passing" means the tree and screen say so.
- Tests that need neither raw mode nor a writer still exist for retained-state behavior; they are
  not accepted as proof for terminal interaction.
- The same protocol serves the remote inspector and headless snapshot surfaces (0031): a tree dump
  is a rendering surface too.
- Prohibited: claiming a TUI change done from a compile or from a test that does not drive the
  running program; UI-affecting changes verified only by reading rendered strings.
- Cost accepted: a server thread in the terminal layer, a wire format that must track the event
  types, and an agent tool that owns PTYs and a terminal emulator.

## Status in omp

**Implemented.** Primary terminal implementation: `crates/tui/src/debug.rs`. The real-PTY
protocol and terminal chat smoke are implemented. `crates/app/src/gui.rs` serves the same named
debug wire against the production `NativeHost` off-screen, including key/chord, mouse, paste,
resize, text, tree, values, slots, frame PNG, and clean quit. Its native lifecycle extensions
inject IME preedit/commit, file/media drops, focus, and light/dark appearance through the same
`omp_gui::Scene` methods as winit. Focused adapter proofs exercise those live scene/paint paths,
and `crates/chat/tests/host.rs` proves terminal and native actors produce the exact same typed
block projection for one detached session snapshot.

## References

- The Harness Playbook, "The interface": "Verification is part of the interface"
- `crates/tui/src/debug.rs`, `crates/tui/README.md` "Debug a running app (`OMP_TTY` +
  `OMP_TUI_DEBUG`)", `.omp/tools/tui.ts`
- `AGENTS.md` "TUI Debugging (`tui` tool, `OMP_TUI_DEBUG`, `OMP_TTY`)"
- 0029 (the agent-facing bug-report path, the other half of agent-driven QA), 0031, 0034 (the
  transcript protocol this verifies at the terminal level)
