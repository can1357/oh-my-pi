/**
 * Whether a refusal report's chain is open and whether its wake is still owed,
 * read from the session's **durable branch entries** — never from the replay
 * context the model sees.
 *
 * The replay context is a rendering: compaction summarizes entries away and the
 * context builder drops aborted and empty-error turns. A safety property read
 * from it disagrees with what happened, which is how rounds 4-6 of #18028 each
 * produced a fresh defect. The branch keeps every turn, aborted ones included,
 * so these two questions have one answer every reader agrees on.
 *
 * There is deliberately no notion of "new work" here. A chain ends at an
 * answered assistant turn and at nothing else, so no message producer — a
 * prompt, a parent's assignment, an SDK notification arriving as a `user`
 * message, whatever is added next — can be misclassified into ending one. The
 * accepted cost is explicit: after a final report, a new prompt that is also
 * refused gets a final report and no wake. Its sender is the waker and sees the
 * failure, so nothing is left waiting.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { assistantTurnDelivered } from "./messages";
import type { CustomMessageEntry, SessionEntry } from "./session-entries";

/** Custom-message type of the notice that reports a refused turn's tool calls; see `TurnRecovery.settleTerminalRefusal`. */
export const REFUSAL_TOOL_CALL_REPORT_TYPE = "refusal-tool-call-report";

/** Custom-message type of the note that a user's interrupt withdrew a refusal report's wake. */
export const REFUSAL_WAKE_WITHDRAWN_TYPE = "refusal-wake-withdrawn";

/**
 * `details` of a refusal report. A final report ends its chain: no wake follows
 * it. `carriedFrom` names the report entry a compaction or a resume copied back
 * into view.
 */
export interface RefusalReportDetails {
	final: boolean;
	carriedFrom?: string;
	/**
	 * The provider's own refusal wording, kept for diagnostics only. `details` is
	 * never sent to the model, and this text must never reach anything that is:
	 * storing it in model-visible content replays it on every later request and
	 * the classifier refuses the next turn too, which is the forever-refused
	 * session of dispatch://INFRA-1191.
	 */
	upstreamError?: string;
}

export function isRefusalReportEntry(entry: SessionEntry): entry is CustomMessageEntry<RefusalReportDetails> {
	return entry.type === "custom_message" && entry.customType === REFUSAL_TOOL_CALL_REPORT_TYPE;
}

/**
 * Whether an assistant turn **answered**: it finished (not an error, not an
 * abort) and delivered something — non-whitespace text, a tool call, or an
 * image ({@link assistantTurnDelivered}).
 *
 * An empty successful turn is not an answer. A provider returning a clean stop
 * with no content would otherwise close the chain on its own and leave the
 * refused calls unreported with no error anywhere — the very defect shape this
 * change removes, reintroduced through its own definition. A turn that is only
 * tool calls did answer: the model acted and its calls run. A turn that
 * finished with nothing delivered (no content, whitespace, reasoning alone, a
 * `length` stop that emitted no text) did not.
 */
export function isAnsweredAssistantTurn(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		message.stopReason !== "error" &&
		message.stopReason !== "aborted" &&
		assistantTurnDelivered(message)
	);
}

/**
 * Whether a refusal settling now is the woken turn refused again: reading the
 * branch backwards, a refusal report comes before any answered assistant turn.
 * Nothing else ends a chain — no kind of message, however it started a run — so
 * no producer can be misclassified. A `/clear` boundary starts a new history.
 *
 * Then the next report is final — it says the session will not continue — and
 * no second wake is scheduled.
 */
export function refusalChainOpen(branch: readonly SessionEntry[]): boolean {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "reset_boundary") return false;
		if (isRefusalReportEntry(entry)) return true;
		if (entry.type === "message" && isAnsweredAssistantTurn(entry.message)) return false;
	}
	return false;
}

/**
 * The refusal report whose wake is owed, read from the session's branch: the
 * newest report, when it is not final and neither an answered assistant turn
 * nor a note that the user withdrew the wake comes after it.
 *
 * An error turn, an aborted turn or an empty turn after it leaves the wake
 * owed: none of them delivered the work the report asks for. A user's interrupt
 * is recorded only by the withdrawal note, because an aborted turn on its own
 * cannot tell a user's interrupt from a compaction's, a session switch's or an
 * exiting process's.
 */
export function owedRefusalReport(
	branch: readonly SessionEntry[],
): CustomMessageEntry<RefusalReportDetails> | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "reset_boundary") return undefined;
		if (isRefusalReportEntry(entry)) return entry.details?.final === true ? undefined : entry;
		if (entry.type === "custom_message" && entry.customType === REFUSAL_WAKE_WITHDRAWN_TYPE) return undefined;
		if (entry.type === "message" && isAnsweredAssistantTurn(entry.message)) return undefined;
	}
	return undefined;
}

/** Whether the branch owes a refusal report's wake ({@link owedRefusalReport}). */
export function refusalWakeOwed(branch: readonly SessionEntry[]): boolean {
	return owedRefusalReport(branch) !== undefined;
}
