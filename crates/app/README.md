# omp-app

`omp-app` is OMP's production command-line and presentation boundary. It ships
the `omp` binary and adapts the headless `omp-driver` composition to
interactive TUI chat, print, RPC, ACP, gateway, authentication, setup, and
other user-facing commands.

It does not own the project-environment daemon, Python extension host, or
Python eval runtime. Those implementations live in `omp-envd`; environment
client APIs live in `omp-env`.

## Structure

- `main` owns process bootstrap, panic and exit handling, telemetry lifetime,
  and delegation to `omp_app::run`.
- Before ordinary CLI startup, `main` recognizes the hidden `__omp-eval-child`
  and `__omp-ext-host` arguments and delegates them to `omp-envd` entry
  points. The former is a disposable eval process; the latter is the sole
  Python extension-host role and communicates over CONTROL. This is a
  same-binary process adapter, not host ownership. The parent never boots
  CPython as a preflight.
- `cli` defines and dispatches the public command tree and lowers parsed
  options into driver or command-adapter inputs.
- `chat_cmd` owns the controller task and feeds detached session snapshots and
  patches to `omp-chat` for terminal or native-GUI presentation. `print_mode`,
  `rpc_mode`, and `acp_mode` expose pure text and protocol actors over the same
  journal-first composition.
- `auth_*`, `models_cmd`, `setup_cmd`, and the other `*_cmd` modules implement
  user-facing command policy and diagnostics.
- `daemon` and `gateway_rpc` adapt the production inference gateway. They are
  separate from the project-environment host in `omp-envd`.

## Philosophy

App parses, presents, and reports; driver composes. Reusable agent sessions,
execution modes, discovery, convar projections, registries, and environment bridges
belong in `omp-driver`. Filesystem/process/document/tool authorities,
extension-host internals, eval children, and named-worker placement belong in
`omp-envd`. App may retain the lifetimes returned by those layers and dispatch
their process entry points, but it must not build competing implementations.

Provider traffic uses the shared inference and egress stack, authentication
delegates to the broker, local generation uses the local inference facade,
and serving delegates to the gateway assembly. Commands reject incomplete
configurations rather than simulating success.

## Development

Run `just setup-python` once before commands that link embedded Python. Use
`just check-pkg omp-app` and `just test-pkg omp-app`. Exercise the command
surface with `just run -- <args>`; use `just e2e` or an exact narrower E2E
recipe from `just --list` for joined behavior.

The default `omp` build keeps optional native engines off the critical path.
Use `--features local-all` for all local model backends and `--features gui`
for the native GPU presentation host.
