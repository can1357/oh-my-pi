# Gap 19: a VM-backed macOS sandbox beside Seatbelt, and Windows CI

Status: research only. Nothing here is implemented or authorized.
Date: 2026-11-13, revised 2026-11-14 (design review rounds 1 and 2: the reopen triggers and the proposed thresholds now live in ADR 0070 D4 to D7; where this note's plan and ADR 0070 differ, the ADR wins)
Baseline: omp2 f4186b783b; upstream c308970263 (pinned checkout). The 2026-11-14 additions were read at omp2 `9cb6fd6389`.

Evidence keys:

- **OBSERVED** means read in code or docs at the baseline, run on this host, or fetched from a named URL on 2026-11-13. Code citations use `path:line`. Upstream paths carry the `upstream:` prefix.
- **[INFERENCE]** means the author's reasoning. Every size, cost or time estimate is an inference.
- **UNVERIFIED** means no run or source confirmed it.

No build, test or CI run was made. Nothing was installed. No VM was started.

## Question

Two questions, both research only:

1. Should omp2 add a VM-backed sandbox for macOS next to Seatbelt?
2. Should it run Windows in CI, and how?

Out of scope: the Linux backends (Bubblewrap, Landlock, gVisor), and the Windows AppContainer backend's own design.

## 1. Upstream

**VM sandbox: none found.** I searched `crates`, `docs` and `packages/coding-agent/src` of the pinned checkout for Seatbelt, `sandbox-exec`, Virtualization.framework, Tart, Lima, Firecracker, krunkit and Apple `container`. The hits were unrelated (`docs/user-facing-packages.md`, a name generator, a file-write fallback). Upstream's isolation crate, `pi-iso`, is filesystem isolation by copy-on-write: modules for APFS, Btrfs, ZFS, overlayfs, Linux reflink, Windows ProjFS and Windows block clone (`upstream:crates/pi-iso/src/apfs.rs`, `upstream:crates/pi-iso/src/overlayfs.rs`, `upstream:crates/pi-iso/src/projfs.rs`, `upstream:crates/pi-iso/src/windows_block_clone.rs`). That is not process confinement. The only VM advice is for the `computer` tool: use a dedicated account, and on a machine with nobody to ask, such as a dedicated VM, a setting answers the control request (`upstream:docs/computer-use.md:6`, `upstream:docs/computer-use.md:208`). The user brings the VM. Upstream has nothing to port for gap 19a.

**Windows CI: smoke tests of release binaries only.** Every release binary is cross-built on Linux. A later job downloads each one and runs `--version` and `--smoke-test` in a throwaway home on its own platform (`upstream:.github/workflows/ci.yml:863-868`). The matrix includes `windows-2025` for x64 and `windows-11-arm` for arm64, beside Linux glibc and musl and macOS on both architectures (`upstream:.github/workflows/ci.yml:887-889`). Upstream does not run its test suite on Windows in this workflow. The job runs only for a release (`upstream:.github/workflows/ci.yml:872-873`).

## 2. omp2 inventory

### The sandbox crate

- `omp-sandbox` compiles backend-independent capability specifications into confinement plans. Backends: Seatbelt, Bubblewrap, Linux Landlock with seccomp, gVisor, Docker, Docker with runsc, and Windows AppContainer (`crates/sandbox/README.md:3`). Strict specifications fail when the chosen backend cannot enforce every requested capability; caveated plans list their limits, and `Plan::enforced` is authoritative (`crates/sandbox/README.md:7`).
- `Backend` is a closed enum of those seven (`crates/sandbox/src/capability.rs:22-50`), with a fixed capability set per backend (`crates/sandbox/src/capability.rs:400-408`) and a fixed `Backend::all()` list (`crates/sandbox/src/capability.rs:413-423`).
- **Candidates on macOS are Seatbelt, then Docker with runsc, then Docker** (`crates/sandbox/src/runner.rs:1113-1116`). On Linux: gVisor, Bubblewrap, then the two Docker forms. On Windows: AppContainer only. The fallback on macOS is Seatbelt (`crates/sandbox/src/runner.rs:1128-1135`).
- Correction 2026-11-14: that candidate list applies to `Runner::run` admission only. `Runner::native_command()`, used by the environment daemon's exec sandbox and the extension-host spawn, is Seatbelt-only on macOS with `DegradationPolicy::Reject` and no Docker path (`crates/sandbox/src/runner.rs:1136-1142`, `crates/envd/src/exec_sandbox.rs:396`, `:1244`, `crates/envd/src/exthost/spawn.rs:571-573`).
- So a VM-backed fallback already exists in one form, for `Runner::run` admission. Docker Desktop and its relatives run containers inside a Linux VM. The Docker backend needs an image named in `OMP_SANDBOX_DOCKER_IMAGE` and fails as unavailable without one (`crates/sandbox/src/backends/docker.rs:24`, `crates/sandbox/src/backends/docker.rs:72-76`). It runs the command inside that image, with host paths only through declared bind mounts (`crates/sandbox/src/backends/docker.rs:207-208`). The command therefore runs on Linux, not macOS. That is a real limit for macOS-native tools. [INFERENCE: Docker Desktop on macOS runs Linux images, from general knowledge, not read here.]

### What Seatbelt does and does not do

- The launcher is `/usr/bin/sandbox-exec` (`crates/sandbox/src/backends/seatbelt.rs:21`). On this host (macOS 27.2.1) `man sandbox-exec` says: "sandbox-exec – execute within a sandbox (DEPRECATED)" and that developers should adopt App Sandbox instead. It is deprecated, not removed.
- The capability set has network, file read and write scopes, ephemeral writes, environment scrubbing and Mach restriction, but no IPC restriction, no `proc.noexec` and no CPU, memory or process limits (`crates/sandbox/src/capability.rs:320-332`). The Docker set has resource limits (`crates/sandbox/src/capability.rs:364-377`).
- The backend records its own limits as caveats. Write and read scopes are path based, so an allowed hardlink to the same inode can bypass them; ephemeral writes are an APFS clone of the working directory, not a whole-host overlay; disk use is not limited; network denial also blocks loopback; scoped egress reaches only a loopback broker (`crates/sandbox/src/backends/seatbelt.rs:325-398`).

### Where a VM fits in the architecture

- ADR 0006 puts policy on the trusted host and an obedient stub in the sandbox. "The same host MUST be able to point the stub at a local process, a container, a VM, or a remote machine"; today every target runs the full `omp-envd` binary, and a minimized stub is deferred (`docs/adr/0006-host-policy-sandbox-stub.md:44-47`, `docs/adr/0006-host-policy-sandbox-stub.md:150`). So in the accepted design a VM is an **environment target**, not a sandbox wrapper around one child command.
- There is an SSH execution backend for build and test commands that never shells out to `ssh` (`crates/exec-ssh/README.md:1-6`). A VM guest running an SSH server is reachable through it. Whether the agent's general tools (read, write, shell), as opposed to build and test runs, can target an SSH host through that path was not traced: UNVERIFIED.

### VM options, with their terms

Licences were read from the GitHub API on 2026-11-13.

| Option | What it is | Guests | Licence read | Notes |
|---|---|---|---|---|
| Apple Virtualization.framework | System framework | macOS and Linux (macOS guests on Apple silicon: UNVERIFIED) | system | Needs a signed host binary with a virtualization entitlement (UNVERIFIED). No licence to ship. |
| Tart (`cirruslabs/tart`) | CLI over Virtualization.framework | macOS and Linux | FSL-1.1-ALv2 (Functional Source License, converting to Apache-2.0), copyright 2022-2026 OpenAI per the file | "Competing Use" bars making the software available in a commercial product that substitutes for it or offers substantially similar functionality; internal use is permitted. Do not bundle; let the user install it. |
| Lima (`lima-vm/lima`) | Linux VMs on macOS | Linux (macOS guests: UNVERIFIED) | Apache-2.0 | Uses Virtualization.framework or QEMU. |
| Apple `container` (`apple/container`) | Linux containers as lightweight VMs | Linux only | Apache-2.0 | "Needs a Mac with Apple silicon" and "designed to run on macOS 26 or later" (its README). |
| Colima (`abiosoft/colima`) | Container runtime in a Lima VM | Linux | MIT | Docker-compatible; already usable through omp2's Docker backend. |
| UTM (`utmapp/UTM`) | GUI VM manager | many | Apache-2.0 | Not scriptable enough for a backend. |
| Vibemon (`stencil-hq/vibemon`) | Self-hosted microVM platform speaking the E2B API; KVM on Linux, HVF on macOS 15+ | Linux (x86_64 and aarch64 on KVM; aarch64 on HVF) | MIT, Apache-2.0 for E2B-derived parts (README, 2026-11-14) | Linux guests, so a Linux VM boundary like Docker Desktop, not macOS-native. Compat page says Linux/KVM end-to-end testing is "not yet run"; macOS egress filter admits only domains on TCP 80 and 443. No start-latency figure published. E2B documents pause at about 4 s per GiB of RAM and resume at about 1 s. The upstream reference adapter `vmon.ts` uses Vibemon SDK calls (OCI image boot, host gateway) not shown in the E2B pages (`upstream:packages/metaharness/src/tb/vmon.ts:201-224`, `:308-315`). URLs: <https://github.com/stencil-hq/vibemon>, <https://github.com/stencil-hq/vibemon/blob/main/docs/src/reference/e2b-compat.md>, <https://docs.e2b.dev/sandbox/persistence.md>. |

Tart's licence text, read from the repository's `LICENSE`: a "Competing Use" is "making the Software available to others in a commercial product or service that substitutes for the Software; ... or offers the same or substantially similar functionality", and permitted purposes "specifically include ... for your internal use and access".

### Windows today

- Windows code exists in 19 crates, found by searching for `target_os = "windows"` and `cfg(windows)`. The largest are `shell-builtins` (24 files), `envd` (23), `sandbox` (12), `app` (11), `shell` (9), `tui` (7), `driver`, `desktop` (4 each; the desktop crate has a `win32` backend, `crates/desktop/src/win32`). The sandbox crate has an AppContainer backend and its Windows runtime (`crates/sandbox/src/backends/appcontainer.rs`, `crates/sandbox/src/runtime/windows.rs`). The workspace depends on `windows-sys` (`Cargo.toml:325`).
- **There is no Windows CI job.** The workflows are `ci.yml`, `codeql.yml`, `p8-baseline.yml`, `package-macos.yml`, `pr-labels.yml` and `semantic-index-eval.yml`. Their runners are Ubuntu 24.04, macOS 15 and the self-hosted Mac variable; the word `windows` does not appear in any of them (searched `.github/workflows`). The recording workflow's matrix has one entry, `macos-arm64` (`.github/workflows/p8-baseline.yml:50-56`).
- **The embedded Python blocks a whole-workspace Windows build.** `omp-py` is a plain, ungated dependency of `omp-app` and `omp-envd` (`crates/app/Cargo.toml:103`, `crates/envd/Cargo.toml:67`). Its fetch script knows three hosts only: macOS arm64, Linux x86_64 and Linux aarch64; anything else exits with "no embedded Python archive configured" (`crates/py/scripts/fetch-python.sh:153-168`). Its link lists exist for ELF and Mach-O only (`crates/py/link/cpython.dynamic-list`, `crates/py/link/cpython.macho-list`). macOS on Intel is not supported either.
- Other Windows frictions: the `justfile` sets `bash` as its shell (`justfile:5`); the toolchain is a pinned nightly (`rust-toolchain.toml:2`) with the Cranelift component; and recipes assume Unix tools. [INFERENCE: windows-latest runners ship Git Bash, so `just` would run; recipes using Unix utilities may not.]
- Existing CI economics: the self-hosted Mac runs the one job that benefits from its persistent target directory, and everything else runs hosted; there is no probe for runner availability (`docs/research/ci-macos-runner-fallback.md:5-21`). Required checks are ten named jobs, and new jobs must not rename them (`docs/BRANCH_PROTECTION.md:42`, `docs/BRANCH_PROTECTION.md:84`). Variables like `vars.MACOS_RUNNER` and `vars.CI_LINUX_MODE` already switch runners without editing the workflow (`docs/research/ci-macos-runner-fallback.md:5`, `docs/research/ci-macos-runner-fallback.md:13`).

### Gap table

| Item | Upstream | omp2 | Gap |
|---|---|---|---|
| Process sandbox on macOS | none | Seatbelt, Docker runsc, Docker | VM-backed macOS guest would be new |
| Linux-VM fallback on macOS | none | Docker (image required) | exists, needs an image |
| macOS-guest VM | none | none | new; external tools only |
| Windows sandbox | none found | AppContainer | exists |
| Windows test CI | none (release smoke only) | none | new |
| Windows release smoke | yes | none | needs a Windows binary first |
| Embedded Python on Windows | n/a | unsupported | blocks full-workspace build |

## 3. Class

**Class d (propose)** for both. Upstream has no VM sandbox and no Windows test CI to port. Both would be new omp2 design.

Verdicts:

- **VM-backed macOS sandbox: research only; do not implement now.** Seatbelt's deprecation is real but it is deprecated, not removed. The existing Docker fallback already gives a VM boundary for Linux-compatible work. The missing piece, a macOS-native guest, can be reached today by running a Tart or Lima guest as an SSH host without any change to `omp-sandbox`. Revisit if Apple removes `sandbox-exec` or if hardlink-style bypasses matter to the owner.
- **Windows CI: research only; start with a compile check, not a test run.** A full Windows test job is blocked by the embedded Python. A staged, non-required check is feasible.

## 4. Options

### VM-backed macOS sandbox

1. **Do nothing.** Seatbelt stays; Docker is the fallback. Cost: zero. Fit: acceptable while `sandbox-exec` works.
2. **Document a recipe**: run a macOS or Linux guest with Tart, Lima or Apple `container` as an SSH host, `ssh add` it, and use the existing exec-ssh path. Cost: about a day of writing and checking. Fit: good. No code, no redistribution, no licence issue because the user installs the tool. Limit: only what the SSH execution path covers (UNVERIFIED for general tools).
3. **A new `Backend` variant in `omp-sandbox`** that starts a VM per run or per session through Virtualization.framework and runs the command in the guest. Cost: weeks. Needs a Rust binding to the framework (the workspace already uses `objc2` crates in `omp-desktop`, `crates/desktop/Cargo.toml:35-40`; whether a Virtualization binding exists there was not checked), a signed entitlement, an image distribution story, host-side network policy (a VM needs a filtering NAT or a proxy, where Seatbelt uses a loopback broker) and a shared-directory story (virtiofs; build speed over it is UNVERIFIED). Fit: poor against ADR 0006, which puts a VM at the environment-target level.
4. **A VM as an environment target** running the full `omp-envd` (ADR 0006's stated direction). Cost: large; depends on the deferred minimized stub (ADR 0039). Fit: best long-term, outside this gap.
5. **Bundle Tart.** Rejected: its licence limits making it available in a competing product, and a bundled binary needs redistribution rights omp2 has not been given. [INFERENCE: whether an agent harness is a "Competing Use" is a legal question; avoid it.]

Choice: option 2 now; option 4 later through ADR 0039; options 3 and 5 not recommended. [INFERENCE]

### Windows CI

1. **Do nothing.** Windows code is unchecked, and `cfg(windows)` paths can rot unseen. Cost: zero.
2. **A full workspace job on `windows-latest`.** Blocked by `omp-py`. Not feasible now.
3. **Cross-compile check from Linux** for a Windows target using a Windows cross toolchain. Cost: low minutes, no Windows runner. Catches type and cfg errors in Windows code. Does not run anything. Feasibility with the nightly toolchain and `windows-sys` is UNVERIFIED.
4. **A hosted Windows job that builds and tests only the crates that do not depend on `omp-py`.** Cost: one job; Windows minutes cost more than Linux (rate not checked: UNVERIFIED). Fit: good. It runs the Windows backends of `omp-sandbox`, `omp-shell`, `omp-shell-builtins`, `omp-tui` and `omp-desktop`.
5. **Add Windows support to `omp-py`** (a Windows archive, a `.def` export list, link flags). Cost: large, and it widens a locked area (ADR 0036). Fit: only if the owner wants a Windows release.
6. **Release smoke like upstream.** Needs a Windows binary, so needs option 5 first.

Choice: option 3 first, then option 4, both non-required; option 5 only on an owner decision. [INFERENCE]

## 5. Plan

Nothing below is implemented. Each item is a proposal with its own acceptance test.

### VM: slice V0, a measured spike (no repository change)

- Measure, on the self-hosted Mac, the time to start a clean guest and run `true` for Tart, Lima and Apple `container`, the speed of a shared-directory `cargo build` against a native one, and what network filtering is available. Record the numbers in a research note.
- Acceptance: a table of measured times and a yes or no per tool on "can run a macOS-native command" and "can filter egress". Until measured, every number about VM speed in this document is UNVERIFIED.
- Revised 2026-11-14: the proposed pass lines for a MicroVM execution backend tested against Vibemon (gates X0 to X9, baselines B0r and B0c) and for a VM subagent view (I1 to I3) are in ADR 0070 D5 and D6, every number a proposal for the owner. The spike runs only after a reopen trigger fires (ADR 0070 D4: Apple signals S1 to S3, owner need H, isolation need I); Windows events WIN1 to WIN4 are in D7. The `sandbox-exec` removal detector that already exists is `seatbelt::probe()` plus proof P12, with limits listed in the ADR. Code: `crates/sandbox/src/backends/seatbelt.rs:436-473`, `crates/e2e/tests/p12_daemon_approvals.rs:13-14`, `:63-72`.

### VM: slice V1, the recipe (deferred by ADR 0070 D3; needs open question 6 answered first)

- Write a short guide: install a guest tool, create a guest with SSH, `ssh add` it with a pinned host key, and run build and test commands through the SSH execution backend.
- Acceptance: on the self-hosted Mac, a guest runs one workspace test command through exec-ssh and returns its result and exit code; the project `hosts.toml` is untouched in an untrusted workspace (`crates/ssh/src/lib.rs:157-170`).
- Gate: none; documentation only.

### VM: slice V2 (only if V0 and V1 justify it)

- A sandbox `Backend::VmGuest` variant, or better an environment target (option 4). Capabilities declared honestly, with caveats for shared directories and egress.
- Gate: default-off, mechanism chosen by the future record (ADR 0070 D8 does not mint `cap-sandbox-vm` or `sv_sandbox_vm`). Adding a variant touches every exhaustive `match` in the runner (`crates/sandbox/src/runner.rs:41`, `crates/sandbox/src/runner.rs:240`, `crates/sandbox/src/runner.rs:318`, `crates/sandbox/src/runner.rs:406`, `crates/sandbox/src/runner.rs:458`) and the serialized backend names, which are additive.
- Acceptance: the conformance suite the other backends run (`crates/sandbox/tests`) passes for the supported capabilities, and unsupported ones fail strict specifications.

### Windows: slice W0, find the closure

- List which workspace crates depend on `omp-py`, directly or not, using the dependency graph for the Windows target. Output: a list of crates that can build on Windows today.
- Done 2026-11-14 as a manifest read (normal and build dependencies in `crates/*/Cargo.toml`): 8 of 62 crates depend on `omp-py` (`omp-app`, `omp-chat`, `omp-driver`, `omp-e2e`, `omp-envd`, `omp-py`, `omp-roster-probe`, `omp-tools`); the other 54, including `omp-sandbox`, `omp-shell`, `omp-shell-builtins`, `omp-tui` and `omp-desktop`, do not. It ignores dev-dependencies and features and does not show that they compile on Windows.
- Acceptance still open: confirm with `cargo tree --target x86_64-pc-windows-msvc -i omp-py -e normal,build` (not run: no cargo build in this pass).

### Windows: slice W1, compile check

- A non-required job, run on demand (a nightly run waits until the cost of one Windows run is measured), that checks the W0 crates for `x86_64-pc-windows-msvc`. Switch it on with a repository variable, default unset, so the job is skipped like the Mac variants (`docs/research/ci-macos-runner-fallback.md:5`). ADR 0070 D8 does not mint the variable's name.
- Acceptance: the job passes on the baseline, fails on an injected type error in a `cfg(windows)` block, and is not in the required list (`docs/BRANCH_PROTECTION.md:42`).

### Windows: slice W2, unit tests

- On a hosted Windows runner, run the tests of the W0 crates. Skip tests that need Unix tools, with a typed reason.
- Acceptance: the job is green on three consecutive runs before it is allowed on any PR path; a flaky-test list is kept.

### Windows: slice W3 (owner decision)

- Embedded Python for Windows, and a Windows release smoke like upstream's. Out of scope here.

## 6. Open questions

1. **Apple's macOS licence for VMs.** How many macOS guests a Mac may run, and under what terms, was not read. UNVERIFIED. It limits any macOS-guest design.
2. **Nested virtualization.** GitHub-hosted macOS runners are themselves VMs; whether Virtualization.framework works inside them is UNVERIFIED. A VM backend could be tested only on the self-hosted Mac.
3. **Entitlements and signing.** Virtualization.framework use requires a signed binary with an entitlement. UNVERIFIED. `package-macos.yml` is manual, "publishes nothing" and has no signing step (`.github/workflows/package-macos.yml:3-14`), so omp has no signing story to reuse.
4. **Tart's licence.** FSL-1.1-ALv2 with a Competing Use clause, copyright line naming OpenAI as read. The owner should decide whether even a documented recipe that points at Tart is acceptable, or whether to name only Apache-2.0 tools (Lima, Apple `container`).
5. **Seatbelt's future.** The man page says deprecated. No removal date was found. Apple DTS said in September 2020 that the deprecation exists because the profile language is undocumented for third parties (<https://developer.apple.com/forums/thread/661939>), and the binary is still present in 2026. The triggers for V2 are now defined in ADR 0070 D4; the owner ratifies them.
6. **General tool execution over SSH.** Whether read, write and shell tools can target an SSH host, not only build runs, decides whether V1 works for agent sessions. Partial finding 2026-11-14: envd's `ssh://` support is reads (`crates/ssh/README.md:5-8`); no write or shell path over SSH was found (not exhaustively searched).
7. **Windows release.** Does the owner want a Windows binary? That decides W3 and the `omp-py` work.
8. **Cost.** Hosted Windows minute rates and per-run cost were not checked. NOT MEASURED.
9. **Locked ADRs.** ADR 0006 is the guide for the VM question. ADR 0036 (Python-only extensions and eval) is why embedded Python cannot simply be made optional. ADR 0024 (latched roster) is untouched: no new roster family. The additive-only rule holds: new CI jobs, a new backend variant and new convars change nothing existing.

## 7. Upstream origin and license

Nothing from upstream is proposed for reuse for the VM question: it has no VM sandbox. For Windows CI, the useful upstream idea is the release smoke matrix and its comment explaining why binaries are cross-built and then run on their own platform (`upstream:.github/workflows/ci.yml:863-868`). Upstream's `LICENSE` is MIT (copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`); workflow YAML is configuration, and copying it keeps that notice.

Third-party VM tools were checked only for their licence: Tart FSL-1.1-ALv2, Lima, Apple `container`, Apple `containerization` and UTM Apache-2.0, Colima MIT (GitHub API, 2026-11-13). None is proposed for bundling.


## 8. MicroVM route facts (read 2026-11-14)

Moved here from ADR 0070 Context. Pages were read from `main` on 2026-11-14; no commit hash could be read (the GitHub API was blocked for the session), so nothing is pinned.

**Vibemon** (<https://github.com/stencil-hq/vibemon>): a self-hosted microVM platform that speaks the E2B API; the E2B SDKs and CLI work unmodified. Sandboxes are copy-on-write forks of a template snapshot with no kernel boot. Pause writes a memory delta and a disk overlay; with an S3-compatible store configured it can be resumed on another node. Platforms: Linux/KVM (guests x86_64 and aarch64; VMM, node and driver roles); macOS 15+/HVF (guest aarch64; same roles); Windows/WHP (guest x86_64; VMM only). macOS binaries need an ad-hoc signature with `hvf.entitlements`; Linux nodes need `/dev/kvm`, and TAP networking needs root or `CAP_NET_ADMIN`. MIT licence, Apache-2.0 for E2B-derived parts. The README gives no start-latency figure and no benchmark.

**Vibemon's E2B compatibility page** (<https://github.com/stencil-hq/vibemon/blob/main/docs/src/reference/e2b-compat.md>): sandbox create, list, kill, timeout, connect, pause, fork, snapshot-as-template and template operations are routed; the envd process service (Start, Connect, SendInput, SendSignal) and filesystem service and file upload and download are implemented over Connect v1; paused sandboxes auto-resume on connect. Limits: egress header rules are Linux-only and "currently failing in the macOS test run"; on macOS the egress filter admits only domains on TCP 80 and 443; "Not yet run: Linux/KVM end-to-end testing"; GPU sandboxes lose memory on resume. Test status as recorded there: Python SDK 1444 passed, 8 failed, 34 skipped; JS SDK 1007 passed, 1 failed, 36 skipped. Guests are Linux (the init list names Debian, Ubuntu, RHEL, Arch and Alpine), so on a Mac this is a Linux VM boundary like Docker Desktop, not a macOS-native sandbox.

**E2B** (<https://docs.e2b.dev/sandbox/persistence.md>, <https://docs.e2b.dev/sandbox.md>): `Sandbox.create()` with a timeout; `commands.run`; pause saves filesystem and memory, "pausing takes about 4 seconds per 1 GiB of RAM" and "resuming takes about 1 second"; `Sandbox.connect()` resumes a paused sandbox; paused sandboxes are kept until killed; network connections drop on pause. The documentation does not state a cold-start time.

**Gap between the reference adapter and the E2B API.** `upstream:packages/metaharness/src/tb/vmon.ts` boots from an OCI `image` with `allow_host_gateway: true` (`:201-224`) and calls `sandbox.hostGateway(localUrl)` (`:308-315`). The Vibemon README and compatibility page do not mention a host gateway, and the E2B pages read show none. So an adapter limited to the E2B API cannot assume the inference gateway that ADR 0052 D8 and ADR 0039 K2 rely on: either the guest reaches inference through an allowed egress route with no key in the guest, or the adapter uses a Vibemon-specific call. UNVERIFIED which Vibemon supports; ADR 0070 gate X8 tests it.
