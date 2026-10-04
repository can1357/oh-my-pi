# Magic keywords

Magic keywords are standalone prose words in a user prompt that can add hidden, user-attributed instructions for that turn. Notice injection is enabled by default. The TUI animates recognized words while the editor is focused and shows static highlights in sent messages. Disabling the global switch stops editor animation and hidden notices, but leaves static highlighting and spelling exemptions in place. Recognized words are exempt from macOS spelling autocorrect and typo underlines, so `workflowz` and `jevify` are never rewritten into dictionary words.

The full list — trigger word, gradient, settings copy, required tools, and notice — lives in one table, `packages/coding-agent/src/modes/magic-keywords.ts`; every other surface (settings, notice injection, editor highlighting) derives from it.

## Keywords

| Keyword       | Effect                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrathink`  | Adds a careful multi-step reasoning notice. When automatic thinking is active, it also selects the highest reasoning effort supported by the current model for that turn, bypassing `providers.autoThinkingMaxEffort`.                                                                                                                                                 |
| `orchestrate` | Adds the multi-agent orchestration contract: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete. The notice requires `task` to be enabled and names only the available tools.                                                                                                                                       |
| `workflowz`   | Adds a deterministic multi-subagent workflow contract centered on the persistent `eval` kernel's `agent()`, `completion()`, handle, `wait()`, and `workpool()` helpers. It is intended for broad research, reviews, migrations, and adversarial coverage. The notice is injected only when both `eval` and `task` are active. |
| `jevify`      | Adds the bulk-classification contract for the `eval` kernel's `judge()` helper: freeze the question, rubric, pre-filter, and escalation threshold before loading any data, judge every item in one batch, then read only what the judge flags. It is intended for commit/PR audits, log triage, and any long homogeneous list with a yes/no or bucket question. The notice is injected only when `eval` is active. |

Use the keyword anywhere in the prose of the prompt:

```text
ultrathink about the failure modes before changing this API

orchestrate the migration described in docs/plan.md

workflowz an adversarial review of the authentication changes

jevify commit a17c3e0 for changes unrelated to the tui refactor
```

## Matching rules

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink`, `Orchestrate`, `Workflowz`, and `Jevify` do not trigger.
- The keyword must be standalone prose. Sentence punctuation and quotes may touch it, but letters, digits, underscores, slashes, backslashes, hyphens, file extensions, symbol references, and call syntax do not match. For example, `orchestrate,` matches; `orchestrated`, `orchestrate.ts`, `foo::orchestrate`, and `orchestrate()` do not.
- Fenced code blocks (backticks or tildes), inline code spans, HTML/XML comments/tags/elements, and their contents are ignored.
- All enabled keywords in one prompt may add their own notice. The visible word remains in the user message; hidden notices are non-displayed custom messages attributed to the user.
- Matching uses the expanded prompt, after slash-command and prompt-template expansion. Synthetic, agent-initiated prompts do not trigger notices.
- The instruction applies only to the turn containing the keyword.

## Configuration

Open `/settings` and use **Interaction → Magic Keywords**, or change the settings from a shell:

```bash
# Disable every magic keyword
omp config set magicKeywords.enabled false

# Disable one keyword while leaving the others enabled
omp config set magicKeywords.ultrathink false
omp config set magicKeywords.orchestrate false
omp config set magicKeywords.workflow false
omp config set magicKeywords.jevify false
```

The global switch and four per-keyword switches default to `true`. The global switch gates every hidden notice and editor animation; a per-keyword switch gates only that notice (and ultrathink's maximum-auto-thinking override). Static highlighting and spelling exemptions remain. `workflowz` uses the settings key `magicKeywords.workflow`; its notice adapts to the active task batching, scout availability, and Eval kernel-tool settings. Run `omp config list` to inspect every setting and its current value. See [Settings](./settings.md) for configuration scopes, precedence, and project-local overrides.
