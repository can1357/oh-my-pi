---
title: Cleanse
description: Detect project diagnostics with configured checkers and fix them with bounded parallel repair subagents.
coverage: B
---

`omp cleanse` detects project diagnostics with the language checkers it finds configured (or installed) in your repository, then dispatches a bounded batch of parallel subagents to fix them and re-runs the checkers to verify. It is a one-shot repair pass: after a refactor or before a review, it turns "run the linters" into "fix what they found".

## Usage

```bash
omp cleanse
omp cleanse -n 4 -m opus
omp cleanse -t
```

Flags:

| Flag | Description |
| --- | --- |
| `-n, --agents <n>` | Maximum number of file-disjoint subagents (default: 8) |
| `-m, --model <model>` | Subagent model selector (default: `@smol`) |
| `-t, --tests` | Also run configured project test suites |

`--agents` must be a positive integer.

## What happens

1. **Detect.** `omp cleanse` discovers the checkers that apply to your project's languages and runs the ones whose executables are available. Checkers whose executables are missing are listed as skipped, not installed. Test suites (`cargo test`, `pytest`, and so on) only run with `-t`.
2. **Dispatch.** Every diagnostic is attached to its file, and the files are grouped into weighted, file-disjoint assignments — no two subagents ever edit the same file. Up to `--agents` subagents run in parallel, one per assignment.
3. **Verify.** After the repair wave, the checkers run again. The command reports how many diagnostics remain.

Each subagent gets the resolved model (`@smol` by default) and its own session file, printed at launch.

## Outcomes

| Status | Exit code | Meaning |
| --- | --- | --- |
| `clean` | 0 | No diagnostics were found, or all detected diagnostics were resolved by the repair wave. |
| `unresolved` | 1 | Diagnostics remain after the repair wave; the remaining ones are printed. |
| `unsupported` | 1 | No supported checker with an available executable was found. |
| `cancelled` | 130 | The run was interrupted (SIGINT/SIGTERM). |

## Supported checkers

Discovery is per language; a checker only runs when its executable exists in the project or on `PATH`:

| Language | Checkers |
| --- | --- |
| Rust | `cargo clippy`, `cargo test` |
| Go | `go vet`, `go test` |
| Python | `ruff`, `pytest`, `pyright` |
| JavaScript/TypeScript | `biome check`, `eslint`, `tsgo`/`tsc --noEmit`, package-manager `test` |
| Ruby | `rubocop`, `rspec` |
| PHP | PHPStan, Psalm, PHPUnit |
| Swift | SwiftLint, `swift test` |
| Dart | `dart analyze`, `dart test` |
| Elixir | Credo, `mix test` |
| Shell | ShellCheck |
| Haskell | HLint, `stack test` / `cabal test` |
| Terraform | TFLint, `terraform validate` |
| Lua | Luacheck, Busted |
| C/C++ | `clang-tidy` |
| .NET | `dotnet build`, `dotnet test` |
| Zig | `zig build`, `zig build test` |
| JVM | Gradle check, Maven verify (test suites included) |

## When to use it

Run `omp cleanse` after a large refactor to clear out diagnostics across the whole repository at once, or before a code review so reviewers see the diff rather than the lint backlog. Because each subagent owns disjoint files, the parallel repairs cannot conflict with each other; anything left over is reported as `unresolved` for a follow-up pass.

## See also

- [Subagents](/oh-my-pi/features/subagents/) — the parallel worker sessions cleanse dispatches
- [CLI Reference](/oh-my-pi/reference/cli/) — `omp cleanse` flag reference
