# Stream C — Structured operations vs sHEL

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff` (2026-11-16 UTC).  
Auditors: [Audit shell structured ops](bc-a0b48f6f-eff1-5b14-ad30-a5585b30003a), [Audit structured ops sHEL](bc-335a8f37-37e9-5811-b7d0-9a20d4ab5005).  
Public materials: [shel.sh](https://shel.sh/) + docs skim (2026-11-16). **sHEL was not installed or executed** here.  
Tests cited were inventoried from source; they were **not** re-run. Benchmarks: **NOT MEASURED**.

## Study

Does sHEL provide useful capabilities that OMP2’s in-process shell, builtins, and typed tool results do not already provide?

## sHEL characterization (external)

Marketing ([shel.sh](https://shel.sh/)): “literal-safe”, volatile, automation-friendly, pipe to jq/awk, cross-platform latency claims.

**Verified from public docs/repos (second auditor; still not a runtime proof):**

- Technical core targets **Windows `cmd.exe` literal-safety** (Base64, delayed expansion, `FOR /F`, `findstr`, clipboard encodings) — not Unix JSON/NDJSON pipelines.  
- Install surface is a **multi-repo AGPL workstation** (F# ORC, PowerShell tools, preview GUI); Linux dry-run wants .NET/PowerShell/Ruby — not a drop-in `shel` JSON CLI.  
- `shel` absent on PATH in this environment; install dry-run only; **no sHEL transform engine exercised**.  
- **No sHEL source, crate, or import at the pin** (zero `sHEL`/`SHEL` hits in production source).

Domain mismatch: OMP2’s hazard is bash/sandbox under ADR 0028; sHEL’s documented problem is cmd special-character syntax. That is not an OMP2 structured-ops gap.

## Native inventory (IV unless noted)

| Capability | Owner | Decision |
|---|---|---|
| In-process Bash | `omp-shell`; envd registers builtins | **REUSE** |
| Native `jq` (jaq) | `jq.rs` CLI front-end ported from jaq **2.3.0 docs**; locked crates **jaq-core 2.2.1 / jaq-std 2.1.x / jaq-json 1.1.x** (EGM G3); `factory.rs` | **REUSE** |
| jq streaming / multi-doc / NDJSON-shaped work | jaq iterators; `-s` slurp | **REUSE**; **DEFER** separate stream engine |
| Text filters (`sed`/`cut`/`tr`/`sort`/`uniq`/`grep`/`rg`) | shell-builtins | **REUSE** (`awk` absent) |
| Path policy / host-safe jq overrides | ReadOpener, PathPolicy; env/halt/debug overrides | **REUSE** |
| Shell tool spill / projection | `bash@2`, envd live capture + `artifact://` spill | **REUSE** |
| Minimizer jq filter | Defs/tests in `omp-minimizer` **IV**; live owner `envd/src/exec.rs` (`is_single_cargo_command` / `minimize_cargo_output`) — **cargo-only** (EGM G7) | **REUSE** crate; **DEFER** live jq minimize |
| `omp_core::slopjson` | Tolerant tool-arg JSON (`MAX_DEPTH=128`) | **REUSE** for args; **REJECT** as query language |
| YAML/TOML/CSV as transform language | **A** (serde_yaml for config/import only) | **DEFER** yq-like unless measured need |
| Dedicated non-bash structured-ops tool | **A** | **DEFER**; prefer bash+`jq` first |
| Embedded sHEL / second interpreter | **A** | **REJECT** without measured gap |

### Security notes (source-traced)

- Hidden-root `PathPolicy` refuses unsafe `jq` file/`--rawfile` operands (tests present).  
- Filters remain jq expressions inside bash strings — shell injection surface is the bash tool, not “structured input eliminates injection.”  
- No hard memory cap inside the jq builtin; cancel checked between values — **EXTEND** host bounds if abuse observed.

## Alternatives (A–E)

| Option | Tentative |
|---|---|
| A. Existing OMP2 (bash+jq) | **Default absent a measured gap** — not a proof of “sHEL workload coverage” |
| B. Improve native Rust builtins | **EXTEND** only for proven gaps (bounds, missing filters) |
| C. Small structured transform tool | **DEFER** |
| D. Optional external sHEL | **DEFER** comparison baseline only; do not productize without measurement |
| E. Embedded pipeline engine | **REJECT** unless A–B fail measured workloads |

## Recommendations

1. **REUSE** in-process `jq` + bash + spill/projection as the structured-ops path.  
2. **REJECT** embedding sHEL or any second shell/data interpreter without a measured failure of native `jq`/builtins.  
3. **DEFER** live minimizer wiring for jq (cargo-only policy looks intentional).  
4. **DEFER** YAML/CSV query builtins until a concrete workload demands them.  
5. Any later benchmark must verify correctness first; publish numbers only when run — until then mark **NOT MEASURED**.

## Non-goals

- Do not add another shell interpreter “for completeness.”  
- Do not treat `slopjson` as a general query/transform engine.  
