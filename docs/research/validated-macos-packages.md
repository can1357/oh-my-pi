# Build once and reuse validated macOS packages

Base inspected: `omp2@7aedb5bd571a2d7777ead86b3d6df39bdda1659b`.
This is an independent packaging slice after PR #685; it does not change the
verification worker's GitHub-first/Mac-fallback order or BuildBuddy settings.

## Implemented boundary

`.github/workflows/package-macos.yml` remains manual. It builds the existing
`omp-app` release binary once with `cargo build -p omp-app --bin omp --release
--locked`, the repository's thin-LTO release profile, four build jobs and the
release embedded-Python configuration. Existing optional BuildBuddy/sccache
configuration remains attached to that build. This does not substitute a debug
binary or upstream's fat-LTO package for OMP2's consumer configuration.

`scripts/package-macos.sh` creates the tarball, `.pkg` and SHA256 file. The existing
`scripts/install-smoke-macos.sh` checks checksums, installs into a scratch prefix,
checks the installed binary's version/help, and inspects the package payload and
metadata. It does not install system-wide or establish full behavioral correctness.
Previously that smoke step used `continue-on-error`, while ordinary package
uploads used `always()`. Smoke failure could therefore leave apparently normal
downloadable packages. Those exceptions are removed: ordinary artifacts require
successful smoke and provenance creation; failure diagnostics retain their
separate `-partial-` name and short retention.

## Evidence and reuse

`scripts/package_macos_evidence.py` records the full checkout SHA, Actions run and
attempt, compiler identity, release profile, selected Cargo/Rust environment
overrides, release Python config path/hash, source-input hashes and exact package
hashes. It rejects a dirty tracked checkout. Validation rejects source/run/attempt
mismatch, unsafe filenames/symlinks, duplicate manifest keys, incomplete or extra
asset sets, and changed package bytes. Tests use fixture package bytes and an
actual temporary Git repository; they do not claim a native Mac build happened.

The ordinary Actions artifact `omp-macos-arm64-<full-source-sha>` contains the
same validated package bytes and `package-provenance.json`, retained for 14 days.
Consumers can download and install it without rebuilding. Its provenance is a
workflow observation bound to that artifact, not a cryptographic signature,
independent attestation or substitute for required verification gates.

## Optional draft publication

An owner can manually dispatch `Package macOS` on `omp2` with `publish_draft=true`.
The default is false. After successful packaging, a separate Ubuntu publisher
downloads only this run's named artifact, validates its exact source/run/attempt
and hashes, then uploads those existing bytes to a **draft** GitHub Release named
`omp-macos-<full-source-sha>`. It runs no compiler, package builder or native binary.
Only that job receives `contents: write`; the package build retains read-only
repository permissions and its existing BuildBuddy environment. Checkout credentials
are not persisted in the publishing job.

Both workflow and helper restrict publication to `blyzer/oh-my-pi`, an `omp2`
manual dispatch and actor `blyzer`. The helper refuses existing release tags and
uncertain tag lookups; it does not overwrite an existing release. GitHub tag
lookup and release creation are separate operations under the repository-writer
trust model, not an atomic defense against another malicious writer racing them.
A draft's creation does not publish a public release; final release approval
remains separate. No release was created during this implementation session.

This intentionally reuses GitHub's existing artifact/release facilities. Nix
packaging, Cachix, new signing identities, notarization and an always-running
service are outside this slice. Current packages are ad-hoc signed, not Apple
notarized. Build image/Homebrew drift and the selected metadata do not establish
a fully reproducible or hermetic build environment.

## Validation

The helper and workflow policy tests run through the existing
`test_hosted_runners.py` discovery of `test_macos*.py`; no extra heavyweight CI
job is needed. The helper is classified as lightweight policy code in the
dependency map. Changing that map itself selects full validation initially;
subsequent helper-only changes do not automatically compile the whole workspace.

Local commands: `PYTHONPATH=scripts python3 -m unittest test_hosted_runners
test_check_ci_paths test_ci_scope test_ci_optional_workflows` (147 tests passed),
`python3 scripts/check-ci-paths.py`, Actionlint 1.7.12 on the packaging workflow
(Shellcheck unavailable/disabled), editing-discipline and whitespace checks.
Native package/smoke execution and live draft publication require macOS/GitHub
and were not executed here. No latency, cost or successful public distribution
measurement is claimed.
