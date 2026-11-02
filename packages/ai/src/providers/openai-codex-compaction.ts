import type { CodexCompactionContext, CodexCompactionRequestContext } from "../types";

/** Add the selected wire implementation to one logical compaction context. */
export function createOpenAICodexCompactionRequestContext(options: {
	context: CodexCompactionContext | undefined;
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
}): CodexCompactionRequestContext | undefined {
	const context = options.context;
	if (!context) return undefined;
	return {
		operationId: context.operationId,
		trigger: context.trigger,
		reason: context.reason,
		implementation: options.implementation,
		phase: context.phase,
		strategy: context.strategy,
	};
}
