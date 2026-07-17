# Browser Canvas + Pi Speak Remote Cockpit Plan

## Decision

Build the canvas as an **optional view in the existing `packages/collab-web` browser guest**, not as a new orchestration runtime and not as a NodeTerm fork.

The OMP host remains authoritative for agent/session state. The browser canvas is a real-time projection of that state over the existing encrypted collaboration protocol. Pi Speak is a voice input/output client for the selected agent in that projection. `psmux` is an optional external-terminal adapter, not the agent graph's source of truth.

This reuses the repository's existing cross-device control path and avoids duplicating Pi's session, policy, task, persistence, provider, and subagent systems.

## Goals

1. Provide a spatial, browser-based map of a remotely running OMP session:
   - main agent and subagent hierarchy;
   - live state, current task/tool, attention requests, transcript access, and session/worktree grouping;
   - durable user-controlled positions, groups, annotations, and filters.
2. Let a write-capable remote client safely chat with, interrupt, revive, or end a selected agent using the existing collab permissions.
3. Integrate Pi Speak as a low-latency voice control surface for the selected agent:
   - talk → transcribe → normal agent message;
   - stop / barge-in → existing abort path;
   - selected replies and attention requests can be spoken according to a local speech policy.
4. Keep the same client usable from desktop browsers and phone-sized browsers.

## Non-goals

- Do not fork, embed, or copy NodeTerm. Its current BUSL-1.1 license makes it a UX reference, not a dependency.
- Do not replace `AgentRegistry`, `AgentLifecycleManager`, task execution, JSONL session persistence, or the existing collab protocol with a canvas-specific runtime.
- Do not make `psmux` mandatory or use it as the canonical record of agent status.
- Do not expose arbitrary remote shell keystrokes or PTY streams in the first release.
- Do not persist microphone audio or partial STT hypotheses into the agent transcript.
- Do not automatically speak raw model token streams, every subagent response, or tool output.

## Existing foundations to preserve

| Existing surface | Role in this plan |
| --- | --- |
| `packages/coding-agent/src/registry/agent-registry.ts` | Canonical in-process agent identity, parent links, lifecycle, CWD, current activity, attention state, and persisted session references. |
| `packages/coding-agent/src/registry/agent-lifecycle.ts` | Safe revive/release lifecycle for parked and live agents. |
| `packages/wire/src/index.ts` | Shared browser-safe collab wire grammar; already includes agent snapshots and task subagent lifecycle/progress payloads. |
| `packages/coding-agent/src/collab/host.ts` | Authoritative host that mirrors registry snapshots and task events, and enforces write permissions for `chat`, `kill`, and `revive`. |
| `packages/collab-web/src/lib/client.ts` | Browser guest's ordered, immutable state replica and command client. |
| `packages/collab-web/src/components/agents/*` | Existing browser agent list/drawer and transcript entry points; canvas augments rather than replaces them. |
| `packages/coding-agent/src/collab/link-file.ts` | Existing Pi Speak gateway handoff for the active collab link. |
| `psmux-agent-orchestrator` skill | Optional host-local execution adapter for long-running interactive terminals on Windows. |

## Target architecture

```text
┌──────────────────────── OMP host ────────────────────────┐
│ AgentRegistry / lifecycle / session JSONL / task EventBus │
│        │                         │                        │
│ native Pi subagents          psmux adapter (optional)     │
│        └──────────────┬──────────┘                        │
│                  CollabHost                               │
└──────────────────────┬───────────────────────────────────┘
                       │ AES-GCM collab frames over relay
       ┌───────────────┴────────────────┐
       │                                │
┌──────▼──────────────────────┐  ┌──────▼──────────────────┐
│ collab-web browser canvas    │  │ Pi Speak gateway/client │
│ React Flow + existing guest  │  │ STT/TTS + selected node │
│ rendering and controls       │  │ control                 │
└─────────────────────────────┘  └─────────────────────────┘
```

### Control plane

- Keep using the sealed collaboration frame protocol and existing full-link versus view-link capability model.
- A view-only link can observe the canvas and transcript state but cannot send a prompt, abort, chat, revive, or kill.
- A write-capable browser uses existing `GuestClient.sendPrompt`, `sendAbort`, and `sendAgentCmd` methods. The host remains the policy-enforcing point.
- Existing `chat` targets a particular agent. Canvas voice input must use that target-specific path rather than the unscoped main-session prompt path.
- Do not add a new direct browser-to-host control socket or send plaintext metadata through the relay.

### State and event plane

- `AgentRegistry` remains authoritative. Canvas nodes are derived from `AgentSnapshot`, `SubagentLifecyclePayload`, and `SubagentProgressPayload`; no browser node can alter an agent's lifecycle by itself.
- Extend the browser-safe `AgentSnapshot` only with display-safe, bounded fields that the canvas genuinely needs:
  - `activity?: string`;
  - `needsAttention?: boolean`;
  - `attentionReason?: string`;
  - optionally `color?: string` if it is already a stable agent presentation property.
- Do **not** change `AgentRegistry.setActivity()` into an unthrottled global event source. It deliberately avoids listener churn.
- Instead, while a host has active work, `CollabHost` should poll/snapshot the registry at a bounded cadence (for example, 750–1,000 ms), compare against its last agent payload, and broadcast only when the snapshot changed. Stop the cadence when no agent is running or needs attention. Structural status changes continue to use the current debounced registry listener.
- Continue to use task progress events for tool/token/cost detail; do not put high-frequency tool payloads into the agent snapshot.

### Canvas presentation plane

Add a `CanvasView` to `packages/collab-web` and install a permissively licensed graph library such as `@xyflow/react` directly in that package.

Node types:

| Node | Data source | Initial interaction |
| --- | --- | --- |
| Main agent | `AgentSnapshot.kind === "main"` | select, transcript, prompt/voice target, abort |
| Subagent | `AgentSnapshot.kind === "sub"` | select, progress, transcript, chat/revive/kill if write-capable |
| External terminal (later) | psmux adapter snapshot | read-only status/output preview; no arbitrary shell input in v1 |
| Annotation/group | local canvas metadata | create/edit/move locally |
| Artifact/link (later) | explicit artifact metadata only | open via existing safe links |

Edges:

- Parent-to-child agent edges derive only from `parentId`.
- Do not imply shared context merely because two nodes are adjacent. Context sharing remains governed by existing agent collaboration policy and transcript APIs.
- A task/tool relationship is rendered as a badge or detail panel, not a separate permanent edge for every tool call.

Layout and storage:

- Start with deterministic automatic layout from agent parentage, CWD, and creation time.
- Store per-user positions, collapsed groups, pins, annotations, and viewport in browser local storage keyed by room/session identity plus a schema version.
- The layout is private by default. Shared layouts are a later, explicit feature with a separate permission/data model.
- Never serialize prompt text, transcript contents, collab key material, or microphone audio in layout metadata.

Responsiveness:

- Desktop: pan/zoom, minimap, details drawer, keyboard navigation.
- Mobile: selected-node focus mode, bottom sheet details, fit-to-graph action, no tiny terminal emulator.
- Preserve existing transcript and agent-list views as accessible fallback surfaces.

## Pi Speak integration

### Interaction contract

1. User selects a main-agent or subagent canvas node.
2. User holds push-to-talk or taps a clearly visible talk control.
3. Pi Speak obtains local audio and generates partial STT only for UI feedback.
4. On finalization, the client shows the final transcript and sends it through `sendAgentCmd("chat", agentId, text)` for the selected agent.
5. The OMP host handles revival/steering/persistence through the same path as typed agent chat.
6. User can barge in while speech or generation is active. The UI first stops local playback, then uses the existing targeted control/abort semantics; it must not simulate Ctrl-C into a psmux pane.

### Speech output policy

Speech is local to the Pi Speak/browser client and is off by default for non-selected agents. Default priorities:

1. Explicit user request to read the selected agent's final response.
2. `NEEDS YOU` / attention reason for the selected agent.
3. Selected main-agent completion summary.
4. Optional short status announcements (e.g. failure, completion) behind a preference.

Never auto-speak:

- thinking content;
- raw streaming deltas;
- tool arguments/output;
- every child-agent reply;
- secrets or credentials;
- text from a view-only client that cannot locally opt into playback.

### Audio boundary

- Audio capture, VAD, STT partials, and playback stay on the trusted Pi Speak client/gateway whenever possible.
- Send only a final, user-visible text command through the existing encrypted control plane.
- Add a local “speech hard stop” that immediately clears queued/active playback before sending any remote control command.
- If streaming audio transport becomes necessary later, define it as a separate authenticated/e2e-encrypted media channel. Do not overload collab JSON frames or the relay with opaque microphone chunks in the first release.

## psmux integration (later)

Create a small execution-adapter interface rather than importing psmux behavior throughout canvas code:

```ts
interface ExternalRuntimeSnapshot {
  id: string;
  label: string;
  cwd?: string;
  status: "running" | "idle" | "exited" | "unknown";
  kind: "psmux";
  preview?: string;
}
```

- A Windows host adapter can map known psmux session/window/pane targets to these snapshots.
- It should spawn, inspect, capture, and terminate only sessions explicitly created/managed by OMP; never enumerate or expose all user panes by default.
- Canvas commands call a host-side adapter with an allowlisted action set. They do not invoke `psmux send-keys` with arbitrary browser text.
- The adapter may create a linked external-terminal node, but it must not overwrite native Pi agent identity or status.

## Delivery phases

### Phase 0 — Contract and UX spike

**Scope:** `packages/collab-web` only, using existing `GuestSnapshot` data and a mock host.

- Add a canvas/list view toggle without changing wire formats.
- Render main/subagent nodes, parent edges, status, existing progress detail, selection, fit view, and mobile focus mode.
- Keep canvas read-only and retain the existing agents panel as the fallback.
- Test against `scripts/mock-host.ts` fixtures and all connection states (connecting, live, reconnecting, ended).

**Acceptance:** A browser guest can open a full or view link and see a stable, keyboard-accessible graph without breaking the current transcript UI.

### Phase 1 — Complete canvas read model

**Scope:** `packages/wire`, `packages/coding-agent`, `packages/collab-web`.

- Extend `AgentSnapshot` with the bounded display fields above.
- Add host-side changed-snapshot broadcasting at a bounded active-work cadence.
- Update TUI collab guest and browser client replica handling for the additive fields.
- Add deterministic layout, private local layout persistence, CWD grouping, attention badges, and transcript drill-in.

**Acceptance:** Status, current activity, and attention changes appear on another device within the chosen refresh budget and survive reconnect/resync without duplicate nodes or stale child edges.

### Phase 2 — Safe canvas controls

**Scope:** `packages/collab-web` plus focused host/wire tests only if a genuinely new command is needed.

- Wire existing selected-agent chat, kill, revive, and main-session abort controls into canvas details.
- Make write capability explicit in every control state; hide/disable commands for view links.
- Add a confirmation gate for kill and any future release/destructive operation.
- Preserve host-side authorization as the final authority.

**Acceptance:** A write link can control the selected live/parked agent; a view link cannot cause a host-side action even with manually crafted frames.

### Phase 3 — Pi Speak selected-agent voice control

**Scope:** Pi Speak extension/gateway plus `collab-web` integration points; do not modify the core agent execution contract unless necessary.

- Read the active collab link using the existing `collab.json` contract.
- Add selected-agent identity handoff and final-STT submission through targeted agent chat.
- Implement push-to-talk, final-transcript preview, local playback queue, hard stop, and barge-in.
- Add per-client speech policy/preferences and attention/completion announcements.

**Acceptance:** Speech to a selected subagent produces the same persisted remote-chat behavior as typed input; view links cannot invoke voice control; a stop action halts playback promptly and interrupts only the intended agent.

### Phase 4 — psmux external-runtime adapter

**Scope:** a new host-local adapter module and browser node type.

- Implement explicit OMP-managed psmux session registration and constrained snapshots.
- Display external-terminal nodes with status and a sanitized, bounded output preview.
- Add only allowlisted lifecycle actions after the policy review.

**Acceptance:** Managed psmux work is observable from the canvas without exposing unrelated local terminal sessions or granting arbitrary shell access.

### Phase 5 — optional collaboration enhancements

- Explicit shared layout/annotation model with ownership and write rules.
- Named handoff/artifact edges that point to existing safe transcript/artifact references.
- Cross-host and multi-project dashboard only after per-session isolation and authorization are proven.

## Required tests and verification

### Wire and host

- `AgentSnapshot` additions remain browser-safe, additive, and serialize/deserialize correctly.
- Host snapshots never include `advisor` agents, session content, auth tokens, or arbitrary command output.
- Active-work snapshot cadence is bounded, deduplicated, stops when idle, and cannot keep a host alive.
- A forged view-link guest cannot issue `prompt`, `abort`, `chat`, `kill`, or `revive` successfully.
- Parent changes, parked/revived transitions, and reconnect welcome snapshots converge to the same graph state.

### Browser client and canvas

- `GuestClient` applies welcome, agent, progress, lifecycle, reconnect, and end frames to one consistent graph store.
- Node identity is stable across updates; deleted agents remove their edges; a missing parent degrades gracefully.
- Layout migration and room/session-keyed local persistence cannot read/write key material or transcripts.
- Canvas remains usable at phone width and with keyboard-only interaction.
- All displayed remote text follows the existing browser sanitization/rendering rules.

### Pi Speak

- Final STT goes to the selected agent through the same targeting path as typed chat.
- Partial STT never enters the session JSONL.
- Read-only sessions cannot initiate voice actions.
- Playback policy excludes unsafe/verbose streams and honors the local hard stop.
- Barge-in sends one bounded interrupt for the intended target and does not affect sibling subagents.

### Verification commands

Use focused checks in changed packages, then the appropriate workspace suite:

```sh
bun --cwd=packages/wire test
bun --cwd=packages/coding-agent test -- collab
bun --cwd=packages/collab-web test
bun --cwd=packages/collab-web run check
bun check
```

Run only the commands supported by the final package scripts; do not use `tsc` directly.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A canvas becomes a second, divergent orchestration state machine | Derive all agent nodes from collab snapshots/events; canvas metadata is presentation-only. |
| High-frequency activity updates overload relay/browser | Host-owned bounded polling plus payload deduplication; detailed tools remain event-driven. |
| Remote UI broadens a destructive control surface | Existing full-link/view-link capability model, host-side enforcement, explicit confirmations, no arbitrary PTY access. |
| Voice is distracting or leaks sensitive output | Local opt-in speech policy, selected-agent scope, no tool/raw-stream playback, immediate hard stop. |
| Browser canvas is unusable on mobile | Focused selected-node mode and bottom-sheet controls; preserve list/transcript views. |
| psmux creates Windows-specific coupling | Isolate behind an external-runtime adapter; native Pi agents and the canvas remain cross-platform. |

## Definition of done for the first shippable version

A remote user opens an existing OMP collab link in `collab-web`, switches to Canvas, and sees the main agent plus live subagents as a consistent graph. They can select a node, read its safe transcript/progress details, and—only with a write-capable link—send typed or final voice-transcribed text to that exact agent, interrupt it, or revive it. A view link remains observability-only. No canvas action bypasses the OMP host, no microphone audio is persisted, and no arbitrary psmux terminal control is exposed.
