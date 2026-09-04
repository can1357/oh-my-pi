# omp-shell

`omp-shell` is the standalone Bash parser and execution engine used by omp. It provides the `Shell` and `ShellBuilder` API together with execution contexts, shell values, source locations, extension hooks, and structured execution results.

This crate was ported from [`brush-core` 0.5.0 and `brush-parser` 0.4.0](https://github.com/reubeno/brush), licensed under MIT.

## Structure

- `parser` parses shell input and tracks source positions and spans.
- `shell`, `interp`, and `commands` manage shell state, interpret syntax, and execute commands.
- `expansion`, `arithmetic`, `braceexpansion`, `patterns`, and `regex` implement shell expansion and matching behavior.
- `builtins`, `functions`, `keywords`, and `extensions` provide executable shell facilities and integration hooks.
- `env`, `variables`, `options`, `namedoptions`, and `wellknownvars` represent the shell environment and configuration.
- `jobs`, `processes`, `openfiles`, `traps`, and `sys` handle process lifecycle, file descriptors, signals, and platform-specific behavior.
- `error`, `results`, `sourceinfo`, `callstack`, and `trace_categories` carry diagnostics and execution metadata.

## Philosophy

Keep parsing, expansion, and execution as distinct layers while preserving shell state explicitly through the public API. Platform-sensitive behavior stays behind focused process, file, and system modules, and execution outcomes use structured result and control-flow types rather than ad hoc status handling. Changes should preserve the upstream licensing and source-attribution context above.
