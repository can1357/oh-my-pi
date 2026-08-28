/**
 * Cache-coherence seams for the two hot history walks: token estimation
 * ({@link Tokenizer.countMessage}) and LLM conversion (the coding-agent's
 * `convertToLlm`).
 *
 * Long sessions re-walk a settled `AgentMessage[]` every turn, re-tokenizing and
 * re-converting historical objects that only the newest suffix can change. Each
 * `Tokenizer` memoizes estimates per message identity; this module owns the two
 * invariants that keep those memos (and the cross-package convert memo) honest:
 *
 * 1. **Settle gate.** A streaming assistant is mutated under one identity while
 *    its `usage`/`stopReason` are provisional (the seed carries zeroed usage and
 *    a placeholder `stopReason`). Caching it would freeze a mid-stream count, so
 *    estimation only caches assistants that are settled — real `usage`
 *    (`totalTokens > 0`) with a terminal `stopReason` that is not `"aborted"` /
 *    `"error"`. Unsettled assistants never read or insert. Non-assistant roles
 *    are immutable once appended and cache by identity.
 * 2. **Owner invalidation.** `pruneToolOutputs` / `pruneSupersededToolResults`,
 *    `applyShakeRegion`, and `stripImagesFromMessage` rewrite message content in
 *    place under a stable identity. Each MUST call {@link invalidateMessageCache}
 *    on the mutated message before the next convert/estimate pass. Invalidation
 *    bumps a symbol-keyed version tag on the message itself, so every live
 *    `Tokenizer` memo drops its stale entry at once without registering
 *    anywhere; the convert cache lives in another package and subscribes via
 *    {@link registerMessageCacheInvalidator}.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "../types";

/** External cache invalidators (e.g. the coding-agent `convertToLlm` memo). */
const externalInvalidators = new Set<(message: AgentMessage) => void>();

/**
 * Register a cache tied to message identity so owner mutations in this package
 * (prune/shake) can invalidate it across the package boundary. Returns an
 * unregister function. The coding-agent `convertToLlm` memo registers here.
 */
export function registerMessageCacheInvalidator(invalidate: (message: AgentMessage) => void): () => void {
	externalInvalidators.add(invalidate);
	return () => {
		externalInvalidators.delete(invalidate);
	};
}

/**
 * Estimate-version tag riding on the message itself. Symbol-keyed, so JSON
 * session persistence and default iteration never see it. Object spread copies
 * the tag onto derived clones — harmless, because estimate memos key on message
 * *identity* and a fresh clone starts with no memo entries anywhere.
 */
const kEstimateVersion = Symbol("omp.messageEstimateVersion");

interface VersionedMessage {
	[kEstimateVersion]?: number;
}

/**
 * Current estimate version of `message` (0 until first invalidation). A
 * `Tokenizer` memo entry stamped with an older version is stale and must be
 * recounted.
 */
export function messageEstimateVersion(message: AgentMessage): number {
	return (message as VersionedMessage)[kEstimateVersion] ?? 0;
}

/**
 * True when this message's estimate is safe to cache by identity. Non-assistants
 * are immutable once appended; assistants are cached only once settled (see the
 * settle-gate invariant above).
 */
export function isEstimateCacheable(message: AgentMessage): boolean {
	if (message.role !== "assistant") return true;
	const assistant = message as AssistantMessage;
	return (
		assistant.stopReason !== "aborted" &&
		assistant.stopReason !== "error" &&
		assistant.usage != null &&
		assistant.usage.totalTokens > 0
	);
}

/**
 * Drop every cached derivation of `message` after an in-place rewrite. Owners of
 * mutation (prune, shake, strip-images) call this at the mutation seam so the
 * next convert/estimate pass recomputes from the new content.
 */
export function invalidateMessageCache(message: AgentMessage): void {
	const versioned = message as VersionedMessage;
	versioned[kEstimateVersion] = ((versioned[kEstimateVersion] ?? 0) + 1) | 0;
	for (const invalidate of externalInvalidators) invalidate(message);
}
