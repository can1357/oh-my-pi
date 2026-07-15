import type { Context, Message } from "@pk-nerdsaver-ai/pi-ai";

/** Count only image blocks already present in the outgoing provider context. */
export function countContextImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

/** Insert prepared background messages before the latest native user turn. */
export function injectBackgroundPackMessages(context: Context, backgroundMessages: readonly Message[]): Context {
	if (backgroundMessages.length === 0) return context;
	let latestUserIndex = -1;
	for (let index = context.messages.length - 1; index >= 0; index--) {
		if (context.messages[index]?.role === "user") {
			latestUserIndex = index;
			break;
		}
	}
	const insertionIndex = latestUserIndex < 0 ? context.messages.length : latestUserIndex;
	return {
		...context,
		messages: [
			...context.messages.slice(0, insertionIndex),
			...backgroundMessages,
			...context.messages.slice(insertionIndex),
		],
	};
}
