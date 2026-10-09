import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import type { MnemopiLlmCompletion } from "./runtime-options";

/**
 * Caller-selected evidence for reflection, supplied in descending relevance order.
 * The helper does not recall or re-rank memories; earlier entries take priority
 * when the serialized input budget is exhausted.
 */
export interface ReflectMemory {
	/** Stable source identifier used verbatim in `[id]` citations. */
	id: string;
	/** Source text; may be truncated to fit the input budget. */
	content: string;
	/** Optional source timestamp, passed through as metadata without sorting. */
	timestamp?: string | null;
	/** Optional memory category, passed through as metadata. */
	kind?: string | null;
}

/**
 * An accepted LLM reflection, not the caller's recalled-memory fallback.
 * Citation validation checks source identity, not whether each claim follows
 * from the source text.
 */
export interface ReflectResult {
	/** Trimmed completion text with recognized fabricated citation IDs removed. */
	text: string;
	/**
	 * Unique validated IDs in first-citation order, restricted to memories actually
	 * included in the bounded input. Empty only for an accepted uncited uncertainty answer.
	 */
	citedIds: string[];
	/**
	 * Always true for results returned by {@link synthesizeReflection}: the answer
	 * has at least one validated citation or is an explicit uncited uncertainty answer.
	 */
	synthesized: boolean;
}

const MAX_INPUT_CHARS = 12_000;
const COMPLETION_TIMEOUT_SECONDS = 15;

function fitJsonString(value: string, budget: number): string {
	let high = Math.min(value.length, budget - 2);
	const candidate = value.slice(0, high);
	if (JSON.stringify(candidate).length <= budget) return candidate;
	let low = 0;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (JSON.stringify(value.slice(0, middle)).length <= budget) low = middle;
		else high = middle - 1;
	}
	return value.slice(0, low);
}

function reflectionInput(query: string, memories: readonly ReflectMemory[]): { input: string; ids: Set<string> } {
	// This is source data, not instructions: the host supplies the reflection system prompt.
	const prefix = `{"query":${JSON.stringify(fitJsonString(query, MAX_INPUT_CHARS / 4))},"memories":[`;
	const suffix = "]}";
	const entries: string[] = [];
	const ids = new Set<string>();
	let remaining = MAX_INPUT_CHARS - prefix.length - suffix.length;
	for (const memory of memories) {
		const separatorLength = entries.length === 0 ? 0 : 1;
		const budget = remaining - separatorLength;
		const row = {
			id: memory.id,
			timestamp: memory.timestamp ?? null,
			kind: memory.kind ?? null,
			content: "",
		};
		const metadataLength = JSON.stringify(row).length;
		if (metadataLength >= budget) break;

		// JSON escaping can expand source text. Fit the highest-ranked memory before
		// considering any later one, including when that first memory is oversized.
		row.content = fitJsonString(memory.content, budget - metadataLength + 2);
		const entry = JSON.stringify(row);
		entries.push(entry);
		ids.add(memory.id);
		remaining -= separatorLength + entry.length;
		if (row.content.length < memory.content.length) break;
	}
	return { input: `${prefix}${entries.join(",")}${suffix}`, ids };
}

function citationIdMatcher(ids: ReadonlySet<string>): (value: string) => boolean {
	const hexLengths = new Set<number>();
	const hexGroups = new Set<string>();
	const prefixes = new Set<string>();
	for (const id of ids) {
		if (/^[\da-f]{8,}$/i.test(id)) {
			hexLengths.add(id.length);
		} else if (/^[\da-f]+(?:-[\da-f]+)+$/i.test(id)) {
			hexGroups.add(
				id
					.split("-")
					.map(part => part.length)
					.join("-"),
			);
		} else {
			const prefixed = /^(.+[-_:.])[A-Za-z0-9]+$/.exec(id);
			if (prefixed) prefixes.add(prefixed[1]!);
		}
	}
	return value => {
		if (/^[\da-f]{8,}$/i.test(value) && hexLengths.has(value.length)) return true;
		if (
			/^[\da-f]+(?:-[\da-f]+)+$/i.test(value) &&
			hexGroups.has(
				value
					.split("-")
					.map(part => part.length)
					.join("-"),
			)
		) {
			return true;
		}
		for (const prefix of prefixes) {
			if (value.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.slice(prefix.length))) {
				return true;
			}
		}
		return false;
	};
}

function cleanCitations(
	raw: string,
	ids: ReadonlySet<string>,
): { text: string; citedIds: string[]; hasCitationAttempt: boolean } {
	const resemblesId = citationIdMatcher(ids);
	const citedIds = new Set<string>();
	let hasCitationAttempt = false;
	const text = raw.replace(
		/([ \t]*)\[([^[\]\r\n]+)\]([ \t]*)/g,
		(match, before: string, content: string, after: string, offset: number) => {
			const next = raw[offset + match.length] ?? "";
			// Markdown links and ordinary bracketed prose are not memory citations.
			if (next === "(") return match;
			const parts = content.split(/[,;]/).map(part => part.trim());
			if (!parts.every(part => ids.has(part) || resemblesId(part))) return match;
			hasCitationAttempt = true;
			const known = parts.filter(part => ids.has(part));
			for (const id of known) citedIds.add(id);
			if (known.length === parts.length) return match;
			if (known.length > 0) return `${before}[${known.join(", ")}]${after}`;
			// Remove only whitespace stranded by a removed citation, not prose formatting.
			if (next === "" || /^[.,;:!?)}\]]$/.test(next)) return "";
			return before && after ? " " : before || after;
		},
	);
	return { text: text.trim(), citedIds: [...citedIds], hasCitationAttempt };
}

function isUncitedUncertainty(text: string): boolean {
	// Match the entire answer, never just an uncertainty preface to unsupported claims.
	const normalized = text
		.toLowerCase()
		.replace(/i\u0307/g, "i")
		.replace(/’/g, "'")
		.replace(/\s+/g, " ");
	return /^(?:i (?:don't|do not) know|not enough information|there is no information about this|bilmiyorum|bu konuda (?:yeterli )?bilgi yok|yeterli bilgi yok)[.!?]?$/.test(
		normalized,
	);
}

/**
 * Synthesizes an answer from caller-selected memories, or returns null so the
 * caller can retain its non-LLM fallback.
 *
 * @remarks
 * Memories are serialized in caller order without recall or re-ranking. The JSON
 * input is capped at 12,000 UTF-16 code units, including escaping and metadata;
 * the serialized query string is capped at 3,000. Memory content may be truncated.
 * Packing stops at the first truncated entry or entry whose metadata does not fit,
 * and omitted IDs cannot validate citations.
 *
 * Recognized citation attempts with no validated IDs always produce null, even
 * if removing them leaves an uncertainty statement. Mixed valid and fabricated
 * citations retain the valid IDs and remove the fabricated ones. With no citation
 * attempts, an uncited answer is accepted only when its entire text is one of:
 * "I don't know", "I do not know", "Not enough information",
 * "There is no information about this", "Bilmiyorum", "Bu konuda bilgi yok",
 * "Bu konuda yeterli bilgi yok", or "Yeterli bilgi yok". Matching ignores case,
 * repeated whitespace and straight versus curly apostrophes, and permits one
 * optional trailing `.`, `!` or `?`. Additional claims are not accepted.
 *
 * @param complete - Host completion callback, responsible for the reflection
 * system prompt; receives JSON source data and the `memory-reflect` task.
 * @param query - The caller's reflection question, truncated to the query budget.
 * @param memories - Relevant source memories, highest priority first.
 * @param opts - Output token limit (default 2,048) and optional cancellation signal.
 * Completion uses temperature zero and a 15-second timeout.
 * @returns An accepted result with `synthesized: true`, at least one validated
 * citation or explicit uncited uncertainty; null when completion is unavailable,
 * no memories fit, completion fails or times out, output is null or empty, all
 * attempted citations are invalid, or an uncited answer is not explicit uncertainty.
 * @throws The cancellation reason when aborted; cancellation never becomes fallback.
 */
export async function synthesizeReflection(
	complete: MnemopiLlmCompletion | null | undefined,
	query: string,
	memories: readonly ReflectMemory[],
	opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<ReflectResult | null> {
	opts.signal?.throwIfAborted();
	if (!complete || memories.length === 0) {
		logger.debug("mnemopi reflection falling back", {
			reason: !complete ? "completion_unavailable" : "no_memories",
		});
		return null;
	}

	try {
		const { input, ids } = reflectionInput(query, memories);
		if (ids.size === 0) {
			logger.debug("mnemopi reflection falling back", { reason: "no_memories_within_budget" });
			return null;
		}
		const raw = await withTimeout(
			Promise.resolve(
				complete(input, {
					maxTokens: opts.maxTokens ?? 2048,
					temperature: 0,
					timeout: COMPLETION_TIMEOUT_SECONDS,
					signal: opts.signal,
					task: { kind: "memory-reflect", input },
				}),
			),
			COMPLETION_TIMEOUT_SECONDS * 1000,
			"Memory reflection timed out",
			opts.signal,
		);
		opts.signal?.throwIfAborted();
		if (typeof raw !== "string" || raw.trim() === "") {
			logger.debug("mnemopi reflection falling back", {
				reason: raw === null ? "completion_returned_null" : "completion_returned_empty",
			});
			return null;
		}

		const { text, citedIds, hasCitationAttempt } = cleanCitations(raw, ids);
		if (text === "") {
			logger.debug("mnemopi reflection falling back", { reason: "no_text_after_citation_cleanup" });
			return null;
		}
		if (citedIds.length === 0 && (hasCitationAttempt || !isUncitedUncertainty(text))) {
			logger.debug("mnemopi reflection falling back", {
				reason: hasCitationAttempt ? "no_valid_citations" : "unsupported_uncited_answer",
			});
			return null;
		}
		return { text, citedIds, synthesized: true };
	} catch (error) {
		opts.signal?.throwIfAborted();
		if (error instanceof Error && error.name === "AbortError") throw error;
		logger.debug("mnemopi reflection falling back", { reason: "completion_failed", error: String(error) });
		return null;
	}
}
