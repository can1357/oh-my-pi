import type { AfterToolCallResult, AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { latestReviewStart } from "./tool-result-eviction";

/** Ceiling on tracked signatures so a long advisor session cannot grow the registry without bound. */
const MAX_TRACKED_SIGNATURES = 4096;

/** Stands in for a tool result the advisor already has verbatim, earlier in its own context. */
export const DEDUPED_RESULT_NOTICE = "[Unchanged since your earlier identical call]";

/** Opening of the hint upstream `read` appends (`appendRepeatReadHint` in `tools/read.ts`); the count follows. */
const REPEAT_READ_HINT_HEAD = "\n\n[You have received this identical output ";

const LEGACY_INTENT_FIELD = "__intent";

function withoutIntent(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const { [INTENT_FIELD]: _intent, [LEGACY_INTENT_FIELD]: _legacyIntent, ...rest } = args as Record<string, unknown>;
	return rest;
}

/**
 * Stable identity for one tool call: name plus arguments with object keys
 * sorted and the agent-authored intent dropped, so cosmetic argument
 * reordering or a reworded intent never hides a genuine repeat.
 */
export function toolCallSignature(name: string, args: unknown): string {
	return stableStringifyJson([name, withoutIntent(args)]);
}

/**
 * Drops the repeat hint upstream `read` appended to `text` for a call whose
 * `path` argument is `readPath`. From the 3rd byte-identical read of a selector
 * `read` appends it to the end of its first text block, quoting that argument,
 * with a count that rises on every repeat; the advisors share one tool session,
 * so the count pools across them and two identical reads would otherwise never
 * compare equal. The meta-notice wrapper then appends `notice` to the last
 * text block. Only a hint ending exactly there and naming exactly `readPath`
 * is dropped: anything else hint-shaped is content and must still compare.
 */
function stripRepeatReadHint(text: string, readPath: string, notice: string): string {
	const end = notice && text.endsWith(notice) ? text.length - notice.length : text.length;
	const tail = ` times. Re-reading '${readPath}' will not change it — use a narrower selector (path:A-B), or proceed with the edit.]`;
	const countEnd = end - tail.length;
	if (countEnd < 0 || !text.startsWith(tail, countEnd)) return text;
	let countStart = countEnd;
	while (countStart > 0) {
		const code = text.charCodeAt(countStart - 1);
		if (code < 48 || code > 57) break;
		countStart--;
	}
	const start = countStart - REPEAT_READ_HINT_HEAD.length;
	if (countStart === countEnd || start < 0 || !text.startsWith(REPEAT_READ_HINT_HEAD, start)) return text;
	return text.slice(0, start) + text.slice(end);
}

function comparableText(
	toolCall: { name: string; arguments: Record<string, unknown> },
	content: readonly (TextContent | ImageContent)[],
	details: unknown,
): string | undefined {
	const parts: string[] = [];
	for (const block of content) {
		// An image cannot be compared byte-for-byte cheaply, and eliding one
		// would drop information the text join never carried. Treat as a miss.
		if (block.type !== "text") return undefined;
		parts.push(block.text);
	}
	const readPath = toolCall.arguments.path;
	if (toolCall.name === "read" && typeof readPath === "string" && parts.length > 0) {
		// Every block is text here: the hint went on the first, the notice on the last.
		const meta = (details as { meta?: OutputMeta } | undefined)?.meta;
		const notice = parts.length === 1 ? formatOutputNotice(meta) : "";
		parts[0] = stripRepeatReadHint(parts[0]!, readPath, notice);
	}
	return parts.join("\n");
}

/**
 * Collapses an advisor's byte-identical repeat investigation calls to a pointer
 * at the copy it already carries.
 *
 * 13.2% of advisor investigation calls are byte-identical repeats within one
 * advisor session: the same `read`/`grep` re-issued review after review because
 * the advisor cannot tell from its own context that it already looked. Each
 * repeat re-inflates the very prefix stale-result eviction just trimmed, so
 * without this the two levers fight each other.
 *
 * A repeat is a hit only while the original result sits in the current
 * review, at or after the latest non-synthetic user delta. Stale-result
 * eviction (`evictStaleToolResults`) protects exactly that span, so an
 * original from an earlier review may be blanked before the next request
 * while this review's stub survives, leaving the advisor with neither copy. A
 * cross-review repeat therefore serves the full result and becomes the new
 * tracked original.
 *
 * Liveness is checked by scanning that span for the recorded tool-call id
 * instead of clearing the registry on reset, rollback or compaction. A
 * rolled-back, compacted-away or evicted result is simply not found (or
 * carries `prunedAt`), which reads as a miss, serves the full result again and
 * overwrites the entry.
 */
export class AdvisorToolResultDedupe {
	/** Call signature → id of the tool call whose still-live result answers it. */
	#seen = new Map<string, string>();

	/**
	 * Call from the advisor `Agent`'s `afterToolCall` for non-`advise`,
	 * non-error results. Returns an override when `result` byte-matches the
	 * still-live result of an earlier identical call; otherwise records this
	 * call and returns undefined.
	 */
	check(
		toolCall: { id: string; name: string; arguments: Record<string, unknown> },
		result: AgentToolResult<unknown>,
		messages: readonly AgentMessage[],
	): AfterToolCallResult | undefined {
		const signature = toolCallSignature(toolCall.name, toolCall.arguments);
		const priorId = this.#seen.get(signature);
		if (priorId !== undefined && this.#matchesLive(priorId, toolCall, result, messages)) {
			// Keep pointing at the original: this stub is `useless`, so a later
			// pass may elide it, and a pointer at an elided stub is a dead end.
			return { content: [{ type: "text", text: DEDUPED_RESULT_NOTICE }], useless: true };
		}
		this.#record(signature, toolCall.id);
		return undefined;
	}

	#matchesLive(
		priorId: string,
		toolCall: { name: string; arguments: Record<string, unknown> },
		result: AgentToolResult<unknown>,
		messages: readonly AgentMessage[],
	): boolean {
		const text = comparableText(toolCall, result.content, result.details);
		if (text === undefined) return false;
		const reviewStart = latestReviewStart(messages);
		for (let i = messages.length - 1; i >= reviewStart; i--) {
			const message = messages[i]!;
			if (message.role !== "toolResult" || message.toolCallId !== priorId) continue;
			if (message.prunedAt !== undefined || message.isError) return false;
			// Same signature, so the same `path` argument: one `toolCall` serves both.
			return comparableText(toolCall, message.content, message.details) === text;
		}
		return false;
	}

	#record(signature: string, toolCallId: string): void {
		if (!this.#seen.has(signature) && this.#seen.size >= MAX_TRACKED_SIGNATURES) {
			this.#seen.clear();
		}
		this.#seen.set(signature, toolCallId);
	}
}
