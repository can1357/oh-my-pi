/**
 * Journals off-transcript model calls (side channels: recaps, commit messages,
 * memory extraction, …) as `model_usage` entries, so their spend counts in
 * session totals and `omp stats`, and what they were sent and replied survives.
 *
 * No static prompt is ever written: the entry's `purpose` names it. Dynamic
 * text is written only while it is small ({@link COMPLETION_TEXT_MAX_CHARS});
 * a diff or a transcript that a request carried is left out.
 *
 * @example
 * ```ts ignore
 * const journal = journalCompletion(session.sessionManager, { purpose: "commit:message" });
 * const message = await completeSimple(model, context, options);
 * journal?.(message, userPrompt);
 * ```
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import type { CompletionRecord } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Session journal surface that records off-transcript model calls; journal-only managers omit it. */
export type ModelUsageLedger = Pick<SessionManager, "appendModelUsage" | "getSessionId" | "getLeafId">;

/** Whether `manager` can journal model usage (full session managers can; advisor-local journals cannot). */
export function isModelUsageLedger(manager: Partial<ModelUsageLedger> | undefined): manager is ModelUsageLedger {
	return (
		manager?.appendModelUsage !== undefined && manager.getSessionId !== undefined && manager.getLeafId !== undefined
	);
}

/** Longest prompt or reply a `model_usage` entry keeps; longer text is left out, never truncated. */
export const COMPLETION_TEXT_MAX_CHARS = 4000;

/**
 * What a completion was sent and replied, as journaled: each side only while it
 * fits {@link COMPLETION_TEXT_MAX_CHARS}. A call answered through a forced tool
 * call has no text, so its reply is the tool arguments as JSON. A proxied
 * provider can hand back a message without `content` (#4323); that reads as an
 * empty reply.
 */
export function completionRecord(prompt: string | undefined, message: AssistantMessage): CompletionRecord {
	let reply = "";
	if (Array.isArray(message.content)) {
		reply = extractTextContent(message);
		if (!reply) {
			for (const block of message.content) {
				if (block.type === "toolCall") reply += (reply ? "\n" : "") + JSON.stringify(block.arguments);
			}
		}
	}
	const record: CompletionRecord = {};
	if (prompt !== undefined && prompt.length <= COMPLETION_TEXT_MAX_CHARS) record.prompt = prompt;
	if (reply.length <= COMPLETION_TEXT_MAX_CHARS) record.reply = reply;
	return record;
}

/** How {@link journalCompletion} labels and fills its entries. */
export interface CompletionJournalOptions {
	/** Names the call and its static prompt (`recap`, `commit:message`); a `:detail` suffix groups under its base in stats. */
	purpose: string;
	/** Model role the call resolved through, such as `smol`. */
	role?: string;
	/** Journal usage and timing only, for a call whose result the session already stores (a compaction summary). */
	usageOnly?: boolean;
}

/** Receives each settled attempt of a side-channel completion, with the user-turn text it was sent. */
export type CompletionJournal = (message: AssistantMessage, prompt?: string) => void;

/**
 * Build a reporter that journals every attempt of one side-channel request on
 * the branch the session is on now. Call it once per request, right before
 * sending, and hand it each billed attempt, failed ones included. A stale
 * session owner or a failed write is logged and dropped: accounting never
 * fails the call it accounts for. Returns `undefined` when `manager` cannot
 * journal usage.
 */
export function journalCompletion(
	manager: Partial<ModelUsageLedger> | undefined,
	options: CompletionJournalOptions,
): CompletionJournal | undefined {
	if (!isModelUsageLedger(manager)) return undefined;
	const owner = { sessionId: manager.getSessionId(), parentId: manager.getLeafId() };
	return (message, prompt) => {
		try {
			manager.appendModelUsage(
				{
					purpose: options.purpose,
					role: options.role,
					api: message.api,
					provider: message.provider,
					model: message.model,
					usage: message.usage,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					duration: message.duration,
					ttft: message.ttft,
					...(options.usageOnly ? {} : { completion: completionRecord(prompt, message) }),
				},
				owner,
			);
		} catch (error) {
			logger.debug("model usage journal failed", { purpose: options.purpose, error: String(error) });
		}
	};
}
