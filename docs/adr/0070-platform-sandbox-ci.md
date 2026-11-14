# 0070. Platform sandbox and CI: no VM-backed macOS sandbox and no Windows test job now; the existing fallbacks stand

Status: Proposed 2026-11-14; research-only, machine-reviewed (EGM, 2 rounds), not owner-approved
Date: 2026-11-14
Area: runtime

Research: [docs/research/platform-sandbox-ci.md](../research/platform-sandbox-ci.md) (gap 19 of the upstream gap closure). This record states a research-only decision. It has no implementation slices. It states the events and the proposed thresholds that would reopen it. "Machine-reviewed" means two rounds of fresh-context reviewers, each finding checked against source (see "What the review changed"); no person has approved it.

## Terms

- **OMPv1 / upstream**: the TypeScript implementation at commit `c308970263`; paths below are `upstream:<path>`. **omp2**: this repository's Rust implementation.
- **EGM (Elephant-Goldfish Model)**: the design-review method used for this record: the author drafts, fresh-context reviewers see only the document and the files it names.
- **Seatbelt**: macOS `sandbox-exec`, the macOS sandbox backend in `omp-sandbox`. **Docker forms**: the Docker and Docker-with-runsc backends.
- **`Runner::run` admission** and **`Runner::native_command()`**: the two ways `omp-sandbox` is entered (details in Context).
- **E2B**: a hosted sandbox service with an open client API; **Vibemon** (`stencil-hq/vibemon`): a self-hosted microVM platform that speaks that API.
- **MicroVM execution backend**: ADR 0052's proposal for an `ExecutionBackend` (the build-and-test execution trait in `omp-exec`) that runs a command in a microVM.
- **Environment target**: ADR 0006's term for where `omp-envd` (the project environment daemon) runs: a local process, a container, a VM or a remote machine.
- **T2 extension, `Delegated` adapter**: ADR 0049's tier for vendor integrations, and ADR 0040's intended in-core adapter for a backend outside the binary. The adapter does not exist in code (Context).
- **Reflink view**: ADR 0007's per-file copy-on-write clone of the workspace for a subagent (`create_worktree`), with a plain-copy fallback.
- **ADW**: the repository's phased development workflow driver (`crates/driver/src/adw`).

## Context

### What OMPv1 does

- No VM sandbox. A search of `crates`, `docs` and `packages/coding-agent/src` of the pinned checkout for Seatbelt, `sandbox-exec`, Virtualization.framework, Tart, Lima, Firecracker, krunkit and Apple `container` found only unrelated hits. Its isolation crate `pi-iso` is copy-on-write filesystem isolation (APFS, Btrfs, ZFS, overlayfs, reflink, ProjFS, Windows block clone), not process confinement (`upstream:crates/pi-iso/src/apfs.rs`, `upstream:crates/pi-iso/src/overlayfs.rs`, `upstream:crates/pi-iso/src/projfs.rs`). The only VM advice is for the `computer` tool: use a dedicated account or VM (`upstream:docs/computer-use.md:6`, `:208`).
- It has a Vibemon client for benchmark trials only: `upstream:packages/metaharness/src/tb/vmon.ts` imports the Vibemon SDK (`:4`), boots an OCI image with `allow_host_gateway: true` (`:201-224`) and attaches a host gateway so the guest reaches a host-local inference endpoint (`:308-315`). Those are Vibemon SDK calls; the E2B pages read for this record show neither (research note, section 8).
- No Windows test CI. Release binaries are cross-built on Linux, then a release-only job runs `--version` and `--smoke-test` on each platform, including `windows-2025` and `windows-11-arm` (`upstream:.github/workflows/ci.yml:863-868`, `:872-873`, `:887-889`).

### What omp2 has

- `omp-sandbox` supports Seatbelt, Bubblewrap, Landlock with seccomp, gVisor, Docker, Docker with runsc and Windows AppContainer (`crates/sandbox/README.md:3`). `Backend` is a closed enum with fixed capability sets (`crates/sandbox/src/capability.rs:22-50`, `:400-423`).
- **There are two entry points, and only one has a fallback.** `Runner::run` admission picks the first available of `candidates()`: on macOS Seatbelt, then Docker with runsc, then Docker (`crates/sandbox/src/runner.rs:1113-1116`). `Runner::native_command()` is hard-wired to Seatbelt on macOS and Bubblewrap on Linux and has no Docker path (`crates/sandbox/src/runner.rs:1136-1142`); the environment daemon's exec sandbox and the extension-host spawn use it, both with `DegradationPolicy::Reject` (`crates/envd/src/exec_sandbox.rs:396`, `:1244`; `crates/envd/src/exthost/spawn.rs:571-573`). `fallback_backend()` also returns Seatbelt on macOS (`crates/sandbox/src/runner.rs:1128-1135`). So if `sandbox-exec` disappears, admission through `Runner::run` could fall to Docker, but the exec sandbox and extension-host spawn would fail closed with a backend-unavailable error; what a user sees there is not specified.
- **The Docker forms are a Linux VM boundary, not a macOS one.** They need an image named in `OMP_SANDBOX_DOCKER_IMAGE`, with no default; without it the backend is unavailable (`crates/sandbox/src/backends/docker.rs:72-76`, `:24`). The command runs in that image with host paths only through declared bind mounts (`:207-208`). Docker Desktop on macOS runs Linux images [INFERENCE, general knowledge], so macOS-native work (Xcode, Swift, Mach-O) cannot use it.
- Seatbelt's launcher is `/usr/bin/sandbox-exec` (`crates/sandbox/src/backends/seatbelt.rs:21`). On the research host, macOS 27.2.1, `man sandbox-exec` reads "sandbox-exec - execute within a sandbox (DEPRECATED)": deprecated, not removed. Apple DTS said in September 2020 that the sandbox profile language "is not documented for third-party use. This, btw, is why sandbox-exec has been deprecated" (<https://developer.apple.com/forums/thread/661939>, fetched 2026-11-14). So it has been deprecated for at least six years and is still present. Seatbelt has no IPC restriction, no `proc.noexec` and no CPU, memory or process limits (`crates/sandbox/src/capability.rs:320-332`), and records caveats: path-based scopes an allowed hardlink can bypass, no disk limit, loopback blocked with network off (`crates/sandbox/src/backends/seatbelt.rs:325-398`).
- **A launcher-removal detector already exists, with limits.** `seatbelt::probe()` runs `sandbox-exec -p "(version 1) (allow default)" /usr/bin/true` and returns `ProbeFailure::Start` if the launcher cannot start or `ProbeFailure::Rejected` if it fails (`crates/sandbox/src/backends/seatbelt.rs:436-473`); it honors an `OMP_SANDBOX_EXEC` override (`:446`). Proof P12 fails, rather than skips, on macOS when the probe fails (`crates/e2e/tests/p12_daemon_approvals.rs:13-14`, `:63-72`) and gates in the CI job `Rust workspace and acceptance proofs`, which runs on the self-hosted Mac or `macos-15` (`.github/workflows/ci.yml:457`). Three limits. It proves only that the launcher starts, not that deny rules still enforce; the live enforcement tests (`crates/sandbox/tests/seatbelt.rs:298`, `mod live`) do check that, but return early when the backend is unavailable (`:319-323`), so they do not fail on removal. It runs when CI's macOS image changes, which can be after users upgraded. And it says nothing about Apple's announcements.
- ADR 0006 puts a VM at the environment-target level: "The same host MUST be able to point the stub at a local process, a container, a VM, or a remote machine" (`docs/adr/0006-host-policy-sandbox-stub.md:44-47`, `:150`). A guest with an SSH server is reachable by the SSH execution backend for build and test commands (`crates/exec-ssh/README.md:1-6`). envd's `ssh://` support is reads (`crates/ssh/README.md:5-8`); no path for write or shell tools over SSH was found (not exhaustively searched).
- VM tool terms, read from the GitHub API on 2026-11-13: Tart is under the Functional Source License (FSL-1.1-ALv2; a "Competing Use" clause limits making it available in a competing commercial product; internal use is permitted). Lima, Apple `container`, Apple `containerization` and UTM are Apache-2.0; Colima is MIT. Whether omp is a "competing product" is a legal question not analysed here (O4).

### The MicroVM route (ADR 0052, ADR 0007)

- ADR 0052's guide proposes a MicroVM backend behind `ExecutionBackend` and `ExecutionRun` (`crates/exec/src/backend.rs:139-177`) with an E2B/Vibemon adapter first (`docs/adr/0052-one-executor-contract.md:40-67`). What the contract carries: an `ExecutionRequest` is "one unit of execution: a whole command over a captured working tree" (`crates/exec/src/request.rs:152-157`) in the build-and-test domain (`crates/exec/src/lib.rs:1`), and ADW offloads only `just` recipes (`crates/driver/src/adw/remote.rs:83-90`). A subagent's read, edit and shell tools do not run through `ExecutionBackend`; they run through the environment daemon.
- **Where a vendor backend would live is not settled.** ADR 0049 puts vendor integrations in T2 extensions, and ADR 0040 intends an in-core `Delegated` adapter (`docs/adr/0040-remote-build-and-test-execution.md:1833`). No such execution adapter exists in `crates/exec*` (the only mention is a comment, `crates/exec-reapi/src/lib.rs:6`), `ExecutionBackend` is a generic trait with associated future types, not a dynamic contract, and a search of `crates/py` and `crates/envd/src` found no extension API for it. ADR 0036 makes extensions Python-only. So a Python extension cannot supply an `ExecutionBackend` today, and how it would is an open question (O11).
- Vibemon and E2B facts (guests are Linux; Linux/KVM end-to-end testing "not yet run"; no published start latency; E2B pause about 4 s per GiB and resume about 1 s; the `vmon.ts` calls missing from the E2B pages) are in the research note, section 8, with URLs. The point that matters here: on an Apple-silicon Mac, Vibemon is a Linux VM boundary like Docker Desktop, not a macOS-native sandbox.
- For subagent isolation, ADR 0007 requires a per-writer view, no write access to the parent tree, and a content-addressed patch or branch returned (`docs/adr/0007-subagent-filesystem-isolation.md`, Decision and Amendment 2026-11-12). Today `create_worktree` clones each manifest entry with `clone_file_cow` (`crates/envd/src/workspace/operations.rs:673-725`, `:2041`). The request message has no backend field: `CreateWorktree { name, base, paths, owner_pid, props }` (`crates/proto/proto/omp/env/v1/env.proto:1154-1160`), and `SCHEMA_REV` is 29 (`crates/proto/src/lib.rs:51`). A VM-backed view therefore cannot be requested through the existing message, and cannot come from an exec backend (above); it would be an environment-target design (ADR 0006) plus a wire decision (O9).

### Windows

- Code exists in 19 crates under `cfg(windows)`, including an AppContainer backend and a `win32` desktop backend (`crates/sandbox/src/backends/appcontainer.rs`, `crates/sandbox/src/runtime/windows.rs`, `crates/sandbox/src/runtime/windows_acl.rs`, `crates/desktop/src/win32`, `Cargo.toml:325`). There is no Windows CI job: no file in `.github/workflows` contains the word `windows` (searched 2026-11-14; the workflows are `ci.yml`, `codeql.yml`, `p8-baseline.yml`, `package-macos.yml`, `pr-labels.yml`, `semantic-index-eval.yml`).
- A whole-workspace Windows build is blocked: `omp-py` is an ungated dependency of `omp-app` and `omp-envd` (`crates/app/Cargo.toml:103`, `crates/envd/Cargo.toml:67`), its fetch script supports only macOS arm64 and Linux x86_64 and aarch64 (`crates/py/scripts/fetch-python.sh:153-168`), and its link lists exist for ELF and Mach-O only. The `justfile` uses `bash` (`justfile:5`); the toolchain is a pinned nightly (`rust-toolchain.toml:2`).
- **Which crates are not blocked (manifest read, 2026-11-14).** Following normal and build dependencies only in `crates/*/Cargo.toml`, 8 of 62 crates depend on `omp-py`: `omp-app`, `omp-chat`, `omp-driver`, `omp-e2e`, `omp-envd`, `omp-py`, `omp-roster-probe`, `omp-tools`. The other 54 do not, including `omp-sandbox`, `omp-shell`, `omp-shell-builtins`, `omp-tui` and `omp-desktop`. This is a manifest read, not `cargo tree`: it ignores dev-dependencies and features, and says nothing about whether those crates compile on Windows.
- How much Windows-gated code changes (`git log -G'cfg\(windows\)|target_os = "windows"' 9cb6fd6389 -- crates`, 2026-11-14): 109 Rust files carry such a cfg; 65 commits since 2026-08-14 touch a matching line (73 with a broader regex that adds `cfg(not(windows))`-style forms and `target_family`); **2** since 2026-10-15, and both are wide refactors (`bc6f29d210`, ADR 0049 phases; `5820502ad8`, shell-builtins stderr). The AppContainer backend file was last changed 2026-09-04 (`de7a1c71a9`). So Windows-gated lines change mostly as a side effect of unrelated refactors, which is evidence against a count-based trigger.
- CI economics: the self-hosted Mac runs the one job that benefits from its persistent target directory; everything else is hosted (`docs/research/ci-macos-runner-fallback.md:5-21`). Ten named checks are required and new jobs must not rename them (`docs/BRANCH_PROTECTION.md:42`, `:84`).

### Rules that bind

ADR 0006 (policy on the host, a stub in the sandbox; a VM is an environment target); ADR 0036 (Python-only extensions and eval, so embedded Python cannot simply be made optional); ADR 0024 (no new roster family); ADR 0049 (vendor integrations are extensions); additive only (`CreateWorktree`, the `Backend` enum and `SCHEMA_REV` are existing surfaces); no new language runtimes; no `pi` identity.

## Decision

**D1. Do not add a VM-backed macOS sandbox backend now.** Seatbelt stays the macOS default; the Docker forms stay the fallback for `Runner::run` admission only. Reasons: `sandbox-exec` is deprecated but present and a probe plus a failing proof already detect its removal; a Linux VM boundary already exists through Docker (with the limits above); a macOS-guest design needs an entitlement, an image distribution story, host-side egress filtering and a shared-directory story, none of which has been measured; and ADR 0006 places a VM at the environment-target level, not in the sandbox crate.

**D2. Do not build a MicroVM execution backend or a VM subagent-isolation backend now.** Nothing in this record authorizes either. Constraints on any future record, not decisions: a vendor adapter is not a `Backend` variant in `omp-sandbox` and not in a core crate (ADR 0049); a MicroVM execution backend serves build and test commands (the `ExecutionBackend` contract); a VM-backed subagent view is an environment-target design with its own wire decision (O9), because an exec backend cannot supply the per-writer view; where the vendor adapter lives is O11.

**D3. Tart is not bundled or redistributed.** Any recipe names Apache-2.0 tools (Lima, Apple `container`) first and treats Tart as a user-installed option, pending O4. No Linux-VM recipe is in scope of this record; it would need O6 answered first and is deferred.

**D4. Reopen triggers.** This record is reopened, and a new record with slices is written, only when one of these named events occurs. A reopen decides, at least: what the exec sandbox and extension-host spawn do without `sandbox-exec` (they use `Runner::native_command()`, which has no fallback), and the user-visible error.

*Trigger S (Apple signal for `sandbox-exec`).* Any one of:
- S1. `just e2e-p12` or the CI job `Rust workspace and acceptance proofs` goes red on macOS with `ProbeFailure::Start` or `ProbeFailure::Rejected` from `seatbelt::probe()`, or the live tests in `crates/sandbox/tests/seatbelt.rs:298` report a rule no longer enforced, on any macOS image, including a beta image run by hand. Whoever is about to move the CI Mac or the hosted image to a new macOS major runs `just e2e-p12` and the sandbox crate tests on the beta first and notes the result in the research note; no automation is proposed.
- S2. A macOS release's notes or the `sandbox-exec` man page move from "DEPRECATED" to stating removal, or Apple developer documentation names `sandbox-exec` or the `<sandbox.h>` API as removed. Check at each macOS major release; today's baseline text is "DEPRECATED" on macOS 27.2.1. This check is manual and may lag.
- S3. Apple documents a supported way for a command-line tool to confine a child process. That reopens the question in the other direction: a supported API may replace Seatbelt without a VM.

*Trigger H (owner need).* The owner records a use case that needs Seatbelt's hardlink-style scope bypass or its missing CPU, memory and process limits closed (`crates/sandbox/src/capability.rs:320-332`, `crates/sandbox/src/backends/seatbelt.rs:325-398`). Without it, the Docker forms already offer those limits for `Runner::run` admission.

*Trigger I (isolation need).* The owner ratifies a use case where a child needs process or network confinement beyond the filesystem view, or the forced-copy `create_worktree` of this repository's manifest takes longer than the owner's budget on a filesystem without copy-on-write that the owner names as supported.

*Spike gate.* The spikes below run only after S1, S2, H or I fires, because they cost host time and the self-hosted Mac also runs the required P12 check (`.github/workflows/ci.yml:457`). A spike that passes is necessary, not sufficient: building still needs an owner decision and its own record.

**D5. MicroVM execution backend spike (V0): proposed gates, every number a proposal for the owner to ratify (O9).** Hosts: one Linux host with `/dev/kvm` and one Apple-silicon Mac on macOS 15 or later, both running the same Vibemon commit, recorded in the V0 note when it is run (no commit was readable when this record was written, so none is pinned here). The Mac must not be the CI Mac while CI is running. Method: each repeated gate is run 30 times; a latency bound passes when at most 1 of the 30 runs exceeds it; a pass-or-fail gate passes with 0 failures in 30 (which bounds the failure rate near 10% at 95% confidence, an accepted weakness). The "warm template" is a template snapshotted from the image the Linux CI job uses plus the repository's pinned toolchain, with no command running; the V0 note states its exact contents. The "adapter's calls" are made directly with E2B's own client, since no adapter exists.

| Gate | Measure | Proposed bound | Basis |
|---|---|---|---|
| X0 health | Pinned commit age, and whether Vibemon's own Linux/KVM end-to-end suite has been run | commit at most 90 days old; Linux/KVM suite reported as run | The compat page says "Not yet run: Linux/KVM end-to-end testing"; a young, single-vendor project is a lock-in risk (AGENTS.md "No vendor server-side tools") |
| X1 conformance | Create from template; process Start, Connect, SendInput, SendSignal, stream to exit; file upload and download; kill; pause then connect | 0 failures | Calls the reference adapter uses (`vmon.ts`) and ADR 0052's minimum contract |
| X2 start | Create from the warm template to first `true` exit 0 | at most 2.0 s | Unanchored: E2B documents resume (about 1 s), not create, and Vibemon publishes no figure; 2.0 s is twice the resume figure |
| X3 exec overhead | `true` in an existing sandbox via the E2B client, minus the same `true` through `omp-exec-local` on the same host | at most 250 ms | Unanchored: chosen so 30 calls in a build step add at most 7.5 s |
| X4 workspace in | Copy this repository's non-ignored manifest (the set `create_worktree` snapshots) into the guest | at most 2 times the forced-copy `create_worktree` time on the same host (B0c) | Both move the same bytes; the guest path adds a transport |
| X5 cancel and kill | `ExecutionRun::cancel` to process gone; sandbox kill to resources released | at most 5 s and 10 s | Unanchored owner-set numbers; `cancel` is the one cancel path (`crates/exec/src/backend.rs:168-173`) |
| X6 reattach | Detach, drop the client, reattach through process Connect, read remaining output and exit code | 0 lost or duplicated results | `reattach` and `detach` exist for this (`crates/exec/src/backend.rs:156`, `:177`); ADR 0052 safeguard 3 forbids relaunching blindly |
| X7 egress | With network blocked, a TCP connect to a public IP and a DNS lookup of a public name both fail; the adapter's declared enforced posture claims nothing the test shows unenforced | 0 failures and 0 mismatches | ADR 0052 D2 and D9: advertised is not enforced. The compat page admits only domains on TCP 80 and 443 on macOS, so any scoped-allow need on macOS is declared unsupported |
| X8 inference path | A guest turn completes against a host-side inference endpoint with a canary credential kept off the guest: no match for the canary in the guest's environment or filesystem (`env` and a recursive search) | 0 matches; the route used (egress allowlist or a Vibemon-specific gateway) recorded | `vmon.ts` uses a Vibemon gateway call the E2B pages do not show (O10) |
| X9 density | 8 concurrent sandboxes of 2 vCPU and 1 GiB each on a 16 GiB host, 10 rounds | 0 failures; idle memory per sandbox recorded | Concurrent ADW phases (ADR 0007 amendment, 2026-11-12; not the e2e proof P3) |

Baselines, measured first on the same hosts: B0r, `create_worktree` on this repository's manifest on the reflink path; B0c, the same forced onto the copy path; and `omp-exec-local` `true` latency. None has a stored number (UNVERIFIED).

**D6. VM-backed subagent view spike: proposed gates, in addition to D5, every number a proposal for the owner to ratify (O9).** Only after trigger I and the wire decision in O9.
- I1 (rule). A guest edit never reaches the host tree: the host manifest digest before and after is identical in 30 of 30 runs, and the patch returned from the guest applies to the host view and yields the same digest as the reflink path for the same edits. The P9 proof cannot be reused: it has one test, `p9_control_extension_is_rooted_in_the_isolated_worktree`, which checks that an extension worker is rooted in the isolated worktree and the parent is untouched, with no edit-then-patch flow and no digest comparison (`crates/e2e/tests/p9_isolation.rs:1-2`, `:261`). A new proof in `crates/e2e` is needed. Digests come from `WorkspaceSnapshot.manifest_hash` (`crates/proto/proto/omp/env/v1/env.proto:1031-1036`) and the diff artifact that `MergeWorktree` produces (`crates/envd/src/workspace/operations.rs:820`); `WorktreeInfo` carries no digest (`env.proto:1179-1185`).
- I2 (cost). Materialize the manifest in the guest and return the patch in at most 3 times B0c. The relative base is the copy path because a reflink is metadata-only and a guest copy over HTTP cannot match it.
- I3. The owner has ratified the need (trigger I) and ruled on how a VM view is requested (O9).

**D7. Windows CI triggers.** No Windows test job now. Any one of these events reopens this record:
- WIN1. The owner decides a Windows binary will ship (O7).
- WIN2. A change to `crates/sandbox/src/backends/appcontainer.rs`, `crates/sandbox/src/runtime/windows.rs`, `crates/sandbox/src/runtime/windows_acl.rs` or `crates/desktop/src/win32`, because a sandbox backend cannot be reviewed without a build. It is evaluated at review time of the change that touches those paths; no automation is proposed. (A count-based trigger was rejected: see Context and the review log.)
- WIN3. A user report or issue whose cause is in `cfg(windows)` code.
- WIN4. `crates/py/scripts/fetch-python.sh` gains a Windows archive, which makes a whole-workspace job reconsiderable.
The reopen decides the stages, each its own record. Candidate stages, for orientation only: (a) confirm with `cargo tree --target x86_64-pc-windows-msvc -i omp-py -e normal,build` the 54-crate list in Context; (b) an on-demand compile check of those crates for `x86_64-pc-windows-msvc` on hosted `windows-2025` (the image upstream uses, `upstream:.github/workflows/ci.yml:887-889`), switched on by a repository variable, non-required; (c) their unit tests; (d) only on an owner decision, embedded Python for Windows and a release smoke like upstream's. A recurring nightly run waits for O8, the measured cost of one Windows run.

**D8. Gating of any later work.** This record changes no convar, feature or CI file. Any later work is default-off. The existing mechanisms are the model, and the future record picks one: the ADW placement convar `sv_exec_policy` (default `local-only`, `crates/driver/src/adw/remote.rs:70`) for remote execution, and repository variables for CI (`vars.MACOS_RUNNER`, `vars.CI_LINUX_MODE`). Note that the existing `cap-*` features are on by default in `omp-app` (`crates/app/Cargo.toml:25-34`), so a default-off feature would differ from them. Names such as `cap-sandbox-vm`, `sv_sandbox_vm` or `vars.CI_WINDOWS` are not minted here.

## Rejected options

- **A new `Backend::VmGuest` variant now.** Weeks of work and an entitlement, with no measurement showing the need; it touches every exhaustive `match` on `Backend` (`crates/sandbox/src/runner.rs:41`, `:240`, `:318`, `:406`, `:458`).
- **A Vibemon or E2B adapter in a core crate.** Vendor integrations are extensions (ADR 0049).
- **Treat a Linux microVM on macOS as a replacement for Seatbelt.** Its guests are Linux; the boundary equals what Docker Desktop gives.
- **Bundle Tart or any VM tool.** No redistribution right for Tart; see D3.
- **A full-workspace `windows-latest` job.** Blocked by `omp-py`.
- **Add Windows support to `omp-py` now.** Large, and it widens a locked area (ADR 0036); only with an owner decision for a Windows release.
- **Vague triggers ("when Apple removes it", "when VMs are fast enough") and a Windows count-based trigger.** The first were rejected in round 1; the count (2 commits in 30 days, both wide refactors) cannot tell a real Windows change from an incidental one.
- **Do nothing and say nothing.** The deprecation and the missing Windows check deserve a recorded decision and triggers.

## Slices

None. This record is research only and authorizes no implementation and no spike. Three measurement items are defined so a future record can start from them; each changes no repository file apart from a research note.

- **B0 and V0.** Defined in D5 and D6. They run only after trigger S, H or I fires (D4), on hosts the owner supplies, and write their results to `docs/research/microvm-v0.md` (a future file). V0 is not runnable now: no Vibemon commit is pinned and the warm template is undefined until then.
- **W0 (done as a manifest read).** The 54-crate list in Context. Its confirmation with `cargo tree` is stage (a) in D7 and was not run (no cargo build in this pass).

If a trigger fires and the owner accepts, each stage gets its own record with slices, acceptance tests and, where it applies, an e2e proof in `crates/e2e` and a golden journal.

## Upstream origin and license

Nothing from upstream is reused: it has no VM sandbox, and its Vibemon client is a TypeScript benchmark harness that serves only as a reference for the lifecycle. For Windows CI the useful idea is the release smoke matrix and the comment explaining why binaries are cross-built and then run on their own platform (`upstream:.github/workflows/ci.yml:863-868`). Upstream's `LICENSE` is MIT (copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`); workflow YAML is configuration and copying it keeps that notice. Third-party tools were checked only for licence: Tart FSL-1.1-ALv2; Lima, Apple `container`, Apple `containerization` and UTM Apache-2.0; Colima MIT; Vibemon MIT with Apache-2.0 for E2B-derived parts (its README, 2026-11-14).

## Consequences

- macOS sandboxing is unchanged: Seatbelt with its documented caveats; Docker as a Linux fallback for `Runner::run` admission only.
- If `sandbox-exec` is removed, the exec sandbox and extension-host spawn fail closed with no fallback until a new record decides otherwise. The detector (probe plus P12) fires when CI's macOS image changes, which can lag users; S2 and S3 are manual checks. This record accepts that lag and names the gap rather than hiding it.
- The MicroVM and VM-view routes have proposed pass lines and a stated constraint set, not a design. The numbers are proposals for the owner.
- Windows code stays unchecked in CI. `cfg(windows)` paths can rot unseen until a D7 event occurs.
- Nothing in the repository, its CI or its dependencies changes.

## Open questions for the owner

- **O1.** Apple's macOS licence for guests: how many macOS guests a Mac may run. Not read (UNVERIFIED). Read it before any macOS-guest work.
- **O2.** Nested virtualization: whether Virtualization.framework or HVF runs inside GitHub-hosted macOS runners is unknown. Assume VM work is testable only on a self-hosted Mac and a Linux host with `/dev/kvm`.
- **O3.** Signing and entitlements for a VM backend. `package-macos.yml` is manual, "publishes nothing" and has no signing step (`.github/workflows/package-macos.yml:3-14`), so omp has no signing story to reuse; Vibemon's own macOS binaries need an ad-hoc signature with `hvf.entitlements` (its README).
- **O4.** May a recipe name Tart, given its FSL licence? Recommendation: name Lima and Apple `container` first.
- **O5.** Seatbelt's removal date. None found. D4 trigger S stands until Apple states one.
- **O6.** Can general tools (write, shell), not only reads and build runs, target an SSH host? Only `ssh://` reads were found (`crates/ssh/README.md:5-8`); not exhaustively searched. It gates any guest-over-SSH recipe.
- **O7.** Does the owner want a Windows release? It decides WIN1 and the `omp-py` work.
- **O8.** Hosted Windows minute rates and the cost of one run: not checked. NOT MEASURED.
- **O9.** Ratify or replace the D5 and D6 numbers, and rule on how a VM-backed view would be requested: `CreateWorktree` has no backend field and an additive field changes the schema revision (`crates/proto/proto/omp/env/v1/env.proto:1154-1160`, `crates/proto/src/lib.rs:51`). Recommendation: keep the view as is and put any VM beneath an environment target, so no schema change is needed.
- **O10.** Is "E2B API only" a requirement? The reference adapter uses Vibemon-specific calls. Recommendation: allow a Vibemon-specific call behind the adapter if X8 cannot pass otherwise, and record the adapter as Vibemon-specific.
- **O11.** How can a vendor MicroVM backend be supplied? No extension API for `ExecutionBackend` exists and the `Delegated` execution adapter is not in code (Context). Options: a generic in-core adapter that drives a Python extension, or a Rust crate behind a feature. To be settled in ADR 0052's work before any MicroVM code.
- **O12.** What should the exec sandbox and extension-host spawn do, and show the user, when `sandbox-exec` is gone? They have no fallback today (Context). Decide before trigger S1 or S2 fires, not after.

## What the review changed

Review method and ledger: two rounds of fresh-context reviewers (four personas and a synthesizer each) read this file and the files it cites; every finding below was checked against source. The status ledger for this record is `docs/adr/STATUS.md`.

### Round 1 (the ledger listed three open findings; the round's full text was not kept)

1. **The Apple `sandbox-exec` trigger was not concrete.** Confirmed: the earlier text said only "Apple announces removal", while the code already had `seatbelt::probe()` (`crates/sandbox/src/backends/seatbelt.rs:436-473`) and the P12 proof (`crates/e2e/tests/p12_daemon_approvals.rs:13-14`, `:63-72`). Changed: D4 Trigger S (S1 to S3), with Apple's DTS statement as the source of the deprecation reason.
2. **V0 had no measurable thresholds for a MicroVM backend (ADR 0052, Vibemon, ADR 0007).** Confirmed: the earlier V0 said "time a clean guest start" with no pass line and did not cover Vibemon. Changed: D5 and D6 gates with proposed numbers, and the Vibemon and E2B facts (research note, section 8). Also recorded: the upstream adapter's Vibemon-specific calls, Linux guests, and that `CreateWorktree` has no backend field.
3. **No concrete Windows CI trigger.** Confirmed: the earlier text gave a staged route and no event. Changed: D7 events.

### Round 2 (blockers 0, majors 15, minors 9)

Majors:
- **M1. The "Docker forms stay the fallback" premise was incomplete.** Confirmed: `native_command_backend()` has no Docker path (`crates/sandbox/src/runner.rs:1136-1142`), the exec sandbox and extension-host spawn use it with `DegradationPolicy::Reject` (`crates/envd/src/exec_sandbox.rs:396`, `:1244`; `crates/envd/src/exthost/spawn.rs:571-573`), Docker needs an image and runs Linux (`crates/sandbox/src/backends/docker.rs:72-76`). Changed: Context, D1, D4 preamble, Consequences, new O12.
- **M2. "None" slices yet B0, V0, W0 and a circular Trigger V.** Confirmed: the old Trigger V depended on V0 passing. Changed: the spike gate in D4 (spikes run only after S, H or I), V0 hosts, method, template, result file and pin rule in D5, Slices rewritten. Severity kept at major: the do-nothing decision does not depend on V0. W0 was run as a manifest read.
- **M3. D3 fixed the shape while O11 said it was untraced.** Confirmed: no `Delegated` execution adapter exists (`crates/exec-reapi/src/lib.rs:6` is a comment), and no extension API for `ExecutionBackend` was found in `crates/py` or `crates/envd/src`. Changed: D2 states constraints, not a shape; O11 rewritten with the finding.
- **M4. An exec backend cannot carry subagent isolation.** Confirmed: `ExecutionRequest` is "a whole command over a captured working tree" (`crates/exec/src/request.rs:152-157`), ADW offloads `just` recipes only (`crates/driver/src/adw/remote.rs:83-90`). Changed: D2 and D6; a VM view is an environment-target design.
- **M5. D5 and D6 are speculative apparatus.** Rejected, by coordinator ruling: round 1 required concrete thresholds, so the tables stay, now labelled as proposals for the owner (O9). M6 to M8 fix them.
- **M6. Thresholds without basis, unspecified methods, mixed sample sizes.** Confirmed (X2 compares create with a resume figure; X4 and X5 numbers have no source; sample sizes differed). Changed: a Basis column that says "unanchored" where it is, one sampling rule, a warm-template definition, defined X3 to X9 methods, an X0 health gate.
- **M7. I2 and X4 were inconsistent.** Confirmed: a reflink is metadata-only (`crates/envd/src/workspace/operations.rs:673-725`). Changed: both are relative to the copy path B0c; absolute caps removed.
- **M8. The P9 fixture does not do what the text said.** Confirmed: one test (`crates/e2e/tests/p9_isolation.rs:261`), no edit-then-patch flow. Changed: I1 says a new proof is needed and names the digest sources (`WorkspaceSnapshot.manifest_hash`, `operations.rs:820`).
- **M9. Probe plus P12 is not a sufficient watcher.** Confirmed: it proves only that the launcher starts; the live tests return early when the backend is unavailable (`crates/sandbox/tests/seatbelt.rs:319-323`); P12 runs when CI's image changes; the probe honors `OMP_SANDBOX_EXEC` (`seatbelt.rs:446`). Changed: Context states the limits, S1 adds the live tests and a manual beta run, Consequences accepts the lag.
- **M10. The WIN2 count did not reproduce.** Confirmed: re-measured at `9cb6fd6389`, 2 commits since 2026-10-15 (3 only from 2026-10-14), both wide refactors; 65 and 109 reproduce, a broader regex gives 73. Changed: the count trigger is removed and rejected; WIN2 is a path trigger including `runtime/windows_acl.rs`.
- **M11. Event-to-stage semantics inconsistent and Windows work under-specified.** Confirmed. Changed: D7 events reopen the record; stages are orientation only, with the target triple, runner image and `cargo tree` command; no nightly run before O8.
- **M12. Undefined project terms.** Confirmed. Changed: a Terms section.
- **M13. Process meta-text in the ADR.** Confirmed. Changed: the header and this section state the method in two lines; round 2 instructions removed.
- **M14. One record covers four decisions.** Partly accepted: the MicroVM and Vibemon detail moved to the research note (section 8) and Context points to it. D5 and D6 stay, per the ruling above.
- **M15. "Roadmap P3" collides with proof P3.** Confirmed (`docs/knowledge-base.md:367` defines proof P3 as the job primitive). Changed: X9 says concurrent ADW phases.

Minors:
- **m1. Unminted names and the `sv_exec_policy` citation.** Confirmed: `sv_exec_policy` is `AdwExecPolicy` at `crates/driver/src/adw/remote.rs:70`, not `FallbackPolicy`; `cap-*` features default on in `omp-app` (`crates/app/Cargo.toml:25-34`). Changed: D8.
- **m2. Ledger row out of date.** Confirmed (`docs/adr/STATUS.md:82`). The row is proposed in the pull request; it is not edited here.
- **m3. Cheap reads left open.** Partly accepted: W0 (manifest read), O3, O11 narrowed from the tree; O6 narrowed to a partial finding.
- **m4. No pinned Vibemon commit or health gate.** Confirmed: the GitHub API was blocked for this session, so no commit could be read. Changed: D5 records the gap and adds X0.
- **m5. The Linux-VM recipe had no owner.** Confirmed. Changed: D3 defers it.
- **m6. Wrong Windows CI citation.** Confirmed: `.github/workflows/p8-baseline.yml:50-56` is one macOS matrix entry. Changed: the claim cites the absence across all workflows.
- **m7. Tart legal conclusion without analysis.** Accepted: Context states the licence only and flags the question (O4).
- **m8. "Do not bundle Tart" four times.** Accepted: D3 holds it; Rejected options points to it.
- **m9. Context altitude.** Accepted: test counts, timings and the stderr truncation size removed from the ADR.

## Status in omp

**Status: Not started; research only.** Reusable today: the Docker backend as a Linux fallback for `Runner::run` admission, the SSH execution backend for build and test commands, `seatbelt::probe()` and proof P12 as a partial `sandbox-exec` removal detector, `ExecutionBackend` and `ExecutionRun` as the MicroVM contract, the CI variable pattern (`vars.MACOS_RUNNER`, `vars.CI_LINUX_MODE`).

## References

[docs/research/platform-sandbox-ci.md](../research/platform-sandbox-ci.md); ADR 0006 (policy on the host, a stub in the sandbox); ADR 0007 (subagent filesystem isolation); ADR 0036 (Python-only extensions and eval); ADR 0039 (remote control and factory workers); ADR 0040 (remote build and test execution); ADR 0049 (tiered integration architecture); ADR 0052 (one executor contract, MicroVM guide); [docs/research/ci-macos-runner-fallback.md](../research/ci-macos-runner-fallback.md). External, fetched 2026-11-14: <https://developer.apple.com/forums/thread/661939>; Vibemon and E2B URLs are listed in the research note, section 8.
