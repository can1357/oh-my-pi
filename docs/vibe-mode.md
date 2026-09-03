# Vibe mode

Vibe mode turns the top-level interactive session into a **director** for persistent background worker sessions instead of letting it edit or execute commands itself. The director's active tools are reduced to `read`, optional parent-owned `todo`, and five worker-control tools. Workers do the searching, editing, running, and building; the director verifies their claims by reading touched files. When available, `todo` belongs only to the parent director.

## Enabling and disabling

Toggle it with the `/vibe` slash command:

```text
/vibe                 # enter vibe mode
/vibe fix the flaky test in packages/tui   # enter and submit a first directive
/vibe                 # run again to exit
```

- Entering activates a parent-session worker scope, installs the vibe tools, reduces the active toolset to `read`, optional parent-owned `todo`, and the vibe tools, and injects the director instructions.
- An inline prompt (`/vibe <prompt>`) enters the mode and submits that prompt as the first directive.
- Exiting restores the prior toolset, cancels in-flight worker turns, kills every worker session in the scope, and persists terminal lifecycle records. A worker never outlives an intentional mode exit.
- Vibe mode is mutually exclusive with both active **and paused** plan/goal modes; exit those modes first.
- Starting, forking, moving, or handing off the session is rejected while vibe mode is active.
- The status line shows a `Vibe` indicator while the mode is on.

`/vibe` is an interactive-TUI command. The mode and worker lifecycle events are persisted with the parent session. Resuming a session whose current mode is `vibe` rehydrates completed workers as idle/parked sessions with their child transcripts; a turn interrupted by process restart is not resumed automatically. Explicitly killed or mode-exit workers stay terminal.

## The two worker tiers

Every worker is a real, keep-alive task-executor subagent with the normal coding tool surface and its own persisted child transcript. Choose a tier when spawning:

| Tier   | Bundled agent | Default role | Use for                                             |
| ------ | ------------- | ------------ | --------------------------------------------------- |
| `fast` | `sonic`       | `@smol`      | Mechanical execution, drafts, high-volume work      |
| `good` | `task`        | `@task`      | Design, judgment calls, and reviewing `fast` output |

The tier always selects the bundled `sonic` or `task` definition, not a same-named discovered custom agent. Model resolution otherwise matches task-agent routing: `task.agentModelOverrides.sonic` / `.task` wins over the bundled agent model, and role aliases resolve through `modelRoles`, with the parent active/default model as fallback.

## Worker-control tools

| Tool         | Input and behavior                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibe_spawn` | `{ cli: "fast" \| "good", prompt, name? }`. Starts a blank worker with a complete, self-contained first brief. `name` is sanitized/capped at 48 characters; an id is generated when omitted.         |
| `vibe_send`  | `{ session, message }`. Steers a streaming turn at its next step; if a turn exists but cannot be steered, queues an automatic next turn; if idle/parked, starts the next turn immediately.           |
| `vibe_wait`  | `{ sessions?, timeout? }`. Waits for the first watched turn to settle (all in-flight workers when omitted), default 30 seconds. It acknowledges settled jobs so their result is not delivered twice. |
| `vibe_kill`  | `{ session }`. Cancels an in-flight turn, clears queued messages, releases the worker, and retains any initialized transcript at `history://<id>`.                                                   |
| `vibe_list`  | `{}`. Lists sessions in spawn order with tier, state, turn/queue counts, resolved model, and recent activity.                                                                                        |

Spawn and send return immediately. Each worker-turn result self-delivers into the director conversation through the async job manager; long response text is preview-capped there, with full output available at `agent://<id>`. Running `fast` and `good` workers on independent workstreams concurrently is the normal shape.

## Scope and failure behavior

Worker ids are scoped to the owning agent and parent session; a worker from another scope is reported as unknown and cannot be controlled. Spawning requires the session async job manager. Spawn failures tear down the partial record; turn failures self-deliver as failed job results, while a recoverable keep-alive worker returns to `idle` for another `vibe_send`. A worker whose registered child session can no longer be resolved becomes `dead`.

## Workflow

1. Split the request into independent workstreams — one persistent worker per workstream so each accumulates useful conversation context.
2. Call `vibe_spawn` with a self-contained brief: files, constraints, and observable acceptance criteria. Workers start blank and never see the director's conversation.
3. Keep directing other workers while turns are in flight. Use `vibe_wait` only when blocked; a timed-out wait can be reissued.
4. Use `vibe_send` naturally for corrections and next steps. A mid-turn send steers when possible; otherwise it becomes the worker's next turn automatically.
5. When a result arrives, `read` touched files and inspect full output when the preview is insufficient. Reconcile verified work through the optional parent `todo`.
6. Route by difficulty: draft with `fast`, escalate to `good` when mechanical execution stalls or judgment is required.
7. Use `vibe_kill` for a finished/stuck worker. Exiting the mode kills the entire remaining scope.

The director remains responsible for the final outcome: worker completion means the turn settled, not that its claims are correct.
