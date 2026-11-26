# Prewalk

Prewalk is a one-shot handoff from the active model to a faster or cheaper model after planning reaches implementation. It lets the starting model inspect the repository, create a todo list, and begin the change before the target model continues the session.

Prewalk is off by default. Its target is `prewalk.into`, which defaults to the model assigned to the `@smol` role. To have OMP decide per task whether a prompt is worth it, see [Auto-prewalk](#auto-prewalk).

## Enable prewalk

Enable prewalk persistently in the global config:

```bash
omp config set prewalk.enabled true
```

The equivalent YAML in `~/.omp/agent/config.yml` or a project `.omp/config.yml` is:

```yaml
prewalk:
   enabled: true
```

`prewalk.into` (default `@smol`) sets the handoff target, and `prewalk.from` (default `@default`) sets the planning model: `/prewalk restart` returns to it, and auto-prewalk's `escalate` mode plans on it. Both take a model pattern or role. For example, to plan on a slower model and hand off to your default model:

```yaml
prewalk:
   from: "@slow"
   into: "@default"
```

The configured setting arms new sessions, not resumed/imported sessions. Explicit session flags can arm either:

| Flag                             | Effect                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--prewalk`                      | Arm prewalk for the new session.                                                                                                                                            |
| `--no-prewalk`                   | Leave prewalk disabled for the startup session, even when `prewalk.enabled` is `true`, and keep [auto-prewalk](#auto-prewalk) out of it. `/new` still follows the settings. |
| `--prewalk-into <model-or-role>` | Arm prewalk and use the supplied model pattern or role instead of `prewalk.into`.                                                                                           |

For example:

```bash
omp --prewalk
omp --prewalk-into @smol
omp --prewalk-into openai/gpt-5-mini
```

At startup, OMP resolves the target with the normal model-role and model-matching rules, trying configured role candidates in order for an authenticated, enabled provider. Extension-provided targets may resolve after extension registration. If no usable target remains, OMP prints a warning and starts with prewalk unarmed.

`--no-prewalk` cannot be combined with `--prewalk` or `--prewalk-into`. An explicit `--prewalk-into @default` resolves against the default role from before `--model` overrides it.

`/new` starts a fresh cycle using `prewalk.enabled` and `prewalk.into`, rather than inheriting a consumed handoff or the previous todo gate. Startup flags (`--prewalk`, `--no-prewalk`, `--prewalk-into`) apply only to the startup session; `/new` always uses the configured setting. When prewalk is enabled, the new session restores the previous planning model and thinking level after a handoff unless a later selection replaced them. If the planning model can no longer be used (for example, its credentials were removed), `/new` warns and stays on the current model. Resuming an existing session does not automatically re-arm prewalk.

Any model or thinking-level change made after the handoff counts as a replacement, including the switches plan mode makes on entry and exit. Automatic retry fallback, fallback restoration, and context promotion do not; if the session is back on the handoff model and thinking level when you run `/new`, it still restores the planning model.

A model or thinking-level selection made while the handoff is still switching wins, and the handoff is not recorded, so neither `/new` nor the next task returns to the planning model. If your selection lands before the target model is in place, the switch is cancelled with a `Prewalk: cancelled …` notice and the session stays on your selection. If the target model is already in place (for example, you picked a thinking level), the session stays on the target with your selection and still receives the implementation checklist. Returning from an automatic handoff likewise never overrides a selection made while the planning model loads.

## Handoff trigger

An armed prewalk injects a planning nudge. When the `todo` tool is active, any successful `todo` call—including the read-only `view` operation—opens the handoff gate. Without an active `todo` tool, the gate is already open.

OMP switches at the completed assistant-turn boundary containing the first eligible `edit` or `write` result, after persisting that turn's assistant message and tool results. Unlike the todo gate, the edit/write trigger does not require a successful result.

Calls to other tools do not trigger the handoff. Neither do `write` calls that change no files: messages to `agent://` peers, replies, and `proc://` stdin, mode, or kill writes. A `bash` call that ran tool commands counts only when its dispatch records classify the run as a workspace write; a read-only dispatch such as LSP navigation or a `<tool> --help` lookup does not arm the handoff, and neither does an execution-tier dispatch such as a test runner or remote command.

The switch is one-shot: after the handoff, prewalk disarms itself, removes the planning nudge, and steers the target with an implementation checklist. It changes the session's active model and optional thinking level without rewriting model-role assignments. A same-model handoff can still change thinking; when the model and effective thinking configuration already match, prewalk disarms without switching.

The handoff is recorded in the session, so resuming it, restoring it with `--restore`, or reviving a parked subagent continues on the handoff model and thinking level instead of returning to the planning model. A retry fallback taken after the handoff supersedes it, as for any session-local model. A revived subagent does not arm its prewalk again while it is still on that target.

## Arm from an active session

In a top-level session, changing `prewalk.enabled` live also takes effect:
turning it on arms the `prewalk.into` target when none is armed; turning it off
disarms a pending handoff. This does not control subagent prewalk.

Run these slash commands without restarting OMP:

```text
/prewalk [into]
/prewalk restart [from] [into]
/prewalk off
```

`/prewalk` arms a one-shot handoff from the active model to `into` (any model pattern or role; default `prewalk.into`).

`/prewalk off` cancels a pending handoff and clears its planning steering without changing the active model, saved configuration, or already-delivered continuation history. Run while the handoff is switching, it cancels that switch. It is safe to run when already off or after a handoff; it does not switch back to the planning model itself, although the next task still returns from an [automatic handoff](#one-task-at-a-time). Cancellation applies only to the current session: `/new` re-arms prewalk when the configured setting is enabled. It also keeps [auto-prewalk](#auto-prewalk) from arming again until `/new`.

After a handoff, `/prewalk restart` immediately returns the session to `from` and re-arms the handoff to `into`; omitted arguments use `prewalk.from` and `prewalk.into`. Arguments apply to that command only and are not remembered. Selectors are resolved when the command runs, so role reassignments take effect, and neither role's persisted configuration changes.

If prewalk is already armed, `/prewalk` leaves the existing target in place. `/prewalk restart` also preserves a matching arm; if its existing target differs from the requested `into`, restart is rejected before changing the active model. To choose a different target at startup, use `--prewalk-into`.

## Auto-prewalk

`prewalk.enabled` and `/prewalk` unconditionally arm a one-shot handoff. Auto-prewalk asks OMP's native judge, per task, whether prewalk is worthwhile, and arms the same handoff from the active model when it is. It is a prewalk-suitability check, not a difficulty rating or a general model router: under `on` it never picks a different planning model, and under `escalate` the only other model it plans on is the one `prewalk.from` names.

```yaml
prewalk:
   enabled: false
   auto: on
   autoTarget: "@smol"
```

`prewalk.autoTarget` (default `@smol`) takes a model pattern or role, resolved with the normal role and model-matching rules, including authentication.

| `prewalk.auto`  | Behavior                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | No classification. An earlier automatic handoff is still returned from at the next task.                                                                                                             |
| `suggest`       | Classifies each new task and reports the decision only. Never arms prewalk; an earlier automatic handoff is still returned from at the next task.                                                    |
| `on`            | Classifies each new task. When the judge is confident the task fits and the target resolves with a usable credential, arms a handoff from the active model to the target; otherwise nothing changes. |
| `escalate`      | Like `on`, but a task the judge is confident about first moves to `prewalk.from` to plan, then hands off from it. When `prewalk.from` already is the active model and thinking level, this is `on`, except that `@initial` then has nothing to hand back to. |

Run `suggest` for a while to see how it judges your prompts, then set `auto: on`. To plan on a stronger model, either make it your active (`@default`) model, or set it as `prewalk.from` and use `escalate`. The planning model does not have to be stronger; `escalate` plans on whatever `prewalk.from` names.

### Plan on another model

```yaml
prewalk:
   auto: escalate
   from: "anthropic/claude-opus-4-5"
   autoTarget: "@initial"
```

Under `escalate`, the judge runs on the model the task starts on. When it is confident, OMP switches to `prewalk.from` before the rest of setup, so memory recall, hooks, attachments, and auto thinking all run on the planner, and the switch shows as a model change in the session. The handoff then goes from the planner to `prewalk.autoTarget`. With `autoTarget: "@initial"`, it hands back to the model and thinking level the task started on; when the planner is the same model at a different thinking level, these moves only change the thinking level, which keeps the provider session. `@initial` needs a task `escalate` moved: under `on` it warns once and hands off to `@smol` instead, a task that stayed where it started (see below) is already there and is not armed, and subagents always use `@smol` for it.

Only a task `escalate` can move waits for the judge before setup starts, so then the judge is capped at 1 second instead of 4, and the planner's metadata and credential load while it runs. A model or thinking-level selection made while the judge runs keeps the task where you put it. When `prewalk.from` already is the active model and thinking level, or cannot be resolved, nothing waits and the judge keeps its usual budget, as under `on`. An unusable `prewalk.from` (unresolvable, or without a credential) warns once and leaves the task on the active model; it is then handled as under `on`, except that `@initial` has nothing to hand back to. `suggest` adds the planner `escalate` would move to, for example `Auto-prewalk: prewalk 0.84; escalate would plan on anthropic/claude-opus-4-5`.

`prewalk.enabled` keeps its meaning: unconditional prewalk, independent of `prewalk.auto`.

### Requirements

Auto-prewalk needs the `judge` model role to resolve first to a native judgment backend, the same condition as `find.enabled: auto`. It uses the existing judge-role provider support, including TypeSafe `jev`, OpenRouter, OpenAI Decisions, and Workers AI Clef. It relies on calibrated probabilities and never executes a prompted on-device or chat judge, even if the judge-role cache predates a login or discovery change. Without a native judge nothing is classified, and nothing is reported.

### What it decides

The judge sorts each task by where its expensive reasoning belongs, not by how hard or large it is:

| Route     | Meaning                                                                                                                    | Typical tasks                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prewalk` | The hard thinking comes first; once it settles the approach, the remaining implementation and verification are bounded.    | Tracing an unfamiliar subsystem before a localized change; reading several interacting files before implementing a clear design; diagnosing a bug down to a concrete fix; a migration whose hard part is finding the transformation and everything it touches. |
| `primary` | Strong reasoning stays necessary while implementing, debugging, or validating, so the first edit is too early to hand off. | Unresolved races or invariants; subtle lifecycle changes; a bug whose cause will still be unclear after a first look; high-risk or algorithmically hard changes.                                                                                               |
| `direct`  | There is no up-front phase worth handing off from.                                                                         | Explanations and read-only questions; trivial, mechanical, or fully specified edits; tiny localized fixes.                                                                                                                                                     |

Volume of work alone and difficulty alone never make a task a prewalk candidate, and a wrong handoff costs more than a missed one: between `prewalk` and `primary` the judge is told to choose `primary`, and for a small task to choose `direct`. OMP arms only when `prewalk` wins **and** its probability is at least 0.70. That threshold is fixed, and a `prewalk` winner below it counts as a "no".

`suggest` reports one line per judged task:

```text
Auto-prewalk: prewalk 0.84
Auto-prewalk: primary (prewalk 0.18)
Auto-prewalk: direct (prewalk 0.06)
Auto-prewalk: prewalk 0.55 (below threshold)
```

Under `on`, a confident decision shows the usual `Prewalk: armed for …` notice; other decisions are only logged. The plan nudge travels with the task's first request, and the existing handoff does the switching, with its todo gate and first `edit`/`write` trigger unchanged. Like a configured prewalk, an armed task skips the `todo.eager` reminder, since the plan nudge owns todo creation.

### One task at a time

An automatic handoff belongs to the task that armed it. When the next task starts, OMP returns to the model and thinking level that task started on (before an `escalate` switch to the planner, if it made one), then judges the new task, so a `primary` task is never left on the handoff target. `/new` does the same. This return happens whatever `prewalk.auto` is set to by then, including after `/prewalk off`. An auto arm that its task never used is dropped at the next task, which is judged on its own. An Esc while the task is still on the planner leaves the session there, and the next task returns to where the interrupted one started.

An explicit model or thinking-level selection after the handoff takes ownership: the session stays where you put it. Such a selection also cancels a pending auto arm before it switches; this includes the switches plan mode makes on entry and exit, model presets, and extension or ACP selections. Pending arms made by `/prewalk`, `--prewalk`, or `prewalk.enabled` stay armed, and their handoffs are never restored by auto-prewalk.

### What is classified

Only new, user-authored tasks in the top-level session: typed prompts, user-invoked `/skill:` prompts, and queued follow-ups when they are delivered. Steering is never classified, since it amends the task already running. Acknowledgements such as `ok` or `thanks`, synthetic continuation turns, agent-attributed messages, subagents, plan mode, and tasks where prewalk is already armed are skipped. Subagents have their own per-agent control; see [Subagent prewalk](#subagent-prewalk).

The judge runs alongside the rest of prompt setup (memory recall, hooks, auto thinking), and its decision is applied just before the request is sent, so it adds latency only when it is the slowest setup step.

A follow-up such as `do that` or `continue` cannot be judged alone, so the judge also sees the previous substantive user request and the agent's last reply, each truncated like other small-model input. The current request stays authoritative: the context only resolves what it points at.

### Manual controls win

A negative, direct, or sub-threshold decision, or a classifier error, leaves the model, thinking level, and prewalk exactly as they were.

A pending prewalk from `/prewalk`, `prewalk.enabled`, or `--prewalk` is never replaced, retargeted, or reclassified. `/prewalk off` and `--no-prewalk` keep auto-prewalk out of the session (for `--no-prewalk`, the startup session) until `/new`, and neither switches models. An explicit `/prewalk` or `/prewalk restart` takes over a pending auto arm, which then behaves like a manual one.

### Failure behavior

Auto-prewalk is an optimization and fails open. A missing native judge, a judge error or malformed answer, the timeout (4 seconds, or 1 second for a task `escalate` can move), an abort, or a prompt superseded while the judge ran all leave the task exactly as it would be without auto-prewalk. Answers with invalid probabilities, an inconsistent winning route, or invalid confidence are rejected. Judge failures, and how long each judgment took, are logged rather than shown; an unusable target reports an `Auto-prewalk not armed: target …` warning. Judgments are journaled as model usage under the purpose `auto-prewalk`.

## Subagent prewalk

Task subagents have separate prewalk controls: agent frontmatter, `task.prewalk`, and per-agent `task.agentPrewalk` overrides. See [Task agent discovery](./task-agent-discovery.md) for their precedence and target selection.

Those controls arm unconditionally. `task.agentPrewalkAuto` lets the judge decide per assignment instead:

```yaml
task:
   agentPrewalkAuto:
      task: "on"
      builder: "openai/gpt-5-mini"
```

Each entry maps an agent name to `"on"` (hand off to `prewalk.autoTarget`), `"off"`, or a target model pattern or role. A missing entry behaves like `"off"`.

The judgment happens once at spawn, on the assignment text, with the same native judge, routes, and fixed 0.70 threshold as Auto-prewalk (see [What it decides](#what-it-decides) and [Requirements](#requirements)). When it arms, the subagent gets the same handoff an unconditional subagent prewalk would; otherwise it runs without prewalk.

An unconditional arm from agent frontmatter, `task.prewalk`, or `task.agentPrewalk` wins and is never judged. Per-call-model and restricted-tool (plan mode) spawns are skipped without a judgment, as are spawns whose target is unavailable or equals the starting model and effort.

Subagent auto-prewalk fails open: a missing native judge, a judge error, the timeout, or a low-signal assignment leaves the spawn without prewalk. It is independent of `prewalk.auto`. A kept-alive subagent keeps its spawn decision for follow-ups. Once the subagent session starts, the judgment is recorded as model usage on it under the purpose `auto-prewalk`.
