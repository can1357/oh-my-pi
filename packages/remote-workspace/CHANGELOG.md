# Changelog

## [Unreleased]

### Added

- Environments-cloud / pkscloudenvs routing: pure resolvers for the MSI-local canonical root (`C:\dev\desktop-infra\environments-cloud`), skill paths (`mesh-orchestrator`, `colab-warmup`), and mesh handoff argv (`mesh` / `mesh-run` / `cloud` / …), plus `ompk-remote environments` (alias `cloud`) CLI. Override with `OMPK_ENVIRONMENTS_CLOUD_ROOT`.
- Phase 1: `RemoteJobV1` schema, durable state machine, `ExecutionBackend` interface, `MsiDockerBackend`, SQLite job store, orchestrator service, and the standalone `ompk-remote` CLI.

### Changed

- Documented the split between phase-1 local Docker sandbox jobs and environments-cloud (pkscloudenvs) as the mesh/cloud/auth/launch SoT.
