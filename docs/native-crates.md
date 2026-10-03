# Native Crates

Contributor map for Rust workspace members under `crates/`. They are implementation details behind `@oh-my-pi/pi-natives` and its embedded shell; package consumers use JavaScript entrypoints, not these crate APIs.

The root `Cargo.toml` lists every crate under `crates/` explicitly in `workspace.members` — add new crates there. Its `[patch.crates-io]` selects vendored `brush-core`, `brush-parser`, `cfg_aliases`, `napi`, and `tree-sitter-go`.

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-natives`    | [`crates/pi-natives`](../crates/pi-natives)       | Top-level N-API `cdylib`. It exposes the JS-visible API and depends on `pi-ast`, `pi-diff`, `pi-edit`, `pi-iso`, `pi-predict`, `pi-shell`, `pi-vcs`, `pi-vfs`, `pi-voice`, and `pi-walker`.                    |
| `pi-builtins`   | [`crates/pi-builtins`](../crates/pi-builtins)     | Every builtin the embedded shell installs: a patched fork of brush's POSIX/bash builtins, plus one module per in-process command-line utility (`cat`, `grep`/`rg`, `sed`, `ls`, `find`, `jq`, `fd`, `diff`, `ps`, `top`, `kill`, the moreutils set, …). `src/host.rs` holds the `Utility` trait and the `Host` view of the shell (stdio, working directory, exported environment, cancellation) that the utilities run against. Ports of uutils coreutils/findutils/sed and jaq live here too; see the crate `LICENSE` for third-party notices. |
| `pi-diff` | [`crates/pi-diff`](../crates/pi-diff) | N-API-free jsdiff-compatible Myers, line, word, and structured-patch primitives, consumed by native diff bindings and the edit engine. |
| `pi-edit` | [`crates/pi-edit`](../crates/pi-edit) | Edit-mode parsing, matching, staging, streaming previews, snapshots, and host-writer application; wrapped by native `EditSession` / `EditStore`. |
| `pi-predict` | [`crates/pi-predict`](../crates/pi-predict) | N-API-free ngram, SmolLM, and macOS spelling-backed word-completion engines, wrapped by `TextPredictor`. |
| `pi-vfs` | [`crates/pi-vfs`](../crates/pi-vfs) | Injectable async filesystem plus a blocking facade, native host fast paths, and URL-preserving lexical helpers shared by shell, builtins, and traversal. |
| `pi-shell`      | [`crates/pi-shell`](../crates/pi-shell)           | Persistent embedded brush shell, command execution/minimization, process plumbing, and in-process command integration used by `pi-natives`; traversal and injectable filesystem primitives live in `pi-walker` and `pi-vfs`. |
| `pi-voice`      | [`crates/pi-voice`](../crates/pi-voice)           | Cross-platform microphone/playback and Opus/WebRTC support used by the `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` bindings.                          |
| `pi-ast`        | [`crates/pi-ast`](../crates/pi-ast)               | tree-sitter/ast-grep language registry, matching/editing, block analysis, and summarization support across the workspace grammar set.                           |
| `pi-iso`        | [`crates/pi-iso`](../crates/pi-iso)               | Isolation backend implementations and diffing for APFS, btrfs, ZFS, Linux reflinks, overlayfs, Windows block clones, and ProjFS; fallback uses a Git worktree for Git repositories and recursive copy otherwise.                      |
| `pi-walker`     | [`crates/pi-walker`](../crates/pi-walker)         | Parallel filesystem walker using ignore rules and globsets, shared by native scans and shell commands. Reads go through `pi-vfs`; bulk syscalls require native-local paths and the shared cache requires no provider.                         |
| `pi-vcs`        | [`crates/pi-vcs`](../crates/pi-vcs)               | In-process version control: git on gitoxide (the git binary also handles credential-bound network transfers, reftable repos, and whole-worktree status/untracked walks) and Jujutsu on jj-lib; unified discovery and operations used by the `vcs*` native bindings. |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core), [`crates/vendor/brush-parser`](../crates/vendor/brush-parser) | Vendored shell engine and its tokenizer/parser, consumed by `pi-shell` and `pi-builtins`. Their manifests retain upstream package metadata; workspace patches select these local forks. |
| Build/runtime compatibility | [`crates/vendor/cfg_aliases`](../crates/vendor/cfg_aliases), [`crates/vendor/napi`](../crates/vendor/napi), [`crates/vendor/tree-sitter-go`](../crates/vendor/tree-sitter-go) | Workspace patches fix macro compatibility, N-API environment teardown, and Go grammar support respectively. |

`pi_builtins::default_builtins()`, `pi_builtins::utility_builtins()`, and `pi_builtins::process_builtins()` (defined in `src/factory.rs`) are the authoritative builtin sets; `pi-shell` decides which of them to register. A directory being a workspace member does not by itself mean that `pi-natives` exposes it as a JavaScript API.

## Boundary map

```text
@oh-my-pi/pi-natives JS entrypoints
  -> pi-natives (N-API conversion, platform bindings, task boundaries)
       -> pi-ast / pi-diff / pi-edit / pi-iso / pi-predict / pi-vcs / pi-voice
       -> pi-walker / pi-vfs
       -> pi-shell
            -> brush-core (parser, expansion, interpreter)
            -> pi-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
            -> pi-vfs / pi-walker (filesystem provider and traversal)
```

For the loader and JS boundary, see:

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

Subsystem details live in:

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

These crates remain contributor-facing implementation details. Promote one to standalone user-facing documentation only when it gains a public API or executable consumed independently of `@oh-my-pi/pi-natives`; see [`user-facing-packages.md`](./user-facing-packages.md).
