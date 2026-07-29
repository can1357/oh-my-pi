# System Prompt Customization

How the coding-agent assembles the system prompt sent to the model, and what users can control via `SYSTEM.md`, `APPEND_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (default stable instruction template)
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` (internal custom-prompt template; not the normal CLI `SYSTEM.md` path)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (project/environment footer)

---

## 1) Inputs

Four user-controllable inputs feed prompt assembly. All four resolve a value as either a literal string or, if the argument looks like a file path, the contents of that file (`resolvePromptInput`).

| Input | Source | Effect |
|---|---|---|
| `--system-prompt <text-or-file>` | CLI flag | Replaces block 0: the default stable instructions. Highest precedence. |
| `SYSTEM.md` | `<cwd>/.ompk/SYSTEM.md`, then `~/.ompk/agent/SYSTEM.md` (and equivalent paths under `.claude`, `.codex`, `.gemini`) | Same effect as `--system-prompt`; used when the flag is absent. |
| `--append-system-prompt <text-or-file>` | CLI flag | Adds a prompt block. Without a custom system prompt it goes after all default blocks; with one it goes after the custom block and before the preserved project/environment footer. |
| `APPEND_SYSTEM.md` | Same discovery as `SYSTEM.md` | Same effect as `--append-system-prompt`; used when the flag is absent. |

Discovery for `SYSTEM.md` / `APPEND_SYSTEM.md` uses `findConfigFile` (`packages/coding-agent/src/config.ts`): the first existing file across the ordered bases (`.ompk`, `.claude`, `.codex`, `.gemini` — project-level at `<cwd>` first, then user-level at `~`) wins. **No ancestor walk-up.** Running `omp` from `<repo>/subdir` does not pick up `<repo>/.ompk/SYSTEM.md`; the file must live directly under the cwd's config base or in the user-level location. See [`docs/config-usage.md`](./config-usage.md) for the full discovery contract.

Precedence (highest first):

1. `--system-prompt`
2. project `SYSTEM.md`
3. user `SYSTEM.md`

For append, the same precedence applies between `--append-system-prompt`, project `APPEND_SYSTEM.md`, and user `APPEND_SYSTEM.md`.

---

## 2) Replace vs. append

Normal CLI startup builds the default provider-facing prompt blocks first, then applies CLI / discovered file overrides in `packages/coding-agent/src/main.ts`:

```ts
if (resolvedSystemPrompt && resolvedAppendPrompt) {
  options.systemPrompt = defaultPrompt => [resolvedSystemPrompt, resolvedAppendPrompt, ...defaultPrompt.slice(1)];
} else if (resolvedSystemPrompt) {
  options.systemPrompt = defaultPrompt => [resolvedSystemPrompt, ...defaultPrompt.slice(1)];
} else if (resolvedAppendPrompt) {
  options.systemPrompt = defaultPrompt => [...defaultPrompt, resolvedAppendPrompt];
}
```

The default blocks come from `buildSystemPrompt`:

- block 0: `system-prompt.md` — the stable default instructions (staff-engineer preamble, tool inventory, exploration rules, workflow rules, etc.);
- block 1, when non-empty: `project-prompt.md` — dynamic project/environment context (workstation info, context files, dir-context list, workspace tree, current date/cwd, and other project footer content).

Consequences for normal CLI use:

- Providing `--system-prompt` or `SYSTEM.md` replaces only block 0. The stable default instructions are removed, but the dynamic project/environment footer from `project-prompt.md` remains as `defaultPrompt.slice(1)`.
- Providing `--append-system-prompt` or `APPEND_SYSTEM.md` without a custom system prompt appends a new block after all default blocks.
- Providing both a custom system prompt and an append prompt produces: custom system prompt block, append prompt block, then the preserved dynamic project/environment footer.

If you want to keep both default blocks and add to them, use `--append-system-prompt` / `APPEND_SYSTEM.md` without `--system-prompt` / `SYSTEM.md`. If you want to replace the stable default instructions while keeping the dynamic footer, use `--system-prompt` / `SYSTEM.md`.

---

## 3) Templating contract

**Contents of `SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are treated as plain text.** They are resolved before prompt-block replacement and are not rendered as Handlebars templates.

The built-in prompt templates are Handlebars (`packages/utils/src/prompt.ts`), but user-provided strings are not compiled with that renderer. The secondary capability path can insert `systemPromptCustomization` into a Handlebars parent template, but a `{{value}}` reference in Handlebars still does not recursively render its substituted contents — the value is emitted as a string. Concretely:
```handlebars
{{! parent template — handled by Handlebars }}
{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
```

If `SYSTEM.md` contains:

```handlebars
Working in {{cwd}} on {{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

the rendered output contains those characters verbatim — `{{cwd}}`, `{{#if hasMemoryRoot}}`, etc. are NOT substituted. They will be shown to the model as literal Handlebars syntax.

This is by design. The internal template variables (`cwd`, `date`, `environment`, `workspaceTree`, `skills`, `rules`, `toolRefs`, `hasMemoryRoot`, `hasObsidian`, `mcpDiscoveryServerSummaries`, ...) are not a supported public surface — they change between releases as the prompt is rewritten, and they would couple user configs to internals. Treat them as private.

If a future release exposes a templating surface for `SYSTEM.md`, it will be opt-in (e.g. via a settings flag or a different filename) and documented here.

---

## 4) Recommended patterns

### "Tweak the default" — keep default, add a few rules

Use `APPEND_SYSTEM.md` (or `--append-system-prompt`) without `SYSTEM.md`. The default stable instructions and the dynamic project/environment footer stay intact; your text is appended as an additional block.

```text
# ~/.ompk/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### "Replace the stable default instructions" — bring your own base prompt

Use `SYSTEM.md` (or `--system-prompt`). You replace the stable default instructions in block 0, but normal CLI startup still preserves the dynamic project/environment footer block (`project-prompt.md`): workstation info, context files, dir-context list, workspace tree, current date, cwd, and related project context.

```text
# ~/.ompk/agent/SYSTEM.md
You are a code reviewer. Read diffs, surface issues, never edit files.
- Cite paths with backticks.
- Prefer concrete fixes over abstract advice.
```

If you do this and want default tool guidance, exploration rules, or workflow rules, copy what you need from `packages/coding-agent/src/prompts/system/system-prompt.md` and maintain it yourself — there is currently no way to inherit selected sections from that stable default instruction block.

### "Customize while keeping generated skills/rules/tool guidance"

Use `APPEND_SYSTEM.md`, not `SYSTEM.md`. Skills, rulebook summaries, always-apply rules, the tool inventory, and the built-in guidance that tells the model when to read `skill://<name>` are part of block 0 (`system-prompt.md`). Because `SYSTEM.md` replaces block 0, those generated lists are not available to the model in a custom system prompt.

The dynamic project/environment footer that remains after `SYSTEM.md` is only block 1 (`project-prompt.md`): workstation info, AGENTS.md context files, dir-context list, workspace tree, current date, cwd, and related project context. It does not include discovered skills.

There is currently no supported CLI mode for "replace the stable default instructions but keep the generated skills/rules/tool guidance." If you need automatic skills loading, keep the default block and add your customization via `APPEND_SYSTEM.md`. If you fully replace with `SYSTEM.md`, you must hard-code any skill names/instructions you want the model to know about, and those will not track discovery automatically.

### "Customize automatic session titles"

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect the model call that names a new session. Create the title-specific prompt file instead:

```text
# ~/.ompk/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message carries no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` is discovered with the same project-then-user config-directory pattern as `SYSTEM.md` / `APPEND_SYSTEM.md`. When absent, OMP uses the bundled `title-system.md` / `tiny-title-system.md` prompts. When present, the online title path still forces the `set_title` tool call, and the local tiny-model path keeps the `<title>...</title>` wrapper while using this file as the system turn.

### "Replace everything, including project context" — SDK-only

The normal CLI file/flag path intentionally preserves `defaultPrompt.slice(1)`. Code using `CreateAgentSessionOptions.systemPrompt` directly can return a full replacement array and omit the project footer, but that is not what `.ompk/SYSTEM.md`, `~/.ompk/agent/SYSTEM.md`, or `--system-prompt` do.

### "Replace, but keep one section of the default instructions" — not directly supported

There is no built-in way to inherit specific sections from `system-prompt.md` while replacing the rest. The supported CLI modes are: append to the default prompt, or replace block 0 and keep the dynamic footer.

---

## 5) Deduplication

The CLI path avoids double-injecting discovered `SYSTEM.md` by replacing block 0 after the default prompt blocks are rendered. Any `systemPromptCustomization` from the secondary capability path would have been rendered into block 0, and that block is discarded when `main.ts` applies `[resolvedSystemPrompt, ...defaultPrompt.slice(1)]`.

Inside `buildSystemPrompt` itself, secondary customization and always-apply rules are still deduplicated:

- `dedupePromptSource` drops a `systemPromptCustomization` block when it already appears in an internally supplied `customPrompt` or append prompt.
- `dedupeAlwaysApplyRules` omits always-apply rules whose body appears verbatim in any of `{customPrompt, appendPrompt, systemPromptCustomization}`.

---

## 6) Discovery paths

Only one path actually drives the customization a CLI user sees: the primary CLI path. The capability layer exists but its `SYSTEM.md` output never reaches the rendered prompt under normal CLI startup.

- The primary CLI path (`discoverSystemPromptFile` / `discoverAppendSystemPromptFile` in `main.ts`, which feeds `resolvedSystemPrompt` / `resolvedAppendPrompt`) calls `findConfigFile`. `findConfigFile` checks only `<cwd>/.ompk`, `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.gemini`, and the user-level equivalents — it does **not** walk up ancestors. Files in `<ancestor>/.ompk/SYSTEM.md` are ignored when `omp` is started from a subdirectory.
- The secondary capability path (`loadSystemPromptFiles` → builtin discovery) does walk up via `findNearestProjectConfigDir` and requires the project `.ompk/` directory to be non-empty. Its result is rendered into the template variable `systemPromptCustomization`. Under normal CLI startup the default template (`system-prompt.md`) never references that variable, so ancestor-walk capability content has no user-visible effect.

Net effect for CLI users: put `SYSTEM.md` / `APPEND_SYSTEM.md` directly under `<cwd>/.ompk` (or another supported config base under cwd) or in the user-level location (`~/.ompk/agent/SYSTEM.md` etc.). Ancestor paths are not searched.

---

## 7) Quick reference

| Goal | Use |
|---|---|
| Add an instruction on top of the full default prompt | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Replace the stable default instructions but keep project/environment context | `SYSTEM.md` or `--system-prompt` |
| Preserve generated skills/rules/tool guidance while customizing | `APPEND_SYSTEM.md`; `SYSTEM.md` replaces that generated block |
| Customize automatic session titles | `TITLE_SYSTEM.md`; chat-turn `SYSTEM.md` / `APPEND_SYSTEM.md` do not affect title generation |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Files are inserted verbatim. |
| Inherit specific sections from `system-prompt.md` | Not supported; use append, or copy what you need into `SYSTEM.md`. |
| Override at a per-repo level | Project `.ompk/SYSTEM.md` under the cwd you launch `omp` from |
| Override globally | `~/.ompk/agent/SYSTEM.md` or `~/.ompk/agent/APPEND_SYSTEM.md` |
