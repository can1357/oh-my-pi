import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { OperatorMessageQueue, OperatorQueuedMessage } from "@oh-my-pi/pi-wire/operator-types";
import {
	isDisplayableQueuedMessage,
	isHiddenUserCompanion,
	isUserQueuedMessage,
	queueChipText,
	toRestoredQueuedMessage,
} from "./queued-messages";

export interface QueuedMessageSelection {
	kind: OperatorQueuedMessage["kind"];
	message: AgentMessage;
	index: number;
	start: number;
	queue: readonly AgentMessage[];
}

export interface ReservedQueuedMessage {
	kind: OperatorQueuedMessage["kind"];
	messages: AgentMessage[];
	selected: AgentMessage;
	index: number;
	previous?: AgentMessage;
	next?: AgentMessage;
}

function isOperatorQueuedMessage(message: AgentMessage): boolean {
	return isUserQueuedMessage(message) && !(message.role === "user" && message.attribution === "agent");
}

/** Identities belong to engine messages; copies made by an edit retain their identity. */
export class MessageQueueRegistry {
	#ids = new WeakMap<AgentMessage, string>();
	#epoch = crypto.randomUUID();
	#nextTurn: readonly AgentMessage[] = [];
	#nextTurnRevision = 0;

	#id(message: AgentMessage): string {
		let id = this.#ids.get(message);
		if (!id) {
			id = crypto.randomUUID();
			this.#ids.set(message, id);
		}
		return id;
	}

	revision(agent: Agent, nextTurn: readonly AgentMessage[]): string {
		if (
			this.#nextTurn.length !== nextTurn.length ||
			this.#nextTurn.some((message, index) => message !== nextTurn[index])
		) {
			this.#nextTurn = nextTurn.slice();
			this.#nextTurnRevision++;
		}
		return `${this.#epoch}:${agent.queueRevision}:${this.#nextTurnRevision}`;
	}

	snapshot(sessionId: string, agent: Agent, nextTurn: readonly AgentMessage[]): OperatorMessageQueue {
		const items: OperatorQueuedMessage[] = [];
		let otherPendingCount = nextTurn.length;
		for (const [kind, queue] of [
			["steer", agent.peekSteeringQueue()],
			["follow-up", agent.peekFollowUpQueue()],
		] as const) {
			for (const message of queue) {
				if (!isOperatorQueuedMessage(message)) {
					if (isDisplayableQueuedMessage(message)) otherPendingCount++;
					continue;
				}
				const text =
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n")
						: queueChipText(message);
				items.push({
					id: this.#id(message),
					kind,
					text,
					imageCount: toRestoredQueuedMessage(message).images?.length ?? 0,
					editable: message.role === "user",
				});
			}
		}
		return { sessionId, revision: this.revision(agent, nextTurn), items, otherPendingCount };
	}

	select(agent: Agent, itemId: string): QueuedMessageSelection {
		for (const [kind, queue] of [
			["steer", agent.peekSteeringQueue()],
			["follow-up", agent.peekFollowUpQueue()],
		] as const) {
			for (let index = 0; index < queue.length; index++) {
				const message = queue[index]!;
				if (!isOperatorQueuedMessage(message) || this.#id(message) !== itemId) continue;
				let start = index;
				while (start > 0 && isHiddenUserCompanion(queue[start - 1]!)) start--;
				return { kind, message, index, start, queue };
			}
		}
		throw new Error("That queued message has already been consumed or removed. Refresh the queue.");
	}

	edit(agent: Agent, selection: QueuedMessageSelection, text: string): void {
		const original = selection.message;
		if (original.role !== "user") throw new Error("This queued command cannot be edited as plain text.");
		if (typeof text !== "string") throw new Error("Queued message text must be a string.");
		const images = toRestoredQueuedMessage(original).images ?? [];
		if (!text.trim() && images.length === 0) throw new Error("A queued message needs text or an image.");
		const replacement: AgentMessage = { ...original, content: [{ type: "text", text }, ...images] };
		this.#ids.set(replacement, this.#id(original));
		const queue = selection.queue.slice();
		queue[selection.index] = replacement;
		agent.replaceQueues(
			selection.kind === "steer" ? queue : [...agent.peekSteeringQueue()],
			selection.kind === "follow-up" ? queue : [...agent.peekFollowUpQueue()],
		);
	}

	remove(agent: Agent, selection: QueuedMessageSelection): ReservedQueuedMessage {
		const reserved: ReservedQueuedMessage = {
			kind: selection.kind,
			messages: selection.queue.slice(selection.start, selection.index + 1),
			selected: selection.message,
			index: selection.start,
			previous: selection.queue[selection.start - 1],
			next: selection.queue[selection.index + 1],
		};
		const remaining = [...selection.queue.slice(0, selection.start), ...selection.queue.slice(selection.index + 1)];
		agent.replaceQueues(
			selection.kind === "steer" ? remaining : [...agent.peekSteeringQueue()],
			selection.kind === "follow-up" ? remaining : [...agent.peekFollowUpQueue()],
		);
		return reserved;
	}

	/** Roll back only this reservation, using fresh queues so concurrent edits/enqueues survive. */
	restore(agent: Agent, reserved: ReservedQueuedMessage): void {
		const owned = new Set(reserved.messages);
		const steering = agent.peekSteeringQueue().filter(message => !owned.has(message));
		const followUp = agent.peekFollowUpQueue().filter(message => !owned.has(message));
		const queue = reserved.kind === "steer" ? steering : followUp;
		const next = reserved.next ? queue.indexOf(reserved.next) : -1;
		const previous = reserved.previous ? queue.indexOf(reserved.previous) : -1;
		const index = next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(reserved.index, queue.length);
		queue.splice(index, 0, ...reserved.messages);
		agent.replaceQueues(steering, followUp);
	}
}
