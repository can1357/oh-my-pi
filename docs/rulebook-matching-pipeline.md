# Rulebook Matching Pipeline

This document describes how coding-agent discovers rules from supported config formats, normalizes them into a single `Rule` shape, resolves precedence conflicts, and splits the result into:

- **Rulebook rules** (available to the model via system prompt + `rule://` URLs)
- **TTSR rules** (Time Traveling Stream Rules)

It reflects the current implementation, including partial semantics and metadata that is parsed but not enforced.

## Implementation files

- [`packages/coding-agent/src/capability/rule.ts`](../packages/coding-agent/src/capability/rule.ts)
- [`packages/coding-agent/src/capability/rule-buckets.ts`](../packages/coding-agent/src/capability/rule-buckets.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/discovery/index.ts`](../packages/coding-agent/src/discovery/index.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts)
- [`packages/coding-agent/src/discovery/builtin-defaults.ts`](../packages/coding-agent/src/discovery/builtin-defaults.ts)
- [`packages/coding-agent/src/discovery/agents.ts`](../packages/coding-agent/src/discovery/agents.ts)
- [`packages/coding-agent/src/discovery/github.ts`](../packages/coding-agent/src/discovery/github.ts)
- [`packages/coding-agent/src/discovery/cursor.ts`](../packages/coding-agent/src/discovery/cursor.ts)
- [`packages/coding-agent/src/discovery/windsurf.ts`](../packages/coding-agent/src/discovery/windsurf.ts)
- [`packages/coding-agent/src/discovery/cline.ts`](../packages/coding-agent/src/discovery/cline.ts)
- [`packages/coding-agent/src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`packages/coding-agent/src/system-prompt.ts`](../packages/coding-agent/src/system-prompt.ts)
- [`packages/coding-agent/src/internal-urls/rule-protocol.ts`](../packages/coding-agent/src/internal-urls/rule-protocol.ts)
- [`packages/utils/src/frontmatter.ts`](../packages/utils/src/frontmatter.ts)

## 1. Canonical rule shape

All providers normalize source files into `Rule`:

```ts
interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  _source: SourceMeta;
}
```

Capability identity is `rule.name` (`ruleCapability.key = rule => rule.name`).

Consequence: precedence and deduplication are **name-based only**. Two different files with the same `name` are considered the same logical rule.

## 2. Discovery sources and normalization

`src/discovery/index.ts` auto-registers providers. For `rules`, current providers are:

- `native` (priority `100`)
- `omp-plugins` (priority `90`) — `rules/*.{md,mdc}` inside configured extension package roots, normalized via the shared `buildRuleFromMarkdown` path
- `agents` (priority `70`)
- `cursor` (priority `50`)
- `windsurf` (priority `50`)
- `cline` (priority `40`)
- `github` (priority `30`)
- `builtin-defaults` (priority `1`)

### Native provider (`builtin.ts`)

Loads `.omp` rules from:

- project rules: `<cwd>/.omp/rules/*.{md,mdc}` when the cwd's `.omp/` directory is non-empty
- user rules: `<active-native-agent-dir>/rules/*.{md,mdc}`
- sticky user rule: `<active-native-agent-dir>/RULES.md`
- sticky project rule: `RULES.md` from the nearest non-empty `.omp/` directory selected while walking from cwd toward the repository root; OMP does not continue farther when that directory lacks the file

The active native agent directory is `~/.omp/agent` by default, follows named profiles, and honors `PI_CODING_AGENT_DIR`.

Normalization:

- `name` = filename without `.md`/`.mdc`
- frontmatter parsed via `parseFrontmatter`
- `content` = body (frontmatter stripped)
- `globs`, `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` are parsed by `buildRuleFromMarkdown`
- top-level `RULES.md` is synthesized as rule name `RULES` and forced to `alwaysApply: true`

Both sticky files use the fixed name `RULES`. Because native items are appended as project rules, user rules, user sticky `RULES.md`, then project sticky `RULES.md`, the first earlier item named `RULES` wins. Normally this means user sticky content shadows project sticky content; a regular `rules/RULES.md` can shadow both.

Important caveat: `condition` values that look like file globs are converted into `tool:edit(...)` / `tool:write(...)` scope shorthands with catch-all condition `.*`.

### Agents provider (`agents.ts`)

Loads from both `.agent` and `.agents` directories:

- project: walk upward from `cwd` to repo root, loading `<ancestor>/.agent/rules/*.{md,mdc}` and `<ancestor>/.agents/rules/*.{md,mdc}`
- user: `~/.agent/rules/*.{md,mdc}` and `~/.agents/rules/*.{md,mdc}`

Normalization uses the shared `buildRuleFromMarkdown` path: filename-derived name, stripped frontmatter body, and parsed `globs`, `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode`.

### Cursor provider (`cursor.ts`)

Loads from:

- user: `~/.cursor/rules/*.{mdc,md}`
- project: `<cwd>/.cursor/rules/*.{mdc,md}`

Normalization (`transformMDCRule`):

- `description`: kept only if string
- `alwaysApply`: normalized to a boolean — `true` only when frontmatter has `alwaysApply: true` (anything else becomes `false`)
- `globs`: accepts array (string elements only) or single string
- `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` are parsed by shared rule helpers
- `name` from filename without extension

### Windsurf provider (`windsurf.ts`)

Loads from:

- user: `~/.codeium/windsurf/memories/global_rules.md` (fixed rule name `global_rules`)
- project: `<cwd>/.windsurf/rules/*.md`

Normalization:

- `globs`: array-of-string or single string
- `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` parsed by shared rule helpers
- `name` is fixed to `global_rules` for the user global file and derived from filename for project rules

### Cline provider (`cline.ts`)

Searches upward from `cwd` for nearest `.clinerules`:

- if directory: loads `*.md` inside it
- if file: loads single file as rule named `clinerules`

Normalization:

- `globs`: array-of-string or single string
- `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, and `interruptMode` parsed by shared rule helpers
- `name` is fixed to `clinerules` for a `.clinerules` file and derived from filename for `.clinerules/*.md`

### GitHub provider (`github.ts`)

Loads `*.instructions.md` recursively from:

- project: `<cwd>/.github/instructions/`
- user: `<dir>/.github/instructions/` for every directory in the comma-separated `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`

The filename without `.instructions.md` is the rule name. Shared Markdown parsing still recognizes normal OMP rule metadata, including TTSR fields. GitHub's `applyTo` is additionally normalized as follows:

- a comma-separated string (or tolerated YAML array) becomes `globs`;
- `*`, `**`, or `**/*` makes the rule always-apply and clears `globs`;
- any other glob makes the rule non-always-apply; a missing `description` is generated from the globs;
- missing `applyTo` produces a rulebook description plus a discovery warning.

Because TTSR bucketing runs before always-apply/rulebook bucketing, a GitHub instruction carrying an accepted `condition` or `astCondition` is still TTSR-only regardless of `applyTo`.

## 3. Frontmatter parsing behavior and ambiguity

All providers use `parseFrontmatter` (`utils/frontmatter.ts`) with these semantics:

1. Frontmatter is parsed only when content starts with `---` and has a closing `\n---`.
2. Body is trimmed after frontmatter extraction.
3. If whole-document YAML parsing fails:
   - a warning is logged,
   - the parser falls back to simple `key: value` line parsing (`^([\w-]+):\s*(.*)$`),
   - each captured value is reparsed independently as YAML, and only values that still fail parsing remain raw trimmed strings.

Fallback limitations:

- Multiline arrays, nested objects, and other indentation-dependent YAML structures are not reconstructed. A valid one-line flow value (for example `[text, thinking]`) can still survive the per-value reparse.
- An individually malformed value remains a raw string; providers requiring a boolean, list, or object may drop that metadata.
- `ttsr_trigger` works in fallback (underscore key); hyphenated keys like `thinking-level` also parse and are normalized to camelCase (`thinkingLevel`) — key normalization applies to the YAML path too.
- Files without valid frontmatter still load as rules with empty metadata and full content body. The scope parser also tolerates the common malformed fallback value `scope: "text","thinking"`, though valid YAML (`"text, thinking"` or `[text, thinking]`) is preferred.

## 4. Provider precedence and deduplication

`loadCapability("rules")` (`capability/index.ts`) merges provider outputs and then deduplicates by `rule.name`.

### Precedence model

- Providers are ordered by priority descending.
- Equal priority keeps registration order (`cursor` before `windsurf` from `discovery/index.ts`).
- Dedup is first-wins: first encountered rule name is kept; later same-name items are marked `_shadowed` in `all` and excluded from `items`.

Effective rule provider order is currently:

1. `native` (100)
2. `omp-plugins` (90)
3. `agents` (70)
4. `cursor` (50)
5. `windsurf` (50)
6. `cline` (40)
7. `github` (30)
8. `builtin-defaults` (1)

### Intra-provider ordering caveat

Within a provider, item order comes from `loadFilesFromDir` glob result ordering plus explicit push order. This is deterministic enough for normal use but not explicitly sorted in code.

Notable source-order differences:

- `native` appends project `.omp/rules`, user `~/.omp/agent/rules`, user `RULES.md`, then nearest project `RULES.md`.
- `omp-plugins` appends `rules/` results per configured extension package root.
- `agents` appends project-walk `.agent`/`.agents` rule dirs before user home dirs.
- `cursor` appends user then project results.
- `windsurf` appends user `global_rules` first, then project rules.
- `cline` loads only the nearest `.clinerules` source.
- `github` appends cwd project instructions first, followed by each `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entry in environment-list order.
- `builtin-defaults` uses the embedded rule source order.

## 5. Split into Rulebook, Always-Apply, and TTSR buckets

After rule discovery in `createAgentSession` (`sdk.ts`), `bucketRules(...)` applies session-level filtering and bucket assignment:

1. Drop rules listed in `ttsr.disabledRules`.
2. Drop rules from the `builtin-defaults` provider when `ttsr.builtinRules === false`.
3. Register rules with a non-empty `condition` or `astCondition` into `TtsrManager`; if registration succeeds, the rule is TTSR-only.
4. Put remaining `alwaysApply === true` rules into `alwaysApplyRules`.
5. Put remaining rules with `description` into `rulebookRules`.

### Bucket behavior

- **TTSR bucket**: any enabled rule with a non-empty parsed `condition` (regex) or `astCondition` (ast-grep patterns) that `TtsrManager.addRule(...)` accepts. Takes priority over other buckets.
- **Always-apply bucket**: `alwaysApply === true`, not TTSR. Full content injected into system prompt. Resolvable via `rule://`.
- **Rulebook bucket**: must have description, must not be TTSR, must not be `alwaysApply`. Listed in system prompt by name+description; content read on demand via `rule://`.
- A rule with both a trigger condition and `alwaysApply` goes to TTSR only if TTSR registration accepts it; otherwise it can fall through to always-apply.
- A rule with both `alwaysApply` and `description` goes to always-apply only (not rulebook).

## 6. How metadata affects runtime surfaces

### `description`

- Required for inclusion in rulebook.
- Rendered in the system prompt rulebook block (`<domain-rules>` in the default template, `<rules>` in the custom-prompt template).
- Missing description keeps the rule out of the rulebook listing; unless it is always-apply or an accepted TTSR rule, it is also not addressable via `rule://`.

### `globs`

- Carried through on `Rule`.
- Rendered inline in the default prompt's rulebook listing (`- <name> (<glob>, ...): <description>`); the custom-prompt template renders them as `<glob>...</glob>` entries.
- Exposed in rules UI state (`extensions` mode list).
- Used by TTSR as a global path gate: if a TTSR rule has globs, the match context must include at least one matching file path.
- Not used to automatically select rulebook rules for `rule://`; rulebook matching remains advisory prompt behavior.

### `alwaysApply`

- Parsed and preserved by providers.
- Used in UI display (`"always"` trigger label in extensions state manager).
- Used as an exclusion condition from `rulebookRules`.
- **Full rule content is auto-injected into the system prompt** (before the rulebook rules section).
- Rule is also addressable via `rule://<name>` for re-reading.

### `condition`, `astCondition`, `scope`, and `interruptMode`

- `condition` is the regex TTSR trigger field; legacy `ttsr_trigger` / `ttsrTrigger` are accepted as fallback inputs during parsing. A leading `(?i)`, `(?m)`, or `(?s)` inline flag group is translated to the equivalent JavaScript `RegExp` flags.
- `astCondition` is the ast-grep trigger field: a string or YAML sequence of structural patterns, kept verbatim (no glob inference). It only matches on edit/write tool streams, where the language is inferred from the file path. A rule may set `condition`, `astCondition`, or both.
- `scope` narrows TTSR matching to an allowlist of stream surfaces. It accepts either a comma-separated YAML string or a YAML sequence. Omitting it watches assistant prose (`text`) and all tool arguments (`tool`), but not thinking.

  ```yaml
  # Prose and thinking; equivalent forms:
  scope: "text, thinking"
  ```

  ```yaml
  scope: [text, thinking]
  ```

  ```yaml
  # A block-style YAML sequence is also valid:
  scope:
    - text
    - thinking
  ```

  ```yaml
  # Only TypeScript source snapshots produced by edit/write:
  scope: "tool:edit(*.ts), tool:write(*.ts)"
  ```

  Valid tokens are `text`, `thinking`, `tool` (or `toolcall`), and `tool:<name>(<path-glob>)`. The parser tolerates the malformed fallback spelling `scope: "text","thinking"`, but portable rule files should put the comma inside one YAML string or use a YAML sequence.

- A `condition` token that looks like a file glob becomes `tool:edit(<glob>)` and `tool:write(<glob>)` scope entries plus catch-all condition `.*`; `astCondition` tokens never trigger this shorthand.
- `interruptMode` can override the global TTSR interrupt mode for the rule.

## 7. System prompt inclusion path

`buildSystemPromptInternal` receives both `rules` (rulebook) and `alwaysApplyRules`.

Always-apply rules are deduped against the effective system/custom/append prompt sources and loaded context-file bodies. A rule whose normalized content already appears in one of those sources is omitted from automatic injection. Remaining raw bodies render before the rulebook listing: inside `<generic-rules>` in the default template and directly in the bundled custom-prompt template.

Rulebook rules are rendered in a `<domain-rules>` block as `- <name> (<globs>): <description>` lines; the URL list in the prompt documents `rule://<name>` and the workflow section tells the model to read relevant rules first. The custom-prompt template (`custom-system-prompt.md`) instead renders `<rule name="...">` entries with `<glob>` children under an explicit "You MUST read `rule://<name>`" instruction.

This is advisory/contextual: prompt text asks the model to read applicable rules, but code does not enforce glob applicability.

## 8. `rule://` internal URL behavior

`RuleProtocolHandler` resolves against the process-global active-rule snapshot
installed once per top-level session in `sdk.ts`:

```ts
setActiveRules([
  ...rulebookRules,
  ...alwaysApplyRules,
  ...ttsrManager.getRules(),
]);
```

Implications:

- `rule://<name>` resolves against **rulebookRules**, **alwaysApplyRules**, and **registered TTSR rules**.
- TTSR rules are bucketed out before rulebook/always, but `ttsrManager.getRules()` re-adds them to the snapshot so a triggered rule (e.g. a builtin) stays addressable for re-reading.
- Rules with no description, no `alwaysApply`, and no accepted TTSR condition are not addressable via `rule://`.
- Resolution is exact name match.
- Unknown names return error listing available rule names.
- Returned content is raw `rule.content` (frontmatter stripped), content type `text/markdown`.

## 9. Known partial / non-enforced semantics

1. The rule providers currently loaded for `rules` are `native`, `omp-plugins`, `agents`, `cursor`, `windsurf`, `cline`, `github`, and embedded `builtin-defaults`; provider files for other tools may parse other config formats but do not register rule loaders.
2. `globs` metadata is surfaced to prompt/UI and is used as a global path gate for TTSR matching, but it is not used to automatically select rulebook rules for `rule://`.
3. Rule selection for `rule://` includes rulebook, always-apply, and registered TTSR rules (so a triggered TTSR rule can be re-read), but not rules that registered no condition and carry neither a description nor `alwaysApply`.
4. Discovery warnings (`loadCapability("rules").warnings`) are produced but `createAgentSession` does not currently surface/log them in this path.
