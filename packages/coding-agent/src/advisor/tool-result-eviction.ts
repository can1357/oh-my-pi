import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache, MIN_PRUNE_TOKENS } from "@oh-my-pi/pi-agent-core/compaction";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";

/**
 * Tools whose output the advisor can get back by calling them again. Anything
 * else (e.g. `recall` memory) is not re-derivable from the deltas or the
 * advisor's notes, so it is never evicted.
 */
const EVICTABLE_TOOL_NAMES: Record<string, true> = { read: true, grep: true, glob: true };

function createEvictionNotice(tokens: number): string {
	return `[Stale result elided - ${tokens} tokens]`;
}

export interface ToolResultEvictionResult {
	evicted: number;
	tokensSaved: number;
}

function isEvictionCandidate(message: AgentMessage, tokens: number): message is ToolResultMessage {
	if (message.role !== "toolResult") return false;
	return (
		message.prunedAt === undefined && tokens >= MIN_PRUNE_TOKENS && EVICTABLE_TOOL_NAMES[message.toolName] === true
	);
}

/**
 * Index where the most recent review starts: its newest non-synthetic user
 * delta. Everything from here on belongs to the review that just finished and
 * is protected, since the next delta usually touches the same files.
 */
function latestReviewStart(messages: readonly AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && message.synthetic !== true) return i;
	}
	return 0;
}

/**
 * Evict the advisor's stale `read`/`grep`/`glob` output from reviews before
 * the latest one.
 *
 * An advisor re-sends its own investigation output on every later request,
 * while the deltas it reviews and the notes it wrote (which live in `advise`
 * tool-call *arguments*, on assistant messages) carry the actual value.
 *
 * Rewriting history is not free: the provider re-writes the prompt cache from
 * the cut onward, while a saved token is re-read on every later request. So the
 * cut maximizes the margin f(i) = saved(i) − rewrite(i) rather than taking the
 * deepest passing cut: a big eviction must not reach back through several
 * reviews just to reclaim one small result sitting behind thousands of rewrite
 * tokens.
 *
 * Mutates `messages` in place, following compaction's in-place rewrite
 * contract (blank content, `prunedAt`, cache invalidation).
 */
export function evictStaleToolResults(messages: AgentMessage[], tokenizer: Tokenizer): ToolResultEvictionResult {
	const protectFrom = latestReviewStart(messages);
	// The protected tail is never blanked but is still re-written by any cut.
	let nonCandidateAcc = 0;
	for (let i = protectFrom; i < messages.length; i++) nonCandidateAcc += tokenizer.countMessage(messages[i]);

	// One backward pass over the evictable prefix, tracking the running objective:
	//   saved(i)   = Σ (tokens − stub) over candidates at index >= i
	//   rewrite(i) = Σ tokens over non-candidates after i + Σ stub over
	//                candidates at index >= i
	// i.e. exactly the bytes the provider must re-write when the cut is at i.
	let savedAcc = 0;
	let stubAcc = 0;
	let bestIndex = -1;
	let bestMargin = 0;
	let bestSaved = 0;

	for (let i = protectFrom - 1; i >= 0; i--) {
		const message = messages[i];
		const tokens = tokenizer.countMessage(message);
		if (!isEvictionCandidate(message, tokens)) {
			nonCandidateAcc += tokens;
			continue;
		}
		const stub = tokenizer.countTokens(createEvictionNotice(tokens));
		savedAcc += tokens - stub;
		stubAcc += stub;
		const margin = savedAcc - (nonCandidateAcc + stubAcc);
		// Strict improvement keeps the later (shallower) index on ties.
		if (margin > bestMargin) {
			bestMargin = margin;
			bestIndex = i;
			bestSaved = savedAcc;
		}
	}

	if (bestIndex < 0) return { evicted: 0, tokensSaved: 0 };

	const prunedAt = Date.now();
	let evicted = 0;
	for (let i = bestIndex; i < protectFrom; i++) {
		const message = messages[i];
		const tokens = tokenizer.countMessage(message);
		if (!isEvictionCandidate(message, tokens)) continue;
		message.content = [{ type: "text", text: createEvictionNotice(tokens) }];
		message.prunedAt = prunedAt;
		invalidateMessageCache(message);
		evicted++;
	}

	return { evicted, tokensSaved: bestSaved };
}
