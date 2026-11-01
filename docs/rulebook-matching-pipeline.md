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
- [`packages/coding-agent/src/cli/ttsr-cli.ts`](../packages/coding-agent/src/cli/ttsr-cli.ts)
- [`packages/utils/src/frontmatter.ts`](../packages/utils/src/frontmatter.ts)

Discovered Markdown rules use `discoverRuleFromMarkdown`; `enabled: false` frontmatter excludes the file before name-based deduplication. `buildRuleFromMarkdown` is the explicit-load variant and does not apply that discovery filter.

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
	question?: string;
	scope?: string[];
	agents?: string[];
	models?: string[];
	providers?: string[];
	class?: string[];
	family?: string[];
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	_source: SourceMeta;
}
```

Capability identity is `rule.name` plus the rule's model scope (`models`, `providers`, `class`, `family`); an unscoped rule's identity is its name alone.

Consequence: precedence and deduplication are name-based across sources. The highest-precedence source directory that defines a `name` owns it, and every same-named rule from any other directory is shadowed on every model. Within that directory, same-named files with different model scopes are distinct variants (for example `foo.md` and `foo.mdc` in one `rules/` directory), and the session keeps the first variant that admits its model (§5).

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
- `globs`, `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `question`, `scope`, `agents`, `models`, `providers`, `class`, `family`, and `interruptMode` are parsed by `buildRuleFromMarkdown`
- user sticky `RULES.md` is named `RULES`; project sticky `RULES.md` is named `RULES@project`; both are forced to `alwaysApply: true`

The distinct sticky names allow user and project content to coexist. Native items are appended as project rules, user rules, user sticky `RULES.md`, then project sticky `RULES.md`; an earlier regular rule with either sticky name can still shadow that sticky file.

Important caveat: `condition` values that look like file globs are converted into `tool:edit(...)` / `tool:write(...)` scope shorthands with catch-all condition `.*`.

### Agents provider (`agents.ts`)

Loads from both `.agent` and `.agents` directories:

- project: walk upward from `cwd` to repo root, loading `<ancestor>/.agent/rules/*.{md,mdc}` and `<ancestor>/.agents/rules/*.{md,mdc}`
- user: `~/.agent/rules/*.{md,mdc}` and `~/.agents/rules/*.{md,mdc}`

Normalization uses the shared `buildRuleFromMarkdown` path: filename-derived name, stripped frontmatter body, and parsed `globs`, `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `question`, `scope`, `agents`, `models`, `providers`, `class`, `family`, and `interruptMode`.

### Cursor provider (`cursor.ts`)

Loads from:

- user: `~/.cursor/rules/*.{mdc,md}`
- project: `<cwd>/.cursor/rules/*.{mdc,md}`

Normalization (`transformMDCRule`):

- `description`: kept only if string
- `alwaysApply`: normalized to a boolean — `true` only when frontmatter has `alwaysApply: true` (anything else becomes `false`)
- `globs`: accepts array (string elements only) or single string
- `condition`/legacy `ttsr_trigger`, `astCondition`, `question`, `scope`, `agents`, `models`, `providers`, `class`, `family`, and `interruptMode` are parsed by shared rule helpers
- `name` from filename without extension

### Windsurf provider (`windsurf.ts`)

Loads from:

- user: `~/.codeium/windsurf/memories/global_rules.md` (fixed rule name `global_rules`)
- project: `<cwd>/.windsurf/rules/*.md`

Normalization:

- `globs`: array-of-string or single string
- `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `question`, `scope`, `agents`, `models`, `providers`, `class`, `family`, and `interruptMode` parsed by shared rule helpers
- `name` is fixed to `global_rules` for the user global file and derived from filename for project rules

### Cline provider (`cline.ts`)

Searches upward from `cwd` for nearest `.clinerules`:

- if directory: loads `*.md` inside it
- if file: loads single file as rule named `clinerules`

Normalization:

- `globs`: array-of-string or single string
- `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `question`, `scope`, `agents`, `models`, `providers`, `class`, `family`, and `interruptMode` parsed by shared rule helpers
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

Because TTSR bucketing runs before always-apply/rulebook bucketing, a GitHub instruction carrying an accepted `condition`, `astCondition`, or `question` is still TTSR-only regardless of `applyTo`.

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

`loadCapability("rules")` (`capability/index.ts`) merges provider outputs and then deduplicates by `rule.name`, keeping same-named variants with different model scopes only from the first source directory.

### Precedence model

- Providers are ordered by priority descending.
- Equal priority keeps registration order (`cursor` before `windsurf` from `discovery/index.ts`).
- Dedup is first-wins: the first encountered rule name is kept; a later same-name item is marked `_shadowed` in `all` and excluded from `items` unless it comes from the same provider and directory with a different model scope.

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
3. Drop rules whose `agents` globs do not match the session's agent name (`main` for a top-level session, otherwise the agent definition name); rules without `agents` apply to every agent.
4. Drop rules whose model scope (`models`, `providers`, `class`, `family`) does not admit the model that receives the prompt; rules without these fields apply to every model. Of the same-named rules left, keep only the first (highest-precedence) one.
5. Register rules with a non-empty `condition`, `astCondition`, or `question` into `TtsrManager`; if registration succeeds, the rule is TTSR-only.
6. Put remaining `alwaysApply === true` rules into `alwaysApplyRules`.
7. Put remaining rules with `description` into `rulebookRules`.

### Bucket behavior

- **TTSR bucket**: any enabled rule with a non-empty parsed `condition` (regex), `astCondition` (ast-grep patterns), or `question` (judged) that `TtsrManager.addRule(...)` accepts. Takes priority over other buckets.
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

### `agents`

- Restricts a rule to matching agents. Accepts a YAML sequence, a single string, or a comma-separated string; patterns are lowercased glob patterns matched case-insensitively against the agent definition name (`scout`, `reviewer`, `foreman-*`). Whitespace around commas inside a `{a, b}` glob-brace group is tolerated and normalized away.
- The literal `main` matches the top-level session; a subagent with no definition name falls back to `sub`. Both `main` and `sub` are reserved: a custom agent definition cannot use either name (`parseAgentFields` rejects it), so neither sentinel can be shadowed by a real agent.
- Omitted (or an empty list) means the rule applies to every agent — the pre-existing behavior.
- Filtering happens in `bucketRules(...)` at session creation and session-scoped prompt rebuilds, before TTSR registration: an unmatched rule joins no bucket, is never compiled into `TtsrManager`, and is not addressable via `rule://` in that session.
- Subagents receive the parent's unfiltered discovered rule list and re-evaluate `agents` under their own name, so a scout-only rule loads in scouts and nowhere else.

   ```yaml
   agents: [scout, "foreman-*"]
   ```

   ```yaml
   # Main agent only; every subagent ignores this rule:
   agents: main
   ```

### `models`, `providers`, `class`, and `family`

- Restrict a rule to the models it applies to. Each field accepts a YAML sequence, a single string, or a comma-separated string, lowercased like `agents`. Patterns within one field are alternatives; every present field must match. An omitted field is no constraint.
- `models` uses the `enabledModels` glob grammar (without a `:level` suffix), matched case-insensitively against both `provider/id` and the bare id. `*` does not cross `/`, so `claude-*` misses a routed id such as `openrouter/anthropic/claude-sonnet-4.5`, while `**/claude-*` matches it and the direct `anthropic/claude-sonnet-4-5`. Because the bare id is matched too, `anthropic/*` also matches `openrouter/anthropic/...`; use `providers` to pin the host.
- `providers` matches `Model.provider` (`anthropic`, `openrouter`, ...).
- `class` and `family` match the catalog's model identity (`class: anthropic`, `family: opus`), which is the same for a model on every host and across revisions. A model the catalog cannot classify has class `unknown` and no family, so any `family` scope excludes it.
- The scope is evaluated against the model that receives the prompt: the session's model for the main agent, the subagent's own model for a subagent, and the advisor's model for an advisor (see [advisor-watchdog.md](advisor-watchdog.md)). Judged TTSR rules are scoped by the session model, whose output is judged, not by the judge model.
- Every model change re-scopes immediately: `/model`, `setModel`, and retry fallbacks replace the TTSR registrations and the `rule://` snapshot. The system prompt is rebuilt only when the always-apply or rulebook rules it renders change, so a retry fallback to a model with the same matched set keeps the prompt bytes and its prompt cache. A request already in flight keeps the prompt it was sent with.
- `omp ttsr list` and `omp ttsr scan` ignore model scope; `omp ttsr test --model <selector>` evaluates it for the resolved model. Without `--model`, model scope is ignored and same-named variants collapse to the highest-precedence one (TTSR registrations are keyed by name), so pass `--model` to test a specific variant.
- Precedence consequence: a scoped rule shadows every lower-precedence same-named rule on every model, not only on the models it admits. A project rule `X` with `family: opus` replaces a user or builtin `X` on Opus and leaves no `X` on any other model. To restrict an inherited rule to some models while keeping it elsewhere, add your own copy of it next to the scoped override, under the same name with a scope for the models that should keep it (for example `X.md` with `family: opus` and `X.mdc` with `family: sonnet` in one `rules/` directory). Same-named variants share one extension id (`rule:X`), so the extensions dashboard toggles them together.

   ```yaml
   # Opus on any host:
   family: opus
   ```

   ```yaml
   # Claude models served directly by Anthropic:
   class: anthropic
   providers: anthropic
   ```

   ```yaml
   models: ["**/claude-sonnet-*", "openai/gpt-5*"]
   ```

### `condition`, `astCondition`, `question`, `scope`, and `interruptMode`

- `condition` is the regex TTSR trigger field; legacy `ttsr_trigger` / `ttsrTrigger` are accepted as fallback inputs during parsing. A leading `(?i)`, `(?m)`, or `(?s)` inline flag group is translated to the equivalent JavaScript `RegExp` flags.
- `astCondition` is the ast-grep trigger field: a string or YAML sequence of structural patterns, kept verbatim (no glob inference). It matches finalized source snapshots from tools exposing `matcherEntries` or `matcherDigest` (built-in edit/write do), with language inferred from the file path. It does not run on partial streaming deltas. A rule may set `condition`, `astCondition`, or both.
- `question` makes the rule **judged**: a single natural-language yes/no question the `judge` model role answers about each completed in-scope output (reply, reasoning, or tool call). It never matches mid-stream and never interrupts; a yes delivers the rule as a warning (see `ttsr-injection-lifecycle.md` §10). When `condition`/`astCondition` are also set they only gate whether the question is asked, which keeps judge cost down. Runs per `ttsr.judge` (`auto` requires a native TypeSafe jev judge).

   ```yaml
   question: "Does the reply claim tests pass without showing they were run?"
   scope: text
   ```

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

`RuleProtocolHandler` prefers the caller's session-local rules supplied in the resolution context, falling back to the process-global active-rule snapshot. `sdk.ts` installs both snapshots at creation and refreshes them on every prompt build and every model change:

```ts
setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
```

Implications:

- `rule://<name>` resolves against **rulebookRules**, **alwaysApplyRules**, and **registered TTSR rules**.
- TTSR rules are bucketed out before rulebook/always, but `ttsrManager.getRules()` re-adds them to the snapshot so a triggered rule (e.g. a builtin) stays addressable for re-reading.
- Rules with no description, no `alwaysApply`, and no accepted TTSR condition are not addressable via `rule://`.
- Resolution is exact name match.
- Unknown names return error listing available rule names.
- Returned content is raw `rule.content` (frontmatter stripped), content type `text/markdown`.

### Rule refresh

Session-scoped prompt rebuilds re-discover rules for the current cwd, re-bucket them with live `ttsr.*` filters and the current model, and update prompt, URL-resolution, and subagent-inheritance snapshots. The subagent-inheritance snapshot stays unfiltered. A model change re-buckets the same snapshot without disk discovery. Explicitly supplied rule sets are re-bucketed without disk discovery. `/clear` and `/new` clear capability caches so edits are observed at those boundaries. TTSR registrations are replaced atomically; injection records are kept per variant and survive model changes, and a name loses its records only when it leaves discovery (see `ttsr-injection-lifecycle.md`). Rebuilding while TTSR is disabled preserves injection records for later re-enablement.

## 9. Known partial / non-enforced semantics

1. The rule providers currently loaded for `rules` are `native`, `omp-plugins`, `agents`, `cursor`, `windsurf`, `cline`, `github`, and embedded `builtin-defaults`; provider files for other tools may parse other config formats but do not register rule loaders.
2. `globs` metadata is surfaced to prompt/UI and is used as a global path gate for TTSR matching, but it is not used to automatically select rulebook rules for `rule://`.
3. Rule selection for `rule://` includes rulebook, always-apply, and registered TTSR rules (so a triggered TTSR rule can be re-read), but not rules that registered no condition and carry neither a description nor `alwaysApply`.
4. Discovery warnings (`loadCapability("rules").warnings`) are produced but `createAgentSession` does not currently surface/log them in this path.
