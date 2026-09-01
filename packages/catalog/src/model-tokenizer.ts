import { compareRevision, parseRevision } from "./compat/revision";
import { classifyModel } from "./compat/taxonomy";
import type { ModelIdentity } from "./compat/types";
import { bareModelId } from "./identity/id";
import type { ModelTokenizer } from "./types";

// Resolution is pure and catalog ids recur across providers and aliases.
const MAX_TOKENIZER_CACHE_ENTRIES = 2_048;
const modelTokenizerCache = new Map<string, ModelTokenizer | null>();

function revisionAtLeast(revision: string | undefined, floor: string): boolean {
	if (revision === undefined) return false;
	const parsedRevision = parseRevision(revision);
	const parsedFloor = parseRevision(floor);
	return (
		parsedRevision !== undefined && parsedFloor !== undefined && compareRevision(parsedRevision, parsedFloor) >= 0
	);
}

function claudeTokenizer(identity: ModelIdentity): ModelTokenizer | undefined {
	if (identity.class !== "anthropic") return undefined;
	if (identity.family === "opus") {
		if (revisionAtLeast(identity.revision, "5")) return "claude-v5";
		if (revisionAtLeast(identity.revision, "4.7")) return "claude-v47";
		return "claude-v3";
	}
	if (identity.family === "sonnet" || identity.family === "fable" || identity.family === "mythos") {
		return revisionAtLeast(identity.revision, "5") ? "claude-v5-sonnet" : "claude-v3";
	}
	return "claude-v3";
}

function qwenTokenizer(identity: ModelIdentity): ModelTokenizer | undefined {
	return identity.class === "qwen" && revisionAtLeast(identity.revision, "3.5") ? "qwen3" : undefined;
}

function deepSeekTokenizer(identity: ModelIdentity): ModelTokenizer | undefined {
	return identity.class === "deepseek" ? "deepseek-v3" : undefined;
}

function kimiTokenizer(identity: ModelIdentity): ModelTokenizer | undefined {
	return identity.class === "kimi" ? "kimi-k2" : undefined;
}

function glmTokenizer(identity: ModelIdentity): ModelTokenizer | undefined {
	return identity.class === "glm" && revisionAtLeast(identity.revision, "5") ? "glm5" : undefined;
}

/**
 * Resolve the exact locally embedded tokenizer for a canonical model id.
 *
 * This is catalog policy, not a runtime caller heuristic: [`buildModel`](./build.ts)
 * materializes the result as `Model.tokenizer`; consumers read that property.
 */
export function resolveModelTokenizer(modelId: string): ModelTokenizer | undefined {
	const cached = modelTokenizerCache.get(modelId);
	if (cached !== undefined) return cached ?? undefined;
	const identity = classifyModel("", bareModelId(modelId), { lenient: true });
	const tokenizer =
		claudeTokenizer(identity) ??
		qwenTokenizer(identity) ??
		deepSeekTokenizer(identity) ??
		kimiTokenizer(identity) ??
		glmTokenizer(identity);
	if (modelTokenizerCache.size === MAX_TOKENIZER_CACHE_ENTRIES) modelTokenizerCache.clear();
	modelTokenizerCache.set(modelId, tokenizer ?? null);
	return tokenizer;
}
