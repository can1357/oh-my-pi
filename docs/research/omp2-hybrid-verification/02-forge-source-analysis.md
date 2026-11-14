# Forge source analysis

Inspected `HouMinXi/forge` at **91338bb2eb57e27b44c9164a2ada63aebb05fa4e**, cloned on 2026-11-14. This is the Python `code-review-forge` 2.9.0 implementation, not OMP2's unrelated Git hosting crate named `forge`. All paths below refer to this upstream snapshot. Source inspection verifies the described branches exist; it does not establish live model effectiveness.

## Auditable source map

The following links pin the source, rather than a moving README:

- [Runtime review factory](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/factories.py#L479-L650): `build_l1_provider`, roles, shared prompt, execution policy.
- [Grouped reviews](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/factories.py#L1028-L1109): `build_grouped_l1_provider`.
- [LOCAL convergence](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/machine.py#L2405-L2660): `_run_local`; [round execution](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/machine.py#L4458-L4500), `_execute_round`; [severity fixpoint](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/machine.py#L4714-L4880), `_fixpoint_reached`.
- [Receipt generation](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/receipt.py#L157-L255): response canonicalization, hashes and shingles; `write_receipts` follows at line 255.
- [Receipt verification](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/verify.py#L1772-L1855): `run_verify` and `_run_verify_impl`; [coverage and response freshness](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/verify.py#L751-L919); [excerpt evidence](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/verify.py#L1163-L1452).
- [Grouping](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/diff_grouping.py#L258-L419): `extract_names`, `build_edges`, `build_groups`.
- [Semantic falsifier](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/falsify_real.py#L213-L330): `RealFalsifier.falsify`; [execution falsifier](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/exec_falsify.py#L29-L100), `ExecEvidence`, and `ExecFalsifier.run` at lines 170 onward.
- [Backend contract](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/backend.py#L192-L268): `BackendConfig`; [invocation](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/llm_invoke.py#L2379-L2470), `llm_invoke`.
- [Rust mutation adapter](https://github.com/HouMinXi/forge/blob/91338bb2eb57e27b44c9164a2ada63aebb05fa4e/src/code_forge/mutation_engines/adapters/rust_cargo_mutants.py#L1-L100): native results and baseline parsing, supported cargo-mutants version 27.1.0.

## What the perspectives actually do

The ordinary API/CLI factory gives the three calls these roles:

| Pass | Actual runtime role | Further opt-in lenses |
| --- | --- | --- |
| `qodo` | Structural reviewer: correctness and logic errors | Hidden failures, sentinel ambiguity, partial transactions |
| `expert` | Senior engineer: SOLID, architecture, security | Concrete simplification and type/guard weaknesses |
| `adversarial` | Adversarial QE: assume bugs exist | Gate/environment leakage and concrete downstream impact |

`lenses.py:18-38` defines the lens text and `PASS_LENSES`; it is separately trusted and off by default. The much longer shipped `skills/code-forge/passes/pass*.md` instructions guide assistant-driven modes. They must not be mistaken for the ordinary factory's actual short role suffix. In particular, API calls do not automatically acquire every interactive agent tool promised by a skill document.

All three ordinary prompts share the JSON contract, optional environment manifest, changed-file post-images, conventions, blast-radius context, external context sources, design intent, focus specification, split context and annotated diff. The role sentence comes last. With no lenses, that sentence is the primary perspective distinction. The same configured backend serves these calls; three perspectives do **not** imply three independent model families. API calls may execute concurrently, optionally staggered; CLI calls are serial because invocation owns a module-global active process (`factories.py:617-650`).

## Three clean cycles is a state algorithm, not nine objective labels

`_execute_round` performs L0 deterministic detection, LOCAL-only L0 autofix, trusted blocking rules, L1 semantic review, L2 mutation and E2E. CI does not run the LOCAL autofix loop. `_run_local` loops toward a configured clean threshold, with bounded rounds and receipt acceptance. Its default three-clean-round policy yields at least nine **perspective invocations** for one ungrouped non-stub review that converges without rejected rounds. Physical HTTP requests can exceed nine because of retries, JSON correction, missing-excerpt repair, truncation continuation and falsification calls (`llm_invoke.py`). Grouping multiplies pass invocations by reviewed groups. Stub mode explicitly exempts a trusted no-L1 setup; CI has a separate one-cycle attestation path (`machine.py:1164`), so nine is not a universal invariant of every invocation.

Nine ordinary passes repeatedly review the supplied diff, but they are neither nine independent models nor necessarily nine independent discoveries. Inline assistant operation can use the same model sequentially. Fresh response hash/shingle tests reject some repeated output; they cannot prove cognitive independence or correctness.

The current fixpoint is more nuanced than “no findings three times”:

- New confirmed findings and fixed-to-confirmed reversions reset credit.
- Semantic uncertainty resets; protocol-only failure produces incomplete progress.
- Recurring P0/P1 confirmations reset; recurring P2 restarts the cycle.
- Recurring P3 below density thresholds can count as clean. A clean cycle therefore need not mean zero product findings.
- L2 infrastructure failure prevents earning clean credit, rather than constituting a product defect.
- Receipt schema, inspection coverage and acquisition failures have explicit preservation/interruption logic. Earned cycles are retained only with valid persisted evidence; `_restore_earned_window` refuses unavailable proof.

Do not silently substitute the proposed A1–C3 matrix for this behavior. They are different policies. Keep original Forge as an evaluation arm and require a paired noninferiority comparison, particularly for security and concurrency defects, before changing a default gate.

## Native checks versus semantic claims

| Mechanism | Status at inspected snapshot | What it establishes / limitation |
| --- | --- | --- |
| Tool runner and parser registry | Implemented; source inspected | `runner.py:200-297` executes tools with version capture, parses outputs, distinguishes tool crashes. Installed tools and language coverage determine availability. |
| Trusted gate/rulepacks | Implemented; source inspected | `gate_check.py`, `trust.py`, `baseline_guard.py` separate trusted rules/configuration from reviewed changes; protection depends on selected integration and trusted configuration. |
| Finding/excerpt schema and source matching | Implemented; source inspected | `reviewer_json.py` and `verify.py` validate structure, quoted source, paths and diff binding. A real excerpt establishes inspection evidence, not truth of a semantic allegation. |
| Semantic falsifier | Implemented; source inspected | `RealFalsifier` asks another LLM to confirm/dismiss/abstain using finding-anchored diff context and optional readers. It is not an executable proof. External API-shape claims without host-verified evidence are downgraded to uncertain. |
| Execution falsifier | Implemented; source inspected | Explicit DECLARED environment executes configured tests/builds, records tails, exit code, identity and lock hash; absent/observed manifest returns unavailable. Passing execution is receipt-level evidence, not proof every alleged defect is absent. |
| Mutation measurement | Implemented adapters; availability conditional | Python mutmut and adapter files for Rust cargo-mutants, JS Stryker, Go gremlins, C Mull and others exist. Adapter availability is not equivalent to default runtime activation for Rust. `factories.build_l2_runner:247-310` retains a Python-centric mutmut path and discloses other adapter requirements. |
| Stub falsification | Explicit stub/interface implementation | `falsify.py:20-78` includes `Falsifier` and `StubFalsifier`; real production implementation exists separately. Do not label the entire falsifier subsystem a stub. |
| Full Rust semantic dependency graph | Absent in inspected grouping algorithm | Python name intersections are not compiler bindings, Rust call graphs, CFGs or dataflow proof. |
| Exact repeated-token savings or defect recall on OMP2 | Unknown / unmeasured | No live comparison was executed in this research. |

The Rust mutation adapter checks `mutants.json`, `outcomes.json` and mutant logs. A native “caught” label alone is insufficient: `killed_has_failure` requires executed failure evidence. Unknown statuses remain unknown. This is a useful evidence discipline to reuse even if OMP2 integrates cargo-mutants directly.

## Partitioning and caching

`diff_grouping.extract_names:258-301` extracts only Python module-level definitions, loaded `Name`s and imported names. Unreadable, invalid or non-Python files yield empty sets. `build_edges:303-328` forms direct changed-file name intersections, without transitive closure or symbol resolution. Import aliases, same-named unrelated declarations and dynamic dispatch limit accuracy.

Crucially, **def-use edges do not partition groups** in the current code. `build_groups:350-419` uses deterministic file roles/churn, attaches tests, separates engine files, groups remaining integration/source files and retains configuration/docs/other groups. Some docs/config groups have zero passes unless coverage rules require them. Cross-group edges supply context. `build_grouped_l1_provider` reviews groups sequentially and merges/deduplicates findings by fingerprint; every reviewed group receives three perspectives and all groups must be clean for the round.

Prompt-prefix caching is a formatting optimization, not a content-addressed evidence protocol. `factories.py:563-616` constructs shared bytes once and appends role-specific suffixes, enabling provider cache reuse. The same large diff/post-image still appears in each outbound request. A provider may discount cached tokens; that does not establish less transmission, zero provider computation or cache availability. `Usage` and `factories._pass_token_line` track input/output/cached tokens. Do not infer a cache hit from identical prefixes alone.

Probe caching (`backend._read_cache/_write_cache:840-884`) concerns backend discovery, not verified source results. Forge source identity (`source.compute_source_hash:26-65`) normalizes text line endings and trailing whitespace in Git diff mode. That is not a sufficient cache key for arbitrary Rust diagnostics: whitespace can matter to literal contents/macros, and unchanged dependencies, toolchains, flags and external inputs can alter behavior. OMP2 should use byte-exact SHA-256 source/dependency manifests plus execution and policy identity.

## Evidence, edits and inconclusive outcomes

`State` persists findings, dispositions and round history; receipt files are named by cycle/pass. `machine._continuation_round_index:1740-1796` allocates monotonically increasing cycle numbers across reused receipt directories to avoid clobbering older diff evidence. Earned windows bind cycles to source identity and repository manifests. `verify._capture_earned_cycle`, `_restore_earned_window` and `_run_verify_impl` validate the selected proof rather than simply counting files. Responses have normalized SHA-256 and similarity shingles; source excerpts are checked against reconstructed/current source.

The initial review subject guard is intentionally retained across autofix rounds (`machine.py:976`). Mutation source capture/matching runs before and after measurement (`machine.py:3432-3622`, `mutation.capture_mutation_source_guard:766-840`); drift refuses a native ruling. These mechanisms are stronger than a bare diff checksum but do not establish a complete build-input dependency closure. Do not reuse earned proof across arbitrary edits merely because a finding fingerprint is unchanged. OMP2 should mint a new revision-bound receipt, retain old evidence as historical, and explicitly invalidate impacted objectives.

`Disposition.UNCERTAIN` is distinct from backend acquisition failure. `RealFalsifier.falsify` propagates exhausted transport/protocol failures rather than turning them into semantic uncertainty. The state machine prevents those incomplete perspectives from earning fresh clean cycles and detects repeated unavailable-provider/nonconverging cases. LOCAL round exhaustion escalates. These distinctions should be preserved in OMP2 as FAIL versus INCONCLUSIVE, rather than interpreting timeouts/skips as PASS.

## Security and operational limits

- Repository code, comments, manifests, external context and model replies are untrusted. Matching a quoted line does not defeat prompt injection. Reviewer instructions and trusted gate policy must remain outside retrieved content authority.
- `exec_falsify._clean_subprocess_env:116-142` filters environment variables; that does not constitute an operating-system sandbox. Build scripts/tests can execute arbitrary code. Read-only intent in its class docstring is not proof commands cannot write.
- `mutation_engines/isolate.py` implements a Linux bubblewrap/cgroup supervisor with namespace and resource limits. This has platform/setup prerequisites and must not become an implicit mandatory service or Docker/Podman requirement for OMP2. Use OMP2's existing execution authority and expose unavailable isolation as policy-dependent inconclusive.
- The historical assistant hook `hooks/check_git_commit_review.sh:1-35` accepts documented bypass markers (`docs`, `config`, `chore`, `wip`, `post-review-c3`), exits permissively on malformed input, and recognizes shell command text with regexes. It is not an authoritative commit boundary. Modern CLI receipt verification is a separate, stronger mechanism. OMP2 should enforce commit authority at a typed gate plus CI, never trust a comment marker.
- The backend supports CLI subprocesses and HTTP APIs; `llm_invoke` requires an explicit backend and disables implicit `claude -p` fallback. HTTP formats include OpenAI, Anthropic and Vertex paths. Optional MCP is a separate package extra/entry point (`pyproject.toml:28-80`); it is not a native OMP2 tool contract.
- Source excerpts, full post-images and external context may leave the machine. Apply scope/secret filtering and explicit remote-provider policy. Invocation auditing and receipts improve accountability but are not evidence of confidentiality.
- Forge is Apache-2.0 (`LICENSE`, `pyproject.toml`), while OMP2 is MIT. Any copied implementation/prompts need attribution and notice review. Reimplementing the selected architecture against native contracts avoids mechanically importing an entire Python stack.

## Measurements and feasible verification

Existing `evidence/`, `tests/fixtures/fixpoint/`, `src/code_forge/eval/` and publication scripts supply upstream-authored experiments. For example, comments in `RealFalsifier` describe 8/20 agreement before adding diff context; `_fixpoint_reached` describes 24/28 live fingerprints appearing in only one of six rounds. These are **upstream observations**, not independently reproduced accuracy estimates, and do not prove nine passes outperform a targeted native hybrid. Synthetic freshness/receipt tests cannot estimate escaped regressions.

Attempted in this environment:

```text
cd /workspace/forge
python --version
# Python 3.12.14
python -m pytest tests/test_diff_grouping.py tests/test_consecutive_clean.py tests/test_falsify_api_shape.py -q
# exit 1: No module named pytest
```

No dependency installation or paid model calls were performed for this track. Future reproduction: create a disposable Python >=3.12 environment, install the pinned checkout's dev extra using `uv`, run the three named suites, then the full suite. For effectiveness, run original Forge with recorded backend/model/version, seed/temperature and prompts on the same frozen Rust change corpus as OMP2; collect raw receipts and actual physical request/token counts. Report adapter availability, failed prerequisites and semantic abstentions separately from clean results. Never quote README pass counts as this investigation's measurements.

A dependency-free micro-experiment **was executed** against the actual `source.py` using Python `runpy`. It demonstrates why OMP2 must not adopt normalized diff identity as a sufficient cache key; this is an identity collision, not proof a complete Forge gate accepts stale receipts (other evidence checks may reject them).

```python
# Execute this snippet with Python from the pinned Forge checkout.
import runpy
m = runpy.run_path('src/code_forge/source.py')
a = 'VALUE = """a \n"""\n'
b = 'VALUE = """a\n"""\n'
na, nb = {}, {}
exec(a, na)
exec(b, nb)
da = '--- a/x.py\n+++ b/x.py\n@@ -0,0 +1,2 @@\n+VALUE = """a \n+"""\n'
db = da.replace('a \n', 'a\n')
print('literal_values_differ:', na['VALUE'] != nb['VALUE'])
print('diff_hashes_equal:', m['compute_source_hash'](git_diff=da)
      == m['compute_source_hash'](git_diff=db))
print('normalized_source_hash:', m['compute_source_hash'](git_diff=da))
```

Observed exit 0, with `literal_values_differ: True`, `diff_hashes_equal: True`, and normalized source hash `12ae5ea3e7a1f46e5b555d6e60ba47fbc9b2b794530afdcf6bd07207a002c3e7`. These are synthetic local inputs; no model/latency/defect-recall benchmark is implied.

## Integration decision

| Mechanism | Decision for OMP2 | Reason |
| --- | --- | --- |
| Whole Forge CLI/MCP | Keep optional evaluation/interoperability adapter | Fast baseline and fidelity; adds Python/config/backend/state duplication and multiplies context traffic. |
| Perspective prompts | Redesign as targeted configurable reviewers | Preserve useful adversarial coverage without hardcoding nine calls or pretending model independence. |
| Clean-credit algorithm | Retain as comparison policy, do not silently port as equivalent to A1–C3 | Current semantics include severity/density and distinct CI behavior. |
| Receipt acceptance, source anchoring, explicit incompleteness | Port concepts to native typed receipts | Strong defense against fabricated/stale claims; reuse OMP2 journal/CAS instead of another mutable state directory. |
| Deterministic tools and mutation providers | Reuse native OMP2 execution; optional external tool adapters | Avoid duplicate process/sandbox/credential/control planes. |
| Python def-use grouping | Replace with conservative native AST/LSP impact plus fallback | Useful heuristic, insufficient for Rust semantics; never mark unknown callers unaffected. |
| Prefix layout and usage accounting | Reuse idea through OMP2 AI layer | Cache-friendly ordering complements, rather than replaces, demand-driven evidence loading. |
| Comment-marker commit hooks | Discard as authoritative enforcement | Bypassable and outside typed source-bound gate authority. |
| Model-only falsification | Retain as investigation, require executable/source evidence for decisive claims | A second model's agreement is not proof and cannot waive required checks. |

Recommended adaptation: native OMP2 orchestration with pluggable deterministic/semantic providers. First preserve current runtime contracts, add a revision-bound deterministic receipt for selected existing checks, then add focused semantic investigation and native validation. Compare it to unmodified Forge before replacing any promised multi-perspective behavior.
