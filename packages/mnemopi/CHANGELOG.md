# Changelog

## [Unreleased]

## [18.0.9] - 2026-08-28

### Fixed

- Fixed working-memory search returning too few or no results when the most relevant matches had been superseded, ensuring valid older entries are still returned.

## [18.0.0] - 2026-08-22

### Fixed

- Fixed false-positive location extraction in episodic gists by properly enforcing capitalization constraints for proper nouns.
- Improved episodic gist participant extraction with Unicode support to properly capture names in non-Latin scripts (e.g., Cyrillic, Greek).

## [17.3.8] - 2026-08-19

### Added

- Added optional task metadata to the runtime LLM completion interface so hosts can tell an extraction call from a consolidation call and choose the matching prompt

## [17.3.5] - 2026-08-16

### Fixed

- Fixed an issue where transient provider failures (such as Anthropic overload or rate limit errors) were incorrectly treated as empty responses; these failures are now retried automatically before falling back.

## [17.3.4] - 2026-08-14

### Fixed

- Fixed `recall()` silently dropping `scope='global'` rows whenever a `channelId` filter was active: `buildWhere()` appended a redundant hard `channel_id = ?` clause on top of the `(session_id = ? OR scope = 'global' OR channel_id = ?)` visibility clause, so global rows whose `channel_id` didn't match (e.g. imported rows with `channel_id NULL`) were excluded. Channel isolation is preserved by the visibility clause alone. This made imported/global episodic memory permanently unrecallable through callers that always pass a channel (such as the coding-agent memory backend). ([#8525](https://github.com/can1357/oh-my-pi/issues/8525))

## [17.2.11] - 2026-08-07

### Fixed

- Fixed an issue where an interrupted local embedding model download could permanently corrupt the cache and silently disable semantic recall. The system now automatically detects incomplete model files, clears the corrupted cache, and retries the download.

## [17.2.10] - 2026-08-06

### Changed

- Updated internal LRU cache implementation.

## [17.2.6] - 2026-08-03

### Added

- Added opt-in SQLite page-size configuration for file-backed databases, configurable via the `MNEMOPI_DB_PAGE_SIZE` environment variable or the `pageSize` option in `openDatabase`. Existing databases retain their original page size.

## [17.2.3] - 2026-08-01

### Fixed

- Stripped `<think>…</think>` reasoning blocks from remote LLM output in `cleanOutput`, so reasoning-model responses no longer leak into consolidated memories or corrupt fact extraction (the reasoning wrapper previously survived parsing and every stored fact became reasoning prose). ([#7231](https://github.com/can1357/oh-my-pi/issues/7231))

## [17.2.2] - 2026-07-31

### Fixed

- Fixed a resource leak where SQLite prepared statements were not properly released, keeping the database connection alive after calling close(). This resolves file locking issues on Windows (which prevented deleting, moving, or rotating database files) and silent file handle leaks on POSIX systems.

## [17.0.8] - 2026-07-22

### Changed

- Optimized vector operations (exact vector-index search, SHMR similarity clustering, and default-similarity MMR rerank) by migrating hot loops to native batch kernels, resulting in significant performance improvements (up to 1.8x faster top-K search, 2.4x faster pairwise clustering, and 22-36x faster MMR reranking).

## [17.0.4] - 2026-07-18

### Fixed

- Fixed a corrupt cached embedding model (truncated `model_optimized.onnx`, `Protobuf parsing failed` on load) permanently disabling local embeddings: init now quarantines the broken cache file (rename to `*.corrupt-<ts>`, only when the path resolves inside the fastembed cache directory) and retries once so the model re-downloads.

## [17.0.1] - 2026-07-16

### Fixed

- Fixed working-memory TTL trim silently deleting restored or imported durable rows: rows keeping `consolidated_at = NULL` with an old `timestamp` are no longer trimmed when flagged `IMPORTED`, `importFromDict` stamps imported rows as consolidated, and every working-memory delete path (trim, `forgetWorking`, force-import overwrite) now cascades linked annotations, embeddings, facts, memoria projections, gists, and graph edges instead of leaving orphans. ([#4819](https://github.com/can1357/oh-my-pi/issues/4819))
- Fixed Mnemopi local embeddings on Windows loading an unrelated `onnxruntime.dll` from the inherited system path instead of fastembed's cached ORT runtime. ([#4849](https://github.com/can1357/oh-my-pi/issues/4849))

## [16.3.9] - 2026-07-06

### Fixed

- Fixed extractor JSON parsing to correctly unwrap object-shaped facts, instructions, preferences, and timeline items from known text fields instead of persisting literal `[object Object]` rows.

## [16.3.7] - 2026-07-05

### Added

- Added `RecallOptions.contentPreviewChars` to allow customizing or disabling the content preview cap (default is 500, set to 0 for full content).
- Added `RecallResult.truncated` and `RecallResult.full_length` properties to easily identify clipped previews without parsing trailing markers.

### Fixed

- Fixed background LLM fact extraction to preserve specific extractor categories (`instructions`, `preferences`, `timelines`, and `kg` triples) in MEMORIA tables and graph triples instead of flattening them into generic `fact/entity` rows.
- Improved recall previews and `factLine` context to append a trailing ellipsis (`…`) when content is clipped, preventing mid-word truncation without a marker.

## [16.3.5] - 2026-07-04

### Fixed

- Fixed `remember(..., { embedText })` so hosts can store full transcripts while embedding, FTS-indexing, and rebuild-reembedding a marker-free projection. ([#4395](https://github.com/can1357/oh-my-pi/issues/4395))

## [16.2.2] - 2026-06-27

### Fixed

- Improved resilience during API extraction calls by enhancing the handling of rate limits and transient errors.

## [16.1.17] - 2026-06-24

### Fixed

- Fixed `remember(..., { extract: true })` fact/entity extraction accepting an `extractText` override so hosts can store full transcripts while mining facts from a safer projection; also tightened deterministic `Instruction:` extraction to require an explicit `I`/`you` subject instead of treating every `always`/`never` clause as a user instruction. ([#3372](https://github.com/can1357/oh-my-pi/issues/3372))

## [16.1.8] - 2026-06-20

### Fixed

- Capped per-input length in `embed()` at `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS` (default 8192 chars, override via the env var or `embeddings.maxInputChars` runtime option; `0` disables) so a long retention transcript can no longer overflow the embedding model's context window. Oversized inputs are clipped with a head/tail split so chronological transcripts keep both the opening setup and the most recent turns instead of losing the latest content under a naive prefix slice. llama.cpp's `/embeddings` server used to reject the request with `request (N tokens) exceeds the available context size`, silently dropping vector recall for that memory ([#3126](https://github.com/can1357/oh-my-pi/issues/3126)).
- Fixed the proactive-linking write path ignoring host configuration: `proactiveLinkIfEnabled` read `MNEMOPI_PROACTIVE_LINKING` directly, so a host that enabled proactive linking through `configureRecallFeatures()` had no effect unless the environment variable was also set. `proactiveLinking` is now a `RecallFeatureFlags` option resolved through a `proactiveLinkingEnabled()` fallback, matching the existing polyphonic and enhanced recall flags, with the `MNEMOPI_PROACTIVE_LINKING` environment variable still taking precedence whenever it is set. ([#2440](https://github.com/can1357/oh-my-pi/issues/2440))

## [16.1.3] - 2026-06-19

### Added

- Exposed `setLocalModelInitializer` (and the `LocalEmbeddingModel`, `LocalModelInitializer`, `LocalModelInitOptions`, `StandardEmbeddingModel` types) so hosts can route fastembed loads through a dedicated subprocess and keep `onnxruntime-node`'s NAPI constructor + finalizer out of their own address space. Same wipe semantics as the existing `setLocalModelInitializerForTests` seam; the agent CLI uses it to crash-proof Windows when `memory.backend: mnemopi` is enabled ([#3031](https://github.com/can1357/oh-my-pi/issues/3031)).

### Fixed

- Fixed background fact extraction skipping runtime-configured remote LLM endpoints when `MNEMOPI_LLM_BASE_URL` was unset, so `remember(..., { extract: true })` now stores remote-distilled facts from `mnemopi.llm` config instead of falling back to regex heuristics. ([#3041](https://github.com/can1357/oh-my-pi/issues/3041))
- Fixed local fastembed startup on macOS ARM64 by letting `fastembed@2.1.0` install its matching `onnxruntime-node@1.21.0` native runtime instead of forcing `1.26.0`, and by repairing missing tokenizer sidecars from the upstream Hugging Face model cache when a stale fastembed archive lacks them. ([#3054](https://github.com/can1357/oh-my-pi/issues/3054))

## [16.0.6] - 2026-06-18

### Fixed

- Forced the on-demand fastembed runtime install to override fastembed's archived `onnxruntime-node@1.21.0` transitive pin with Mnemopi's `onnxruntime-node@1.26.0` pin, fixing local embedding startup on macOS ARM64. ([#2920](https://github.com/can1357/oh-my-pi/issues/2920))

### Changed

- Updated OpenRouter request headers to use standard shared headers from the pi-ai package

## [16.0.5] - 2026-06-17

### Fixed

- Capped `sleep_consolidation` episodic rows at `maxEpisodeChars` (default 100KB, `MNEMOPI_MAX_EPISODE_CHARS`) so raw session transcripts cannot be stored and extracted as multi-megabyte episodes. ([#2869](https://github.com/can1357/oh-my-pi/issues/2869))
- Skipped regex-only entity and pattern fact extraction for oversized raw transcripts so progress/log noise cannot flood MEMORIA with junk facts. ([#2868](https://github.com/can1357/oh-my-pi/issues/2868))

## [15.13.1] - 2026-06-15

### Added

- Added a wipe-and-rebuild reconcile (`reconcileEmbeddingModel`) that runs when the configured embedding model changes. At store open, if the model stamped on stored `memory_embeddings` rows differs from the active `currentEmbeddingModel()`, the stale embeddings and their binary vectors are dropped and every existing memory is enqueued for background re-embedding (in bounded batches) at the new model/dimension. The destructive wipe is skipped whenever it could not be rebuilt — embeddings disabled via the runtime option or the `MNEMOPI_NO_EMBEDDINGS` env, an unresolved (empty) active model, or a read-only open (`reconcile: false`, used by ephemeral stats readers that would exit before the async rebuild finished) — so a stale-but-valid corpus is never destroyed without a replacement. Recall degrades gracefully (FTS-only) for memories whose vectors are not yet rebuilt ([#2476](https://github.com/can1357/oh-my-pi/issues/2476))

### Fixed

- Normalized enhanced recall fact scoring against lexical coverage so high-confidence facts that only match generic query tokens no longer outrank exact working-memory hits. ([#2441](https://github.com/can1357/oh-my-pi/issues/2441))

## [15.12.4] - 2026-06-13

### Fixed

- Fixed `consolidateToEpisodic` (the function backing `sleep` / `sleepAllSessions`) never populating the episodic graph: the `gists` and `graph_edges` tables stayed at 0 rows across every bank even after multiple consolidation cycles, so Polyphonic Recall's `graph` voice (BFS over `findGistsByParticipant` / `findRelatedMemories`) always returned nothing. Consolidation now best-effort ingests the new episodic memory into `EpisodicGraph` so the gist row, gist→memory `ctx` edge, fact edges, and cross-memory similarity/entity/temporal edges land alongside the episodic row. Independent of the existing `MNEMOPI_PROACTIVE_LINKING` flag, which still gates the same enrichment on the `remember()` write path. ([#2435](https://github.com/can1357/oh-my-pi/issues/2435))

## [15.12.0] - 2026-06-12

### Changed

- Moved `fastembed` and `onnxruntime-node` from `dependencies` to optional `peerDependencies` pinned to exact versions. When the peers are absent (bundled CLI, compiled binary, or installs that skip optional peers), the local embedding path `bun install`s the pinned pair into `~/.omp/cache/fastembed-runtime/<version-key>` on first use and loads fastembed from there — restoring local embeddings in bundled distributions and removing ~270MB of eager native downloads from default installs ([#2389](https://github.com/can1357/oh-my-pi/issues/2389))

## [15.11.4] - 2026-06-12

### Added

- Added `configureRecallFeatures()` (exported from the package root, `core`, and `config`) so hosts can enable the polyphonic recall engine and the enhanced recall query cache programmatically. `polyphonicRecallEnabled()`, `enhancedRecallEnabled()`, and `isEnhancedRecallEnabled()` now fall back to these configured defaults, with the `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL` environment variables still taking precedence whenever they are set. ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))

### Fixed

- Fixed the embedding pipeline's silent `catch {}` blocks (`runEmbedding()`, `getLocalModel()`, and the local-model path of `embed()`) swallowing failures with zero diagnostics. These best-effort paths still degrade gracefully (return `null` / skip the write), but now emit structured `logger.debug` entries with the error and per-site context (item count, model name). The `mnemopi.debug` config flag now propagates into the core library via runtime options (`MnemopiOptions.debug` → `ResolvedMnemopiRuntimeOptions.debug`) and escalates these logs to `warn` so they surface at the default log level. ([#2322](https://github.com/can1357/oh-my-pi/issues/2322))

### Changed

- Extraction, embedding, and remote-LLM clients now accept an `ApiKey` (static string or resolver) and resolve it per request through `withAuth`, so 401s force-refresh and rotate credentials via the central auth-retry policy instead of failing with a stale key. Empty-key setups (local/proxy endpoints without `Authorization`) and pinned literal keys behave exactly as before.
- Embedding and remote-LLM 401 errors now throw pi-ai's typed `ProviderHttpError` instead of `Object.assign`-patched `Error`s, keeping the same structural `.status` contract for the auth-retry classifier.
- SHMR consolidation clustering (`core/shmr`) now uses the real embedding provider when one is configured instead of always hashing: `embed()`, the new `embedBatch()`, `clusterBySimilarity()`, `computeHarmonyScore()`, `harmonize()`, and `recallBeliefs()` are now async, batch-embed candidate texts in a single provider call, and reuse precomputed vectors from `memory_embeddings` for episodic candidates. The SHA1 bag-of-words hash remains as the deterministic fallback when no provider is available or embedding fails. ([#2324](https://github.com/can1357/oh-my-pi/issues/2324))

## [15.10.12] - 2026-06-10

### Changed

- Reworked the in-memory fallback vector search to build a normalized exact vector index per query, matching the shape needed for future quantized or TurboVec-style backends without adding a new dependency yet.

## [15.10.11] - 2026-06-10

### Fixed

- Fixed embedding provider detection to match `openrouter` by URL host, so custom embedding endpoints are now recognized correctly instead of being misclassified by substring matching
- Fixed the check for OpenRouter base URLs so only true `openrouter` hosts are treated as non-custom

## [15.10.8] - 2026-06-09

### Added

- Added a `fetch` option to `ExtractionClient` to inject a custom fetch implementation for remote LLM requests
- Added an optional `fetch` option to `extractFacts` to control the transport used for remote extraction calls
- Added support for passing a custom `fetch` implementation through `complete` and `summarizeMemories` via remote LLM options

## [15.9.1] - 2026-06-04

### Breaking Changes

- Changed `Mnemopi.recall()`, `Mnemopi.recallEnhanced()`, `Mnemopi.search()`, `Mnemopi.query()`, the module-level `recall`/`recallEnhanced`/`search`/`query` exports, the `BeamMemory.recall`/`recallEnhanced` methods, the free `recall`/`recallEnhanced` functions in `core/beam/recall`, and `orchestrateRecall` to return `Promise<RecallResult[]>` so the recall pipeline can auto-derive `queryEmbedding` from the query text via `embedQuery`. Callers must `await` recall calls; pass `queryEmbedding: null` to opt out of auto-embedding and stay on FTS-only.
- Changed the MCP entrypoints `handleToolCall`, `callToolJson`, and `handleJsonRpc` in `mcp-server`/`mcp-tools` to async so the recall/shared-recall handlers can await the new `Promise<ToolResult[]>` shape; external MCP transports must `await` these.

### Fixed

- Fixed `memory_embeddings` never being populated by the production `remember`/`rememberBatch`/`updateWorking`/`consolidateToEpisodic` paths; embedding generation is now scheduled as a background task on `beam.pendingExtractions` (mirroring `scheduleFactExtraction`), so configured providers (fastembed, OpenAI-compatible API, custom) actually run and rows land in `memory_embeddings(memory_id, embedding_json, model)`. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `recall()`/`recallEnhanced()` never deriving a query embedding from the query text, which silently degraded every deployment to FTS-only regardless of provider configuration. The recall pipeline now auto-calls `embedQuery(query)` when `options.queryEmbedding` is undefined; pass `null` to keep the old FTS-only behaviour. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `toRecallOptions` dropping `queryEmbedding` between the `Mnemopi` facade and the beam layer, so callers can now explicitly pin or disable the query vector through the public API.
- Fixed `withMemory` (CLI) and `withBeam`/`withSharedBeam` (MCP) closing the SQLite handle before background fact-extraction and embedding tasks finished, so short-lived `mnemopi store`/`mnemopi sleep` and MCP `remember`/`update` paths now drain `flushExtractions` before close instead of silently dropping `memory_embeddings` rows. CLI handlers and MCP `handleRemember`/`handleUpdate`/`handleSleep`/etc. are async as a result. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)
- Fixed the process-wide `embedQuery()` cache in `core/embeddings.ts` keying by query text alone, which let two `Mnemopi` instances in the same process with different providers/models cross-contaminate their `dense_score` rankings. The cache key now includes a WeakMap-assigned provider identity, the resolved model name, and the configured `apiUrl`, so disjoint runtimes never read each other's cached vectors. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)

## [15.7.4] - 2026-05-31

### Fixed

- Fixed the `darwin-x64` release build failing in `bun build --compile` because the Windows ORT 1.24 preload pulled `onnxruntime-node` into the static graph and there is no `darwin/x64` prebuilt for that line. The preload is now guarded behind a `process.platform === "win32"` literal that Bun dead-code-eliminates on non-Windows targets; macOS/Linux load fastembed's bundled ORT 1.21 binding as before.

## [15.7.3] - 2026-05-31

### Changed

- Changed embedding result normalization to return `Float32Array` vectors so `embed` and `embedQuery` now cache and emit float32 rows
- Changed the embedding provider contract to a single typed `EmbeddingOutput` (`AsyncIterable<number[][]>`) instead of `unknown`, matching fastembed's `embed()`, so `EmbeddingProvider.embed` and the `provider` runtime option stream the embedding matrix as async batches (`async *embed(texts) { yield texts.map(embedOne); }`)
- Changed local model cache directory resolution for `fastembed` to use `getFastembedCacheDir` instead of the hard-coded `~/.hermes/cache/fastembed` path

### Fixed

- Fixed cosine similarity behavior across retrieval, clustering, and caching to consistently handle mismatched vector lengths as zero-padded and ignore non-finite values
- Fixed embedding API requests to retry transient failures with backoff via shared retry logic before returning null
- Fixed compiled `omp` binaries losing local Mnemopi embeddings by keeping `fastembed` and `onnxruntime-node` reachable to Bun's static compiler while preserving lazy runtime loading.

## [15.7.2] - 2026-05-31

### Fixed

- Fixed Windows startup crashes by keeping fastembed's older ONNX Runtime binding lazy until local embeddings are used.
- Fixed a segfault at startup from eagerly loading fastembed: importing the embeddings module pulled in `fastembed`, which eagerly loads the `onnxruntime-node` native addon. The import is now deferred until a local fastembed model is actually initialized, so API-model, disabled-embeddings, and test runtimes never load the native addon.

## [15.6.0] - 2026-05-30

### Added

- Added `llm.extractionPrompt` runtime option to override the fact-extraction prompt template using `{text}` and `{lang}` placeholders
- Added `llm.consolidationPrompt` runtime option to override the consolidation sleep prompt template using `{memories}`, `{source}`, and `{memory_count}` placeholders
- Published `@oh-my-pi/pi-mnemopi` to npm: the local SQLite memory engine is now built, checked, tested, and released through the monorepo CI pipeline alongside the other workspace packages.
- Exported the diagnostic inspector as the `@oh-my-pi/pi-mnemopi/diagnose` subpath for coding-agent memory maintenance commands.
- Added `flushExtractions()` (on `Mnemopi`, `BeamMemory`, and as a module-level export) to drain in-flight background fact extraction; used by tests and graceful shutdown so facts are persisted before the database closes.

### Changed

- Changed fact extraction to prefer a configured runtime LLM completion path before host extraction, with automatic fallback when the configured completion returns no output or fails

### Fixed

- Fixed `rememberBatch(..., { extract: true })` to run background fact extraction for batch uploads (including per-item `extract` flags) so extracted facts are generated and recallable after extraction
- Fixed `extract: true` fact extraction to continue safely when no LLM is configured by turning extraction failures into no-op background tasks
- Fixed configured LLM fact extraction by using temperature 0 so re-ingesting the same text is deterministic and avoids near-duplicate extractions
- Fixed `remember(..., { extract: true })` silently dropping the flag: it now schedules the LLM fact extractor (`extractFactsSafe`) over the stored content and persists the extracted facts so they become recallable. Previously the LLM extractor had no production callers and `extract` was dead.
