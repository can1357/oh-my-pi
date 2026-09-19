/**
 * Normalize isolated RLM worker usage from completer results + lease reconcile.
 * Used by broker/query paths and grant-repair attribution (worker ran → usage kept).
 */

export type RlmWorkerUsageSource = "provider" | "lease_estimate" | "none";

export interface RlmWorkerUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	totalTokens?: number;
	cost?: number;
	provider?: string;
	model?: string;
	/** At least one provider-reported usage field (not char/4 estimate alone). */
	providerReported: boolean;
	source: RlmWorkerUsageSource;
}

export interface RlmWorkerUsageFields {
	tokens?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	provider?: string;
	model?: string;
	workerUsageKnown?: boolean;
	workerUsageSource?: RlmWorkerUsageSource;
}

type CompleterObject = {
	tokens?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	provider?: string;
	model?: string;
};

export function resolveCompleterTotalTokens(raw: unknown, approxTokens: number): number {
	if (typeof raw === "string") return approxTokens;
	const obj = raw as CompleterObject;
	if (obj.tokens != null && obj.tokens > 0) return Math.floor(obj.tokens);
	const io = Math.max(0, Math.floor(obj.inputTokens ?? 0)) + Math.max(0, Math.floor(obj.outputTokens ?? 0));
	if (io > 0) return io;
	return approxTokens;
}

export function extractWorkerUsageFromCompleter(raw: unknown, approxTokens: number): RlmWorkerUsage {
	if (typeof raw === "string") {
		return {
			totalTokens: approxTokens,
			providerReported: false,
			source: "lease_estimate",
		};
	}
	const obj = raw as CompleterObject;
	const inputTokens = obj.inputTokens;
	const outputTokens = obj.outputTokens;
	const cacheReadTokens = obj.cacheReadTokens;
	const cost = obj.cost;
	const providerReported =
		(inputTokens ?? 0) > 0 ||
		(outputTokens ?? 0) > 0 ||
		(cacheReadTokens ?? 0) > 0 ||
		(cost ?? 0) > 0 ||
		(obj.tokens != null && obj.tokens > 0);
	const totalTokens = resolveCompleterTotalTokens(raw, approxTokens);
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		totalTokens,
		cost,
		provider: obj.provider,
		model: obj.model,
		providerReported,
		source: providerReported ? "provider" : "lease_estimate",
	};
}

export function mergeReconciledWorkerUsage(
	usage: RlmWorkerUsage,
	reconciled: { tokens: number; cost: number; lease?: { inputTokens?: number; outputTokens?: number } },
): RlmWorkerUsage {
	const inputTokens = usage.inputTokens ?? reconciled.lease?.inputTokens;
	const outputTokens = usage.outputTokens ?? reconciled.lease?.outputTokens;
	return {
		...usage,
		inputTokens,
		outputTokens,
		totalTokens: reconciled.tokens,
		cost: reconciled.cost,
	};
}

export function workerUsageToQueryFields(usage: RlmWorkerUsage | undefined): RlmWorkerUsageFields {
	if (!usage) return { workerUsageKnown: false, workerUsageSource: "none" };
	return {
		tokens: usage.totalTokens,
		cost: usage.cost,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		provider: usage.provider,
		model: usage.model,
		workerUsageKnown: usage.providerReported,
		workerUsageSource: usage.source,
	};
}

export function brokerResultUsageFields(result: {
	tokens?: number;
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	provider?: string;
	model?: string;
	workerUsageKnown?: boolean;
	workerUsageSource?: RlmWorkerUsageSource;
}): RlmWorkerUsageFields {
	return {
		tokens: result.tokens,
		cost: result.cost,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		cacheReadTokens: result.cacheReadTokens,
		provider: result.provider,
		model: result.model,
		workerUsageKnown: result.workerUsageKnown,
		workerUsageSource: result.workerUsageSource,
	};
}
