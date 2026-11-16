# S4: deterministic native checks and opt-in gates

Status: implemented in [PR #658](https://github.com/blyzer/oh-my-pi/pull/658),
review-ready with scoped local validation and disclosed CI gaps, 2026-11-16.
Implementation branch:
`feat/verification-native-checks`, initially based on `omp2` at
`868e20edb5e676a9a842835b9f06668e4cb62ef9`, then fast-forwarded to current
`omp2` at `bf873e3` before final validation. This note describes this slice's
contract and source boundaries. The validation record below distinguishes
executed checks from remaining validation and unsupported platform coverage.

## Scope and decision

S4 connects the [S1 reducer](13-required-inventory-s1.md),
[S2 snapshots](14-input-snapshots-s2.md) and
[S3 retained evidence](15-evidence-storage-s3.md) to a deterministic native
package-check provider. It implements a narrow part of A1 and C1: package
compilation/type checking, explicitly selected nextest unit/integration tests
and the doctest half of the repository's package test contract. It does not
claim all A1 syntax/format objectives or all regression coverage are satisfied.
Commands use the selected packages' default Cargo feature selection; this is
neither an all-features check nor an implicit workspace-wide test run.
The first closed-input provider requires Linux Bubblewrap. Other backends
return INCONCLUSIVE: scoped filesystem reads alone do not establish scoped
native execution on Seatbelt. macOS needs an execution-fencing contract and
native proof before this provider may admit PASS there.
The inspected [Seatbelt policy](https://github.com/blyzer/oh-my-pi/blob/bf873e3f53b4bf539cf77563fd67b9d52c540381/crates/sandbox/src/backends/seatbelt.rs#L248-L258)
explains why read-denied native images can still execute unless explicitly
denied. This is a source finding, not a measured macOS exploit or a claim that
the new provider ran successfully on macOS.

The driver composes verification; EnvD owns filesystem and process effects.
The existing session journal/CAS retains evidence and the existing ADW phase
graph owns retries and corrections. There is no new daemon, production dependency, process
host, model call, memory lookup or default acceptance behavior. The native
provider is an explicit `Code` phase, not a new ADW phase kind. Legacy command,
Agent and Review providers retain their existing acceptance contracts.
The Linux integration harness uses workspace `ctor` and `omp-sandbox`
development dependencies to dispatch the existing same-executable sandbox
child entry before libtest parses arguments. Production keeps the application's
existing dispatcher.

### Opt-in workflow

For a trusted workspace, an existing `.omp/workflows/<name>.toml` can declare:

```toml
[[phase]]
name = "implement"
kind = "agent"
prompt = "Implement the requested change."

[[phase]]
name = "verify"
kind = "code"
inputs = ["implement"]
on_reject = "correct"
verification = { packages = ["omp-core"], timeout_seconds = 900, minimum_tests = 1, max_output_bytes = 4194304 }
```

`packages` is explicit, nonempty and unique; package names cannot be paths or
command options. The defaults are a 900-second native process-host budget, at least one selected
nonignored test per package and a 4-MiB output bound per command. The timeout
ceiling is 1,800 seconds; output cannot exceed 4 MiB across stdout and stderr combined.
The host budget covers tool admission, process execution and its input fences;
original-Environment source capture, materialization transport and durable
publication are outside that clock. It is not a total wall-clock deadline.
`verification` cannot be
combined with a command, working-directory override, delegated executor or
prompt, and is rejected on model phase kinds. Unknown configuration fields are
rejected. These constraints are enforced at workflow load rather than inferred
from a shell command string.

Only a `PASS` report accepts this provider's phase. `FAIL`, `INCONCLUSIVE`,
missing results and runner errors reject it. `on_reject = "correct"` uses ADW's
existing correction/version invalidation and attempt bounds. It is not an
unbounded independent repair loop and does not grant commit authority.

## Execution and evidence boundary

| Layer | Owning implementation | Responsibility |
| --- | --- | --- |
| Workflow admission | `crates/driver/src/adw/definition.rs`, `production.rs` | Explicit provider, trusted-workspace admission, requirement identity including consumed phase versions, per-attempt journal and PASS-only acceptance |
| Native composition | `crates/driver/src/verification/runner.rs` | Check inventory, source/context binding, fixed command plans, evidence publication, freshness fence and final reducer |
| Frozen source | `crates/envd/src/resource_materializer.rs`; `crates/proto/proto/omp/env/v1/env.proto` | Bounded captured-input CAS materialization into a private leased `src/out/tmp` root; no live-worktree copy or writeback |
| Shared input representation | `crates/exec/src/captured_inputs.rs` | Native capture-manifest entry decoder, reused by composition and evidence retention |
| Process authority | `crates/envd/src/verification.rs` | Isolated existing `ProjectEnvironment`, admitted actual tools, explicit environment, raw output and terminal protocol facts, bounded cleanup |
| Test admission | `crates/driver/src/verification/inventory.rs` | Strict JSON inventory/event reconciliation, duplicate-key refusal, package/binary/case identities and known recipe definitions |
| Retention and decision | Existing `verification/{snapshot,evidence,policy}.rs` | Source/context/action scope, complete retained blob closure, exact applicability and tri-state required-check assessment |

The original environment captures source bytes into its CAS. The materializer
checks the capture manifest and each consumed blob, rejects unsupported paths,
modes and missing/corrupt content, and creates a private lease. Source files are
copied from those verified bytes; the check's writable build and temporary
directories are separate from `src`. Captured inputs are never written back.
The capture decoder's reuse does not make every legacy capture valid for this
stricter execution profile: materialization has its own admission checks.
The additive `MaterializeRequest.captured_inputs` field advances the shared wire
revision to 30 in Rust and Python together. Environment clients must use the
matching operation revision; legacy resource materialization keeps its source
contract, and a request cannot combine both source forms.

The isolated environment requires native source write-denial and disabled
network access. Unsupported confinement is refused, with no unconfined host
fallback. Read-only source permissions alone are insufficient: the kernel
sandbox must enforce the fence. EnvD state stays outside the child-writable
lease. Tools are resolved from operator paths and admitted against source/root
overlap; selected compiler sysroot bytes, actual tool version probes, dependency
roots and the explicit execution environment enter supplemental identities.
The Env workspace is `src`, with explicit sibling output/temp grants. Both
private Cargo configuration filenames are read-only and content-fenced. The
Cargo-home directory has its own nested writable mount: on Bubblewrap this
prevents moving its parent directory to bypass the read-only file mounts.
The native regression fixture attempts overwrite, unlink, file replacement,
Cargo-home replacement and ancestor configuration creation before requiring a
passing real test run.

The child receives a private Cargo home, offline Cargo operation, separate
target/output paths and controlled nextest configuration. It inherits no
workspace environment or credential bridge. The Rustup bootstrap grant is
removed before actual checks; actual toolchain executables bypass later proxy
selection. Compiler/documentation wrapper environment overrides are cleared.
Source configuration capable of bypassing the controlled invocation must be
refused rather than treated as a successful gate.
EnvD scratch state lives in an owned temporary directory beneath the caller's
runtime-state parent. Bootstrap state is removed before final execution; final
scratch is removed after shutdown. Cleanup errors cannot produce PASS. Durable
session journals and retained S3 evidence remain outside this disposable state.

The provider admits the known `check-pkg`/`test-pkg` recipe definitions before
executing fixed host-composed, instrumented Cargo/nextest equivalents. A source
recipe replaced with `echo passed` is not a compiler result. The actual argv and
original stdout/stderr belong in evidence; model-facing minimized text is not
the retained execution record.

For C1, a machine-readable nextest listing supplies the selected test inventory.
Run events must reconcile against every admitted package, binary and case,
including terminal outcomes. The first strict profile refuses inventories with
default-ignored cases as `INCONCLUSIVE`: nextest's observed ignored-event protocol
does not match the complete-terminal contract supported by this parser. This is
an explicit limitation, not permission to drop those cases from coverage.
Exit zero, a human-readable
"tests passed" line, zero selected tests, missing terminal events, duplicate JSON
keys or filtered/foreign inventory cannot manufacture coverage. The doctest
command remains required; zero doctests may record non-applicability only when
the selected nextest inventory satisfies the package minimum.

Each observed check produces immutable S3 evidence bound to its S2 snapshot,
policy, action configuration and native producer provenance. Raw outputs and
command facts are retained as leaf blobs. Final admission also requires the
original source snapshot to remain current and admitted external input bytes
to pass revalidation. A result for the frozen old source is not relabeled as a
result for newly edited source. Lost cancellation/terminal/output information
does not become a passing observation.

## Budgets and trust limits

- Deadline, output limits, explicit package selection and Cargo job count bound
  this profile's work. It does not advertise hard CPU, RAM or PID quotas: the
  Linux sandbox backend does not enforce all of them. Resource exhaustion may
  still prevent a conclusive result.
  A [measured hashing experiment](17-hash-throughput.md) justified optimizing
  only the `sha2` test dependency; the homogeneous LLVM backend and production
  profiles remain unchanged. Its isolated hashing ratio is not a measured
  whole-verifier speedup.
- A frozen capture is a controlled verification profile, not the arbitrary live
  worktree environment. Git metadata and ignored inputs absent from capture are
  not silently admitted; unsupported or unresolved inputs prevent a durable
  passing conclusion.
- This adapter composes local Bubblewrap environments. It does not add remote
  execution or macOS verification admission. Symlink spelling is fingerprinted
  without following links or expanding permissions: an escaping target remains
  absent from the sealed sparse namespace unless independently admitted or part
  of the trusted OS runtime. Readable non-OS roots remain byte-fenced.
  Inventories cover admitted roots conservatively, with a 4-GiB/200,000-entry
  bound per inventory. An oversized shared Cargo cache can therefore prevent
  admission even for a small selected package. Dependency-closure narrowing is
  later work, not an optimization claimed by this slice.
- The OS runtime and host administrator remain trusted. Content-addressing
  selected tools/dependencies does not attest the entire host or defend against
  an administrator replacing the process authority itself. Matching before/after
  captures observe drift; they are not an atomic filesystem transaction.
- Complete executable evidence proves observed command outcomes and declared
  coverage. It does not prove tests are meaningful, requirements are correct,
  arbitrary project harnesses are honest or that semantic/security defects are
  absent. A trusted workspace can still contain weak tests.
- Source/configuration/build-script execution remains untrusted within the
  admitted sandbox. Logs and source text do not become policy instructions.
  No LLM is used in this slice, so no reviewer may waive required checks.
- S4 does not add cross-revision semantic equivalence or broad incremental cache
  reuse. Immutable old evidence remains historical; current applicability and
  freshness still require explicit validation.

## Validation record

Native implementation source: `c70ea7c` on
[`feat/verification-native-checks`](https://github.com/blyzer/oh-my-pi/pull/658),
based on `omp2@bf873e3f53b4bf539cf77563fd67b9d52c540381`.
Executed on Linux with the pinned toolchain, nextest 0.9.146 and available
Bubblewrap. No full-driver suite, macOS execution or green hosted CI outcome is
claimed.
The sandbox and exec rows were executed before `c70ea7c`; their owning source
did not change afterward. The seven-case native and 28-case driver runs tested
`c70ea7c`.

| Executed command | Result |
| --- | --- |
| `CARGO_BUILD_JOBS=1 cargo nextest run -p omp-driver --test verification_native --test-threads 1 --success-output immediate --no-tests fail --locked` | 7 passed, 0 skipped; 155.148 s test execution (one slow case) |
| `cargo nextest run -p omp-sandbox --test bubblewrap -E 'not test(wrapper_prefix_executes_and_filters_environment_names) and not test(live_bubblewrap_confines_reads_writes_socket_and_preserves_fd_63)' --no-tests fail --locked` | 19 passed; 2 explicitly filtered existing live tests |
| `cargo nextest run -p omp-exec --lib --no-tests fail --locked` | 32 passed, 0 skipped |
| `CARGO_BUILD_JOBS=1 cargo nextest run -p omp-driver --lib -E 'test(verification::) or test(adw::definition::) or test(adw::production::native_) or test(a_reviewer_that_did_not_say_accept) or test(a_retry_brief_carries)' --no-tests fail --locked` | 28 passed, 561 filtered; source `c70ea7c` |
| `CARGO_BUILD_JOBS=1 cargo nextest run -p omp-envd --lib -E 'test(resource_materializer::tests::) or test(verification::tests::)' --no-tests fail --locked` | 16 passed, 1195 filtered; source unchanged by remote app-only merge `5e669c1` |

The supported-host cases actually executed: a native PASS, four retained
receipts and journal reload, real compiler/test failures, zero/ignored-test and
forged-recipe rejection, source drift after a frozen test marker, and cancellation
after a frozen C1 test starts. Cancellation settles within the asserted bound,
removes the lease and cannot publish passing C1/freshness receipts; this relies
on the existing process-tree shutdown contract rather than independently proving
every descendant PID exited. The
passing fixture also requires its build script's attempted control writes,
unlinks, replacements, Cargo-home move and ancestor-config creation to fail.
The unavailable-host test's opposite-platform branch was not applicable on this
host; the supported execution cases did not report a skip.

The complete Bubblewrap target was also attempted. Two existing live contracts
are unresolved in this environment: the wrapper harness lacks same-executable
sandbox-child dispatch, and the live socket test requests Unix-socket path
enforcement that this backend rejects. These are not reported as passing or
silently counted as coverage. The two new mount-plan regressions and the native
joined protection proof passed.

Local capacity constraints required serial compilation, moving generated build
caches, and `strip --strip-unneeded` on the generated native test executable.
The final seven-case run used the unstripped executable while doctest compilation
ran concurrently; its duration is not a performance comparison. The source/test
backend remained LLVM. Earlier attempts failed during fixture
setup, host admission, resource exhaustion and protocol integration; their
fixes were rerun rather than counted as successful evidence. Raw local logs are
`/tmp/omp2-s4-native-final.log`, `/tmp/omp2-s4-bubblewrap-focused.log` and
`/tmp/omp2-s4-exec-tests.log`; temporary logs are not committed artifacts.
`just fmt-check-rust`, `just proto-fmt-check`, `just proto-lint` and
`just proto-breaking` passed. Direct lintx checks of the five new Rust files
passed; 37 research-directory relative links resolve and experiment JSON parses.

The combined `CARGO_BUILD_JOBS=1 cargo test --doc -p omp-exec -p omp-env
-p omp-sandbox -p omp-envd -p omp-driver --locked` attempt failed at the driver's
verification module example: rustdoc reported `omp_tools` unavailable in rlib
format. A separate host attempt passed `omp-env`'s empty doctest inventory, then
failed at EnvD because its expected `omp_tools` rlib path did not exist. Neither
attempt established complete doctest coverage. Local logs are
`/tmp/omp2-s4-doctests-final.log` and `/tmp/omp2-s4-host-doctests-final.log`.

The final combined retry passed for all five owning crates after explicitly
adding the existing tools rlib search directory. Exact command:

```sh
RUSTDOCFLAGS='-L dependency=/workspace/oh-my-pi/target/debug/build/omp-tools/0e705635f3fdf9da/out' \
  CARGO_BUILD_JOBS=1 cargo test --doc -p omp-exec -p omp-env -p omp-sandbox \
  -p omp-envd -p omp-driver --locked
```

Result: driver 1 passed, exec 1 passed, env/EnvD/sandbox each 0 doctests;
all five commands' crate stages completed successfully. The absolute cache path
is local to this build and is a workaround, not a new repository requirement.
The log is `/tmp/omp2-s4-all-doctests-retry.log`. A separate driver retry with
the same search path and an unmodified leaf-crate doctest run also passed.
The earlier failures remain recorded rather than presented as successful runs.

Hosted checks on `b3f8919` included passing Linux/macOS lint, formatting,
protobuf and several acceptance jobs, but the workspace job was cancelled and
BuildBuddy failed (exit 100). Fetching its detailed job log returned HTTP 403;
the failure cause is unverified. This does not establish green CI, and no
workflow or BuildBuddy configuration was changed. Independent source review at
`c70ea7c` found no new concrete blocker, with the cancellation-test scope caveat
above. The PR was marked ready for review at the owner's request; this is not a
claim that merge prerequisites passed. The code is not merged. The remote
app-only merge `ef0f06f` was preserved in merge `5e669c1` without overwriting it.

A coordinator-run dependency-free fixture against nextest 0.9.146 exercised one
passing case and one default-ignored case: both listing and execution exited
zero. The listing marked the ignored case with `filter-match: mismatch` and
reason `ignored`; the run emitted an ignored start without a matching terminal
event, plus interim terminal/repeated suite-start events. The strict parser
therefore refuses that inventory rather than inventing complete coverage. This
is a reporter protocol experiment, not an end-to-end verifier run. Raw local
outputs were recorded at `/tmp/omp2-s4-ignored-list.json` and
`/tmp/omp2-s4-ignored-run.json`; those temporary paths are not committed evidence
artifacts.

The coordinator's final record must identify the exact tested source, commands,
pass/fail counts, skipped cases and environment blockers, including:

1. Known package compile/test success and durable receipt reload.
2. Compile/test failure, no tests, incomplete/forged coverage and changed recipes.
3. Source or supplemental-input drift and stale receipt refusal.
4. Cancellation, output truncation, missing terminal state and bounded cleanup.
5. Unsupported confinement refusing PASS and a supported-host execution proof.
6. Workflow opt-in/trust/default behavior and existing ADW correction bounds.

## Remaining work

S5 adds conservative impact analysis, focused semantic reviewers and native
finding falsification; it must not reinterpret a Quick native result as semantic
approval. Structured independent verdicts and changes to claim acceptance remain
ADR 0053 decisions. Optional shared reranking, mutation/fuzz providers, measured
Strict review and broader autonomous rollout remain later slices. Historical
memory stays advisory and cannot satisfy this or any later required gate.
