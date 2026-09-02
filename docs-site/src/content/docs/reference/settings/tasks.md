---
title: Settings — Tasks
description: Subagents, plan and goal modes, and skills and command discovery.
coverage: A
---

Settings that govern subagent delegation, plan and goal modes, and the discovery of skills and slash commands. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

## Modes: plan, goal, and titles

Plan mode is the read-only exploration phase before execution; goal mode tracks a per-session objective across turns. See [Plan Mode](/oh-my-pi/modes/plan-mode/) and [Goal Mode](/oh-my-pi/modes/goal-mode/).

| Key | Type | Default | Description |
|---|---|---|---|
| `plan.enabled` | boolean | `true` | Enable plan mode for read-only exploration and planning before execution. |
| `plan.defaultOnStartup` | boolean | `false` | Automatically enter plan mode at the start of every new session. |
| `goal.enabled` | boolean | `true` | Enable per-session goal mode and the hidden goal tool. |
| `goal.statusInFooter` | boolean | `true` | Show token budget alongside the goal indicator in the status line. |
| `goal.continuationModes` | array | `["interactive"]` | Run modes where active goals may auto-continue between turns. |
| `title.refreshOnReplan` | boolean | `true` | Refresh generated session titles after todo init replans, unless the title was set by the user. |

## Subagents

The `task` tool spawns subagents for delegated work; see [Subagents](/oh-my-pi/features/subagents/) for the workflow.

| Key | Type | Default | Description |
|---|---|---|---|
| `task.eager` | enum | `default` | How strongly to push delegating work to subagents. One of `default` (model decides), `preferred` (adds delegation guidance to the system prompt), `always` (guidance plus a first-turn delegation reminder). |
| `task.batch` | boolean | `true` | Switch the task tool to its batch shape: one call carries `{ context, tasks[] }` — one subagent per item, with an optional per-item agent, per-item isolation, and a required shared context prepended to every assignment. With `async.enabled` on, each spawn runs as an independent background agent; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema. |
| `task.enableEffort` | boolean | `false` | Expose the optional effort parameter on task spawns, letting callers override each subagent's thinking level. |
| `task.maxConcurrency` | number | `32` | Maximum number of subagents running concurrently. |
| `task.enableLsp` | boolean | `false` | Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap. |
| `task.maxRecursionDepth` | number | `2` | How many levels deep subagents can spawn their own subagents. |
| `task.maxRuntimeMs` | number | `0` | Hard wall-clock limit per subagent in milliseconds; `0` disables it. Triggers a normal subagent abort with a "timed out" reason. |
| `task.agentIdleTtlMs` | number | `420000` | How long an idle subagent stays live in memory before being parked to disk (7 minutes). Parked agents are revived automatically when messaged or resumed; `0` keeps idle agents live until exit. |
| `task.softRequestBudget` | number | `200` | Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice; at 1.5x the budget the run is force-stopped and the agent yields partial findings. `0` disables the guard. |
| `task.softRequestBudgetNotice` | boolean | `true` | Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop. |
| `task.maxEffort` | enum | `max` | Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling. |
| `task.disabledAgents` | array | `[]` | Agent names that may not be spawned. Disabled agents are excluded from the task picker and rejected at spawn preflight. |
| `task.agentModelOverrides` | record | `{}` | Per-agent model overrides: a map of agent name to model pattern that takes precedence over the agent's configured model. |
| `task.agentPrewalk` | record | `{}` | Per-agent prewalk overrides (`on`, `off`, or a model pattern); toggled with `P` in `/agents`. |
| `task.prewalk` | boolean | `false` | Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the `smol` role at its first edit/write. Per-agent overrides (`task.agentPrewalk`) and user agent `prewalk` frontmatter apply regardless of this toggle. |
| `task.showResolvedModelBadge` | boolean | `false` | Display the actual model ID used by each subagent in the task widget status line. |

## Isolation and worktrees

Isolation gives each subagent its own view of the repository; successful changes are folded back into the parent checkout.

| Key | Type | Default | Description |
|---|---|---|---|
| `task.isolation.mode` | enum | `none` | Isolation backend for subagents. One of `none`, `auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy`. `auto` picks the best available backend (CoW-aware filesystems, then overlayfs/ProjFS, then a git worktree / recursive-copy fallback); `rcopy` uses a git worktree if available, otherwise a recursive copy. |
| `task.isolation.apply` | boolean | `true` | Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts. |
| `task.isolation.merge` | enum | `patch` | How isolated task changes are integrated. One of `patch` (combine diffs and git apply), `branch` (commit per task, merge with `--no-ff`). |
| `task.isolation.commits` | enum | `generic` | Commit message style for nested repo changes. One of `generic` (static commit message), `ai` (AI-generated from the diff). |
| `worktree.base` | string | unset | Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses `~/.omp/wt`. Must be an absolute or `~`-relative path; relative paths are ignored. The `OMP_WORKTREE_DIR` env var overrides this. |

## Skills

Skill discovery sources and filtering; see [Skills](/oh-my-pi/extending/skills/) for how skills work. The `skills.enable*` toggles control which skill directories are scanned: Claude Code (`~/.claude/skills/` and `.claude/skills/` found walking up from the project), Codex CLI (`~/.codex/skills/`), OMP-native (`~/.omp/agent/skills/` and `.omp/skills/`), and the `.agent`/`.agents` directories (`~/.agent[s]/skills` and `.agent[s]/skills` walking up).

| Key | Type | Default | Description |
|---|---|---|---|
| `skills.enabled` | boolean | `true` | Master switch for skill discovery; also disabled by the `--no-skills` CLI flag. |
| `skills.enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands. |
| `skills.enableCodexUser` | boolean | `true` | Load skills from `~/.codex/skills/`. |
| `skills.enableClaudeUser` | boolean | `true` | Load skills from `~/.claude/skills/`. |
| `skills.enableClaudeProject` | boolean | `true` | Load skills from `.claude/skills/` found walking up from the project. |
| `skills.enablePiUser` | boolean | `true` | Load OMP-native user skills from the active profile's agent directory (`~/.omp/agent/skills/`). |
| `skills.enablePiProject` | boolean | `true` | Load OMP-native project skills from `.omp/skills/` found walking up from the project. |
| `skills.enableAgentsUser` | boolean | `true` | Load skills from `~/.agent/skills/` and `~/.agents/skills/`. |
| `skills.enableAgentsProject` | boolean | `true` | Load skills from `.agent/skills/` and `.agents/skills/` found walking up from the project. |
| `skills.customDirectories` | array | `[]` | Additional directories scanned for skills (sourced as `custom:user`). |
| `skills.ignoredSkills` | array | `[]` | Glob patterns of skill names to exclude from discovery. |
| `skills.includeSkills` | array | `[]` | Glob patterns of skill names to include; empty means all skills load. Overridden per session by the `--skills` CLI flag. |

## Commands

Slash-command import from Claude Code and OpenCode command directories.

| Key | Type | Default | Description |
|---|---|---|---|
| `commands.enableClaudeUser` | boolean | `true` | Load commands from `~/.claude/commands/`. |
| `commands.enableClaudeProject` | boolean | `true` | Load commands from `.claude/commands/`. |
| `commands.enableOpencodeUser` | boolean | `true` | Load commands from `~/.config/opencode/commands/`. |
| `commands.enableOpencodeProject` | boolean | `true` | Load commands from `.opencode/commands/`. |

## Todos

| Key | Type | Default | Description |
|---|---|---|---|
| `tasks.todoClearDelay` | number | `60` | Delay in seconds before completed or abandoned todos are removed from the todo widget. `-1` keeps them until session end. |
