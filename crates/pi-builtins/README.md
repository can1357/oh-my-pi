# pi-builtins

pi's extras for the embedded shell, whose engine implements the bash builtins
itself:

1. **In-process command-line utilities** — `cat`, `grep`/`rg`, `ast-grep`/`sg`,
   `sed`, `ls`, `find`, `sort`, `jq`, `fd`, `diff`, `xargs`, the moreutils set,
   and ~50 more. One module per command, in `src/<command>.rs`.
2. **Process builtins** — `ps`, `top`, `sleep`, `pgrep`, `pkill`, `pidwait`,
   `lsof`.

They exist so the shell never has to fork: a long-lived embedded
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
    const RUNS_COMMANDS: bool = false;
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

Utilities that run command lines (`env`, `xargs`, `find -exec`, `ifne`) set
`RUNS_COMMANDS` and call `host.run_command(ShellCommand::new(argv))`; the host
serves those through the `CommandRunner` it put in the invocation, so builtins,
and the `scheme://` paths only builtins can open, work as they do at the prompt.
`host.child_env()` is for helper programs that are always external
(`sort --compress-program`).

The adapter (`run_utility`/`run_async_utility`) handles, once for all of them:
descriptor paths (`diff <(a) <(b)`), `--help`/`--version` on stdout with status
0, usage errors on stderr, execution on a blocking thread, cancellation,
emulated SIGPIPE, and panic containment. The process builtins (`ps`, `top`,
`sleep`, `pgrep`, `pkill`, `pidwait`, `lsof`) are async bodies over a
`ProcContext`.

## Running extras

A host fills an `extras::Invocation` (argv, environment, working directory,
descriptors as `extras::Fd`, filesystem, cancellation, command runner) and awaits
`extras::run`, which returns the exit status. `extras::extras()` lists every
compiled extra with its `ExtraKind`.

Every command is behind a cargo feature (`util.<name>`), so a single one can be
built and tested in isolation:

```console
$ cargo nextest run -p pi-builtins --no-default-features --features util.sed
```

## Licensing

MIT throughout, but the ported utilities carry upstream notices — uutils
coreutils, uutils findutils, uutils sed, jaq, sd, rust-utf8, GoAWK, and libproc-rs. See `LICENSE`, which
reproduces each in full and lists which commands it covers.
