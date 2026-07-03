
# TECHNICAL SPECIFICATION: Agentic MapReduce for LLM Workflows
## Cognition's Devin Security Swarm + arXiv Research Landscape

**Date:** July 3, 2026
**Scope:** Full architectural spec of Cognition's Agentic MapReduce as deployed in Devin Security Swarm, plus a survey of related arXiv research on MapReduce-style workflows for LLM tasks.

---

## PART 1: COGNITION'S AGENTIC MAPREDUCE (Devin Security Swarm)

### 1.1 Problem Statement

Most coding agent tasks are **local**: fix a bug, add an endpoint, refactor a module. A single agent with a shell, grep, and read can handle these. A different class of work requires reasoning over the **entire codebase**: security scanning, code-quality enforcement, breaking-change detection, large-scale migration. These whole-codebase tasks share a defining property: **the result is only trustworthy if the entire codebase was considered.**

Three failure modes occur when pointing a single search-driven agent at a large repo (e.g., 50k files) for a whole-codebase task:

1. **Agent spends most budget finding work, not doing it.** The agent greps, opens wrong files, backtracks, and re-decides what to inspect next. On large repos, selection dominates analysis. Zhang et al. (2026) analyzed 300 coding-agent trajectories and found that reading and searching consumed 56.2% of tool-use turns and 46.5% of main-agent tokens [source: arXiv:2606.14066].

2. **Context becomes a shared bottleneck.** A long-running agent carries discoveries from one part of the repo while reasoning about the next. As the run grows, unrelated evidence competes for attention and context budget.

3. **No explicit coverage boundary.** A search-driven agent stops when it decides it is done — not when a finite work queue has been exhausted. Its "I've looked everywhere" claim is unfalsifiable.

### 1.2 Core Idea

Adapt the MapReduce distributed systems pattern for agents. An agent synthesizes a **deterministic relevance test** (selectors). That test runs over every source file and produces a finite set of candidates. Candidates are divided into bounded batches, investigated in parallel by child agents, and reduced into a single result.

**Key inversion from classic MapReduce:** In classic MapReduce, handwritten instructions process the entire input. In Agentic MapReduce, an **agent decides what matters** for the current codebase given the task, then a **deterministic pass** finds every instance of it.

**Design principle:** Put agents where reasoning is required (synthesizing the decomposition function, inspecting shards, reducing results). Everything else is deterministic.

### 1.3 Architecture: Four Stages

| Stage       | What Happens                                                                 | Agentic?   |
|-------------|------------------------------------------------------------------------------|------------|
| **Plan**    | An agent studies the repo and authors selectors — patterns identifying relevant code | **Yes**    |
| **Shard**   | The selector runs deterministically over the entire repo; matches bucketed into bounded batches | No         |
| **Map**     | One agent per batch, in parallel, does real per-shard reasoning             | **Yes**    |
| **Reduce**  | An agent groups, dedupes, and synthesizes per-shard outputs into a final answer | **Yes**    |

#### 1.3.1 Plan Stage (Agentic)

The planner studies the repo and produces **selectors**: relevance tests concrete enough to run deterministically over the whole codebase, with **no model in the loop**. Reasoning is spent once, when the selectors are authored.

A selector's language depends on task and codebase. Possible forms:
- **Tree-sitter query** over syntax nodes
- **Compiler query** over symbols and types
- **Traversal** of an import or call graph
- **Comparison** of generated API schemas
- **Lexical pattern** for repository-specific convention

| Task                         | Example Selectors                                                              |
|------------------------------|--------------------------------------------------------------------------------|
| Security Scanning            | Route declarations, auth boundaries, deserialization entry points, dangerous API calls |
| Breaking-Change Detection    | Compare exported symbols or generated API schemas, select affected consumers   |
| Code-Quality Enforcement    | Query syntax trees for deprecated APIs or project-specific anti-patterns       |
| Large-Scale Migration        | Traverse imports and references to find every caller of the interface being replaced |

Selectors are **persisted** for reuse on future runs. Completeness rests on selector recall: a file that matches no selector never reaches a worker. This trade is deliberate — selectors are inspectable, version-controlled artifacts that can be tested against known examples and tuned, whereas a search agent's "I've looked everywhere" is unfalsifiable.

#### 1.3.2 Shard Stage (Deterministic)

Selectors run deterministically against the codebase. Each match emits a **signal**: a compact record of:
- Where the match occurred (file, line)
- Which selector produced it
- What evidence triggered it

Files that emit no signals are **dropped** from consideration and never reach the expensive Map stage. Signals from matching files are grouped into **bounded batches**. The Devin orchestrator assigns each batch to a fresh child worker session for analysis.

**Coverage guarantee:** The deterministic pass produces a finite work queue, every shard is assigned to an investigation agent, and the scan is complete only when that queue is exhausted.

#### 1.3.3 Map Stage (Agentic, Parallelized)

Each Map worker is a **child Devin session** that starts with focused context:
- One bounded shard
- Provenance: which selector fired, on what evidence

The worker investigates every candidate in the shard, reading whatever surrounding code it needs to reach a verdict, and emits a **structured result**: zero or more findings. Workers run **independently and in parallel**.

No single agent searches the entire repo while carrying an ever-growing record of unrelated discoveries. Each worker reasons from a focused context for one bounded shard.

#### 1.3.4 Reduce Stage (Agentic)

A Reducer session aggregates results, **only considering outputs from workers that produced findings**. Workers with zero findings are ignored. The Reducer:
- Consumes structured outputs (not full transcripts or raw code)
- Deduplicates overlapping results
- Reconciles local conclusions
- Applies **global prioritization** to produce one coherent result

The Reducer can also identify **relationships that cross shard boundaries**. For a security scan, it can examine whether several identified exploits across shards can be chained together for a more severe attack path. For breaking-change detection, it can group affected call sites from many shards under the API change that caused them and produce one migration plan.

**Cost efficiency:** Tokens are spent only on candidates that survive selectors, and only on one bounded shard at a time. Cost tracks the amount of relevant code, not the size of the repo the agent had to wade through. The Reducer compounds savings by reasoning over compressed conclusions rather than full transcripts.

**Incremental re-runs:** As a codebase evolves, re-runs process only files that changed since the last commit scanned — you pay for the diff, not a full pass.

### 1.4 Security Swarm: Five-Stage Implementation

Devin Security Swarm is the first production implementation of Agentic MapReduce, applied to security scanning. A scan runs as five stages:

#### Stage 1 — Plan: The Threat Model (Agentic)

A Devin session studies the repository and writes the **rules** for this codebase:
- Patterns for routes
- Data layer
- Auth wrappers
- Deserialization sinks

Swarm surfaces these as an editable **threat model**. Users can read every rule and, on an interactive scan, adjust it before the swarm fans out.

#### Stage 2 — Shard: Signals and Batches (Deterministic)

The rules run deterministically over the entire repo. Every match emits a signal. Files that match nothing are dropped. The rest are bucketed into bounded batches.

#### Stage 3 — Map: The Swarm (Agentic, Parallel)

One child Devin session per batch, in parallel, each from a fresh, focused context: its batch's signals and the rule provenance behind them. A worker:
- Reads the real code
- Clears a false-positive gate
- Reports findings with severity, confidence, and preconditions
- Accounts for every file it was handed

#### Stage 4 — Reduce: Triage and Chains (Agentic)

A reducer session consumes the workers' findings (their conclusions, not transcripts):
- Deduplicates findings
- Attributes ownership
- Triages each into **P0 / P1 / P2**
- With the global view no single worker had, composes **attack chains** across shards (e.g., an unauthenticated ID leak + an ID-gated RCE → one P0 unauthenticated RCE)

#### Stage 5 — Verify: Runtime Proof (Agentic, Parallel)

The orchestrator fans out once more, this time over findings. One sandboxed session per serious finding:
- Reproduces the exploit against a running build
- Records result as **Confirmed**, **False Positive**, or **Inconclusive**
- Confirmed findings can be handed back to Devin to fix, opening a remediation PR

### 1.5 Benchmark Results

Evaluated against 50 real-world vulnerabilities from the GitHub Security Advisory (GHSA) database, each pinned to the exact commit before the fix landed. Spans 14+ languages and vulnerability classes: RCE, SSRF, path traversal, auth bypass, unsafe deserialization, decompression-bomb DoS, and more.

| Harness          | Recall | Cost/Run   |
|------------------|--------|------------|
| Devin Security   | 72%    | $90.23     |
| Claude Security  | 68%    | $131.87    |
| Codex Security   | 48%    | $118.20    |
| Cursor Security  | 26%    | $4.60      |

Only Devin found three critical vulnerabilities other tools missed:
- PHP sandbox bypass via template injection
- Argument injection through metadata value parsing
- Overly broad deserialization surface in Spring Kafka

### 1.6 Product Features

- **Scan profiles:** Devin generates scan profiles from existing threat model documentation, tailors them to specific attacker personas, applies across organization without per-repo config or CI setup.
- **Batch size:** Configurable per profile, giving direct control over depth and cost.
- **Scheduling:** Daily, weekly, or custom schedule. First full scan establishes baseline; subsequent scans process only code that changed.
- **Finding lifecycle:** Findings connect to Devin remediation — Devin writes patches, opens PRs. Next scan checks whether the fix resolved the issue.
- **BYO scanner:** Customers can give Devin access to existing scanners; Devin helps with validation, dedup, attack-chain composition, prioritization, and remediation.
- **Runtime validation:** Optional (enabled via scan profile). Returns Confirmed / False Positive / Inconclusive. Inconclusive = needs human review.
- **Devin Security Program:** Six-week engagement. Cognition's forward-deployed engineering team embeds to burn down CVE backlog and set up continuous remediation.

### 1.7 Security Swarm vs. Skills

Skills are prompts. Swarm is an **orchestration layer** of Devins coordinated through Agentic MapReduce. Swarm provides:
- Dynamic repo slicing
- Parallel investigation
- Completion management
- Cost-aware batching
- Incremental scans
- Reducer-based dedupe and prioritization
- Optional runtime validation per finding
- Scan profiles
- Finding lifecycle connected to Devin remediation

### 1.8 Generalizability

Security scanning is the first application. The pattern fits any task where a verdict is only trustworthy if the whole codebase was in view: code-quality enforcement, breaking-change detection, large-scale migration, and more.

---

## PART 2: arXiv RESEARCH ON MAPREDUCE-STYLE WORKFLOWS FOR LLM TASKS

### 2.1 A-MapReduce: Executing Wide Search via Agentic MapReduce

**Paper:** arXiv:2602.01331 (January 2026)
**Authors:** Mingju Chen, Guibin Zhang, Heng Chang, Yuchen Guo, Shiji Zhou

**Problem:** LLM-based multi-agent systems excel at deep research tasks but struggle with **wide search** — tasks requiring parallel exploration of massive retrieval targets (e.g., broad information-seeking queries).

**Approach:** A-MapReduce recasts wide search as a **horizontally structured retrieval problem**:
- **Map:** Parallel processing of massive retrieval targets through task-adaptive decomposition
- **Reduce:** Structured result aggregation
- Uses **experiential memory** to drive continual evolution of query-conditioned task allocation and recomposition, enabling progressive improvement

**Results:** State-of-the-art on WideSearch and DeepWideSearch benchmarks. 5.11%–17.50% average Item F1 improvements over baselines with OpenAI o3 or Gemini 2.5 Pro. 45.8% reduction in running time compared to representative multi-agent baselines.

**Key distinction from Cognition's work:** A-MapReduce focuses on information retrieval / wide search, while Cognition's Agentic MapReduce focuses on whole-codebase code analysis.

---

### 2.2 LLM×MapReduce (V1 / V2 / V3): Survey Generation

**Paper V3:** arXiv:2510.10890 (October 2025)
**Paper V2:** arXiv:2504.05732 (April 2025)
**Repository:** github.com/thunlp/LLMxMapReduce

**V1:** Utilizes a structured information protocol and in-context confidence calibration to enhance long-sequence understanding. Enabled MiniCPM3-4B to outperform 70B-scale models in long-context evaluations.

**V2 — Entropy-Driven Convolutional Test-Time Scaling:** Draws inspiration from CNNs. Uses stacked convolutional scaling layers to progressively expand understanding of input materials. Each layer integrates local features into higher-level global representations. Includes SurveyEval, a long-to-long generation benchmark for computer science surveys.

**V3 — MCP-Driven Hierarchically Modular Agent System:** Designed for long-form survey generation. Multi-agent architecture where functional components (skeleton initialization, digest construction, skeleton refinement) are implemented as independent Model-Context-Protocol (MCP) servers. Atomic servers aggregate into higher-level servers, creating hierarchical structure. A high-level planner agent dynamically orchestrates by selecting modules based on MCP tool descriptions and execution history. Supports human-in-the-loop intervention through multi-turn interaction.

**Key distinction:** LLM×MapReduce focuses on long-document synthesis and survey generation, using hierarchical MapReduce to process massive text inputs. Cognition's work focuses on codebase analysis.

---

### 2.3 ToM: Tree-Oriented MapReduce for Long-Context Reasoning

**Paper:** arXiv:2511.00489 (October 2025)
**Repository:** github.com/gjn12-31/ToM

**Problem:** Divide-and-conquer frameworks (DCF) for long-context reasoning struggle with long-range dependencies and risk inducing conflicts by processing chunks in isolation.

**Approach:** ToM leverages the **inherent hierarchical structure** of long documents (e.g., headings and subheadings):
- Constructs a **DocTree** through hierarchical semantic parsing
- Performs **bottom-up aggregation**
- **Map step:** Rationales generated at child nodes
- **Reduce step:** Rationales aggregated across sibling nodes to resolve conflicts or reach consensus at parent nodes
- Enables **recursive reasoning** up the tree

**Results:** Significantly outperforms existing divide-and-conquer frameworks and RAG methods on 70B+ LLMs, achieving better logical coherence and long-context reasoning.

**Key distinction:** ToM operates on document hierarchy (tree structure), while Cognition's approach operates on codebase structure (selector-based sharding). ToM's MapReduce is tree-recursive; Cognition's is flat-parallel with a single reduce.

---

### 2.4 Agentics 2.0: Logical Transduction Algebra for Agentic Data Workflows

**Paper:** arXiv:2603.04241 (March 2026)

**Problem:** Agentic AI is transitioning from prototypes to enterprise deployments requiring reliability, scalability, and observability beyond plausible text generation.

**Approach:** Formalizes an LLM inference call as a **typed semantic transformation** called a **transducible function** that enforces:
- Schema validity
- Locality of evidence

Transducible functions compose into larger programs via algebraically grounded operators and execute as **stateless asynchronous calls in parallel** in asynchronous Map-Reduce programs.

**Map operator:** All input states processed in parallel, returning a corresponding list of outputs (order preserved).
**Reduce operator:** Accepts a list of states, returns a single state. If input list exceeds single-prompt capacity, internally reduces into parallel asynchronous batches, aggregated in stages.

**Properties:**
- Semantic reliability through strong typing
- Semantic observability through evidence tracing between input/output type slots
- Scalability through stateless parallel execution

**Evaluation:** State-of-the-art on DiscoveryBench (data-driven discovery) and Archer (NL-to-SQL semantic parsing).

**Key distinction:** Agentics 2.0 provides a formal algebraic framework for Map-Reduce composition of LLM calls, focusing on type safety and evidence tracing. It is a general-purpose framework, not domain-specific.

---

### 2.5 Scepsy: Serving Agentic Workflows Using Aggregate LLM Pipelines

**Paper:** arXiv:2604.15186 (April 2026)

**Problem:** Agentic workflows chain multiple LLMs and tools, branch and recur based on data, and have unpredictable end-to-end latencies. Serving them efficiently on GPU clusters is hard.

**Key Insight:** While end-to-end latencies are unpredictable, each LLM's **share** of total execution time is **stable across runs**.

**Approach:** Scepsy exploits this insight:
1. Profiles LLMs under different parallelism settings
2. Builds an **Aggregate LLM Pipeline** — a lightweight latency/throughput predictor for any proposed GPU allocation
3. Searches over fractional GPU shares, tensor parallelism degrees, and replica counts to find allocation that hits target throughput with minimum latency
4. Places allocation on cluster with topology-aware heuristic minimizing fragmentation

**Results:** Up to 2.4x higher throughput and 27x lower latency compared to systems that optimize LLMs independently or rely on user-specified allocations.

**Key distinction:** Scepsy addresses the **infrastructure/serving** problem for MapReduce-style agentic workflows — how to efficiently schedule them on GPU clusters. Complementary to the algorithmic contributions of the other papers.

---

### 2.6 LLM Map-Reduce Pattern (Agentic Patterns)

**Source:** agentic-patterns.com/patterns/llm-map-reduce-pattern

A pattern-level description (not a research paper) for security-conscious Map-Reduce with LLMs:

**Map:** Spawn lightweight, sandboxed LLMs — each ingests one untrusted chunk and emits a constrained output (boolean, JSON schema, enum).

**Reduce:** Aggregate validated summaries via deterministic code (count, filter, majority-vote) or a privileged LLM that sees only sanitized fields.

**Core control:** Isolation. Each map worker handles one item with constrained output contracts, so contamination cannot spread laterally. The reducer consumes validated summaries only.

**Best fit:** N ≥ 10 items, processing time > 30s/item, items are independent, and aggregation is needed. Use cases: file triage, document summarization, resume filters, code migration verification.

**Pros:** Malicious item can't taint others; scalable parallelism; smaller contexts reduce cost.
**Cons:** Requires strict output validation; extra orchestration overhead; loses cross-item context.

---

## PART 3: CROSS-CUTTING COMPARISON

### 3.1 Architecture Comparison

| System                 | Domain              | Map Unit              | Reduce Strategy                  | Determinism                | Key Innovation                              |
|------------------------|---------------------|-----------------------|----------------------------------|----------------------------|---------------------------------------------|
| Cognition Agentic MR   | Codebase security   | Selector-matched shard | Cross-shard attack chain composition | Selector pass (Plan→Shard) | Agent-authored deterministic selectors      |
| A-MapReduce            | Wide search/retrieval | Retrieval target    | Structured aggregation + experiential memory | Task-adaptive decomposition | Memory-driven continual evolution           |
| LLM×MapReduce V2/V3   | Survey generation   | Document/text chunk   | Convolutional layers / MCP orchestration | Hierarchical planning      | Convolutional test-time scaling; MCP modularity |
| ToM                    | Long-context reasoning | Document tree node | Bottom-up sibling consensus       | DocTree construction       | Tree-recursive reasoning over document hierarchy |
| Agentics 2.0           | General data workflows | Typed input state  | Algebraic reduce over typed states | Strong typing enforcement  | Logical transduction algebra; type safety   |
| Scepsy                 | Infra/serving      | LLM inference call    | N/A (scheduling)                  | GPU allocation search      | Aggregate LLM Pipeline predictor             |
| LLM Map-Reduce Pattern | Security-conscious processing | Untrusted chunk | Deterministic code / privileged LLM | Sandboxed isolation       | Containment of malicious input influence     |

### 3.2 Shared Principles

1. **Decomposition before reasoning:** All approaches decompose large inputs before applying LLM reasoning, rather than feeding everything into one context window.

2. **Parallel map, serial reduce:** The Map phase is always parallelizable; the Reduce phase requires a single coherent aggregation step.

3. **Cost control through bounded context:** Each worker operates on a bounded, focused context rather than the full input, reducing token costs and context window pressure.

4. **Determinism where possible:** Cognition uses deterministic selectors; Agentics 2.0 uses strong typing; the LLM Map-Reduce Pattern uses deterministic aggregation code. The pattern is: keep deterministic operations deterministic, use agents only where reasoning is needed.

5. **Cross-shard/cross-chunk reasoning at reduce time:** Multiple approaches (Cognition, A-MapReduce, ToM) use the Reduce stage to identify relationships that individual map workers could not see — attack chains, consensus, or global patterns.

6. **Incremental re-runs:** Cognition processes only changed files; LLM×MapReduce V2 uses convolutional layers that can be cached; the pattern supports re-processing only deltas.

---

## PART 4: OPEN QUESTIONS AND RESEARCH GAPS

1. **Selector recall measurement:** Cognition acknowledges completeness rests on selector recall, but does not provide a formal method for measuring or guaranteeing selector recall.

2. **Cross-shard information loss:** While the Reducer can compose attack chains, workers operate in isolation. Findings that require simultaneous reasoning across shards (not just post-hoc composition) may be missed.

3. **Formal coverage guarantees:** No approach provides formal mathematical guarantees of coverage completeness. Cognition's "finite work queue exhaustion" is an engineering guarantee, not a proof.

4. **Adversarial robustness:** The LLM Map-Reduce Pattern addresses malicious input isolation, but Cognition's approach does not discuss adversarial codebases (e.g., deliberately obfuscated code designed to evade selectors).

5. **Multi-modal MapReduce:** All surveyed approaches operate on text/code. Extending to multi-modal inputs (images, binary artifacts, runtime traces) for security analysis is unexplored.

6. **Dynamic re-planning:** Cognition's Plan stage runs once per scan. If selectors prove inadequate mid-scan (e.g., a new vulnerability class is discovered), there is no mechanism for dynamic re-planning.

7. **Resource-aware scheduling integration:** Scepsy addresses GPU scheduling but does not integrate with the semantic MapReduce architectures. Combining Scepsy's infrastructure optimization with Cognition's or A-MapReduce's algorithms is an open direction.

---

## REFERENCES

### Cognition / Devin Sources
- Devin Blog: "Agentic MapReduce" (devin.ai/blog/agentic-map-reduce, July 1, 2026)
- Cognition Blog: "Introducing Devin Security Swarm" (cognition.com/blog/introducing-devin-security-swarm, July 1, 2026)
- Devin Security Page (devin.ai/security/)
- PR Newswire: "Cognition Launches Devin Security Swarm" (June 30, 2026)
- ZenML LLMOps Case Study: "Agentic MapReduce for Whole-Codebase Security Scanning"
- Reddit r/CognitionLabs: "Introducing Devin Security Swarm" (July 2, 2026)

### arXiv Papers
- A-MapReduce: arXiv:2602.01331 (Jan 2026) — Wide search via agentic MapReduce
- LLM×MapReduce-V3: arXiv:2510.10890 (Oct 2025) — MCP-driven survey generation
- LLM×MapReduce-V2: arXiv:2504.05732 (Apr 2025) — Convolutional test-time scaling
- ToM: arXiv:2511.00489 (Oct 2025) — Tree-oriented MapReduce for long-context reasoning
- Agentics 2.0: arXiv:2603.04241 (Mar 2026) — Logical transduction algebra
- Scepsy: arXiv:2604.15186 (Apr 2026) — Serving agentic workflows with aggregate LLM pipelines
- Zhang et al., FastContext: arXiv:2606.14066 (2026) — Coding agent trajectory analysis

### Other
- Agentic Patterns: "LLM Map-Reduce Pattern" (agentic-patterns.com)
- LangGraph Map-Reduce pattern (LinkedIn, Sep 2025)
