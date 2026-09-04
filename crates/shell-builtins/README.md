# omp-shell-builtins

`omp-shell-builtins` provides in-process command-line utilities and process-management commands for the OMP shell. It exposes separate registration lists for general utilities such as `cat`, `grep`, `sed`, `ls`, and checksum tools, and for process-oriented commands such as `pgrep`, `pkill`, `pidwait`, `ps`, `top`, `sleep`, `timeout`, and `nohup`. Its `omp-sh` binary is the batteries-included composition of these registries with `omp-shell`.

## Structure

- `factory` assembles the `utility_builtins` and `process_builtins` registration lists consumed by the shell engine.
- `host` adapts shell streams, working directory, exported environment, cancellation, argument parsing, and exit status to synchronous utility implementations.
- `proc_match` and `proc_snapshot` provide shared process discovery and matching support; `ProcInfo` and `ProcessStatus` are part of the crate's public API.
- Command modules implement individual filesystem, text-processing, checksum, system-information, and process-control builtins. `cksum` contains shared checksum machinery used by the digest commands.

## Philosophy

Builtins run inside the shell so pipelines, redirections, the shell working directory, exported variables, and cancellation remain scoped to each command rather than relying on process-global state. General utilities and process-control commands stay independently selectable because embedders may choose different registration policies, including withholding destructive utilities.

The implementations were ported from `pi-builtins`, with individual commands also retaining attribution to sources such as uutils, findutils, and earlier `pi-shell` implementations. Keep ported code close enough to its upstream source to make maintenance practical, and preserve the source-level copyright, license, and attribution notices when updating it.
