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
	/** Original SessionEntry.timestamp; omitted when the source had none. */
	timestamp?: string;
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
const HANDOFF_FILES_REGEX = /<files>[\s\S]*?<\/files>/gi;
const HANDOFF_PREAMBLE_REGEX =
	/^\s*Context replaced\.\s+The <handoff> below is a handoff document[\s\S]*?(?=<handoff>)/i;
const HANDOFF_WRAPPER_REGEX = /<handoff>([\s\S]*?)<\/handoff>/i;
const SHORT_CONTINUATION_PUNCTUATION_RE = /[.!?,;~。！？，、；～]+$/;
const SHORT_CONTINUATION_RE =
	/^(?:continue|go ahead|proceed|keep going|carry on|next|next step|ok|okay|yes|yep|sure|do it|please continue|繼續|继续|好|好的|好喔|沒問題|没问题|下一步|確認|确认|執行|执行|開始|开始|請繼續|请继续)$/i;

const RETENTION_PROTOCOL_MARKER_REGEX = /^\[(?:role:\s*[-_a-zA-Z0-9]+|[-_a-zA-Z0-9]+:end|timestamp:\s+.+)\]$/;
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
/**
 * Compact handoff documents for recall by stripping verbose `<files>` listings
 * and system preamble so substantive goals and progress dominate the query.
 *
 * If `<handoff>` is not present, returns `text` unchanged.
 */
export function compactHandoffForRecall(text: string): string {
	const hasHandoffTag = /<handoff>/i.test(text);
	if (!hasHandoffTag && !/<files>/i.test(text)) return text;
	if (!hasHandoffTag) {
		return /^\s*##\s+Goal\b/im.test(text) ? text.replace(HANDOFF_FILES_REGEX, "") : text;
	}
	let cleaned = text.replace(HANDOFF_PREAMBLE_REGEX, "");
	cleaned = cleaned.replace(HANDOFF_WRAPPER_REGEX, (_, inner: string) => {
		return inner.replace(HANDOFF_FILES_REGEX, "");
	});
	return cleaned;
}

/**
 * Returns true when `text` is a concise continuation or confirmation prompt
 * (e.g. "continue", "go ahead", "ok", "繼續", "下一步") rather than a substantive query.
 */
export function isShortContinuationPrompt(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > 32) return false;
	const normalized = trimmed.replace(SHORT_CONTINUATION_PUNCTUATION_RE, "").trim();
	return SHORT_CONTINUATION_RE.test(normalized);
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
export function sliceLastTurnsByUserBoundary(messages: readonly HindsightMessage[], turns: number): HindsightMessage[] {
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
 * When `recallContextTurns <= 1`, returns the latest prompt unless it is a short
 * continuation prompt (in which case it prepends the most recent substantive user prompt).
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: readonly HindsightMessage[],
	recallContextTurns: number,
): string {
	const latest = compactHandoffForRecall(stripMemoryTags(latestQuery)).trim();
	if (messages.length === 0 || recallContextTurns <= 0) return latest;

	let trailingUserIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			const cleaned = compactHandoffForRecall(stripMemoryTags(messages[i].content)).trim();
			if (cleaned === latest) {
				trailingUserIndex = i;
				break;
			}
		}
	}

	if (recallContextTurns === 1) {
		if (!isShortContinuationPrompt(latest)) return latest;
		const searchFrom = trailingUserIndex >= 0 ? trailingUserIndex - 1 : messages.length - 1;
		for (let i = searchFrom; i >= 0; i--) {
			if (messages[i].role === "user") {
				const c = compactHandoffForRecall(stripMemoryTags(messages[i].content)).trim();
				if (hasSubstantiveContent(c) && !isShortContinuationPrompt(c)) {
					const safeContent = c.replace(/\n(?=(?:user|assistant|system|tool): )/g, "\n  ");
					return `Prior context:\n\nuser: ${safeContent}\n\n${latest}`;
				}
			}
		}
		return latest;
	}

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const contextLines: string[] = [];
	let contextualTrailingUserIndex = -1;
	for (let i = contextual.length - 1; i >= 0; i--) {
		if (contextual[i].role === "user") {
			const content = compactHandoffForRecall(stripMemoryTags(contextual[i].content)).trim();
			if (content === latest) {
				contextualTrailingUserIndex = i;
				break;
			}
		}
	}

	for (let i = 0; i < contextual.length; i++) {
		const msg = contextual[i];
		const content = compactHandoffForRecall(stripMemoryTags(msg.content)).trim();
		if (!content || (msg.role === "assistant" && !hasSubstantiveContent(content))) continue;
		if (i === contextualTrailingUserIndex && content === latest) continue;
		const safeContent = content.replace(/\n(?=(?:user|assistant|system|tool): )/g, "\n  ");
		contextLines.push(`${msg.role}: ${safeContent}`);
	}

	const isLatestContinuation = isShortContinuationPrompt(latest);
	const hasSubstantiveUserInLines = contextLines.some(line => {
		if (!line.startsWith("user: ")) return false;
		const promptText = line.slice("user: ".length);
		return hasSubstantiveContent(promptText) && !isShortContinuationPrompt(promptText);
	});

	if (isLatestContinuation && !hasSubstantiveUserInLines) {
		const sliceStartIndex = messages.length - contextual.length;
		for (let i = sliceStartIndex - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				const c = compactHandoffForRecall(stripMemoryTags(messages[i].content)).trim();
				if (hasSubstantiveContent(c) && !isShortContinuationPrompt(c)) {
					const safeContent = c.replace(/\n(?=(?:user|assistant|system|tool): )/g, "\n  ");
					contextLines.unshift(`user: ${safeContent}`);
					break;
				}
			}
		}
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

	const latest = compactHandoffForRecall(stripMemoryTags(latestQuery)).trim();
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
	const contextEntries = contextBody.split(/\n(?=(?:user|assistant|system|tool): )/).filter(Boolean);

	const kept: string[] = [];
	for (let i = contextEntries.length - 1; i >= 0; i--) {
		kept.unshift(contextEntries[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			continue;
		}
	}

	const isSubstantiveUserEntry = (entry: string): boolean => {
		if (!entry.startsWith("user: ")) return false;
		const promptText = entry.slice("user: ".length);
		return hasSubstantiveContent(promptText) && !isShortContinuationPrompt(promptText);
	};

	let mostRecentSubstantiveUser: string | undefined;
	for (let i = contextEntries.length - 1; i >= 0; i--) {
		if (isSubstantiveUserEntry(contextEntries[i])) {
			mostRecentSubstantiveUser = contextEntries[i];
			break;
		}
	}

	if (kept.length > 0) {
		const keptHasSubstantiveUser = kept.some(isSubstantiveUserEntry);
		if (keptHasSubstantiveUser || !mostRecentSubstantiveUser) {
			return `${contextMarker}${kept.join("\n")}${suffix}`;
		}
		const keptBody = kept.join("\n");
		const remainingForTask = maxChars - contextMarker.length - 1 - keptBody.length - suffix.length;
		if (remainingForTask >= 10) {
			const slicedTask = mostRecentSubstantiveUser.slice(0, remainingForTask);
			return `${contextMarker}${slicedTask}\n${keptBody}${suffix}`;
		}
	}

	// Either kept is empty or kept only held trivial entries that crowded out the oversized substantive user prompt.
	const available = maxChars - contextMarker.length - suffix.length;
	if (available >= 10) {
		let targetEntry = mostRecentSubstantiveUser;
		if (!targetEntry) {
			for (let i = contextEntries.length - 1; i >= 0; i--) {
				if (contextEntries[i].startsWith("user: ")) {
					targetEntry = contextEntries[i];
					break;
				}
			}
		}
		if (!targetEntry && contextEntries.length > 0) {
			targetEntry = contextEntries[contextEntries.length - 1];
		}
		if (targetEntry) {
			const sliced = targetEntry.slice(0, available);
			return `${contextMarker}${sliced}${suffix}`;
		}
	}

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
function formatRetentionMessage(msg: HindsightMessage, includeTimestamps = false): string | null {
	const content = stripMemoryTags(msg.content).trim();
	if (!hasSubstantiveContent(content)) return null;
	const header = `[role: ${msg.role}]`;
	const timestamp = includeTimestamps ? msg.timestamp?.trim() : undefined;
	const stamped = timestamp ? `${header}\n[timestamp: ${timestamp}]` : header;
	return `${stamped}\n${content}\n[${msg.role}:end]`;
}

function formatRetentionMessages(messages: HindsightMessage[], includeTimestamps = false): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const formatted = formatRetentionMessage(msg, includeTimestamps);
		if (formatted) parts.push(formatted);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

function formatEmbeddableRetentionMessages(messages: HindsightMessage[]): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const content = stripRetentionProtocolMarkers(stripMemoryTags(msg.content)).trim();
		if (!hasSubstantiveContent(content)) continue;
		parts.push(content);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

/** Remove retention framing lines from a stored coding-agent episode transcript. */
export function stripRetentionProtocolMarkers(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(line => !RETENTION_PROTOCOL_MARKER_REGEX.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function prepareRetentionTranscript(
	messages: HindsightMessage[],
	retainFullWindow = false,
	options?: { includeTimestamps?: boolean },
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

	return formatRetentionMessages(targetMessages, options?.includeTimestamps === true);
}

/** Format all retention messages without protocol markers for embedding, FTS, and recall display. */
export function prepareEmbeddableRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatEmbeddableRetentionMessages(messages);
}
/** Format only user-authored messages for memory fact/entity extraction. */
export function prepareUserRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatRetentionMessages(messages.filter(message => message.role === "user"));
}
