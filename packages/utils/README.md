# @oh-my-pi/pi-utils

Shared utilities for [omp](https://github.com/can1357/oh-my-pi) packages. Zero ceremony, Bun-first.

## Notable modules

| Module                                                                                                             | Purpose                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `logger`                                                                                                           | Centralized logger writing to `~/.omp/logs/` (`bun test`: temp dir), rotating, never stdout  |
| `prompt`                                                                                                           | Handlebars-based prompt templating and formatting helpers                                    |
| `dirs`                                                                                                             | Path helpers for omp config directories (`~/.omp`, XDG-aware on Linux)                       |
| `stream`                                                                                                           | `readStream` / `readLines` helpers over `ReadableStream`                                     |
| `ptree` / `procmgr`                                                                                                | Process trees, `ChildProcess` wrapper, process lifecycle management                          |
| `postmortem`                                                                                                       | Cleanup callbacks on exit, signals, and fatal exceptions                                     |
| `which`                                                                                                            | `$which()` binary lookup with caching                                                        |
| `fetch-retry`                                                                                                      | `fetch` with retry/backoff policies                                                          |
| `fs-error`                                                                                                         | Errno guards (`isEnoent` and friends)                                                        |
| `env` / `worker-host`                                                                                              | Environment plumbing and side-effect-free worker-host entry contract (`workerHostEntry`)     |
| `abortable` / `async`                                                                                              | AbortSignal-aware stream/promise helpers                                                     |
| `math-delimiters`                                                                                                  | LaTeX span/block delimiter grammar (offsets only) shared by the TUI and collab-web renderers |
| `peek-file`                                                                                                        | Read the first N bytes of a file with pooled buffers                                         |
| `frontmatter`, `glob`, `mime`, `temp`, `format`, `color`, `snowflake`, `tab-spacing`, `path-tree`, `sanitize-text` | Smaller single-purpose helpers                                                               |

Import from the root barrel or per-module subpaths (`@oh-my-pi/pi-utils/<module>`).

### Pure translation core

Import `createTranslator` from `@oh-my-pi/pi-utils/i18n-core` and pass an object
mapping English source messages to translated strings. The module performs no
I/O, reads no environment variables, and installs no global translator.

Missing entries fall back to English. A `\u0004` suffix distinguishes semantic
contexts (for example, `"Open\u0004action.open-file"`); fallback output excludes
that suffix. Contexts should describe meaning, never file paths.

Numeric placeholders such as `{0}` may be reordered, repeated, or omitted.
Translation indexes must be safe integers from zero through the largest English
source index; this permits dense arguments when English omits a language-specific
value. Missing arguments remain literal placeholders, and argument text is never
interpreted as another template. Malformed packs throw during explicit creation,
so applications can handle errors before choosing a translator.

## Install

```sh
bun add @oh-my-pi/pi-utils
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.4.4.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
