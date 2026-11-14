# 0053. Acceptance is decided from evidence by an independent verdict

Status: proposed
Date: 2026-11-12
Area: runtime

## Context

- OMP1 has independent review (owner, 2026-11-12). In upstream can1357/oh-my-pi it is a bundled `/review` command (`packages/coding-agent/src/extensibility/custom-commands/bundled/review/`: it resolves a PR, MR or local diff into a review target and builds the prompt) that runs the reviewer agent, whose structured result is the shape OMP2's `reviewer` agent already returns: `overall_correctness`, `explanation`, `confidence` and a list of findings with priority, confidence, file path and lines. OMP1's advisor is a separate module (`packages/coding-agent/src/advisor/`) of which OMP2's Director is the port. Only the file listing and the command entry point were read, not the review prompts. OMP2 has two pieces and no joined path: the Advisor Director and ADW's `Review` phase kind.
- The Advisor Director (`crates/agent/src/directors/advisor.rs`) pairs the session with the `@advisor` role model, reads the primary transcript as incremental session updates and speaks only through the `advise` tool, at candidate yields and optionally mid-turn. Its notes are advice (`nit`, `concern`, `blocker`); it accepts or rejects nothing. It exists inside one session, not inside an ADW run.
- ADW's `Review` phase is "a model turn that judges another phase's output" (`crates/adw/src/workflow.rs`, `PhaseKind`). Its verdict is the first word of the answer: `ACCEPT`, else a rejection carrying the text (`crates/driver/src/adw/production.rs`, `judge`).
- That review is not independent. Every model phase, including review, uses one selector (`model_phase_selector`: explicit `--model`, then `ai_model`, then `@smol`), so the reviewer is the producer's model. There is no judge role in the catalog's role selectors, and the reviewer is not required to see less than the producer saw.
- A producing model phase (`Agent`) is accepted on any answer: `judge` returns `accepted: true` for every model phase except `Review`. `Code` phases are decided by exit status. So a completion claim is the acceptance condition for every `Agent` phase, and a failed required check cannot override it unless a `Code` phase happens to run that check.
- The Elephant-Goldfish Model (EGM, github.com/google/elephant-goldfish-model) is a published pattern for this: an Elephant holds context and drafts; Goldfish reviewers run in a fresh context with no conversation history, each with one persona, and a synthesizer merges their reports. EGM's own rule is that "a review in the same context is not a Goldfish review". Its personas (zoom-out, comprehension, design critic, implementation readiness) are prompt files; running them took one reviewer subagent each in this session. Evidence of use is in the session that wrote this record (Open questions, below).

## Decision

**D1. Three roles with different authority.**
- **Gate** (deterministic): CI checks, tests, linters and any other required command. A failed required check rejects the phase. No model can overrule it.
- **Judge** (independent model verdict): reads the evidence and decides `Accept`, `Reject(feedback)` or `NeedsHuman`. Its `Accept` counts only when every gate passed.
- **Advisor** (existing): advice only. It never accepts, rejects or blocks a phase. A `blocker` note may raise a `NeedsHuman` request but is not a verdict.

**D2. Independence is a property OMP checks.** A judge runs in a fresh context that contains the assignment, the acceptance criteria, the artifacts (diff, test and check output, CI run ids) and nothing of the producer's conversation. It runs on a model route different from the producer's when one is configured, and with read-only authority (it can read the workspace and run the declared checks; it cannot write). When the configuration cannot supply a different route, the verdict is recorded as `independent: false` rather than hidden.

**D3. A new `@judge` role.** The catalog gains a `judge` role selector beside `advisor`, `smol`, `slow` and the rest. An unset `@judge` falls back to the `@slow` role. Independence is computed, not assumed: the verdict records `independent: true` only when the resolved route differs from the producer's route, otherwise `independent: false`.

**D4. A structured verdict replaces the first-word parse.** The judge returns `Verdict { decision, feedback, criteria: [{id, met, evidence}] }`. An unparseable answer stays a rejection ("a reviewer that did not say ACCEPT has not accepted", kept from `judge`). The criteria list ties each acceptance criterion to the evidence for it.

**D5. A phase declares acceptance.** A phase can list acceptance criteria and required gates. A producing phase that declares none is accepted on its completion claim only when the workflow says so explicitly (`accept_on_claim`); otherwise it is `Unverified` and cannot satisfy a dependent phase that requires verified input. This is a behavior change and needs the owner's decision (O1).

**D6. Executors report evidence, never verdicts.** An `EvidenceBundle` holds gate results, diff and artifact digests and the executor's own claim. ADW alone decides acceptance from it (ADR 0052 D4). The judge's identity, model route, context digest and the evidence digest are written into the `adw.phase.settle` entry (ADR 0051 D3), so provenance answers who accepted which work on what evidence.

**D7. The EGM pattern is a first-party review recipe, not core.** A review-loop recipe ships as a workflow extension: parallel fresh-context reviewers (zoom-out, comprehension, critic, readiness), a synthesizer, and the gate-first rule above. Core owns the role, the verdict contract and the independence checks; the personas and the loop are data an extension supplies, and a user may replace them.

**D8. Judges do not judge themselves.** The executor or model route that produced a phase is excluded from judging it, and a judge cannot be the assigned executor of a dependency of the work it judges.

## Consequences

- Acceptance becomes inspectable: criteria, evidence and the verdict's independence are on record.
- Cost rises: a judge turn per verified phase. D5 lets cheap phases stay claim-accepted by explicit choice.
- A workflow author must declare criteria for anything that matters. That is deliberate.

## Open questions for the owner

- **O1.** D5 default: unverified-by-default (recommended) or keep claim-acceptance by default and opt in to verification? The recommended default changes today's behavior.
- **O2.** Is a model on the same provider but a different model "independent"? Recommendation: independent means a different model; a different provider is better and is recorded, not required.
- **O3.** EGM as a dependency: install the plugin as an expert for design questions (owner-authorized), but ship the review loop as OMP's own recipe so core never depends on it.

## Related upstream request: decision models as judges (can1357/oh-my-pi issue 18621)

Owner-supplied 2026-11-12; the issue was read, the linked Artificial Analysis Decision Index page and the open provider PRs were not. The issue asks OMP1 for native adapters for "decision" models that return calibrated probabilities (Artificial Analysis Decision Index v2, November 2026) instead of free chat text, and says a chat fallback strips those probabilities. A maintainer triaged it as an enhancement, noted some models are already native on upstream main (OpenAI Decisions API and Cloudflare decision models, per the upstream changelog), and said each provider needs its own pull request, so the bundled issue was closed as wontfix. Relevance here: the judge role (D3) and `Verdict` (D4) should not assume a chat model. A judge route may be a decision model whose answer is a calibrated choice, boolean or score, so `Verdict` should be able to carry a probability and a confidence next to the decision. The session tooling already exposes calibrated answers (`judge` with choice, bool and score types), which is a precedent for the shape. This is a design input for D4 and for the ADR 0052 router, not a commitment; each vendor adapter is its own extension and its own pull request, as the maintainer asked.

## Evidence from using EGM on the owner questions

On 2026-11-12 four owner decisions (the `agent_settled` hook revision, the `omp-exec-ssh` closure measure, ACP Q18, ADR 0040 gap follow-ups) were put to three fresh-context reviewers running EGM persona files: zoom-out, comprehension and design critic. The author had recommended Q1 option A, Q2 A plus C, Q3 accept with conditions and Q4 accept Gaps 1, 3 and 4. What the reviews changed:

- Q1: the critic found the premise "no wire change" is false: Python subscribers already put revision 2 on the wire and envd refuses a mismatched event revision (`crates/envd/src/tools/hooks.rs:942-950`, checked by the author). It further claims a Python `agent_settled` hook can never `Continue` today because the mismatch fails open (the author confirmed `gate_domain` starts from `DomainReturn::fail_open()`, `crates/contract/src/hooks.rs:1554-1560`; the rest of the chain was not traced).
- Q2: the critic showed that `.cargo/config.toml` sets `feature-unification = "workspace"` (checked by the author), so 363 is what the repository builds, and called the narrower 273 a goalpost move. The author's A plus C became C only.
- Q3: all three reviewers moved from "accept" to "defer"; the critic listed concrete attacks a profile can mount through argv, environment and unverifiable sandbox claims.
- Q4: the critic found that the two tests ADR 0040 D1 requires before acceptance do not exist (`grep` finds neither; checked by the author), and that a crash after the Accepted commit can yield a duplicate remote run.
- The comprehension reviewer found Q2, Q3 and Q4 not decidable from the text alone.
- A fourth reviewer (implementation readiness) ran on these ADRs and found factual errors in the first drafts of 0051 and 0052, now corrected: the journal is raw SSE framing and not JSON Lines, and its kind set is closed on encode and open; the delegated `Feature` variants are not the names first used; `omp adw list` already exists for workflow definitions; one citation of ADR 0039 was wrong. That is the case for running a readiness review before a record is circulated.

So the author's recommendation was revised in every one of the four. That is the case for D2 (independence is checked, not assumed). Limits: the first two reviewers read their persona files partially because large tool output was truncated; the critic's file:line claims were spot-checked, not all verified; `implementation_readiness` was run on the ADR set, not on the questions.

## Not yet specified (readiness review, 2026-11-12)

Undefined: the field types, wire form and parse rule of `Verdict` (a starting point is the `reviewer` agent's result: `overall_correctness`, `explanation`, `confidence`, findings with priority, confidence, file and line range, which OMP2 already produces and OMP1's `/review` command consumes); a `Run` state for `NeedsHuman`; the TOML schema for acceptance criteria, required gates, criterion ids and `accept_on_claim`; how a dependent phase declares it requires verified input (`Run` has no such concept); the mechanism that makes a judge read-only; the definition of "context digest"; the contract for collecting artifacts (diff, check output, CI run ids); a migration for existing workflows if the recommended default (O1) is adopted; and tests for D8 and for "the advisor never accepts". This record is a proposal, not implementation-ready.

## Acceptance tests

1. A failed required gate rejects a phase even when the judge says `Accept`.
2. A judge never receives the producer transcript (assert on the judge's input).
3. With no `@judge` configured, the verdict carries `independent: false`.
4. An unparseable judge answer rejects.
5. The `settle` entry names judge route, context digest and evidence digest.
6. A claim-only producing phase is `Unverified` under the recommended default and does not satisfy a verified-input dependency.

## Status in omp

Status: Partially implemented.

- `ProductionAdwHost::model_phase_selector_for` in
  `crates/driver/src/adw/production.rs` already selects `@judge` for an implicit
  review model; an explicit operator model remains authoritative. This existing
  selector does not prove route diversity or context independence.
- The Advisor Director and `Review` phase's first-word verdict are implemented.
  Producing native Agent phases are still accepted on their completion claim.
- `crates/driver/src/verification/policy.rs` now provides the S1 pure native
  required-check inventory and PASS/FAIL/INCONCLUSIVE reducer. It checks supplied
  scope/evidence identities and retains every declared result. Its public contract
  tests are in `crates/driver/tests/verification_policy.rs`.
- Not yet implemented: source/environment capture, evidence integrity/provenance
  validation, structured independent verdict, required-gate integration into ADW
  acceptance, durable verification receipts, acceptance criteria and Issue-to-PR
  recipe. The S1 reducer is not a live gate and does not complete D1–D5.
- Unverified: OMP1 review prompts and aggregation, current live reviewer route
  independence, and the interaction of `ai_advisor_*` settings with judge routing.
  Build/test observations for S1 are recorded in the verification research's
  implementation validation note; source presence alone is not runtime proof.

## References

ADR 0051; ADR 0052; ADR 0039 (advisor transcript redaction notes); `crates/agent/src/directors/advisor.rs`; `crates/driver/src/adw/production.rs`; EGM, github.com/google/elephant-goldfish-model.
