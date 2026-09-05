import type { FileEntry } from "./session-entries";

/**
 * What a whole session file holds, judged from the outside.
 *
 * The counts are not decoration: they are what lets an operator audit a prune
 * candidate before archiving or deleting it. `assistantTextChars` is the one
 * that settles the question — a candidate always reports `0`, so a non-zero
 * value in a candidate list would be a bug in this module, not a judgement
 * call.
 */
export interface SessionEmptiness {
	/** The model said something, or finished a turn, somewhere in the file. */
	hasResponse: boolean;
	/** A human asked for something. Without this, nothing in the file was ever requested. */
	hasPrompt: boolean;
	userMessages: number;
	assistantMessages: number;
	/** Prose the assistant wrote, summed over every text block, whitespace trimmed off each. */
	assistantTextChars: number;
	/** Assistant messages that wrote no prose and never ended a turn. */
	unfinishedAttempts: number;
}

/**
 * Why a session is prunable. Two independent failures, not degrees of one:
 *
 * - `no-response` — a human asked, the model never answered.
 * - `no-prompt` — nobody ever asked. The model may well have spoken; a reply to
 *   no question is still nothing anyone wanted. Test harnesses and one-token
 *   probes land here, and `hasResponse` alone can never catch them because the
 *   canned reply makes the file look answered.
 */
export type SessionPruneReason = "no-response" | "no-prompt";

/** The prune verdict, or `undefined` when the session holds a real exchange. */
export function sessionPruneReason(emptiness: SessionEmptiness): SessionPruneReason | undefined {
	if (!emptiness.hasPrompt) return "no-prompt";
	if (!emptiness.hasResponse) return "no-response";
	return undefined;
}

/**
 * Prose an assistant entry actually wrote. Whitespace-only text counts as
 * nothing: a blank text block is what a provider emits around a tool call, not
 * something the model said.
 *
 * Thinking blocks are excluded on purpose. Internal reasoning is not a reply,
 * and a session that only ever thought and called tools is exactly the
 * abandoned tool traffic this module exists to find.
 */
function assistantProseChars(entry: FileEntry): number {
	if (entry.type !== "message" || entry.message.role !== "assistant") return 0;
	let chars = 0;
	for (const block of entry.message.content) {
		if (block.type === "text") chars += block.text.trim().length;
	}
	return chars;
}

/** The turn ended of its own accord rather than dying, being interrupted, or pausing for a tool. */
function endedTurn(entry: FileEntry): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return false;
	const { stopReason } = entry.message;
	return stopReason !== "error" && stopReason !== "aborted" && stopReason !== "toolUse";
}

/**
 * The session-level rule, and **deliberately not** the branch-level one in
 * `SessionManager.#emptyBranchVerdict()`.
 *
 * An assistant message is a response if it carried text **or** ended its turn
 * normally. `toolUse` is not disqualifying here, which is the whole difference
 * between the two rules:
 *
 * - In a tree, `#emptyBranchVerdict()` may treat `toolUse` as unanswered
 *   because the verdict propagates up from children. A mid-turn tool call
 *   survives whenever a real reply hangs *beneath* it; only a branch that
 *   trails off into nothing is dropped.
 * - A session file read flat has no children to propagate from. Every entry is
 *   judged on its own, and in an agent loop nearly every assistant message ends
 *   on `toolUse` — that is the normal shape of the work, not a failure. Lifting
 *   the branch rule to whole files therefore condemns ordinary sessions:
 *   measured across 129 real sessions it flagged 4, including a 411 KB file
 *   with 291 entries, 78 `toolUse` replies, and 35 assistant messages holding
 *   6,528 characters of prose.
 *
 * A fully delivered assistant message with text is a response no matter which
 * stop reason terminated it. `length` answers under both rules for the same
 * reason: the text before the token-ceiling cut is real content.
 */
export function isRespondingAssistantEntry(entry: FileEntry): boolean {
	return assistantProseChars(entry) > 0 || endedTurn(entry);
}

/**
 * Inspect every logical entry in a session file, including abandoned branches.
 *
 * Two things make a session prunable, and they are independent: the model never
 * answered, or nobody ever asked. See `sessionPruneReason`.
 */
export function inspectSessionEmptiness(entries: readonly FileEntry[]): SessionEmptiness {
	let hasResponse = false;
	let userMessages = 0;
	let assistantMessages = 0;
	let assistantTextChars = 0;
	let unfinishedAttempts = 0;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			userMessages++;
			continue;
		}
		if (entry.message.role !== "assistant") continue;

		assistantMessages++;
		const chars = assistantProseChars(entry);
		assistantTextChars += chars;
		if (chars > 0 || endedTurn(entry)) hasResponse = true;
		else unfinishedAttempts++;
	}

	return {
		hasResponse,
		hasPrompt: userMessages > 0,
		userMessages,
		assistantMessages,
		assistantTextChars,
		unfinishedAttempts,
	};
}
