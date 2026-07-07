<instruction>
- Use when syntax shape matters more than text
- Narrow each call to one language
- `pat` is ONE AST pattern; separate calls for unrelated patterns
- `$NAME`/`$$$NAME` capture one / zero-or-more nodes (bound); `$_`/`$$$` do the same without binding. Use `$$$NAME` (NOT `$$NAME` — invalid).
- Metavariable names are UPPERCASE and MUST be the whole AST node (partial text like `prefix$VAR` does NOT work).
- Same metavariable twice → both occurrences MUST match identical code (`$A == $A`, not `$A != $B`).
- Patterns MUST parse as a single valid AST node. Non-standalone snippets → wrap in context, e.g. `class $_ { … }`
- C++ expression-statement calls need trailing `;`: `ns::doThing($ARG);`, `$CALLEE($ARG);`
- TS declarations/methods — tolerate unknown annotations: `async function $NAME($$$ARGS): $_ { $$$BODY }` or `class $_ { method($ARG: $_): $_ { $$$BODY } }`
- Declaration forms are distinct shapes — `function foo`, method `foo()`, `const foo = () => {}`; search each form before concluding absence
- Loosest existence check: `pat: "executeBash"` (narrow `paths`)
</instruction>

<output>
- Matches prefixed by snapshot tag `[src/foo.ts#1A2B]`; `*42:` matched, ` 43:` context.
</output>

<critical>
- AVOID repo-root scans — narrow `paths` first
- Parse issues = query failure, not absence: fix the pattern or tighten `paths` before concluding "no matches"
- Broad cross-subsystem exploration: you SHOULD use the Task tool + explore subagent first
</critical>
