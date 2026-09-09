# omp-sandbox

`omp-sandbox` compiles backend-independent capability specifications into inspectable confinement plans. Supported backends are Seatbelt, Bubblewrap, Linux Landlock with seccomp, gVisor, Docker, Docker with runsc, and Windows AppContainer.

Compilation is pure and secret-free. Preparation resolves filtered environments, private files, filesystem views, and cleanup ownership. Callers may retain `PreparedSandbox` beside a normal child command or use `Runner::run`; `Runner::native_command` selects Seatbelt on macOS and prefers Bubblewrap over the Landlock fallback on Linux for inherited descriptors and caller `pre_exec` hooks. Linux embedders dispatch the documented `HIDDEN_CHILD_ARG` role before untrusted work so owned policy artifacts can be installed before `execve`.

Strict specifications fail when the selected backend cannot enforce every requested capability. Caveated plans expose limitations structurally, and `Plan::enforced` is authoritative.
