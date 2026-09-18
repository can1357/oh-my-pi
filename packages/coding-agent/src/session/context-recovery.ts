import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { isEmptyErrorTurn } from "./messages";
import { getLatestCompactionEntry } from "./session-context";
import type { SessionManager } from "./session-manager";

export interface ContextRecoveryHost {
	agent: Agent;
	sessionManager: SessionManager;
	waitForMessagePersistence(message: AssistantMessage): Promise<void>;
	persistedAssistantEntryId(message: AssistantMessage): string | undefined;
	sameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean;
	withBranchTransition<T>(operation: () => T): T;
	/** Captured generation/owner still owns this recovery attempt. */
	isCurrent(): boolean;
}

export type ContextRecoveryTransactionResult<TResult> =
	| { kind: "complete"; result: TResult }
	| { kind: "stale" };

/** Remove a failed turn only when it is still the active assistant tail. */
export function removeFailedAssistantFromActiveContext(
	host: ContextRecoveryHost,
	assistantMessage: AssistantMessage,
	reason = "assistant-context-cleanup",
): void {
	const messages = host.agent.state.messages;
	const lastMessage = messages[messages.length - 1];
	const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
	if (lastAssistant !== undefined && host.sameAssistantMessage(lastAssistant, assistantMessage)) {
		host.agent.replaceMessages(messages.slice(0, -1));
		return;
	}
	logger.debug("agent active context assistant removal missed", {
		reason,
		lastRole: lastMessage?.role,
		candidateTimestamp: assistantMessage.timestamp,
		lastTimestamp: lastAssistant?.timestamp,
		candidateStopReason: assistantMessage.stopReason,
		lastStopReason: lastAssistant?.stopReason,
	});
}

/** Reparent the working branch past a persisted failed turn after its persistence slot settles. */
export async function dropFailedAssistantTurn(
	host: ContextRecoveryHost,
	assistantMessage: AssistantMessage,
): Promise<string | undefined> {
	await host.waitForMessagePersistence(assistantMessage);
	if (!host.isCurrent()) return undefined;
	removeFailedAssistantFromActiveContext(host, assistantMessage);
	const branch = host.sessionManager.getBranch();
	const persistedEntryId = host.persistedAssistantEntryId(assistantMessage);
	const branchEntry =
		(persistedEntryId === undefined
			? undefined
			: branch.find(
					entry =>
						entry.id === persistedEntryId && entry.type === "message" && entry.message.role === "assistant",
				)) ??
		branch
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					host.sameAssistantMessage(entry.message, assistantMessage),
			);
	if (!branchEntry || !host.isCurrent()) return undefined;
	host.withBranchTransition(() => {
		if (branchEntry.parentId === null) host.sessionManager.resetLeaf();
		else host.sessionManager.branch(branchEntry.parentId);
	});
	return branchEntry.id;
}

/**
 * Drop the failed assistant, run context recovery on the clean branch, then restore
 * the turn iff no history rewrite committed. Stale owners never mutate replacement state.
 */
export async function runContextRecoveryTransaction<TResult extends { historyRewritten?: boolean }>(
	host: ContextRecoveryHost,
	assistantMessage: AssistantMessage,
	run: () => Promise<TResult>,
): Promise<ContextRecoveryTransactionResult<TResult>> {
	const compactionEntryBefore = getLatestCompactionEntry(host.sessionManager.getBranch());
	await dropFailedAssistantTurn(host, assistantMessage);
	if (!host.isCurrent()) return { kind: "stale" };
	const result = await run();
	if (!host.isCurrent()) return { kind: "stale" };
	const compactionEntryAfter = getLatestCompactionEntry(host.sessionManager.getBranch());
	if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
		if (!isEmptyErrorTurn(assistantMessage)) host.sessionManager.appendMessage(assistantMessage);
		const lastMessage = host.agent.state.messages.at(-1);
		if (
			lastMessage?.role !== "assistant" ||
			!host.sameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			host.agent.appendMessage(assistantMessage);
		}
	}
	return { kind: "complete", result };
}
