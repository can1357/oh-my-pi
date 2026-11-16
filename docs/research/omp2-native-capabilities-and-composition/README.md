# OMP2 native capabilities and composition

Status: research in progress (Elephant coordinator)  
Program: Native Extensibility, Agent Skills Capabilities, Reproducible Experts and Structured Operations  
Decision framework: Elephant–Goldfish Model (vendored instructions; not auto-invoked)  
Do not merge production behavior from this tree without an authorized ADR/slice.

## Source pin

| Field | Value |
|---|---|
| Repository | `blyzer/oh-my-pi` |
| Branch inspected | `omp2` tip at program start |
| Commit SHA | `a8762fd997ca754b30ea7d3344cbd5c656aa5dff` |
| Inspection date (UTC) | 2026-11-16 |
| Working branch | `cursor/research-native-capabilities-composition-632b` |
| Prior audit (reference only) | `docs/research/omp2-hybrid-verification/01-current-capability-audit.md` at older SHA `9cb6fd6389` — re-verify claims against the pin above |

## Harness capability report (this Cloud Agent / Cursor environment)

This run is **not** Claude Code, Codex, or a live OMP2 session. The user prompt
frames the role as “Grok”; the actual host is Cursor Cloud Agent with the tools
listed below. SKILL.md files are instructions to read; they are not auto-loaded
here unless the host discovers them. Vendored EGM skills are prompt packs
([EGM-PROVENANCE.md](../../../.claude/skills/EGM-PROVENANCE.md)); Goldfish
isolation is available via Cursor `Task` subagents with fresh context, not via
Claude plugin `omitClaudeMd`.

| Capability | Available | Actual interface | Limitations |
|---|---|---|---|
| Repository reading | Yes | `Read`, `Grep`, `Glob`, shell `git` | Large files need bounded reads; LSP optional |
| Source editing | Yes | `Write`, `StrReplace`, shell git | Editing-discipline rules in AGENTS.md |
| Shell execution | Yes | Shell tool | Network egress may be restricted |
| Test execution | Yes | `just` / `cargo nextest` | Heavy e2e/macOS Seatbelt may be unavailable |
| GitHub writes | Partial | `ManagePullRequest` create/update; push via git | `gh` is read-only; no merge |
| Skill invocation | Manual | Read `.claude/skills/*/SKILL.md` and apply | No automatic skill registry refresh in this harness |
| Isolated subagents | Yes | Cursor `Task` (`explore`, `egm-*`, etc.) | Not OS sandbox of reviewer tools unless host enforces |
| Native OMP2 hook execution | No | Inspect source/tests only | Cannot claim a hook ran unless omp process proves it |
| External standards fetch | Yes | `WebFetch` / MCP where allowed | Third-party repos need explicit clone/fetch |

## Document index

| File | Role |
|---|---|
| [00-harness-and-authority.md](00-harness-and-authority.md) | Capability report + authority boundaries |
| [01-current-architecture.md](01-current-architecture.md) | Source-pinned composition (in progress) |
| [02-agentskills-compliance.md](02-agentskills-compliance.md) | Stream A |
| [03-model-tool-requirements.md](03-model-tool-requirements.md) | Stream A continuation |
| [04-native-hooks-and-pluggy.md](04-native-hooks-and-pluggy.md) | Stream B |
| [05-structured-operations-shel.md](05-structured-operations-shel.md) | Stream C |
| [06-expert-package-composition.md](06-expert-package-composition.md) | Stream D |
| [07-unified-capability-matrix.md](07-unified-capability-matrix.md) | Cross-stream matrix |
| [08-architecture-alternatives.md](08-architecture-alternatives.md) | Alternatives |
| [09-egm-design-review.md](09-egm-design-review.md) | Goldfish findings |
| [10-decisions-and-rationale.md](10-decisions-and-rationale.md) | Owner-facing decisions |
| [11-p0-p1-p2-roadmap.md](11-p0-p1-p2-roadmap.md) | Roadmap |
| [12-security-and-trust.md](12-security-and-trust.md) | Trust |
| [13-conformance-and-test-plan.md](13-conformance-and-test-plan.md) | Tests |
| [14-benchmark-results.md](14-benchmark-results.md) | Benchmarks (measured only) |
| [15-implementation-results.md](15-implementation-results.md) | Landed slices |
| [16-open-questions.md](16-open-questions.md) | Unresolved |

## Streams

1. **A** — Agent Skills compliance and requirement metadata — **recorded** (`02`, `03`)  
2. **B** — Native hook phases vs Bub/Pluggy-style middleware — **recorded** (`04`, REJECT second middleware stack)  
3. **C** — Structured ops vs sHEL — **recorded** (`05`, REJECT embed sHEL; REUSE in-process jq)  
4. **D** — Expert packages vs skills + ADW + extensions — **recorded** (`06`, REJECT ExpertPackage)  

## Authorization gate

No production runtime change lands until:

1. Source-bound matrix and recommendations exist.  
2. EGM Goldfish review is recorded (or isolation limitation is explicit).  
3. Owner answers open decisions in [16-open-questions.md](16-open-questions.md) / ADR process.  
4. A bounded slice is authorized via ADR/TASKS where required.

## Related existing research (reuse, do not duplicate)

- `docs/research/omp2-hybrid-verification/` — capability audit (older pin)  
- `docs/research/omp-v1-vs-omp2-architecture.md`  
- ADR 0024 (tool roster), 0036 (Python extensions), 0049 (tiers), 0015 (Directors)
