---
title: Magic Keywords
description: Standalone prose words in a user prompt — ultrathink, orchestrate, workflowz — that add a hidden instruction for the turn.
coverage: A
---

Magic keywords are standalone prose words in a user prompt that add a hidden, user-attributed instruction for that turn. Notice injection is enabled by default. The TUI highlights recognized words with animated gradients while editing and static gradients in sent messages; highlighting is a visual affordance and currently remains even when notice injection is disabled in settings.

## Keywords

Each keyword adds its own hidden instruction when matched. Visit a keyword's page for the exact contract it injects, examples, and matching edge cases.

| Keyword | Effect |
| --- | --- |
| [`ultrathink`](/oh-my-pi/features/magic-ultrathink/) | Adds a careful multi-step reasoning notice. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn. |
| [`orchestrate`](/oh-my-pi/features/magic-orchestrate/) | Adds the multi-agent orchestration contract: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete. |
| [`workflowz`](/oh-my-pi/features/magic-workflowz/) | Adds a deterministic multi-subagent workflow contract through the `task` tool. The notice is injected only when `task` is available in the active tool set. |

Use a keyword anywhere in the prose of the prompt:

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes
```

The highlighted word stays visible in the prompt; the added instruction is hidden. All three keywords can fire in one prompt, each adding its own instruction.

## Matching rules

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink`, `Orchestrate`, and `Workflowz` do not trigger.
- The keyword must be standalone prose. Sentence punctuation and quotes may touch it, but letters, digits, underscores, slashes, backslashes, hyphens, file extensions, symbol references, and call syntax do not match. For example, `orchestrate,` matches; `orchestrated`, `orchestrate.ts`, `foo::orchestrate`, and `orchestrate()` do not.
- Fenced code blocks (backticks or tildes), inline code spans, and HTML/XML comments, tags, elements, and their contents are ignored.
- The visible word remains in the user message; hidden notices are non-displayed custom messages attributed to the user.
- The instruction applies only to the turn containing the keyword.

## Per-turn output budget (+Nk)

A standalone `+N` token in the prompt sets a per-turn output-token budget. It is parsed at turn start in the same path as magic keywords, and the token stays visible in the message.

```text
be exhaustive +500k please
```

| Form | Budget |
| --- | --- |
| `+N` | `N` output tokens |
| `+Nk` | `N × 1,000` output tokens |
| `+Nm` | `N × 1,000,000` output tokens |
| trailing `!` (`+500k!`) | Enforces the ceiling instead of advising it |

`N` is an integer or decimal (`+1.5k`), the `k`/`m` suffix is case-insensitive, and the token must be bounded by whitespace or the start/end of the prompt — so prices, version strings, and `c++` do not trigger it. The first match in the prompt wins; `+0` is rejected and negative values never match.

The budget is surfaced to the eval `budget` helper as `total`, `spent`, and `hard`; spend counts the turn's model output plus output from eval-spawned subagents. By default the budget is advisory — the model self-limits against `budget.remaining()`. A trailing `!` makes it a hard ceiling: once the turn's spend reaches `total`, eval's `agent()` refuses to spawn further subagents until the ceiling is raised or dropped. The budget applies only to the turn containing the token; a turn without a directive starts with no ceiling.

## Configuration

Open `/settings` and use **Interaction → Magic Keywords**, or change the settings from a shell:

```bash
# Disable every magic keyword
omp config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
```

The global switch and three per-keyword switches default to `true`. The global switch gates every hidden notice; a per-keyword switch gates only that notice (and, for `ultrathink`, the maximum-auto-thinking override). These settings do not currently disable the editor/message gradient — the highlighting remains visible even when notice injection is off. Run `omp config list` to inspect every setting and its current value. See [Settings](/oh-my-pi/configuration/settings/) for configuration scopes, precedence, and project-local overrides.
