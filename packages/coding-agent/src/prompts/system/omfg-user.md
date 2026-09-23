<omfg>
The user is frustrated about recurring agent behavior.
Author ONE Time Traveling Stream Rule (TTSR) that would have caught the offending behavior earlier in this conversation.

TTSR mechanics:
- A rule is a markdown file with YAML frontmatter. Its body is injected as correction guidance when the rule triggers.
- `scope` is a comma-separated allowlist of checked outputs:
  - `text` = assistant prose. `thinking` = reasoning summaries. `tool` = every tool call.
  - `tool:<name>(<glob>)` = one tool, only when its file path matches the glob, e.g. `tool:write(*.rb)`, `tool:edit(*.ts)`.
- edit/write calls are checked as the source text they write; other tool calls as JSON-serialized arguments.
- Three trigger kinds:
  - `condition`: JavaScript regex patterns, matched while output streams. A hit interrupts the stream.
  - `astCondition`: ast-grep patterns (`$X` = one node, `$$$ARGS` = many), matched against edit/write source; language comes from the file extension, so scope MUST be `tool:edit(<glob>)`/`tool:write(<glob>)` with an extension.
  - `question`: a natural-language yes/no question a small classifier answers after the output completes. Never interrupts: the offending output already took effect, and the body arrives later as a warning. Costs a classifier call per in-scope output.

Trigger choice:
- You MUST prefer `condition` or `astCondition`. They are exact, free, and interrupt before damage.
- Code structure (call shapes, nesting, argument patterns) → `astCondition`. Literal tokens or phrases → `condition`.
- Use `question` ONLY when no pattern can catch the behavior without false positives: semantic claims, tone, reasoning quality, intent (e.g. "claims tests pass without running them").
- `question` MUST be answerable from the output alone; yes MUST mean the rule is violated.
- With `question`, you SHOULD add a `condition` prefilter when the offending output always contains some literal cue: the question is then asked only when the cue appears.

Output contract:
- Emit exactly one JSON object and nothing else.
- JSON fields: `name`, `description`, `scope`, `body`, and at least one of `condition`, `astCondition`, `question`.
- `name` MUST be kebab-case.
- `description` MUST be a one-line summary.
- `condition` / `astCondition`: string or string array. `question`: one string.
- Triggers MUST catch the specific offending assistant output visible earlier in this conversation.
- Escape regex backslashes for JSON exactly once: use `"\\beval\\s*\\("`, NEVER `"\\\\beval\\\\s*\\\\("`.
- Keep triggers precise; NEVER use broad catch-alls.
- `scope` MUST be a string or string array, as narrow as the complaint allows. NEVER use `tool, text` unless the same bad behavior occurred in both tool calls and prose.
- Code complaints SHOULD use file-specific tool scopes: Ruby written through `write` → `tool:write(*.rb)`, not bare `tool` or `text`.
- `body` MUST be markdown guidance explaining the right behavior concisely.
- The caller assembles YAML frontmatter. NEVER emit markdown frontmatter or a fenced code block around the JSON.

Example shapes:
{
  "name": "ts-no-any",
  "description": "Never use `any` in TypeScript — use `unknown`, a generic, or the real type",
  "condition": ": any|as any",
  "scope": ["tool:edit(*.ts)", "tool:edit(*.tsx)", "tool:write(*.ts)", "tool:write(*.tsx)"],
  "body": "Never use `: any` or `as any`. Use `unknown`, a domain type, a generic, or a type guard."
}
{
  "name": "go-range-int",
  "description": "Use `for i := range n` instead of C-style counting loops",
  "astCondition": "for $I := 0; $I < $N; $I++ { $$$BODY }",
  "scope": ["tool:edit(*.go)", "tool:write(*.go)"],
  "body": "Write `for i := range n { … }` (Go 1.22+) instead of `for i := 0; i < n; i++`."
}
{
  "name": "no-unverified-test-claims",
  "description": "Never claim tests pass without having run them",
  "condition": "(?i)tests? (pass|are passing|succeed)",
  "question": "Does the reply claim tests pass without showing they were actually run in this conversation?",
  "scope": "text",
  "body": "Only report test results you observed. Run the tests, or say they were not run."
}

Complaint:
{{complaint}}

{{#if feedback}}
Failed attempts or requested amendments so far:
{{feedback}}

Latest candidate JSON:
{{previousRule}}

Regenerate one corrected rule. Fix the listed validation failures or user amendment. NEVER repeat failed scopes or triggers.
{{/if}}
</omfg>
