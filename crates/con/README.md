# omp-con

`omp-con` is omp's typed command-stream control plane. Variables, commands,
actions, cfg profiles, aliases, key bindings, session replay, and replicated
administration all use one parser and one registry.

## Structural philosophy

- Variables are declared once with `var!`; their type, default, validation,
  completion, and policy flags stay together.
- Effective values are derived from ordered layers: defaults, archived
  `config.cfg` values, journal-backed session writes, then engagement binds
  from outermost to innermost.
- `SESSION` writes are projected into `<meta><con><var name value origin>` by
  `omp-session`. Replaying or rewinding the journal therefore reconstructs
  control state without a second settings database.
- Every declared value is copied from the parent's effective view at spawn, then
  `subagent.cfg` and `<agent>.cfg` execute in that order; inheritance is not a flag.
- `REPLICATED` values are authority-owned and locally immutable on replicas.
- Persistence is a replayable command script, not a parallel serialization
  format. `dumpcfg` (`Ctx::dump`) includes only `ARCHIVE` diffs plus aliases and binds.

The built-in names use subsystem prefixes (`ai_*`, `cl_*`, `sv_*`), including
`sv_cheats`, `ai_model`, `ai_fastmode`, and `cl_resize_policy`.

## Layout

| Module | Responsibility |
| --- | --- |
| `value` | Typed values, durations, enums, lists, and kv blocks |
| `spec` | Variable/command/action declarations and flags |
| `ctx` | Registry, command execution, cfg loading, binds, and aliases |
| `layers` | Archive/session/engagement precedence and child seeds |
| `script` | Quotes, comments, separators, lists, and kv parsing |
| `dump` | Deterministic diff-from-default command script |
| `repl` | Authority-to-replica patches |
| `complete` | Names, enum values, and custom providers |
| `builtins` | Core commands and starter convars |
| `macros` | `var!`, `cmd!`, and `action!` declarations |
