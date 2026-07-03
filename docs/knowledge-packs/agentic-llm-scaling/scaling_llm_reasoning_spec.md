
# TECHNICAL SPECIFICATION: Scaling LLM Reasoning
## Part A: MapReduce-Style LLM Workflows | Part B: Tree-of-Thoughts Scaling

**Date:** July 3, 2026
**Scope:** Two independent engineering specifications — one for MapReduce-style LLM workflows (scaling over large inputs), one for Tree-of-Thoughts reasoning (scaling deep reasoning on single problems). A brief hybrid recommendation is included at the end.

---

# PART A: MAPREDUCE-STYLE LLM WORKFLOWS

## A.1 Problem Domain

MapReduce-style LLM workflows address tasks where the bottleneck is **scale of input**, not reasoning depth. The goal is to let LLMs and agents process huge amounts of data — massive documents, whole codebases, wide search targets, or large collections of items — efficiently and reliably at inference time.

Representative systems and their domains:
- **LLM×MapReduce** (V1/V2/V3): Long-text processing and academic survey generation over massive corpora.
- **A-MapReduce**: Wide information search over many retrieval targets.
- **Cognition Agentic MapReduce**: Whole-codebase security scanning and analysis.
- **Agentics 2.0**: General-purpose typed data workflows with Map-Reduce composition.
- **Scepsy**: GPU-cluster serving infrastructure for multi-LLM agentic workflows.

## A.2 Core Architecture

All MapReduce LLM workflows share a three-phase pattern:

### A.2.1 Map (Divide)

The input is decomposed into bounded units:
- **Chunk-based**: Long text split into overlapping chunks (LLM×MapReduce V1).
- **Selector-based**: Codebase matched against deterministic selectors to produce shards (Cognition).
- **Retrieval-target-based**: Wide search targets decomposed by task-adaptive rules (A-MapReduce).
- **Typed-state-based**: Input states processed as typed transducible functions (Agentics 2.0).

Each unit is processed **independently and in parallel** by a worker LLM or agent. The worker operates in a **bounded, focused context** — it never sees the full input, only its assigned unit plus provenance.

**Worker output is structured**: a summary, digest, finding, score, or typed state. Raw transcripts are not passed downstream.

### A.2.2 Intermediate Structure

Between Map and Reduce, several systems add structural layers:

- **LLM×MapReduce V2**: Stacked "convolutional" scaling layers progressively integrate local features into higher-level global representations, analogous to CNN feature hierarchies. Each layer's output feeds the next, building from local chunk summaries to section-level to document-level synthesis.
- **Cognition**: Signals (compact records of selector match location + evidence) are grouped into bounded batches before assignment to workers.
- **ToM (Tree-oriented MapReduce)**: Constructs a DocTree from document hierarchy; Map operates at leaf level, Reduce aggregates up the tree.

### A.2.3 Reduce (Aggregate)

A dedicated reducer aggregates all worker outputs into a single coherent result:
- **Deterministic aggregation**: Count, filter, majority-vote, or type-checked merge (LLM Map-Reduce Pattern, Agentics 2.0).
- **Agentic aggregation**: An LLM session deduplicates, reconciles, and synthesizes (Cognition, LLM×MapReduce V3).
- **Cross-shard composition**: The reducer can identify relationships that no individual worker could see — attack chains across codebase shards, consensus across document sections, or global patterns across retrieval targets.

**Cost principle:** Tokens are spent only on candidates that survive decomposition, and only on one bounded unit at a time. Cost tracks the amount of *relevant* data, not the total input size.

## A.3 Detailed System Specifications

### A.3.1 LLM×MapReduce (V1 / V2 / V3)

| Version | arXiv | Date | Core Innovation |
|---------|-------|------|-----------------|
| V1 | 2410.09342 | Oct 2024 | Divide-and-conquer long-sequence processing with structured information protocol and in-context confidence calibration |
| V2 | 2504.05732 | Apr 2025 | Entropy-driven convolutional test-time scaling; SurveyEval benchmark |
| V3 | 2510.10890 | Oct 2025 | MCP-driven hierarchically modular multi-agent system for interactive survey generation |

**V1 Architecture:**
- Input: Long document exceeding context window.
- Map: Document split into chunks; each chunk processed by an LLM that emits a structured digest (key facts, entity mentions, topic labels).
- Reduce: Digests aggregated via a structured information protocol; confidence calibration weights contributions.
- Result: MiniCPM3-4B outperformed 70B-scale models on long-context benchmarks.

**V2 Architecture (Convolutional):**
- Inspired by CNNs: stacked convolutional scaling layers progressively expand understanding.
- Layer 1: Chunk-level digests (local features).
- Layer 2: Section-level synthesis (integrating adjacent chunks).
- Layer N: Document-level global representation.
- Entropy-driven: Decides when to add more layers based on information-theoretic measures of output stability.
- Includes SurveyEval: a long-to-long generation benchmark for computer science surveys.

**V3 Architecture (MCP-Driven):**
- Functional components implemented as independent Model Context Protocol (MCP) servers:
  - Skeleton initialization server
  - Digest construction server
  - Skeleton refinement server
- Atomic servers aggregate into higher-level servers, creating hierarchical structure.
- A high-level planner agent dynamically orchestrates by selecting modules based on MCP tool descriptions and execution history.
- Supports human-in-the-loop intervention through multi-turn interaction.

### A.3.2 A-MapReduce (arXiv:2602.01331)

**Problem:** Wide search — tasks requiring parallel exploration of massive retrieval targets.

**Architecture:**
- **Map:** Parallel processing of retrieval targets through task-adaptive decomposition. Each target is investigated by an agent that produces structured findings.
- **Experiential Memory:** Drives continual evolution of query-conditioned task allocation and recomposition. The system learns from past runs to improve decomposition and aggregation strategies.
- **Reduce:** Structured result aggregation with deduplication and ranking.

**Benchmark Results:**
- 5.11%–17.50% average Item F1 improvements over baselines using OpenAI o3 or Gemini 2.5 Pro.
- 45.8% reduction in running time compared to representative multi-agent baselines.
- State-of-the-art on WideSearch and DeepWideSearch benchmarks.

### A.3.3 Cognition Agentic MapReduce (Devin Security Swarm)

**Four-Stage Architecture:**

| Stage | What Happens | Agentic? |
|-------|-------------|----------|
| Plan | Agent studies repo, authors deterministic selectors (tree-sitter queries, compiler queries, import-graph traversals, lexical patterns) | Yes |
| Shard | Selectors run deterministically over entire repo; matches emit signals; signals grouped into bounded batches | No |
| Map | One child Devin session per batch, in parallel; each reads real code, clears false-positive gate, reports structured findings | Yes |
| Reduce | Reducer session deduplicates findings, attributes ownership, triages into P0/P1/P2, composes cross-shard attack chains | Yes |

**Security Swarm adds a fifth stage:**

| Verify | One sandboxed session per serious finding; reproduces exploit against running build; returns Confirmed / False Positive / Inconclusive; confirmed findings can trigger auto-PR remediation | Yes |

**Key Design Principle:** Put agents where reasoning is required (synthesizing selectors, inspecting shards, reducing results). Everything else is deterministic.

**Benchmark Results (50 GHSA vulnerabilities):**

| Harness | Recall | Cost/Run |
|---------|--------|----------|
| Devin Security Swarm | 72% | $90.23 |
| Claude Security | 68% | $131.87 |
| Codex Security | 48% | $118.20 |
| Cursor Security | 26% | $4.60 |

**Coverage Guarantee:** The deterministic Shard stage produces a finite work queue. Every shard is assigned. The scan is complete only when the queue is exhausted — not when an agent "decides it's done."

**Incremental Re-runs:** Subsequent scans process only files that changed since the last commit scanned.

### A.3.4 Agentics 2.0 (arXiv:2603.04241)

**Core Concept:** Formalizes an LLM inference call as a typed semantic transformation called a **transducible function** that enforces schema validity and locality of evidence.

**Algebraic Operators:**
- **Map:** All input states processed in parallel, returning a list of outputs (order preserved). Stateless asynchronous calls.
- **Reduce:** Accepts a list of states, returns a single state. If input list exceeds single-prompt capacity, internally reduces into parallel asynchronous batches, aggregated in stages.

**Properties:**
- Semantic reliability through strong typing (schema-validated inputs and outputs).
- Semantic observability through evidence tracing between input/output type slots.
- Scalability through stateless parallel execution.

**Evaluation:** State-of-the-art on DiscoveryBench (data-driven discovery) and Archer (NL-to-SQL semantic parsing).

### A.3.5 Scepsy (arXiv:2604.15186)

**Problem:** Serving agentic workflows on GPU clusters — they chain multiple LLMs, branch/recur based on data, and have unpredictable end-to-end latencies.

**Key Insight:** While end-to-end latencies are unpredictable, each LLM's *share* of total execution time is *stable across runs*.

**Architecture:**
1. Profile LLMs under different parallelism settings.
2. Build an Aggregate LLM Pipeline — a lightweight latency/throughput predictor for any proposed GPU allocation.
3. Search over fractional GPU shares, tensor parallelism degrees, and replica counts to find allocation that hits target throughput with minimum latency.
4. Place allocation on cluster with topology-aware heuristic minimizing fragmentation.

**Results:** Up to 2.4x higher throughput and 27x lower latency compared to systems that optimize LLMs independently or rely on user-specified allocations.

### A.3.6 ToM: Tree-Oriented MapReduce (arXiv:2511.00489)

**Problem:** Divide-and-conquer frameworks for long-context reasoning struggle with long-range dependencies and risk inducing conflicts by processing chunks in isolation.

**Architecture:**
- Constructs a **DocTree** through hierarchical semantic parsing of document structure (headings, subheadings).
- **Map:** Rationales generated at child (leaf) nodes.
- **Reduce:** Rationales aggregated across sibling nodes to resolve conflicts or reach consensus at parent nodes. Recursive reasoning up the tree.
- Bottom-up aggregation preserves hierarchical context that flat chunking loses.

**Results:** Significantly outperforms existing divide-and-conquer frameworks and RAG methods on 70B+ LLMs.

### A.3.7 LLM Map-Reduce Pattern (Security-Conscious)

**Map:** Spawn lightweight, sandboxed LLMs — each ingests one untrusted chunk and emits a constrained output (boolean, JSON schema, enum).

**Reduce:** Aggregate validated summaries via deterministic code (count, filter, majority-vote) or a privileged LLM that sees only sanitized fields.

**Core Control:** Isolation. Each map worker handles one item with constrained output contracts, so contamination cannot spread laterally. The reducer consumes validated summaries only.

**Best Fit:** N >= 10 items, processing time > 30s/item, items are independent, aggregation is needed.

## A.4 Shared Design Principles

1. **Decomposition before reasoning:** Large inputs are decomposed before LLM reasoning is applied.
2. **Parallel map, serial reduce:** Map phase is always parallelizable; Reduce requires a single coherent aggregation.
3. **Bounded context cost control:** Each worker operates on a focused context, reducing token costs.
4. **Determinism where possible:** Deterministic decomposition/aggregation; agents only where reasoning is needed.
5. **Cross-shard reasoning at reduce time:** Reducer identifies relationships no individual worker could see.
6. **Incremental re-runs:** Process only deltas on subsequent runs.

## A.5 Failure Modes and Mitigations

| Failure Mode | Risk | Mitigation |
|-------------|------|------------|
| Decomposition misses important parts | Selector recall gaps; chunking loses cross-boundary dependencies | Inspectable, version-controlled selectors; ToM's hierarchical approach |
| Cross-shard information loss | Workers in isolation miss multi-shard patterns | Reducer composes cross-shard relationships; convolutional layers (V2) |
| Worker output corruption | Malicious or hallucinated outputs pollute reduce | Sandboxed isolation (Map-Reduce Pattern); typed validation (Agentics 2.0) |
| No formal coverage guarantee | "Complete" is engineering claim, not proof | Cognition's finite-queue exhaustion; Agentics' type-safety enforcement |
| Infrastructure bottleneck | Many parallel LLM calls overwhelm GPU cluster | Scepsy's aggregate pipeline scheduling |

---

# PART B: TREE-OF-THOUGHTS SCALING

## B.1 Problem Domain

Tree-of-Thoughts (ToT) addresses tasks where the bottleneck is **reasoning complexity on a single problem**, not data scale. The goal is to improve the quality and robustness of multi-step reasoning by exploring multiple reasoning paths, evaluating progress, and backtracking from errors.

**Origin:** ToT was introduced by Yao et al. (NeurIPS 2023) as a generalization of Chain-of-Thought (CoT) prompting that breaks the "token-level, left-to-right decision-making barrier" of autoregressive LLMs.

**Generalization hierarchy:** CoT (linear) → ToT (tree) → GoT (graph). Each adds structural flexibility.

## B.2 Core Architecture

ToT frames problem-solving as a **search over a tree of reasoning states**. The tree is a graph G = (V, E) where:
- Nodes V are **states** (partial solutions or intermediate thoughts).
- Edges E are **transitions** between states based on generated thoughts.

### B.2.1 Thought Generation

At any given node, the LLM is prompted to generate k distinct potential next steps ("thoughts"). Two strategies:

- **Independent Sampling (I3 / Sampling):** Generate k thoughts from the same state via repeated sampling with temperature variation. Best for open-ended tasks (creative writing, brainstorming) where diversity matters.
- **Sequential Proposal (Propose):** Generate thoughts sequentially, each building on previous context. Best for structured problems (math, puzzles) where systematic exploration is needed.

**Thought granularity** is task-dependent:
- Game of 24: One arithmetic operation (e.g., "5 + 7 = 12").
- Creative Writing: One sentence or paragraph.
- Crosswords: One letter placement.

### B.2.2 State Evaluation

Each generated thought leads to a new potential state. The system evaluates the quality or promise of states to guide search:

- **Independent Evaluation (Value):** The LLM assigns a score (e.g., 1-10) or classification (sure / likely / impossible) to each state independently.
- **Comparative Voting (Vote):** Multiple states are presented together; the LLM votes for the most promising one. Better for subjective tasks (creative writing) where absolute scoring is difficult.

**Evaluation can be:**
- LLM self-evaluation (prompt the model to assess its own outputs).
- External verifier (a separate model or program checks correctness, e.g., for math).

### B.2.3 Search Algorithms

With generated thoughts and evaluated states, a search algorithm traverses the tree:

- **Breadth-First Search (BFS):** Explores all states at each level before going deeper. Keeps b best states per level (beam width b). Best for problems with limited depth and a small initial set of states.
- **Depth-First Search (DFS):** Explores one branch deeply before backtracking. Backtracks when a state is evaluated as impossible or when a subtree is exhausted. Best for complex problems with a larger search space.
- **Beam Search:** Keeps only top-k states at each level, pruning the rest. More efficient than BFS. Used in AG2's ReasoningAgent implementation.
- **A* / Best-First Search:** Uses evaluation scores as heuristics to prioritize exploration. Most efficient when evaluations are reliable.

**Search continues until:** A goal state is reached, computation budget is exhausted, or no promising branches remain.

## B.3 Detailed System Specifications

### B.3.1 Original ToT (Yao et al., NeurIPS 2023)

**Paper:** arXiv:2305.10601
**Repository:** github.com/princeton-nlp/tree-of-thought-llm

**Four-Question Framework:**

| Question | Answer |
|----------|--------|
| 1. How to break down the task into steps? | Define thought granularity (task-specific: operation, sentence, letter) |
| 2. How to generate ideas for each step? | Independent sampling (k samples) or sequential proposal |
| 3. How to evaluate a step? | Independent value assessment or comparative voting |
| 4. What search algorithm to use? | BFS (bounded width b) or DFS (with backtracking) |

**Benchmark Tasks and Results:**

| Task | CoT Success | ToT Success | Improvement |
|------|-----------|-------------|-------------|
| Game of 24 | 4% (GPT-4) | 74% | 18.5x |
| Creative Writing (Coherence) | ~60% | ~70% | +10pp |
| Mini Crosswords (5x5) | ~16% word-level | 60% word-level | 3.75x; 4/20 games fully solved |

**Kahneman framing:** ToT implements "System 2" thinking (deliberate, slow, analytical) vs. CoT's "System 1" (fast, intuitive, linear).

### B.3.2 Graph of Thoughts (GoT)

**Paper:** arXiv:2308.09687

**Generalization:** Models reasoning as an **arbitrary directed graph** where vertices are thoughts and edges are dependencies. Subsumes CoT (linear graph) and ToT (tree graph).

**Graph Operations:**
- **Generation:** Create new thought vertices.
- **Aggregation:** Merge multiple thought vertices into one (many-to-one).
- **Refinement:** Improve an existing thought vertex in place (loop).
- **Backtracking:** Abandon a thought vertex and its descendants.

**Key advantage over ToT:** Allows **feedback loops** (refinement cycles) and **many-to-one aggregation** that trees cannot express. A thought can depend on multiple parents, enabling cross-branch information sharing.

**Results:** Outperforms CoT and ToT in both accuracy and cost-effectiveness on complex tasks.

### B.3.3 Path-of-Thoughts (PoT)

**Paper:** arXiv:2412.17963
**Venue:** ICML 2025

**Specialization:** Designed specifically for **relational reasoning** tasks.

**Three-Stage Architecture:**
1. **Graph Extraction:** Extract a task-agnostic graph of entities and relations from the problem description using LLM.
2. **Path Selection:** Select relevant reasoning paths through the graph using graph algorithms (shortest path, random walk, or learned selection).
3. **Inference:** Reason along selected paths to produce an answer.

**Key distinction from ToT:** ToT explores reasoning paths via LLM-generated tree search. PoT first extracts a structured graph, then uses algorithmic path selection, then reasons. This makes path selection deterministic and inspectable.

**Results:** Up to 21.3% improvement over baselines on benchmarks requiring long reasoning chains. More resilient to LLM errors than prior neuro-symbolic methods. No fine-tuning required.

### B.3.4 AG2 ReasoningAgent (Beam Search + ToT)

**Source:** AG2 framework, github.com/ag2ai/ag2

**Architecture:**
- Implements ToT with beam search for efficient exploration.
- Keeps only top-N best candidates at each step (beam width N).
- Combines LLM thought generation with algorithmic beam search pruning.
- Supports GPT-4, Llama, and other models as the reasoning backend.

**Advantage:** Beam search is more compute-efficient than full BFS or DFS — it prunes aggressively while retaining diversity.

### B.3.5 Cross-lingual ToT (Cross-ToT)

**Paper:** arXiv:2311.08097

**Problem:** CoT reasoning quality varies across languages; cross-lingual alignment of reasoning is needed.

**Approach:** Aligns cross-lingual CoT reasoning across languages using tree-structured exploration. Multiple reasoning paths in different languages are explored and aligned.

## B.4 Cost Model

### B.4.1 Token Cost Formula

For a ToT run with:
- Branching factor k (thoughts per node)
- Tree depth d
- Evaluation at each node

Total LLM calls ≈ k * (sum over levels of nodes at each level)

For BFS with beam width b:
- Level 0: 1 node → k thoughts + k evaluations
- Level 1: b nodes → b*k thoughts + b*k evaluations
- Level i: b nodes → b*k thoughts + b*k evaluations
- Total ≈ 2 * k * (1 + b*(d-1)) LLM calls (generation + evaluation)

For DFS:
- Total ≈ 2 * k * d * (average branching before backtrack)

**Comparison to CoT:** CoT uses exactly 1 LLM call. ToT uses O(k * d * b) calls.

### B.4.2 Empirical Cost Observations

- ToT achieves ~5 percentage point average improvement over CoT on multi-step reasoning tasks.
- Game of 24: 18.5x improvement (4% → 74%) at the cost of significantly more LLM calls.
- Small models (8B) can struggle with ToT: poor self-evaluation leads to incorrect pruning, sometimes degrading performance below CoT.
- "Thinking tokens" — hidden computation tokens — can burn thousands of extra forward passes for a single answer.

### B.4.3 Cost Control Strategies

| Strategy | How It Works | Tradeoff |
|----------|-------------|----------|
| Beam search (beam width b) | Keep only top-b states per level | Lower b = faster but may miss optimal path |
| DFS with early backtracking | Abandon impossible states immediately | Depends on evaluation quality; risk of premature pruning |
| Adaptive depth | Stop expanding when evaluations stabilize | Risk of under-exploration on hard problems |
| Model cascading | Use small model for evaluation, large for generation | Cheaper but evaluation quality may suffer |
| Reward-model evaluation | Train a separate reward model instead of LLM self-eval | Requires training data; more reliable at scale |

## B.5 When ToT Excels vs. Fails

### Excels

- **Combinatorial search spaces:** Game of 24, constraint satisfaction, scheduling.
- **Multi-step math and logic:** Where intermediate errors compound and backtracking helps.
- **Creative writing with structure:** Where multiple narrative branches can be compared.
- **Crossword/puzzle solving:** Where partial solutions can be evaluated and pruned.
- **Relational reasoning (PoT):** Where graph-based path extraction enables deterministic reasoning.

### Fails / Underperforms

- **Simple or single-step tasks:** Overhead of tree search is wasted; CoT suffices.
- **Small models (8B):** Poor self-evaluation leads to wrong pruning decisions; can perform worse than CoT.
- **Tasks with unreliable evaluation:** If the LLM cannot reliably assess intermediate state quality, search degrades to random exploration.
- **Open-ended generation without clear "goal states":** ToT needs definable success/failure criteria for pruning.
- **High-throughput production:** Per-query cost of O(k*d*b) calls makes ToT expensive at scale.

## B.6 Failure Modes and Mitigations

| Failure Mode | Risk | Mitigation |
|-------------|------|------------|
| Branch explosion | k^d nodes overwhelm compute | Beam search; adaptive depth limits |
| Poor evaluation quality | Wrong branches pruned, correct ones abandoned | External verifiers; reward models; comparative voting |
| Small model degradation | 8B models can't self-evaluate reliably | Use larger model for evaluation; model cascading |
| No clear goal state | Search never terminates or terminates prematurely | Define explicit termination criteria; budget caps |
| Stochastic instability | Different runs produce different answers | Increase beam width; aggregate multiple runs |
| Token cost explosion | O(k*d*b) calls per query | Beam search; early stopping; model cascading |

---

# PART C: COMPARISON AND HYBRID RECOMMENDATION

## C.1 Architecture Comparison

| Dimension | MapReduce Workflows | Tree-of-Thoughts |
|-----------|-------------------|-----------------|
| **What scales** | Input size / number of items | Reasoning depth / branching factor |
| **Bottleneck addressed** | Context window, cost of processing large inputs | Quality of multi-step reasoning on one problem |
| **Parallelism** | Embarrassingly parallel (independent shards) | Parallel at each tree level (BFS/beam) |
| **Decomposition** | By data (chunks, shards, retrieval targets) | By reasoning steps (thoughts at each node) |
| **Aggregation** | Reduce: merge structured outputs into one result | Search: select best path through tree |
| **Determinism** | High (deterministic selectors, typed functions) | Low (stochastic LLM generation and evaluation) |
| **Cost model** | O(n shards * per-shard cost) | O(k * d * b) per query |
| **Coverage guarantee** | Engineering-level (finite queue exhaustion) | None (search may miss branches) |
| **Failure mode** | Decomposition misses dependencies | Branch explosion / poor pruning |
| **Best for** | Large inputs, bulk items, whole-codebase tasks | Hard single problems, combinatorial search, math |

## C.2 Should You Build a Hybrid?

**Recommendation: Yes, in specific contexts.**

A hybrid MapReduce + ToT system is valuable when your workload has **both** a large input scale **and** deep per-item reasoning. The pattern is straightforward and composable:

### Hybrid Architecture

1. **MapReduce outer loop:** Decompose large input into shards. Each shard assigned to a parallel worker.
2. **ToT inner loop (per shard):** Each worker uses ToT-style reasoning (branch, evaluate, backtrack) to solve the complex per-shard sub-problem.
3. **MapReduce reduce:** Aggregate per-shard ToT solutions into a global result, with cross-shard composition.

### When to Build Hybrid

- **Code security at scale:** MapReduce shards the codebase; each shard worker uses ToT to reason about multi-step exploit chains within that shard; reducer composes cross-shard attack paths. (This is essentially what Cognition's Security Swarm already approximates.)
- **Wide search with deep verification:** A-MapReduce maps over many retrieval targets; each worker uses PoT/ToT for deep relational reasoning on its target; reduce aggregates best answers.
- **Large-scale document analysis with complex reasoning:** LLM×MapReduce shards a corpus; each worker uses ToT for deep multi-hop reasoning within its chunk; reduce synthesizes.

### When NOT to Build Hybrid

- **If your input is small:** Skip MapReduce; just use ToT directly.
- **If your per-item reasoning is simple:** Skip ToT; just use MapReduce with linear CoT workers.
- **If latency is critical:** The O(k*d*b) cost of ToT per shard, multiplied by N shards, can be very slow. Only build hybrid if you have the compute budget and latency tolerance.

### Hybrid Cost Model

Total LLM calls ≈ N_shards * k * d * b (generation + evaluation)

Where:
- N_shards = number of MapReduce shards
- k = ToT branching factor per node
- d = ToT tree depth
- b = beam width (if using beam search)

**Mitigation:** Use beam search (not full BFS), model cascading (small model for evaluation), and adaptive depth (stop when evaluations stabilize) to control costs.

---

## REFERENCES

### MapReduce-Style Workflows
- Cognition Agentic MapReduce: devin.ai/blog/agentic-map-reduce (July 2026)
- Devin Security Swarm: cognition.com/blog/introducing-devin-security-swarm (July 2026)
- A-MapReduce: arXiv:2602.01331 (Jan 2026)
- LLM×MapReduce V1: arXiv:2410.09342 (Oct 2024)
- LLM×MapReduce V2: arXiv:2504.05732 (Apr 2025)
- LLM×MapReduce V3: arXiv:2510.10890 (Oct 2025)
- ToM: arXiv:2511.00489 (Oct 2025)
- Agentics 2.0: arXiv:2603.04241 (Mar 2026)
- Scepsy: arXiv:2604.15186 (Apr 2026)
- LLM Map-Reduce Pattern: agentic-patterns.com
- ZenML Case Study: zenml.io/llmops-database/agentic-mapreduce-for-whole-codebase-security-scanning

### Tree-of-Thoughts
- ToT (original): arXiv:2305.10601, NeurIPS 2023
- ToT repository: github.com/princeton-nlp/tree-of-thought-llm
- Graph of Thoughts: arXiv:2308.09687
- Path-of-Thoughts: arXiv:2412.17963, ICML 2025
- Demystifying Chains, Trees, and Graphs of Thoughts: arXiv:2401.14295
- Cross-lingual ToT: arXiv:2311.08097
- AG2 ReasoningAgent: github.com/ag2ai/ag2
- Unified Perspective on Tree Search for LLMs: OpenReview (Oct 2025)
