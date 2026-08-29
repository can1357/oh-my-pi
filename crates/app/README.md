# omp-app

`omp-app` is OMP's production command-line and presentation boundary. It ships
the `omp` binary and adapts the headless `omp-driver` composition to
interactive TUI chat, print, RPC, ACP, gateway, authentication, setup, and
other user-facing commands.

It does not own the project-environment daemon, Python extension host, or
Python worker runtime. Those implementations live in `omp-envd`; environment
client APIs live in `omp-env`.

## Structure

- `main` owns process bootstrap, panic and exit handling, telemetry lifetime,
  and delegation to `omp_app::run`.
- Before ordinary CLI startup, `main` recognizes hidden eval,
  extension-host, and Python-worker child arguments and delegates them to
  `omp-envd` entry points. This is a same-binary process adapter, not host
  ownership.
- `cli` defines and dispatches the public command tree and lowers parsed
  options into driver or command-adapter inputs.
- `chat_cmd` and `chat_ui` adapt durable driver session behavior to the
  interactive terminal surface. `print_mode`, `rpc_mode`, and `acp_mode`
  expose non-interactive and protocol-specific presentation adapters over the
  headless composition.
- `auth_*`, `models_cmd`, `setup_cmd`, and the other `*_cmd` modules implement
  user-facing command policy and diagnostics.
- `daemon` and `gateway_rpc` adapt the production inference gateway. They are
  separate from the project-environment host in `omp-envd`.

## Philosophy

App parses, presents, and reports; driver composes. Reusable agent sessions,
execution modes, discovery, settings, registries, and environment bridges
belong in `omp-driver`. Filesystem/process/document/tool authorities and
extension-host/worker internals belong in `omp-envd`. App may retain the
lifetimes returned by those layers and dispatch their process entry points,
but it must not build competing implementations.

Provider traffic uses the shared inference and egress stack, authentication
delegates to the broker, local generation uses the local inference facade,
and serving delegates to the gateway assembly. Commands reject incomplete
configurations rather than simulating success.

## Development

Run `just setup-python` once before commands that link embedded Python. Use
`just check-pkg omp-app` and `just test-pkg omp-app`. Exercise the command
surface with `just run -- <args>`; use `just e2e` or an exact narrower E2E
recipe from `just --list` for joined behavior.

Native Termux/aarch64 builds use `just build-android`. The recipe prepares an
Android PyO3 configuration from Termux's CPython 3.14 and builds the terminal
profile without local ML, native audio, or the GPU GUI. Its binary is
`target/aarch64-linux-android/debug/omp`.

The default `omp` build keeps optional native engines off the critical path.
Use `--features local-all` for all local model backends and `--features gui`
for the native GPU presentation host.
