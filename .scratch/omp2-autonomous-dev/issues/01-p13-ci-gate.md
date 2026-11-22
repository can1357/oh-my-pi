# 01: Gate P13 (remote execution) in CI

**What to build:** P13 (remote execution) runs in CI as a required check on Linux and is locally runnable via `just e2e-p13`. Regressions in remote execution are caught before merge.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Add `e2e-p13` recipe to justfile: `cargo nextest run -p omp-e2e --test p13_remote_exec --locked`
- [ ] Add `e2e-p13` to the `just e2e` recipe dependency list
- [ ] Add P13 to CI workflow as a required check in the Linux E2E job (same job as P9, P10, P11, P14)
- [ ] Update AGENTS.md to remove the P13 gap note ("P13 is not, and is the one gap")
- [ ] Verify P13 passes locally: `just e2e-p13`
- [ ] Verify P13 passes in CI on the next push

**Public interface changes:** None. This is configuration only.

**Verification evidence:**
- `just e2e-p13` runs successfully locally
- CI Linux E2E job includes P13 and passes
- AGENTS.md no longer mentions P13 as a gap
