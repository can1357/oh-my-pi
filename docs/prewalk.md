# Prewalk

Prewalk is a one-shot handoff from the active model to a faster or cheaper model after planning reaches implementation. It lets the starting model inspect the repository, create a todo list, and begin the change before the target model continues the session.

Prewalk is off by default. Its default target is the model assigned to the `@smol` role.

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

The configured setting arms new sessions, not resumed/imported sessions. Explicit session flags can arm either:

| Flag | Effect |
| --- | --- |
| `--prewalk` | Arm prewalk for the new session. |
| `--no-prewalk` | Leave prewalk disabled for the session, even when `prewalk.enabled` is `true`. |
| `--prewalk-into <model-or-role>` | Arm prewalk and use the supplied model pattern or role instead of `@smol`. |

For example:

```bash
omp --prewalk
omp --prewalk-into @smol
omp --prewalk-into openai/gpt-5-mini
```

At startup, OMP resolves the target with the normal model-role and model-matching rules, trying configured role candidates in order for an authenticated, enabled provider. Extension-provided targets may resolve after extension registration. If no usable target remains, OMP prints a warning and starts with prewalk unarmed.

`--no-prewalk` cannot be combined with `--prewalk` or `--prewalk-into`. An explicit `--prewalk-into @default` resolves against the default role from before `--model` overrides it.

## Handoff trigger

An armed prewalk injects a planning nudge. When the `todo` tool is active, any successful `todo` call—including the read-only `view` operation—opens the handoff gate. Without an active `todo` tool, the gate is already open.

OMP switches at the completed assistant-turn boundary containing the first eligible `edit` or `write` result, after persisting that turn's assistant message and tool results. Unlike the todo gate, the edit/write trigger does not require a successful result.

Calls to other tools do not trigger the handoff. A read-only `xd://` device request routed through `write`, such as LSP navigation, also does not count; only device operations classified as workspace writes or execution count.

The switch is one-shot: after the handoff, prewalk disarms itself, removes the planning nudge, and steers the target with an implementation checklist. It changes the session's active model and optional thinking level without rewriting model-role assignments. A same-model handoff can still change thinking; when the model and effective thinking configuration already match, prewalk disarms without switching.

## Arm from an active session

In a top-level session, changing `prewalk.enabled` live also takes effect:
turning it on arms the current `@smol` target when none is armed; turning it off
disarms a pending handoff. This does not control subagent prewalk.

Run either slash command without restarting OMP:

```text
/prewalk
/prewalk restart
/prewalk off
```

`/prewalk` arms a one-shot handoff from the active model to the current `@smol` assignment.

After a handoff, `/prewalk restart` immediately returns the session to the current `@default` assignment and re-arms the handoff to `@smol`. Both roles are resolved when the command runs, so the cycle is independent of concrete model names and does not alter either role's persisted configuration.

`/prewalk off` drops an armed handoff before it fires: the pending plan nudge is removed and the session stays on its active model instead of switching at the next edit/write. It is the command-level counterpart to turning `prewalk.enabled` off, and it is a no-op when nothing is armed.

If prewalk is already armed, `/prewalk` leaves the existing target in place. `/prewalk restart` also preserves a matching arm; if its existing target differs from the current `@smol` resolution, restart is rejected before changing the active model. To choose a different target at startup, use `--prewalk-into`.

## Subagent prewalk

Task subagents have separate prewalk controls: agent frontmatter, `task.prewalk`, and per-agent `task.agentPrewalk` overrides. See [Task agent discovery](./task-agent-discovery.md) for their precedence and target selection.
