import type { AgentRegistry } from "../registry/agent-registry";
import type { IrcDeliveryOutcome, IrcHistoryRecord, IrcReadCursor } from "./types";

export interface IrcConversationMessage {
	id: string;
	from: string;
	to: string;
	body: string;
	ts: number;
	replyTo?: string;
	broadcastId?: string;
	recipients?: string[];
	outcome: IrcDeliveryOutcome;
	error?: string;
}

export interface IrcConversation {
	id: string;
	label: string;
	participants: string[];
	messages: IrcConversationMessage[];
	lastMessageAt: number;
	unread: number;
}

const OUTCOME_RANK: Record<IrcDeliveryOutcome, number> = {
	pending: 0,
	failed: 1,
	injected: 2,
	woken: 3,
	revived: 4,
};

function directConversationId(from: string, to: string): string {
	return `direct:${[from, to].sort().join(":")}`;
}

function displayName(registry: AgentRegistry | undefined, id: string): string {
	return registry?.get(id)?.displayName || id;
}

/**
 * Project delivery records into operator-facing threads. Concrete broadcast
 * legs collapse by broadcastId; direct/sibling traffic groups by endpoint pair.
 */
export function deriveIrcConversations(
	records: readonly IrcHistoryRecord[],
	options: {
		registry?: AgentRegistry;
		viewerId?: string;
		readAt?: (conversationId: string) => IrcReadCursor;
	} = {},
): IrcConversation[] {
	const viewerId = options.viewerId ?? "Main";
	const messages = new Map<string, IrcConversationMessage[]>();
	const broadcastById = new Map<string, IrcConversationMessage>();

	for (const record of records) {
		const { message } = record;
		if (message.broadcastId) {
			const existing = broadcastById.get(message.broadcastId);
			if (existing) {
				if (!existing.recipients?.includes(message.to)) existing.recipients?.push(message.to);
				// Any failed leg must win so reconstructed broadcasts keep partial-delivery truth.
				if (record.outcome === "failed" || existing.outcome === "failed") {
					existing.outcome = "failed";
					if (record.outcome === "failed" && record.error) existing.error = record.error;
					else if (!existing.error && record.error) existing.error = record.error;
				} else if (OUTCOME_RANK[record.outcome] > OUTCOME_RANK[existing.outcome]) {
					existing.outcome = record.outcome;
				}
				continue;
			}
			const projected: IrcConversationMessage = {
				...message,
				to: "all",
				recipients: [message.to],
				outcome: record.outcome,
				error: record.error,
			};
			broadcastById.set(message.broadcastId, projected);
			const thread = messages.get("broadcast:all") ?? [];
			thread.push(projected);
			messages.set("broadcast:all", thread);
			continue;
		}

		const id = directConversationId(message.from, message.to);
		const thread = messages.get(id) ?? [];
		thread.push({ ...message, outcome: record.outcome, error: record.error });
		messages.set(id, thread);
	}

	const conversations: IrcConversation[] = [];
	for (const [id, thread] of messages) {
		thread.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
		const lastMessageAt = thread.at(-1)?.ts ?? 0;
		const participants =
			id === "broadcast:all"
				? [...new Set(thread.flatMap(message => [message.from, ...(message.recipients ?? [])]))]
				: [...new Set([thread[0]!.from, thread[0]!.to])];
		const label =
			id === "broadcast:all"
				? "All agents"
				: participants.includes(viewerId)
					? displayName(options.registry, participants.find(participant => participant !== viewerId) ?? viewerId)
					: participants.map(participant => displayName(options.registry, participant)).join(" ↔ ");
		const readAt = options.readAt?.(id) ?? { timestamp: 0, messageId: "" };
		conversations.push({
			id,
			label,
			participants,
			messages: thread,
			lastMessageAt,
			unread: thread.reduce((count, message) => {
				const addressedToViewer =
					message.to === viewerId ||
					(id === "broadcast:all" && message.from !== viewerId && message.recipients?.includes(viewerId));
				const afterReadCursor =
					message.ts > readAt.timestamp || (message.ts === readAt.timestamp && message.id > readAt.messageId);
				return count + Number(addressedToViewer && afterReadCursor);
			}, 0),
		});
	}
	return conversations.sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.id.localeCompare(b.id));
}
