# Model Rules

Model rules are markdown files that add instructions to the system prompt only when the active model matches. Use them for guidance that applies to one model family, such as a style correction for one provider's models.

Implementation:

- `packages/coding-agent/src/extensibility/model-rules.ts` (loading, matching, overrides, enabled state)
- `packages/coding-agent/src/prompts/system/model-rules.md` (rendered block)
- `packages/coding-agent/src/session/agent-session.ts` (`#buildModelRulesPrompt`, per-prompt injection)
- `packages/coding-agent/src/modes/components/model-rules-selector.ts` (`/model-rules` selector)

## Locations

| Scope   | Directory                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------- |
| Global  | `~/.omp/agent/model-rules/` (the active agent dir, honoring `PI_CODING_AGENT_DIR` and profiles) |
| Project | `<cwd>/.omp/model-rules/`                                                                       |

Only `*.md` files directly in these directories are read.

## File format

```markdown
---
name: claude
models:
   - anthropic/*claude*
   - "**/*opus*"
enabled: true
---

Prefer short answers.
```

| Field     | Required | Meaning                                                             |
| --------- | -------- | ------------------------------------------------------------------- |
| `models`  | yes      | One glob or a list of globs matched against `provider/model-id`.    |
| `name`    | no       | The rule's identity. Defaults to the file name without `.md`.       |
| `enabled` | no       | `false` turns the rule off by default. A saved toggle wins over it. |

The markdown after the frontmatter is the rule body. A file is skipped silently when it has no frontmatter, invalid YAML, no `models`, or an empty body.

## Matching

Globs are matched case-insensitively against `provider/model-id` (for example `anthropic/claude-opus-4`). `*` matches within one `/` segment and `**` matches across segments, so `anthropic/*opus*` matches only Anthropic models, while `**/*opus*` matches any provider.

## Ordering and overrides

Global rules load first, then project rules; within a directory files are sorted by file name.

A rule whose name repeats an earlier rule's name replaces that rule in its position. A project rule therefore overrides the global rule with the same name: only the project rule's body, `models` and `enabled` apply. Because the identity is the name, the override works across different file names, for example global `00-claude.md` and project `50-claude.md` that both set `name: claude`.

## Injection

Rules are re-read from disk on every prompt, so edits and `/model` switches apply on the next prompt without a restart. The enabled rules that match the current model are appended to that turn's system prompt:

```xml
<model-rules>
<model-rule name="claude">
Prefer short answers.
</model-rule>
</model-rules>
```

The block is added before `before_agent_start` extension handlers run, so extensions see it. Subagents get the rules that match their own model.

### Model switches during a turn

When the model changes while a turn is running (`/switch`, `/model`, Alt+P, a retry fallback, a prewalk hand-off, context promotion, or an extension calling `pi.setModel()`), the block is re-rendered for the new model from the rules loaded when the turn started and swapped in place; it is removed when the new model matches no rule and added when the previous model had none. Rule files are not re-read mid-turn.

Each model's block is rendered once per turn, so switching back to a model restores exactly the prompt it had and its provider prompt cache stays valid. If a `before_agent_start` handler replaced the system prompt and dropped the block, it stays dropped.

## Toggling with `/model-rules`

`/model-rules` lists the loaded rules with their scope and globs, marks rules that match the active model as active, and marks project rules that replace a global rule as overriding it. Enter toggles the selected rule; the selected rule's markdown is previewed below the list in a terminal and beside it in Tern.

Toggles are saved in the `modelRules` setting, keyed by rule name:

- a global rule's toggle is written to the global `config.yml`;
- a project rule's toggle is written to `<cwd>/.omp/config.yml`.

```yaml
modelRules:
   claude: false
```

A toggle that matches the rule's frontmatter default removes the entry instead of writing it. Precedence for whether a rule is on: saved toggle, then frontmatter `enabled`, then on. The selector never edits rule files.
