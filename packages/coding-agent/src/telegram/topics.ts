/**
 * Topic-level helpers over one paired chat.
 *
 * A forum chat (negative id) uses the forum calls and falls back to renaming
 * when Telegram refuses; a private chat has no forum calls, so closing and
 * reopening are expressed by renaming the topic with a closed mark.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { TelegramApi, TelegramChatId, TelegramDelivery, TelegramTopics } from "./types";

/** Appended to a topic name to mark it closed; the mark is part of the 128-character limit. */
const CLOSED_MARK = " · closed";
const TOPIC_NAME_LIMIT = 128;

const errorText = (error: unknown): string => String((error as { message?: unknown } | null)?.message ?? error);

/** `<name> · closed`, trimmed so the result fits the topic-name limit. */
export function closedTitle(name: string): string {
	const plain = String(name).slice(0, TOPIC_NAME_LIMIT - CLOSED_MARK.length);
	return `${plain}${CLOSED_MARK}`;
}

/** The base name when `name` carries the closed mark, else null. */
export function withoutClosedMark(name: string): string | null {
	const text = String(name);
	return text.endsWith(CLOSED_MARK) ? text.slice(0, -CLOSED_MARK.length) : null;
}

/** Forum chats (groups/supergroups) have negative ids. */
export function isForumChat(chatId: TelegramChatId): boolean {
	return chatId < 0;
}

const threadField = (threadId: number | null): { threadId?: number } =>
	threadId === null || threadId === undefined ? {} : { threadId };

/** Topic helpers bound to the paired chat. */
export function createTopics(deps: {
	api: TelegramApi;
	delivery: TelegramDelivery;
	chatId: TelegramChatId;
}): TelegramTopics {
	const { api, delivery, chatId } = deps;
	const report = (event: string, context: Record<string, unknown>): void => {
		logger.debug(`telegram: ${event}`, context);
	};

	async function editTopic(threadId: number, name: string): Promise<void> {
		await api.editForumTopic({ chatId, threadId, name });
	}

	async function notify(threadId: number | null, markdown: string): Promise<boolean> {
		const ids = await delivery.send({ chatId, ...threadField(threadId), markdown });
		return ids.length > 0;
	}

	async function create(name: string): Promise<number | null> {
		const topic = await api.createForumTopic({ chatId, name });
		const threadId = topic?.message_thread_id;
		return typeof threadId === "number" ? threadId : null;
	}

	async function close(threadId: number, name: string): Promise<boolean> {
		if (isForumChat(chatId)) {
			try {
				await api.closeForumTopic({ chatId, threadId });
				return true;
			} catch (error) {
				report("topic.close_failed", { threadId, error: errorText(error) });
			}
		}
		try {
			await editTopic(threadId, closedTitle(name));
			return true;
		} catch (error) {
			report("topic.rename_failed", { threadId, error: errorText(error) });
			return false;
		}
	}

	async function reopen(threadId: number, name: string): Promise<boolean> {
		if (isForumChat(chatId)) {
			try {
				await api.reopenForumTopic({ chatId, threadId });
			} catch (error) {
				report("topic.reopen_failed", { threadId, error: errorText(error) });
			}
		}
		try {
			await editTopic(threadId, name);
			return true;
		} catch (error) {
			report("topic.rename_failed", { threadId, error: errorText(error) });
			return false;
		}
	}

	async function rename(threadId: number, name: string): Promise<void> {
		await editTopic(threadId, name);
	}

	return { notify, create, close, reopen, rename };
}
