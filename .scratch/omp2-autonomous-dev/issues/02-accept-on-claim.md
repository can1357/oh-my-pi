# 02: Add accept_on_claim to PhaseSpec

**What to build:** A workflow phase can declare `accept_on_claim = true` to opt out of the unverified-by-default rule. When set, a phase without verification evidence is accepted on its completion claim. This is a narrow schema change enabling ticket 03.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Add `accept_on_claim` field to `PhaseSpec::Prompt` variant in `crates/driver/src/adw/definition.rs`
- [ ] Add `accept_on_claim` to the TOML deserialization schema for workflow definitions
- [ ] Update every caller of `PhaseSpec::Prompt` construction to include the field
- [ ] Add unit test: workflow with `accept_on_claim = true` loads correctly
- [ ] Add unit test: workflow without `accept_on_claim` defaults to `false`
- [ ] Run `just check-pkg omp-driver` and `just test-pkg omp-driver`

**Public interface changes:** `PhaseSpec::Prompt` gains a new field `accept_on_claim: bool`. Default is `false`. Existing workflows continue to work but will be affected by ticket 03 (unverified-by-default) unless they declare this field.

**Verification evidence:**
- `just check-pkg omp-driver` passes
- `just test-pkg omp-driver` passes
- Workflow definition with `accept_on_claim = true` loads without error
