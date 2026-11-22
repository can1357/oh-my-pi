# 03: Replace ADW judge() with verification policy

**What to build:** Producing Agent phases are verified against deterministic checks instead of accepting on any answer. Unverified phases are rejected by default unless they declare `accept_on_claim = true`. Review phases still parse ACCEPT/REJECT but also consult verification evidence. The verdict records independence (whether the judge route differs from the producer route).

**Blocked by:** 02 (needs `accept_on_claim` in PhaseSpec).

**Status:** ready-for-agent

- [ ] Replace `judge()` with `judge_with_verification()` in `crates/driver/src/adw/production.rs`
- [ ] For phases with verification evidence: call `VerificationPolicy::evaluate()` and map `GateVerdict::Pass` to accepted, `GateVerdict::Fail` to rejected, `GateVerdict::Inconclusive` to rejected with feedback
- [ ] For phases without verification evidence: reject unless `accept_on_claim` is declared (unverified-by-default rule)
- [ ] For Review phases: preserve first-word parse (ACCEPT/REJECT) but also consult verification evidence if present
- [ ] Add `Verdict` struct with `decision` (Accept/Reject/NeedsHuman), `feedback`, `criteria`, and `independent` fields
- [ ] Record the verdict in the `adw.phase.settle` journal entry per ADR 0051 D3
- [ ] Update `judge_delegated()` to use the same verification path
- [ ] Add unit tests:
  - Failed required gate rejects phase even when judge says Accept
  - Phase without evidence is rejected under unverified-by-default
  - Phase with `accept_on_claim = true` is accepted on completion claim
  - Review phase consults verification evidence
  - Verdict records independence when judge route differs from producer
  - Unparseable judge answer rejects
  - Settle entry names judge route, context digest, and evidence digest
- [ ] Run `just check-pkg omp-driver` and `just test-pkg omp-driver`
- [ ] Update ADR 0053 status to mark verification integration as implemented

**Public interface changes:** `judge()` is replaced by `judge_with_verification()`. This is a breaking change for workflows that rely on completion-claim acceptance — they must declare `accept_on_claim = true`. The `PhaseResult` struct gains a verdict field.

**High-risk changes:** The unverified-by-default rule changes acceptance behavior for all producing Agent phases. Existing workflows that do not declare verification or `accept_on_claim` will be rejected. This is an authorized breaking change per grill decision G2.

**Verification evidence:**
- All unit tests pass
- `just check-pkg omp-driver` passes
- `just test-pkg omp-driver` passes
- ADR 0053 status updated
