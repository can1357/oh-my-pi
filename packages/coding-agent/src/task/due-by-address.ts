/**
 * The recipient's half of a due-by notice: whether a session's own live
 * conversation still holds the address a notice is sent to.
 *
 * The clock (`./due-by`) runs on the main thread, but a recipient may be homed
 * on a subagent worker. Every question about a recipient's transcript is
 * therefore answered on the recipient's own thread, by these functions over
 * its local session, and the clock only exchanges plain addresses with it
 * (`AgentSessionHandle.dueByProbe`, `notifySubagentOverdue`). A session is
 * never read across threads to decide an address.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "../session/session-entries";

/**
 * Where a notice is delivered in its recipient's transcript. A recipient holds
 * the address only while its live branch still contains `entryId`; an id
 * reused later, or a transcript the dispatch never reached, does not.
 */
export interface DueByAddress {
	/**
	 * The entry the address is anchored to: the entry carrying {@link toolCallId}
	 * once that call is in the transcript, until then the leaf the recipient was
	 * at when the work was dispatched. Null only when it held no conversation.
	 */
	entryId: string | null;
	/**
	 * The dispatching tool call id, for the agent that dispatched the work
	 * directly, while its entry has still to appear: the address advances onto
	 * that entry as soon as the branch holding the leaf carries it, and the id
	 * is then dropped so a later cut between the two is seen as the loss it is.
	 */
	toolCallId: string | undefined;
}

/** The recipient's answer to a probe: it holds the address (possibly advanced onto its call), or it does not. */
export type DueByProbe = { holds: true; address: DueByAddress } | { holds: false };

/**
 * One due-by notice as its recipient receives it. The four functions are the
 * clock's side; from a worker each is a synchronous call to the main thread,
 * which never blocks on a worker. The recipient checks the address itself,
 * locally, and never stores what a check found (a peek must change nothing).
 *
 * - `isOpen`: the notice has not ended, its bound has not passed, and the
 *   child has not settled. A pure read, asked by builds and peeks.
 * - `reserve`: at the request hand-off, the same test, and when it passes the
 *   clock holds the notice for this hand-off: nothing else (its bound
 *   included) can end it until `commit` or `release`. False when it ended.
 * - `release`: the reserved request was not sent; the notice is open again,
 *   or lost if its bound passed while it was held.
 * - `commit`: the reserved request is being handed to the provider; the notice
 *   ends delivered, in the same step, before the request goes out.
 */
export interface SubagentOverdueDelivery {
	childId: string;
	stage: "owner" | "escalation";
	text: string;
	address: DueByAddress;
	isOpen(): boolean;
	reserve(): boolean;
	release(): void;
	commit(): void;
}

/** The parts of a local session the address is decided from. */
export interface AddressedSession {
	readonly sessionManager: {
		getBranch(fromId?: string): SessionEntry[];
		getEntry(id: string): SessionEntry | undefined;
		getEntries(): SessionEntry[];
		getLeafId(): string | null;
	};
	readonly agent: { readonly state: { readonly messages: readonly AgentMessage[] } };
}

/** Whether `message` carries a tool call with id `toolCallId`. */
function hasToolCall(message: AssistantMessage, toolCallId: string): boolean {
	const content = message.content;
	if (!Array.isArray(content)) return false;
	for (const part of content) {
		if (typeof part === "object" && part !== null && part.type === "toolCall" && part.id === toolCallId) return true;
	}
	return false;
}

/**
 * Whether `entryId` is on `session`'s live conversation: its current branch,
 * from the leaf back to the nearest context reset. A `/clear` boundary ends the
 * conversation, so entries before the reset no longer count as held.
 */
function onLiveBranch(session: AddressedSession, entryId: string): boolean {
	const branch: readonly SessionEntry[] = session.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "reset_boundary") return false;
		if (entry.id === entryId) return true;
	}
	return false;
}

/** Whether `entry` lies under `ancestorId` in the same conversation: no context reset between them. */
function descendsFrom(session: AddressedSession, entry: SessionEntry, ancestorId: string): boolean {
	let parentId = entry.parentId;
	while (parentId !== null) {
		if (parentId === ancestorId) return true;
		const parent = session.sessionManager.getEntry(parentId);
		if (!parent || parent.type === "reset_boundary") return false;
		parentId = parent.parentId;
	}
	return false;
}

/**
 * The entry carrying this dispatch's own occurrence of `toolCallId`, found by
 * the occurrence rather than by the id alone: a session reuses a tool call id
 * across turns and even across the steps of one run, so a match by id can be
 * an older dispatch that finished long ago.
 *
 * At dispatch (`current` given) the dispatch's call is the one the session's
 * agent is executing: the latest assistant message of its live state that
 * carries the id. Only the transcript entry holding that same message (by its
 * timestamp) at or above `leafId` is accepted. Afterwards (`current` null) the
 * only occurrence this dispatch can still own is the earliest one written
 * under that leaf. Null when the transcript carries no such occurrence.
 */
function findDispatchCall(
	session: AddressedSession,
	leafId: string,
	toolCallId: string,
	current: AssistantMessage | null,
): string | null {
	const manager = session.sessionManager;
	if (current) {
		const path: readonly SessionEntry[] = manager.getBranch(leafId);
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i]!;
			if (entry.type === "reset_boundary") return null;
			if (
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.timestamp === current.timestamp &&
				hasToolCall(entry.message, toolCallId)
			) {
				return entry.id;
			}
		}
		return null;
	}
	// The earliest occurrence written under the leaf is this dispatch's: a later
	// turn on any branch below it that reused the id was written after it.
	const entries = manager.getEntries();
	const start = entries.findIndex(entry => entry.id === leafId);
	if (start < 0) return null;
	for (let i = start + 1; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant" || !hasToolCall(entry.message, toolCallId)) {
			continue;
		}
		if (descendsFrom(session, entry, leafId)) return entry.id;
	}
	return null;
}

/**
 * The address of a dispatch `session` is making now with tool call
 * `toolCallId`, decided on the dispatching session's own thread. A committed
 * dispatch's call is normally already written: that very occurrence is pinned
 * now, before a later turn can reuse the id. A speculative one is still
 * streaming, so nothing written yet is its call; its address starts at the
 * leaf and advances onto the call once that is written below it.
 */
export function dispatchAddress(session: AddressedSession, toolCallId: string, speculative: boolean): DueByAddress {
	const leafId = session.sessionManager.getLeafId();
	const address: DueByAddress = { entryId: leafId, toolCallId };
	if (leafId === null || speculative) return address;
	const current = session.agent.state.messages.findLast(
		(message): message is AssistantMessage => message.role === "assistant" && hasToolCall(message, toolCallId),
	);
	const call = current ? findDispatchCall(session, leafId, toolCallId, current) : null;
	return call === null ? address : { entryId: call, toolCallId: undefined };
}

/**
 * Whether `session`'s live conversation still holds `address`, advancing it
 * from the dispatch-time leaf onto this dispatch's own call as soon as the
 * transcript carries it. The leaf stands in only while that call is unwritten,
 * only on the transcript the leaf came from, and only a call written below the
 * leaf can claim it. Returns the (possibly advanced) address, or undefined.
 */
export function heldAddress(session: AddressedSession, address: DueByAddress): DueByAddress | undefined {
	if (address.entryId === null) return undefined;
	let held = address;
	if (address.toolCallId !== undefined) {
		if (session.sessionManager.getEntry(address.entryId) === undefined) return undefined;
		const call = findDispatchCall(session, address.entryId, address.toolCallId, null);
		if (call !== null) held = { entryId: call, toolCallId: undefined };
	}
	return held.entryId !== null && onLiveBranch(session, held.entryId) ? held : undefined;
}
