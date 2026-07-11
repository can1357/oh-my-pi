/**
 * Pure content utilities for the Hindsight backend.
 *
 * Ports the semantics of the upstream OpenCode plugin
 * (vectorize-io/hindsight @ hindsight-integrations/opencode/src/content.ts):
 *   - tag stripping for anti-feedback (a recalled <memories> block must
 *     never end up retained as a new memory)
 *   - recall query composition + truncation under a character budget
 *   - retention transcript framing
 */

export interface HindsightMessage {
	role: string;
	content: string;
}

export interface RecallResultLike {
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
}

const MEMORIES_REGEX = /<memories>[\s\S]*?<\/memories>/g;
const LEGACY_HINDSIGHT_MEMORIES_REGEX = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g;
const LEGACY_RELEVANT_MEMORIES_REGEX = /<relevant_memories>[\s\S]*?<\/relevant_memories>/g;
const MENTAL_MODELS_REGEX = /<mental_models>[\s\S]*?<\/mental_models>/g;

/**
 * Strip `<memories>`, `<mental_models>`, and legacy memory blocks.
 *
 * Both `<memories>` (per-turn recall) and `<mental_models>` (curated semantic
 * memory) are injected into the system prompt. If either leaks into the
 * retention transcript, every retain becomes a tighter feedback loop —
 * paraphrased memories feed the next consolidation, which feeds the next
 * mental-model refresh, which feeds the next retain. Always strip before
 * retaining.
 */
export function stripMemoryTags(content: string): string {
	return content
		.replace(MEMORIES_REGEX, "")
		.replace(MENTAL_MODELS_REGEX, "")
		.replace(LEGACY_HINDSIGHT_MEMORIES_REGEX, "")
		.replace(LEGACY_RELEVANT_MEMORIES_REGEX, "");
}

// At least one letter or digit means the message carries a token a retriever
// can actually match on. Punctuation/whitespace-only strings (e.g. the lone
// `.` some providers emit for tool-call-only or thinking-only assistant turns)
// are dropped before retain/recall touches them — see issue #1806.
const SUBSTANTIVE_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * True when `content` carries at least one letter or digit. Used by retain
 * and recall paths to drop placeholder assistant turns ("." / "..." / pure
 * whitespace) that would otherwise pollute the bank and waste tokens on
 * embeddings with no semantic content.
 */
export function hasSubstantiveContent(content: string): boolean {
	return SUBSTANTIVE_CHAR_RE.test(content);
}

/** Format recall results into a bullet list for context injection. */
export function formatMemories(results: RecallResultLike[]): string {
	if (results.length === 0) return "";
	return results
		.map(r => {
			const typeStr = r.type ? ` [${r.type}]` : "";
			const dateStr = r.mentioned_at ? ` (${r.mentioned_at})` : "";
			return `- ${r.text}${typeStr}${dateStr}`;
		})
		.join("\n\n");
}

/** Format current UTC time for the recall preamble. */
export function formatCurrentTime(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const h = String(now.getUTCHours()).padStart(2, "0");
	const min = String(now.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Slice messages to the last N turns, where a turn boundary is a user message.
 * Returns the trailing tail starting at the (N-th from the end) user message.
 */
export function sliceLastTurnsByUserBoundary(messages: HindsightMessage[], turns: number): HindsightMessage[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsSeen += 1;
			if (userTurnsSeen >= turns) {
				startIndex = i;
				break;
			}
		}
	}

	return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

/**
 * Compose a recall query from the latest user prompt plus optional prior context.
 *
 * When `recallContextTurns <= 1` the query is just the trimmed latest prompt.
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: HindsightMessage[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const contextLines: string[] = [];

	for (const msg of contextual) {
		const content = stripMemoryTags(msg.content).trim();
		if (!content) continue;
		if (msg.role === "user" && content === latest) continue;
		contextLines.push(`${msg.role}: ${content}`);
	}

	if (contextLines.length === 0) return latest;
	return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to `maxChars`.
 *
 * Always preserves the latest user message. Drops oldest context lines first
 * and degrades gracefully when even the latest message exceeds the budget.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;

	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

	if (!query.includes("Prior context:")) return latestOnly;

	const contextMarker = "Prior context:\n\n";
	const markerIndex = query.indexOf(contextMarker);
	if (markerIndex === -1) return latestOnly;

	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;

	const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
	const contextLines = contextBody.split("\n").filter(Boolean);

	const kept: string[] = [];
	for (let i = contextLines.length - 1; i >= 0; i--) {
		kept.unshift(contextLines[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			break;
		}
	}

	if (kept.length > 0) return `${contextMarker}${kept.join("\n")}${suffix}`;
	return latestOnly;
}

export interface RetentionTranscript {
	transcript: string | null;
	messageCount: number;
}

/**
 * Format messages into a retention transcript using `[role: ...]` markers.
 *
 * - When `retainFullWindow` is true, all messages are included (used when the
 *   caller pre-sliced the window itself).
 * - Otherwise, only the last user turn (last user message → end) is retained.
 *
 * Messages are tag-stripped before framing to break the recall→retain loop.
 * Returns `{ transcript: null }` when nothing meaningful survives.
 */
function formatRetentionMessages(messages: HindsightMessage[]): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const content = stripMemoryTags(msg.content).trim();
		if (!hasSubstantiveContent(content)) continue;
		parts.push(`[role: ${msg.role}]\n${content}\n[${msg.role}:end]`);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

export function prepareRetentionTranscript(
	messages: HindsightMessage[],
	retainFullWindow = false,
): RetentionTranscript {
	if (messages.length === 0) return { transcript: null, messageCount: 0 };

	let targetMessages: HindsightMessage[];
	if (retainFullWindow) {
		targetMessages = messages;
	} else {
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
		targetMessages = messages.slice(lastUserIdx);
	}

	return formatRetentionMessages(targetMessages);
}

/** Format only user-authored messages for memory fact/entity extraction. */
export function prepareUserRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatRetentionMessages(messages.filter(message => message.role === "user"));
}
