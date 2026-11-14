# Mnemopi retrieval, semantic reranking, and MMR

## Scope and evidence

OMP2 source inspected: `blyzer/oh-my-pi` `9cb6fd638918de77913a3e6c8fc42f9d5b3365bc`.
Upstream baseline inspected using `git show`: `can1357/oh-my-pi`
`55251e34c26eeb5a31a5c86cedf243acd7e2cb23`.
PR [#18747](https://github.com/can1357/oh-my-pi/pull/18747) source inspected at
`92ce767cc18379efde6315f0d2069088d671450d` in its contributor fork. It was open,
unmerged, and conflicted when inspected; its tests and live-endpoint claims are
author-reported, not results reproduced here. The PR body describes earlier
iterations; findings below follow the pinned final source, including its more
extensive score validation and head/tail input clipping.

All OMP2 paths below resolve at the pinned OMP2 commit. Numbered source references
are supplied at the end. “Verified” means source behavior traced; runtime/model
execution was not performed. Proposed behavior is explicitly marked.

## What OMP2 actually has

| Capability | Status | Implementation and practical consequence |
|---|---|---|
| Durable memory, provenance, scoping | Implemented and source-verified | SQLite `BankStore`; `MemoryRecord` contains bank/tier/source/session/timestamp/veracity/metadata/supersession. `BankScope::resolve` supports global, per-project, tagged shared fallback. |
| BM25 lexical retrieval | Implemented and source-verified | SQLite FTS `search_working`, `search_episodic`, `search_facts`; not Tantivy or a separate search service. |
| Four recall voices and fusion | Implemented and source-verified | `RecallEngine::recall` always collects vector (when supplied), graph, episodic, working. |
| `polyphonic_recall` switch | Implemented but incomplete | Setting/default exists, but `MemoryRuntime::search` does not branch on it. No behavioral on/off parity should be inferred from the default `false`. |
| Dense vector search | Implemented but incomplete end-to-end | Exact scan of generation-valid stored vectors, normalized query and dimension filter. Public search accepts a query embedding. Inspected recall tools and prompt recall supply `None`, so these paths do not use the dense voice. |
| Local embedding inference | Implemented library/worker capability | Feature-gated `fastembed`; restartable process supervisor and `rebuild_local_embeddings`. This is embedding, not cross-encoding. No automatic caller of rebuild was found in the repository-wide search. |
| Remote embedding egress | Present as interface plus validation helper | `RemoteEmbeddingEgress`/`embed_remote`; no implementation of the trait was found by repository-wide search. Do not advertise configured remote embeddings as a proven production recall path. |
| Graph/fact search | Implemented and source-verified | FTS facts; term-matched triples and one-hop memory links gated by graph generation. This is a knowledge graph, not a source dependency/call graph. |
| Temporal retrieval | Implemented but limited | English substring heuristic adds recent working candidates; timestamps break fused ties. No general time-decay weighting in this recall engine. |
| Duplicate filtering | Implemented and source-verified | Per-voice memory ID dedup; final lowercase/whitespace-normalized content merge. Not semantic near-duplicate filtering. |
| MMR | Absent from inspected memory implementation | No MMR selection in `recall.rs` or memory call sites. Upstream's MMR must not be attributed to OMP2. |
| Cross-encoder HTTP provider | Absent | No OMP2 equivalent of PR #18747's `Reranker`/`executeRerank`. |
| Apple FM semantic ranker | Implemented but incomplete | Feature-gated `aux_lane::rank` has code and tests, but no production caller. `search_async` only wraps blocking search; its comment identifies ranking as future M4. This is generative scoring, not a dedicated cross-encoder. |
| Enhanced cache | Implemented and source-verified | Exact or similar query, generation-fenced, bounded results. Suitable historical recall optimization; unsuitable as a gate verdict cache. |
| Authoritative verification evidence | Absent from memory API | A recalled memory is historical content, regardless of confidence/veracity labels. It cannot prove current source passes a gate. |

### Exact OMP2 retrieval order and formulas

`MemoryRuntime::search` normalizes bounds, reads bank stamps, optionally checks
exact/similar recall cache, invokes `RecallEngine`, optionally inserts results,
and returns `SearchOutcome`. It does not embed a query or invoke an auxiliary
ranker [M1]. `search_async` uses `spawn_blocking` around that same operation.

`RecallEngine::collect_store` [M2] performs, per scoped bank:

1. Vector scan only when a finite, nonzero query vector is supplied.
2. Graph voice = FTS facts plus triple/link candidates.
3. Episodic FTS retrieval.
4. Working FTS retrieval, plus recent rows if a temporal substring matches.
5. A shared-bank broadening pass where tagged scoping permits it, removing
   literal project-bank terms while retaining the original query embedding.

Vector score is `clamp((dot(stored_normalized_vector, normalized_query)+1)/2,0,1)`.
The store exposes vectors only when vector and durable generations agree, loads
at most 50,000 vectors, and recall then retrieves each candidate record and sorts
the scan. This is an exact bounded scan, not ANN; peak memory and row lookups
scale with the loaded bank. Vectors of another dimension are skipped; there is
no query model-identity argument in `RecallEngine::recall`, so equal dimensions
alone do not establish semantic compatibility [M2, M3].

Working/episodic FTS candidates first select by ascending SQLite `bm25` and ID,
then convert the rank to `lexical=1/(1+abs(bm25))` and
`native=clamp(0.8*lexical+0.2*importance,0,1)` [M3]. This conversion is a bounded
heuristic, not a calibrated relevance probability. Because SQLite FTS5's rank
sign/scale differs from a conventional positive BM25 score, test actual corpus
ordering before treating this transformation as a ranking improvement: the
subsequent native-score sort can differ from the SQL order.

Fusion sorts each voice by descending native score then ID and deduplicates IDs.
For rank `r` starting at 1:

```text
contribution(v,d) = weight(v)/(60+r(v,d)) + 0.01*weight(v)*native(v,d)
score(d) = sum_v contribution(v,d)
weight(vector,graph,episodic,working) = (0.35,0.25,0.25,0.15)
```

Results sharing normalized content are merged by adding scores and voice
contributions, then sorted by score, newest timestamp, ID. The content budget
uses `ceil(UTF8_bytes/4)` rather than tokenizer counts; oversized candidates are
skipped, not silently truncated by `fuse`. Defaults are 8 results, 5,000
approximate tokens, 32 candidates per voice. Normalization clamps result count
to 1–50, token budget to 1–32,768, and per-query voice retrieval to 1–100. The
voice limit is applied per underlying store/query, not as a strict total fused
candidate cap across all banks and broadening passes [M2].

Temporal queries match substrings including `last` and `before`; this can match
unintended word fragments. `recent_working` selects newest rows, but assigns
importance as native score; subsequent voice sorting can reorder them. Comments
describing an episodic recency merge are broader than `search_fts`'s actual
formula [M2, M3].

### Scope, fallbacks, and security

The environment supplies the canonical primary Git root, so linked worktrees
share project identity. Tagged scoping searches project and shared banks, and
legacy adoption checks source-root consistency rather than basename [M4].
Shared-bank content can influence ranking and is explicitly marked `broadened`;
neither shared knowledge nor extracted graph links gain gate authority.

Exact cache hits require normalized query, identical bounds and bank generations;
similar hits accept cosine >=0.95 or token Jaccard >=0.85. Generation changes
evict entries [M5]. Negated or subtly different queries may still be similar;
never use approximate-query cache matches for required-check completion or
security verdicts. A future ranking cache must additionally bind model/version,
input digest, preprocessing, provider, policy and scoring mode.

Missing embeddings or stale vector/graph generations omit those channels while
lexical retrieval continues. Store errors propagate as errors rather than being
silently interpreted as “no relevant memory.” Memory backend off yields an
explicit inactive outcome. The Apple auxiliary ranker's documented fallback is
stronger than its implementation: session creation failure preserves candidates;
individual response errors leave old scores; parse failure overwrites a score
with zero; task panic returns an empty vector. Partial failures therefore mix
score scales. Its concatenated query/memory prompt also provides no structural
trust isolation against malicious recalled instructions [M6]. Do not wire this
lane into security decisions unchanged.

Remote embedding requests contain an opaque `CredentialRef`, not secret bytes;
bounded input/output validation and vector normalization are implemented at the
memory interface [M7]. This interface does not itself prove endpoint allowlisting,
TLS enforcement or actual host egress wiring. Local memory still persists
potentially sensitive source-derived content: scope and provenance are required
for authorized evidence selection, and remote ranking would transmit both the
query and selected memory text. Retain current Environment-owned credentials and
network authority rather than adopting direct environment-variable keys in Rust.

## Upstream Mnemopi and PR #18747

Upstream baseline already has lexical/dense hybrid retrieval, MMR and polyphonic
recall; the PR adds optional cross-encoder provider configuration and reorganizes
candidate gathering/finalization [U1–U5]. Its five voices are **hybrid, vector,
graph, fact, temporal**, not OMP2's four. `voiceWeights` is exposed in metadata,
but `combineVoices` actually adds unweighted `1/(60+r)` after per-voice ID dedup.
The maximum fused score is `5/61`; the new gathering path normalizes by that
maximum. Merely copying the exposed weights would change behavior [U2].

Upstream's temporal voice scores `exp(-ageDays/7)*importance`; baseline hybrid
scoring additionally has lexical thresholds, dense floor 0.65, importance,
recency, veracity/tier weights and optional temporal boost. For episodic rows its
base is `max(dense*vecWeight+fts*ftsWeight+importance*importanceWeight,
0.8*lexical)`, then multiplied by `(0.7+0.3*decay)` and optional
`1+temporalWeight*temporalScore` [U1, U2]. These are not OMP2 scoring formulas.
The inspected upstream dense backend uses a normalized contiguous float matrix
and native exact top-k kernel, not an assumed external vector database [U5].

The PR's configured path is:

```text
derive query embedding -> gather baseline without MMR or clipping
-> optional polyphonic fusion with deferred diversity
-> apply recall filters and normalize fusion scores
-> merge shortlist -> cross-encoder once -> MMR -> presentation clipping
```

`pool=max(topK,reranker.candidates)`; default rerank candidate count is 40.
`finalizeRecall` sends up to that pool with per-document head/tail clipping to
4,096 characters, includes fact subject/predicate, overwrites relevance scores
on success, and applies MMR afterward. It preserves `veracity=false` as negative
infinity. A cross-encoder cannot rescue a relevant document excluded by initial
candidate retrieval or shortlist truncation [U1].

Upstream MMR chooses highest relevance first, then greedily maximizes:

```text
lambda*relevance(d) - (1-lambda)*max_selected Jaccard(tokens(d),tokens(s))
lambda default = 0.7
```

Default token similarity is lowercase whitespace-token Jaccard. Valid Unicode
inputs use a native batch kernel; custom similarity and lone-surrogate cases
stay in TypeScript. This is diversity selection, not semantic query relevance.
The polyphonic helper's separately named `diversityRerank` is a near-duplicate
filter at Jaccard >0.8, not the MMR objective [U2, U3].

The provider sends both `documents` and `texts` to support Cohere/OpenRouter-like
and TEI-like responses. That duplicates text fields in the wire payload; it does
not establish duplicate model billing. Default timeout is 30 seconds and
request helper max attempts is 3. Score mode is `auto|logit|probability`; auto
sigmoids the **whole response** when any score lies outside [0,1], otherwise
preserves values. A logit lying inside [0,1] is ambiguous, so use explicit mode
for known models. `createReranker` rejects missing scores, duplicate/out-of-range
indices and nonfinite values; invalid/failed calls return null and retain
first-stage order before MMR. Sigmoid provides a bounded monotonic score, not
calibrated correctness confidence [U4].

Configuration supports `MNEMOPI_RERANK_API_URL`, `_MODEL`, `_API_KEY`,
`_CANDIDATES`, `_SCORE_MODE` plus facade options. Key fallback uses recognized
endpoint hosts (OpenRouter/OpenAI/Cohere); unrelated custom endpoints do not
implicitly inherit those keys. Error logging includes endpoint/error details;
production adaptation should redact response bodies and query/source data.
The final pinned `enhancedRecallCacheScope` records stage, bank/session, topK,
options, polyphonic mode and explicit embedding hash; it does **not** explicitly
add reranker URL/model as the PR body claims. The configured path caches
first-stage candidates and reranks on each finalization, so this omission must
be evaluated against actual cache stage rather than treated automatically as a
stale final-score bug [U1, U4].

## Pipeline comparison (design assessment, not measurements)

| Pipeline | Relevance/context accuracy | Diversity | Cost/latency and memory | Suitable use |
|---|---|---|---|---|
| A: retrieval → fusion → MMR | Depends on first-stage relevance; misses negation/interaction nuance | Directly controlled at final selection | No model call; bounded pairwise similarity cost O(N*K); small CPU footprint | Baseline ordinary recall; first implementation |
| B: retrieval → fusion → cross-encoder → MMR | Can improve query-document relevance across a broad shortlist | Preserved after semantic scores | Scores N pairs; model weights/activations dominate memory; added inference/request latency | Preferred optional semantic stage for ambiguous evidence |
| C: retrieval → fusion → MMR → cross-encoder | Cannot recover good candidates removed by MMR | Final reorder alone preserves membership, but final truncation can undo diversity | Scores a smaller shortlist, cheaper; trades recall for budget | Explicit low-budget mode only; overselect before ranking, reapply diversity if truncating |
| D: adaptive A/B | Potentially best cost-quality balance; trigger quality needs calibration | Final MMR plus mandatory evidence categories | Trigger overhead; B only on uncertainty/risk; observable fallback needed | Recommended policy over a shared optional provider |

Do not blindly apply lambda=0.7 to tiny RRF scores: the redundancy term can
dominate relevance. Normalize relevance within a declared model/corpus scheme,
keep raw score provenance, and test fusion-only versus cross-encoder calibration.
Use deterministic tie breaks. Exact duplicate removal should precede expensive
pair scoring; semantic near-duplicate filtering must preserve contrary evidence.

**Recommendation:** implement A as an explicit native optional memory improvement,
then D selecting B through a shared in-process/provider abstraction. Keep ordinary
memory recall off the critical latency path by default; enable optional ranking
only after relevance benchmarks justify it. Initially use semantic ranking for
verification evidence selection and ambiguous/high-risk findings. Share provider,
batching, cancellation, caching and credential policy between all three uses,
with separate budgets/scope policies; no mandatory always-running service.

Uncertainty triggers may include low top-score margin, conflicting voices,
contradictory historical findings, or missing required evidence categories.
Uncalibrated scores are not probabilities: trigger thresholds must be tuned on
held-out queries. High-risk review can force semantic investigation regardless
of apparent retrieval confidence. Reranker unavailability means baseline recall
for optional history; it means INCONCLUSIVE if the selected profile requires
that semantic investigation and no allowed substitute completes it.

## Apple Silicon with 16 GB RAM

Feasible direction, not a measured deployment result: use an optional small
encoder reranker with bounded sequence length, one worker, batch size 1–4 and
20–40 candidates; unload idle weights under pressure. A hypothetical 100M
parameter model has roughly 0.2 GB FP16 raw weights or 0.1 GB INT8 raw weights;
these arithmetic figures exclude tokenizer, graph/runtime, activations,
allocator, OS and concurrent agent/compiler/embedding memory. They are **not RSS
estimates**. Pair length and attention cost can dominate latency; benchmark
cold/warm p50/p95, peak resident memory and concurrent Rust build responsiveness.

OMP2's existing `fastembed` worker currently resolves embedding models only
(`BGEBaseENV15` and multilingual E5), not a reranker. A local reranker requires a
validated pair-scoring model/runtime interface; don't add an inference framework
or dependency until current native/runtime options are evaluated. Apple's
existing auxiliary FM lane can be an experimental provider but does not establish
cross-encoder accuracy, deterministic scores, supported OS availability or an
operational memory recall path. No Apple Silicon host/model was available in
this investigation.

An opt-in local endpoint can be user-managed without becoming mandatory. Remote
APIs reduce local RAM but add round-trip latency, cost, credentials and source
egress. Use the existing Environment authority with endpoint/credential scope,
timeouts, bounded response parsing, cancellation, no-secret logs and a declared
data policy. Cache by exact query/document/model/preprocessing digest; treat
provider model aliases as mutable unless version-pinned. Benchmark local CPU,
available accelerated local runtimes and remote providers on the same corpus.

## Verification authority and acceptance criteria

Memory returns historical leads with provenance. The verification engine resolves
those leads against current source, executable checks and policy-bound evidence.
Neither high fused score, reranker score nor a recalled statement of past PASS
can satisfy a gate. Mandatory security context (e.g. unsafe code, trust-boundary
callers and relevant configuration) is loaded by deterministic impact/policy
rules before optional ranked context. Token budgets cannot remove those inputs;
expand the budget, partition investigation or return INCONCLUSIVE.

First follow-up acceptance tests should cover: actual polyphonic flag semantics;
FTS ordering and score normalization; missing/mismatched query embeddings; stale
index generations; cross-bank duplicates/provenance; negated queries and similar
cache collisions; MMR diversity and deterministic ties; complete score validation;
provider timeout/cancellation/partial failures; no mixed-score fallback; malicious
memory contents; and required evidence surviving budgets. Evaluate held-out
recall nDCG@K/recall@K, category coverage, contradiction retrieval, downstream
finding precision/recall, latency, peak RAM and cost. The proposed retrieval
changes need their own behavior-reviewed PR; this research changes no contracts.

## Source reference index

OMP2 permalink root:
<https://github.com/blyzer/oh-my-pi/tree/9cb6fd638918de77913a3e6c8fc42f9d5b3365bc>.

- M1: `crates/memory/src/runtime.rs:381–451` (`search`, `search_async`);
  `585–615` (prompt recall supplies no embedding); `710–757`
  (`rebuild_local_embeddings`); `crates/tools/src/memory.rs:259–263,335–339`
  (tool recall supplies no embedding).
- M2: `crates/memory/src/recall.rs:16–53,100–123,144–235,251–365,394–451`
  (weights, bounds, collection, scan, fusion, broadening and temporal heuristic).
- M3: `crates/memory/src/store.rs:53–77` (`MemoryRecord`), `679–703`
  (`vectors`), `815–931` (facts/recency/graph), `1171–1202` (`search_fts`).
- M4: `crates/memory/src/bank.rs:49–118,121–155` (identity/scoping/adoption).
- M5: `crates/memory/src/cache.rs:37–128` (cache identity and similarity).
- M6: `crates/memory/src/aux_lane.rs:12–45` (`rank`);
  `crates/memory/src/config.rs:196–204,239–255,285–312` (flags/defaults);
  `crates/ai/src/local/applefm.rs:532–537` (`aux_session` prompt).
- M7: `crates/memory/src/remote.rs:11–79` (egress contract/validation);
  `crates/memory/src/embedding/worker.rs:119–141` (feature/model resolution);
  `crates/memory/Cargo.toml:17–21` (feature gates).

Upstream PR permalink root:
<https://github.com/anagnorisis2peripeteia/oh-my-pi/tree/92ce767cc18379efde6315f0d2069088d671450d>.

- U1: `packages/mnemopi/src/core/beam/recall.ts:705–758,1058–1067,1174–1286,1355–1380`
  (hybrid scoring, configured path, candidate gathering/finalization/cache scope).
- U2: `packages/mnemopi/src/core/polyphonic-recall.ts:119–125,279–320,500–537,544–609`
  (voices, temporal score, actual unweighted RRF and duplicate filter).
- U3: `packages/mnemopi/src/core/mmr.ts:11–100` (MMR and native fast path).
- U4: `packages/mnemopi/src/core/rerank.ts:23–59,91–161` (provider/validation);
  `packages/mnemopi/src/config.ts:93–127` (configuration/key selection).
- U5: `packages/mnemopi/src/core/vector-index.ts:20–82` (exact native index).

Reproduction: `git clone --depth 1 --branch feat/mnemopi-rerank
https://github.com/anagnorisis2peripeteia/oh-my-pi.git`; verify the head above;
`git fetch --depth 1 https://github.com/can1357/oh-my-pi.git
55251e34c26eeb5a31a5c86cedf243acd7e2cb23`; compare the listed files with
`git show BASE:path` and `git diff BASE HEAD -- packages/mnemopi`.
The latter reported 11 files, 1,101 insertions, 112 deletions. No Bun executable
was found (`command -v bun`), so PR tests were not run. No retrieval quality,
token savings, local inference latency or defect-detection measurement is claimed.
