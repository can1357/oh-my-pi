# pi-builtins

Every builtin the embedded shell installs. Two layers:

1. **Shell builtins** — `cd`, `echo`, `test`, `printf`, `read`, `export`, `trap`,
   `wait`, … A locally-patched fork of
   [`brush-builtins`](https://github.com/reubeno/brush) (MIT), tracking upstream
   except where noted in `LICENSE`.
2. **In-process command-line utilities** — `cat`, `grep`/`rg`, `sed`, `ls`,
   `find`, `sort`, `jq`, `fd`, `diff`, `xargs`, `ps`, `top`, `kill`, the
   moreutils set, and ~50 more. One module per command, in `src/<command>.rs`.

The second layer exists so the shell never has to fork: a long-lived embedded
shell resolves these names itself, on every platform, whether or not the host
has the real binaries. They were previously ~50 separate vendored crates driven
through a thread-local I/O shim; consolidating them here removed the shim.

## The `Host` contract

`src/host.rs` is the whole story for a utility builtin. A utility is a `clap`
argument model plus a synchronous body:

```rust
pub(crate) trait Utility: clap::Parser + Send + Sync + 'static {
    const NAME: &'static str;
    const USAGE_ERROR: u8 = 1;
    fn run(self, host: &mut Host) -> i32;
}
```

`Host` is the shell as the utility sees it, threaded explicitly rather than
through process globals or thread locals: the command's own stdio (`host.stdout`,
`host.stderr`, `host.stdin`), the shell's working directory (`host.resolve(path)`
— mandatory for every path argument, since the host process's current directory
is unrelated), the exported environment (`host.var`, `host.env`), cancellation
(`host.is_cancelled`), a child-process launcher that inherits all of the above
(`host.child_env()`), and the accumulated exit status (`host.fail`,
`host.exit_code`).

`host::util::<U, SE>()` wraps a `Utility` into a registration that handles, once
for all of them: process-substitution arguments (`diff <(a) <(b)`),
`--help`/`--version` on stdout with status 0, usage errors on stderr, execution
on a blocking thread, the shell's cancellation token, and panic containment.

Utilities that are genuinely async — `sleep`, `timeout`, `ps`, `top`, `pgrep`,
`kill`, `nohup` — implement `brush_core::builtins::Command` directly instead.

## Registration

Three entry points, so the embedding shell decides what to install:

| Function | Contents |
| --- | --- |
| `default_builtins(set)` | The POSIX/bash builtins, per `BuiltinSet`. |
| `utility_builtins()` | The coreutils-style commands, which shadow system binaries. |
| `process_builtins()` | `ps`, `top`, `pgrep`, `pkill`, `pidwait`, `sleep`, `timeout`, `nohup`. |

Every command is behind a cargo feature (`builtin.<name>`, `util.<name>`), so a
single one can be built and tested in isolation:

```console
$ cargo nextest run -p pi-builtins --no-default-features --features base,util.sed
```

## Licensing

MIT throughout, but the ported utilities carry upstream notices — uutils
coreutils, uutils findutils, uutils sed, jaq, and rust-utf8. See `LICENSE`, which
reproduces each in full and lists which commands it covers.
