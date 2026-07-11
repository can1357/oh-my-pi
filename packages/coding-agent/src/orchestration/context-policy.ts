/**
 * Context policy for batch task spawns — blind-first exploration.
 */

export type ContextPolicy = "shared" | "blind" | "staged";

const BLIND_CONTEXT_HEADER = [
	"# Context (blind policy)",
	"Parent favored hypothesis and sibling findings are withheld for independent exploration.",
	"Use only your assignment and raw evidence below.",
].join("\n");

/**
 * Apply per-spawn context policy. `blind` and `staged` withhold shared batch
 * background that may anchor workers to the parent's favored route.
 */
export function applyContextPolicy(
	policy: ContextPolicy | undefined,
	sharedContext: string | undefined,
): string | undefined {
	const effective = policy ?? "shared";
	if (effective === "shared") {
		return sharedContext;
	}
	// staged: first pass behaves as blind; synthesis phase is parent-driven later
	return BLIND_CONTEXT_HEADER;
}

export interface StagedContextOptions {
	/** Findings from sibling (first-pass) workers to share in synthesis phase. */
	readonly siblingFindings?: string;
	/** Batch correlation ID used to group staged workers. */
	readonly batchId?: string;
}

/**
 * Extended apply that supports staged synthesis: when `contextPolicy === "staged"` and
 * `siblingFindings` are provided, the synthesis-phase spawn receives a combined context
 * block instead of the blind header.
 */
export function applyContextPolicyWithSiblingFindings(
	policy: ContextPolicy | undefined,
	sharedContext: string | undefined,
	options?: StagedContextOptions,
): string | undefined {
	const effective = policy ?? "shared";
	if (effective === "shared") {
		return sharedContext;
	}
	if (effective === "staged" && options?.siblingFindings?.trim()) {
		return [
			BLIND_CONTEXT_HEADER,
			"",
			"# Sibling Findings (synthesis phase)",
			options.siblingFindings.trim(),
		].join("\n");
	}
	return BLIND_CONTEXT_HEADER;
}

export function resolveWorkerMode(agentName: string): "explore" | "implement" | "falsify" | "audit" | "synthesize" | undefined {
	switch (agentName.trim()) {
		case "explore":
			return "explore";
		case "falsify":
			return "falsify";
		case "audit":
			return "audit";
		case "plan":
		case "oracle":
		case "tot-reasoner":
			return "synthesize";
		case "quick_task":
		case "task":
		case "designer":
		case "mr-worker":
			return "implement";
		default:
			return undefined;
	}
}
