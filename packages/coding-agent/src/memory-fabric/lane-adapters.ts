/**
 * Lane Adapters -- concrete {@link MemoryLaneAdapter} implementations for
 * each storage lane, written against injected ports.
 *
 * Every adapter is dependency-inverted: it depends on a small port interface
 * declared here (working-state snapshot source, canonical record store,
 * memvid recall, graph queries, episode recall) rather than on concrete
 * storage modules, so the adapters compile and test without any backing
 * store. Latency probes use an injectable clock.
 *
 * Determinism: memory ids and content hashes are derived from the content
 * itself (FNV-1a), never from wall time or randomness, so the same state
 * always produces the same candidate identity -- which is what makes
 * `excludeMemoryIds` and novelty tracking work across retrievals.
 */

import type {
	LaneHealth,
	MemoryLaneAdapter,
	MemoryScope,
	RetrievedMemoryCandidate,
	TieredRetrievalOptions,
	TieredRetrievalRequest,
} from "./tiered-retrieval-types";

/** Injectable clock (epoch ms). Defaults to `Date.now`. */
export type NowFn = () => number;

/** FNV-1a 32-bit hash, hex encoded. Deterministic and dependency-free. */
export function fnv1a32(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Rough token estimate: one token per four characters, minimum one. */
function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

/** Apply the per-lane confidence floor and candidate cap uniformly. */
function capAndFilter(
	candidates: RetrievedMemoryCandidate[],
	options: TieredRetrievalOptions,
): RetrievedMemoryCandidate[] {
	return candidates.filter(c => c.confidence >= options.minConfidence).slice(0, options.maximumCandidatesPerLane);
}

/** Run a latency probe against a lane's cheapest read. */
async function probeHealth(now: NowFn, probe: () => Promise<unknown> | unknown): Promise<LaneHealth> {
	const start = now();
	try {
		await probe();
		return { healthy: true, latencyMs: Math.max(0, now() - start) };
	} catch {
		return { healthy: false, latencyMs: Math.max(0, now() - start) };
	}
}

/** Snapshot of the current working state, as the L0 lane consumes it. */
export interface WorkingStateSnapshot {
	objective?: string;
	currentStep?: string;
	constraints?: string[];
	unresolvedErrors?: string[];
}

/** Port for the working-state lane: yields the current snapshot, if any. */
export interface WorkingStatePort {
	getCurrent(): Promise<WorkingStateSnapshot | undefined>;
}

/**
 * Working-state lane adapter: projects the live task snapshot into L0
 * continuity candidates (objective, current step), L1 constraints, and L2
 * unresolved errors. Everything here is directly observed, so candidates
 * carry full confidence and `tool-observed` provenance.
 */
export class WorkingStateLaneAdapter implements MemoryLaneAdapter {
	readonly id = "working-state" as const;
	readonly name = "Working State";

	readonly #workingState: WorkingStatePort;
	readonly #now: NowFn;

	constructor(workingState: WorkingStatePort, ports?: { now?: NowFn }) {
		this.#workingState = workingState;
		this.#now = ports?.now ?? Date.now;
	}

	async retrieve(
		request: TieredRetrievalRequest,
		options: TieredRetrievalOptions,
	): Promise<RetrievedMemoryCandidate[]> {
		const state = await this.#workingState.getCurrent();
		if (!state) return [];

		const items: RetrievedMemoryCandidate[] = [];

		if (state.objective) {
			items.push(this.#candidate(request.scope, "L0", "continuity", "objective", state.objective, 1, 1));
		}

		if (state.currentStep) {
			const content = `Current step: ${state.currentStep}`;
			items.push(this.#candidate(request.scope, "L0", "continuity", "current-step", content, 1, 1));
		}

		for (const constraint of state.constraints ?? []) {
			items.push(this.#candidate(request.scope, "L1", "constraint", "constraint", constraint, 0.8, 0.9));
		}

		for (const error of state.unresolvedErrors ?? []) {
			const content = `Unresolved: ${error}`;
			items.push(this.#candidate(request.scope, "L2", "failure", "unresolved-error", content, 0.9, 0.9));
		}

		return capAndFilter(items, options);
	}

	#candidate(
		scope: MemoryScope,
		tier: "L0" | "L1" | "L2",
		type: string,
		subject: string,
		content: string,
		usefulness: number,
		importance: number,
	): RetrievedMemoryCandidate {
		const hash = fnv1a32(content);
		return {
			memoryId: `ws_${subject}_${hash}`,
			lane: "working-state",
			tier,
			type,
			subject,
			content,
			scope,
			lexicalScore: 1,
			scopeScore: 1,
			confidence: 1,
			freshness: 1,
			usefulness,
			importance,
			status: "active",
			verification: "tool-observed",
			sourceReferences: [`working-state:${subject}`],
			contentHash: hash,
			tokenEstimate: estimateTokens(content),
		};
	}

	healthCheck(): Promise<LaneHealth> {
		return probeHealth(this.#now, () => this.#workingState.getCurrent());
	}
}

/** A canonical memory record, as the canonical lane consumes it. */
export interface CanonicalRecordLike {
	id: string;
	type: string;
	subject?: string;
	content: string;
	scope: MemoryScope;
	confidence: number;
	importance: number;
	status: RetrievedMemoryCandidate["status"];
	verification: RetrievedMemoryCandidate["verification"];
	sourceReferences: string[];
	contentHash: string;
	/** ISO-8601 creation timestamp; drives freshness decay. */
	createdAt: string;
}

/** Port for the canonical lane: scope-filtered record listing. */
export interface CanonicalStorePort {
	getRecordsByScope(scope: MemoryScope): CanonicalRecordLike[];
}

/** Freshness decays linearly to zero over this horizon. */
const FRESHNESS_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Canonical lane adapter: maps stored records to candidates, inferring the
 * context tier from record type and lifecycle status. Superseded or archived
 * records sink to L4 regardless of type.
 */
export class CanonicalLaneAdapter implements MemoryLaneAdapter {
	readonly id = "canonical" as const;
	readonly name = "Canonical Memory";

	readonly #store: CanonicalStorePort;
	readonly #now: NowFn;

	constructor(store: CanonicalStorePort, ports?: { now?: NowFn }) {
		this.#store = store;
		this.#now = ports?.now ?? Date.now;
	}

	async retrieve(
		request: TieredRetrievalRequest,
		options: TieredRetrievalOptions,
	): Promise<RetrievedMemoryCandidate[]> {
		const records = this.#store.getRecordsByScope(request.scope);
		const included = records.filter(r => options.includeProvisional || r.verification !== "model-proposed");

		const candidates = included.map<RetrievedMemoryCandidate>(record => ({
			memoryId: record.id,
			lane: "canonical",
			tier: inferCanonicalTier(record),
			type: record.type,
			subject: record.subject ?? record.type,
			content: record.content,
			scope: record.scope,
			scopeScore: 1,
			confidence: record.confidence,
			freshness: this.#computeFreshness(record.createdAt),
			usefulness: record.importance,
			importance: record.importance,
			status: record.status,
			verification: record.verification,
			sourceReferences: record.sourceReferences,
			contentHash: record.contentHash,
			tokenEstimate: estimateTokens(record.content),
		}));

		return capAndFilter(candidates, options);
	}

	#computeFreshness(createdAt: string): number {
		const createdMs = new Date(createdAt).getTime();
		if (!Number.isFinite(createdMs)) return 0;
		const ageMs = Math.max(0, this.#now() - createdMs);
		return Math.max(0, 1 - ageMs / FRESHNESS_HORIZON_MS);
	}

	healthCheck(): Promise<LaneHealth> {
		return probeHealth(this.#now, () => this.#store.getRecordsByScope({ projectId: "__health__" }));
	}
}

/** Infer the context tier of a canonical record. */
export function inferCanonicalTier(
	record: Pick<CanonicalRecordLike, "type" | "status">,
): "L0" | "L1" | "L2" | "L3" | "L4" {
	if (record.status === "superseded" || record.status === "archived") return "L4";
	if (record.type === "evidence") return "L3";
	if (record.type === "episode") return "L4";
	if (record.type === "working-state") return "L0";
	if (["decision", "procedure", "constraint", "preference", "fact"].includes(record.type)) return "L1";
	return "L2";
}

/** One memory returned by a memvid recall. */
export interface MemvidRecalledMemory {
	id: string;
	content: string;
	type?: string;
	timestamp?: string;
}

/** Port for the memvid lane: token-budgeted recall of typed memories. */
export interface MemvidRecallPort {
	recall(query: string, options: { maxTokens: number; types?: string[] }): Promise<MemvidRecalledMemory[]>;
}

/**
 * Memvid lane adapter: recalls evidence and episodes for L3/L4. Only
 * consulted when L4 is requested or the request asks for history.
 */
export class MemvidLaneAdapter implements MemoryLaneAdapter {
	readonly id = "memvid" as const;
	readonly name = "Memvid Evidence";

	readonly #memvid: MemvidRecallPort;
	readonly #now: NowFn;

	constructor(memvid: MemvidRecallPort, ports?: { now?: NowFn }) {
		this.#memvid = memvid;
		this.#now = ports?.now ?? Date.now;
	}

	async retrieve(
		request: TieredRetrievalRequest,
		options: TieredRetrievalOptions,
	): Promise<RetrievedMemoryCandidate[]> {
		if (!request.requestedTiers.includes("L4") && !request.includeHistorical) return [];

		const memories = await this.#memvid.recall(request.query, {
			maxTokens: request.maximumTokens ?? 8000,
			types: ["evidence", "episode"],
		});

		const candidates = memories
			.filter(m => m.content.length > 0)
			.map<RetrievedMemoryCandidate>(memory => ({
				memoryId: memory.id,
				lane: "memvid",
				tier: memory.type === "evidence" ? "L3" : "L4",
				type: memory.type ?? "episode",
				subject: memory.type ?? "episode",
				content: memory.content,
				scope: request.scope,
				scopeScore: 0.8,
				confidence: 0.7,
				freshness: 0.5,
				usefulness: 0.6,
				importance: 0.5,
				status: "active",
				verification: "episode-derived",
				sourceReferences: [`memvid:${memory.id}`],
				contentHash: fnv1a32(memory.content),
				tokenEstimate: estimateTokens(memory.content),
			}));

		return capAndFilter(candidates, options);
	}

	healthCheck(): Promise<LaneHealth> {
		return probeHealth(this.#now, () => this.#memvid.recall("__health__", { maxTokens: 10 }));
	}
}

/** Port for the graphify lane: structural code-graph queries. */
export interface GraphQueryPort {
	findCallers(symbol: string, scope: string): Promise<string[]>;
	findCallees(symbol: string, scope: string): Promise<string[]>;
	findDependencies(file: string, scope: string): Promise<string[]>;
	findDependents(file: string, scope: string): Promise<string[]>;
}

/**
 * Graphify lane adapter: turns dependency and call relationships into L3
 * structural candidates. Edges are deduplicated by direction-normalised id,
 * so a mutual dependency between two requested files yields one candidate
 * per edge rather than duplicates.
 */
export class GraphifyLaneAdapter implements MemoryLaneAdapter {
	readonly id = "graphify" as const;
	readonly name = "Graphify Code Graph";

	readonly #graph: GraphQueryPort;
	readonly #now: NowFn;

	constructor(graph: GraphQueryPort, ports?: { now?: NowFn }) {
		this.#graph = graph;
		this.#now = ports?.now ?? Date.now;
	}

	async retrieve(
		request: TieredRetrievalRequest,
		options: TieredRetrievalOptions,
	): Promise<RetrievedMemoryCandidate[]> {
		const files = request.files ?? [];
		const symbols = request.symbols ?? [];
		if (!request.requestedTiers.includes("L3") && files.length === 0 && symbols.length === 0) return [];

		const projectId = request.scope.projectId;
		const byId = new Map<string, RetrievedMemoryCandidate>();
		const add = (candidate: RetrievedMemoryCandidate): void => {
			if (!byId.has(candidate.memoryId)) byId.set(candidate.memoryId, candidate);
		};

		for (const file of files) {
			const [deps, dependents] = await Promise.all([
				this.#graph.findDependencies(file, projectId),
				this.#graph.findDependents(file, projectId),
			]);
			for (const dep of deps) {
				add(this.#edgeCandidate(request.scope, "dependency", file, dep, `${file} depends on ${dep}`));
			}
			for (const dependent of dependents) {
				const content = `${dependent} depends on ${file}`;
				add(this.#edgeCandidate(request.scope, "dependency", dependent, file, content));
			}
		}

		for (const symbol of symbols) {
			const [callers, callees] = await Promise.all([
				this.#graph.findCallers(symbol, projectId),
				this.#graph.findCallees(symbol, projectId),
			]);
			for (const caller of callers) {
				add(this.#edgeCandidate(request.scope, "call", caller, symbol, `${caller} calls ${symbol}`));
			}
			for (const callee of callees) {
				add(this.#edgeCandidate(request.scope, "call", symbol, callee, `${symbol} calls ${callee}`));
			}
		}

		return capAndFilter([...byId.values()], options);
	}

	#edgeCandidate(
		scope: MemoryScope,
		kind: "dependency" | "call",
		from: string,
		to: string,
		content: string,
	): RetrievedMemoryCandidate {
		const edgeId = `gf_${kind}_${fnv1a32(`${from}->${to}`)}`;
		return {
			memoryId: edgeId,
			lane: "graphify",
			tier: "L3",
			type: "graph-path",
			subject: `${kind}: ${from} -> ${to}`,
			content,
			scope,
			graphScore: 1,
			scopeScore: 1,
			confidence: 0.9,
			freshness: 0.9,
			usefulness: 0.8,
			importance: 0.8,
			status: "active",
			verification: "source-extracted",
			sourceReferences: [`graphify:${kind}:${from}:${to}`],
			contentHash: fnv1a32(content),
			tokenEstimate: estimateTokens(content),
		};
	}

	healthCheck(): Promise<LaneHealth> {
		return probeHealth(this.#now, () => this.#graph.findCallers("__health__", "__health__"));
	}
}

/** One recalled episode from the mempalace lane. */
export interface RecalledEpisode {
	episodeId: string;
	content: string;
	timestamp: string;
}

/** Port for the mempalace lane: episodic recall by query and project. */
export interface EpisodeRecallPort {
	recallEpisode(query: string, scope: string): Promise<RecalledEpisode[]>;
}

/**
 * MemPalace lane adapter: recalls historical episodes for L4. Only consulted
 * when L4 is requested or the request asks for history.
 */
export class MemPalaceLaneAdapter implements MemoryLaneAdapter {
	readonly id = "mempalace" as const;
	readonly name = "MemPalace Episodes";

	readonly #episodes: EpisodeRecallPort;
	readonly #now: NowFn;

	constructor(episodes: EpisodeRecallPort, ports?: { now?: NowFn }) {
		this.#episodes = episodes;
		this.#now = ports?.now ?? Date.now;
	}

	async retrieve(
		request: TieredRetrievalRequest,
		options: TieredRetrievalOptions,
	): Promise<RetrievedMemoryCandidate[]> {
		if (!request.requestedTiers.includes("L4") && !request.includeHistorical) return [];

		const recalled = await this.#episodes.recallEpisode(request.query, request.scope.projectId);

		const candidates = recalled.map<RetrievedMemoryCandidate>(ep => ({
			memoryId: ep.episodeId,
			lane: "mempalace",
			tier: "L4",
			type: "episode",
			subject: "historical-episode",
			content: ep.content,
			scope: request.scope,
			scopeScore: 0.8,
			confidence: 0.7,
			freshness: 0.5,
			usefulness: 0.6,
			importance: 0.5,
			status: "active",
			verification: "episode-derived",
			sourceReferences: [`mempalace:episode:${ep.episodeId}`],
			contentHash: fnv1a32(ep.content),
			tokenEstimate: estimateTokens(ep.content),
		}));

		return capAndFilter(candidates, options);
	}

	healthCheck(): Promise<LaneHealth> {
		return probeHealth(this.#now, () => this.#episodes.recallEpisode("__health__", "__health__"));
	}
}
