import type { Message } from "@oh-my-pi/pi-ai";
import { isPerCallContextMessage, markRepeatedPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";

/** The per-call messages of one place: the run that follows a history message, or the run ahead of all history. */
interface Place {
	/** Whether the run follows `anchor` (else it precedes it: the run ahead of all history). */
	after: boolean;
	/** A copy of the history message the run follows or precedes ({@link snapshot}); `undefined` with no history. */
	anchor: Message | undefined;
	/** A copy of each per-call message of the run, as {@link comparable} compares it; `undefined` if it could not be copied. */
	messages: (Message | undefined)[];
}

/**
 * A copy of `message` for the record to keep across requests. The fields that reach a provider message are copied
 * deeply, so an in-place rewrite of any of them is seen: `content`, `providerPayload` (a replayed compaction, tool
 * changes, effort) and an assistant's `requestControls`. Scalars are copied by value, `attribution` among them, which
 * decides a developer turn's wire role. The other object fields (`parentIrc`, `usage`, `contextSnapshot`, a tool
 * result's `details` and `providerMetadata`) are shared: none of them reaches an Anthropic message. `undefined` when a
 * copied field holds a value structured cloning refuses (a host's own object in a block's `arguments` or `metadata`):
 * such a message is never compared, so it is never marked, and the request goes out as it would have.
 */
function snapshot(message: Message): Message | undefined {
	try {
		switch (message.role) {
			case "assistant": {
				const copy = { ...message, content: structuredClone(message.content) };
				if (copy.providerPayload) copy.providerPayload = structuredClone(copy.providerPayload);
				if (copy.requestControls) copy.requestControls = structuredClone(copy.requestControls);
				return copy;
			}
			case "user":
			case "developer": {
				const copy = { ...message, content: structuredClone(message.content) };
				if (copy.providerPayload) copy.providerPayload = structuredClone(copy.providerPayload);
				return copy;
			}
			case "toolResult":
				return { ...message, content: structuredClone(message.content) };
		}
	} catch {
		return undefined;
	}
}

/**
 * A copy of `message` for the comparison, without its timestamp. A hook builds its message afresh for each request
 * and the natural stamp is the current time, while the timestamp reaches no Anthropic message parameter: a user or
 * developer turn goes out as `{ role, content }`. It is read only to order a compaction's file text among the
 * messages, to stamp a control marker, and (on an assistant message) to drop thinking bound to an older prefix. At
 * worst a stamp that crosses another between two requests makes a repeated message of one whose request differs
 * there, once, which costs the cache write that every turn pays without this record; the bytes sent never change.
 */
function comparable(message: Message): Message | undefined {
	const copy = snapshot(message);
	return copy && { ...copy, timestamp: 0 };
}

/**
 * The per-call messages ({@link isPerCallContextMessage}) an Agent's previous main request sent, by place: the history
 * message each run of them follows (or, ahead of all history, precedes) and its ordinal in that run. Prompt caching
 * cuts the reusable prefix at a per-call message, since it is rebuilt for every request. A message rebuilt equal to
 * the one the previous main request had at the same place and ordinal, such as a context hook's fixed note after the
 * compaction summary, is history to the cache: {@link settle} marks it repeated
 * ({@link markRepeatedPerCallContextMessage}). It keeps its per-call mark, so every other reader treats it as before;
 * placement alone reads the repeated mark, does not cut the prefix at it, and never anchors a breakpoint on it. A
 * message that changes or moves is not marked. A place is a history message's bytes, not an index, so a per-call
 * message added or dropped at another place moves no note.
 *
 * The record holds copies ({@link snapshot}), and each request goes out with the messages it was built with: a host
 * that hands the same message object to every request and rewrites its content in place still sends what it wrote,
 * and the rewrite is seen.
 *
 * Only the Agent's own loop settles its requests: side requests, live steering and other Agents never read or change
 * this record. A request the loop prepares but the provider never answers (a `beforeModelCall` stop, a refusal inside
 * the stream function, an abort before the request reaches the provider) leaves the record as the last request
 * answered left it. So does every request to a provider that reports no response (`onResponse`): it never advances the
 * record. An Agent used only with such providers marks nothing; but the record belongs to the Agent, not the provider,
 * so after a switch to one of them the record of the last answered request can still match.
 *
 * The record lives as long as the conversation: `Agent.reset` (which `newSession`, a cleared context and a disposed
 * session's memory release all call) replaces it with a new one. A run keeps the record it started with, so a
 * request of the conversation that ended, prepared or answered after the reset, settles against that one, and the
 * copies it holds go with the run.
 */
export class RepeatedPerCallMessages {
	#previous: Place[] = [];

	/**
	 * `messages`, with each per-call message equal to the previous main request's at its place and ordinal marked
	 * repeated, and `sent`, which makes them the previous main request's per-call messages once the provider answers
	 * that request (the loop calls it from the request's `onResponse`).
	 */
	settle(messages: Message[]): { messages: Message[]; sent: () => void } {
		const current: Place[] = [];
		const matched = new Set<Place>();
		let settled: Message[] | undefined;
		let anchor: Message | undefined;
		let runStart = 0;
		for (let index = 0; index <= messages.length; index++) {
			const message = messages[index];
			if (message !== undefined && isPerCallContextMessage(message)) continue;
			if (index > runStart) {
				// A copy of the anchor too, with its own timestamp: a history message keeps the stamp it was stored
				// with, which tells two turns of the same text apart.
				const anchorMessage = anchor ?? message;
				const anchorCopy = anchorMessage === undefined ? undefined : snapshot(anchorMessage);
				// A place whose history message could not be copied is neither recorded nor looked up, so no later
				// request can match it.
				if (anchorMessage === undefined || anchorCopy !== undefined) {
					const run = messages.slice(runStart, index);
					const place: Place = { after: anchor !== undefined, anchor: anchorCopy, messages: run.map(comparable) };
					current.push(place);
					const previous = this.#previous.find(
						candidate =>
							!matched.has(candidate) &&
							candidate.after === place.after &&
							Bun.deepEquals(candidate.anchor, place.anchor),
					);
					if (previous) {
						matched.add(previous);
						for (const [ordinal, perCall] of run.entries()) {
							const before = previous.messages[ordinal];
							const now = place.messages[ordinal];
							// A per-call message that could not be copied is never compared.
							if (before === undefined || now === undefined || !Bun.deepEquals(before, now)) continue;
							// Built from the message in hand, so the request carries the bytes this request produced.
							const repeated = { ...perCall };
							markRepeatedPerCallContextMessage(repeated);
							settled ??= messages.slice();
							settled[runStart + ordinal] = repeated;
						}
					}
				}
			}
			anchor = message;
			runStart = index + 1;
		}
		return {
			messages: settled ?? messages,
			sent: () => {
				this.#previous = current;
			},
		};
	}
}
