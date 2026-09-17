<critical>
- NEVER edit project files — read-and-verify discovery only.
- MUST run each proposed command once.
- Final: exactly one JSON object matching the schema below; no prose or code fences.
</critical>

# Checker Discovery

User requested `omp cleanse` detect and repair: **{{request}}**

Identify project command(s) surfacing exactly these diagnostics for orchestrator execution, output parsing, and repair-agent dispatch.

<workflow>
1. Inspect manifests, configs, lockfiles, and scripts for relevant tooling.
2. Determine exact command and working directory. Prefer project-local binaries (`node_modules/.bin`, `.venv/bin`, wrappers like `gradlew`) over global tools.
3. Prefer machine-readable output matching a known parser below. Otherwise use gcc-style `file:line:col: severity: message` output and parser `generic`.
4. Run once: verify execution and output matches the chosen parser. Non-zero exit with parseable diagnostics: fine; crash or usage error: not.
5. If multiple commands cover the request, return one entry per command.
</workflow>

## Known parsers

|id|expected output|
|---|---|
|`rust`|`cargo … --message-format=json`|
|`rust-test`|`cargo test … --message-format=json`|
|`go`|`go vet -json`|
|`go-test`|`go test -json`|
|`staticcheck`|`staticcheck -f json`|
|`golangci`|golangci-lint default text output|
|`ruff`|`ruff check --output-format=json`|
|`pyright`|`pyright`/`basedpyright` `--outputjson`|
|`mypy`|mypy default text output|
|`pylint`|`pylint --output-format=json`|
|`flake8`|flake8 default text output|
|`ty`|`ty check --output-format concise`|
|`eslint`|`eslint --format=json`|
|`biome`|`biome check --reporter=json`|
|`oxlint`|unix-format lines `file:line:col: message [Error/rule]` (`--format=unix`)|
|`deno-lint`|`deno lint --json`|
|`stylelint`|`stylelint --formatter json`|
|`rubocop`|`rubocop --format json`|
|`phpstan`|`phpstan analyse --error-format=json`|
|`psalm`|`psalm --output-format=json`|
|`swiftlint`|`swiftlint lint --reporter json`|
|`dart`|`dart analyze --format machine`|
|`credo`|`mix credo --format=json`|
|`shellcheck`|`shellcheck --format=json1`|
|`hlint`|`hlint --json`|
|`terraform`|`terraform validate -json`|
|`tflint`|`tflint --format=json`|
|`actionlint`|actionlint with its JSON `-format` template|
|`generic`|gcc-style `file:line:col: severity: message` lines (tsc/tsgo `--pretty false`, mypy, clang, zig, MSVC-style)|

## Output schema

```json
{
	"checkers": [
		{
			"label": "tsc (packages/app)",
			"language": "TypeScript",
			"cwd": "packages/app",
			"command": ["tsc", "--noEmit", "--pretty", "false"],
			"parser": "generic"
		}
	]
}
```

- `command`: argv array; first element: binary name or project-relative path. NEVER shell-wrap.
- `cwd`: project-relative working directory; omit for project root.
- `parser`: known parser id; omit for `generic`.
- Return `"checkers": []` only if nothing in this project produces the requested diagnostics.
