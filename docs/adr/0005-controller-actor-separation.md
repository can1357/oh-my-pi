# 0005. Controller owns state; views are projections

Status: accepted
Date: 2026-09-02
Area: state

## Context

pi's views read live session state directly. The footer calls `sessionManager.getEntries()`; the
example extensions do the same (`plan-mode`, `snake`, `bookmark` in Appendix A all start from
`ctx.sessionManager.getEntries()`). Once a view holds a reference to the controller's live
state, two things follow:

- The view becomes a place where state is interpreted, and every interpretation is a chance to
  disagree with the journal ("last message" as last-in-file rather than last-on-branch, 0004).
- Adding a second view means plumbing controller state through UI internals. "Inspect subagent"
  in pi is not a view of a child; it requires threading the child's session manager into the
  parent's footer, tree, and renderer code paths.

The envelope (0001) demands at least four views of one session: the local TUI, a remote driver, a
spectator with untrusted presentation input, and a subagent inspector inside a multiplexed
workspace. Each one built by reaching into controller state is another authority and another
place a spectator's input can touch policy.

## Decision

Controller and actor are completely separate.

1. The **controller** owns session state: the tree (0003), its journal, the run loop, and every
   mutation. It is the only component that applies patches.
2. **Actors** render. An actor receives a snapshot of the materialized tree plus the patch stream
   that follows it, keeps its own retained presentation state, and never holds a handle to
   controller internals. An actor MUST NOT read the journal, call into the session manager, or
   hold a mutable reference to the tree.
3. Actor input travels back as commands on the command stream (0014) or as queued items in
   `<queues>`; it never mutates state in place.
4. The TUI, the web client, the remote client, and the subagent inspector are **peers**: the same
   actor contract, fed by different controllers. Inspecting a child means pointing the same actor
   at the child's snapshot and patch stream. There is no "inspector" code path distinct from
   "render a session".
5. A controller MAY publish to many actors concurrently; each actor's view is a pure function of
   `snapshot + patches`, so two actors on the same stream render the same session.

## Consequences

- New surfaces (web, GUI, remote, spectator) are new actors, not new plumbing through the
  controller. Subagent inspection, session replay, and the spectator mode reuse the interactive
  renderer unchanged.
- Trust follows the split: an actor on an untrusted client (spectator) can only render and emit
  commands the controller may refuse; it cannot become an authority (0006).
- Prohibited: views that compute state from journal entries; footer, status line, or overlay code
  that reads controller structures; per-view derivation of "current branch".
- Cost accepted: everything an actor needs must be in the tree or the patch stream. State the
  controller "knows" but has not journaled is invisible to views by construction, which forces it
  into the tree (0003).

## Status in omp

**Implemented.** Primary implementation: `crates/chat/src/host.rs`. The terminal and native chat
actors consume `Session::subscribe()` and return commands without holding controller authority;
`crates/gui` owns only winit/GPU lifecycle and input delivery. `crates/app/src/gui.rs` proves its
native `NativeHost` is built from the detached snapshot/event contract, while
`crates/chat/tests/host.rs` proves terminal and native boot projections are identical and each
actor emits exactly one controller teardown on drop. `crates/app/src/chat_control.rs` transports
pause/resume commands while the controller and kernel derive the gate exclusively from the session
DOM. The stdio actor in `crates/app/src/rpc_mode.rs` projects the same snapshot/patch stream into
pi-compatible message, tool, turn, and subagent events; private DOM snapshots and patches never
cross the public RPC boundary. Collaboration uses the same contract:
`crates/driver/src/collab/observer.rs` publishes a detached child snapshot plus
a bounded event stream, `crates/app/src/chat_services/agents.rs` hands that
projection to the unchanged transcript viewer, and host select/editor requests
race local and remote actors by correlated ids without granting either actor a
mutable session handle.

## References

- The Harness Playbook, "The state" — "Controller and actor"; Appendix A items 2, 5, 6
  (`sessionManager.getEntries()` in views and extensions)
- 0001 (four modes as peers), 0003 (the tree), 0004 (projections), 0006 (trust boundary),
  0014 (command stream), 0031 (typed component model), 0033 (debug protocol defines the UI)
- `docs/architecture/agent-loop.md` — "Events, storage, and presentation";
  `docs/architecture/crates.md` — "Driver composes; app presents"
