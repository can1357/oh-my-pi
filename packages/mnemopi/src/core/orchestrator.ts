import type { BeamMemoryState, RecallOptions, RecallResult } from "./beam/types";
import { embedQuery } from "./embeddings";
import {
	type PolyphonicMemoryResult,
	type PolyphonicRecallOptions,
	polyphonicRecall,
	polyphonicRecallIsEnabled,
} from "./polyphonic-recall";

export interface OrchestratorBeam extends BeamMemoryState {
	recall?: (query: string, topK?: number, options?: RecallOptions) => Promise<RecallResult[]>;
	recallEnhanced?: (query: string, topK?: number, options?: RecallOptions) => Promise<RecallResult[]>;
}

export interface OrchestrateRecallOptions
	extends Omit<RecallOptions, "queryEmbedding">, Omit<PolyphonicRecallOptions, "queryEmbedding"> {
	readonly queryEmbedding?: readonly number[] | Float32Array | null;
	readonly enhanced?: boolean;
	readonly forcePolyphonic?: boolean;
	readonly forceLinear?: boolean;
}

export interface OrchestratedRecallResult extends Omit<RecallResult, "metadata" | "score" | "tier"> {
	score?: number;
	metadata?: RecallResult["metadata"];
	tier?: RecallResult["tier"] | PolyphonicMemoryResult["tier"];
	combined_score?: PolyphonicMemoryResult["combined_score"];
	voice_scores?: PolyphonicMemoryResult["voice_scores"];
}

function toLinearRecallOptions(options: OrchestrateRecallOptions): RecallOptions {
	if (options.queryEmbedding instanceof Float32Array) {
		return { ...options, queryEmbedding: Array.from(options.queryEmbedding) };
	}
	return options as RecallOptions;
}

export async function orchestrateRecall(
	beam: OrchestratorBeam,
	query: string,
	topK = 20,
	options: OrchestrateRecallOptions = {},
): Promise<OrchestratedRecallResult[]> {
	const polyphonic = !options.forceLinear && (options.forcePolyphonic === true || polyphonicRecallIsEnabled());
	let queryEmbedding: readonly number[] | Float32Array | null | undefined = options.queryEmbedding;
	if (queryEmbedding === undefined && query.length > 0) {
		// Auto-derive when the caller did not pass one. `embedQuery()` returns null when
		// embeddings are disabled or no provider is configured, so this is a no-op for
		// FTS-only deployments. `null` (explicit "no embedding") is preserved untouched.
		queryEmbedding = await embedQuery(query);
	}
	if (polyphonic) {
		return polyphonicRecall(beam, query, topK, { ...options, queryEmbedding });
	}
	const linearOptions = toLinearRecallOptions({ ...options, queryEmbedding });
	if (options.enhanced === true && typeof beam.recallEnhanced === "function") {
		return beam.recallEnhanced(query, topK, linearOptions);
	}
	if (typeof beam.recall === "function") return beam.recall(query, topK, linearOptions);
	return [];
}
