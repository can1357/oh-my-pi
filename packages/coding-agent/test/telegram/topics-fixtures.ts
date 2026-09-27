import { createTopics } from "../../src/telegram/topics";
import type { TelegramApi, TelegramDelivery, TelegramTopics } from "../../src/telegram/types";

export interface RecordedCall {
	method: string;
	fields: Record<string, unknown>;
}

export interface TopicsBench {
	calls: RecordedCall[];
	sent: Array<Record<string, unknown>>;
	topics: TelegramTopics;
	of(method: string): RecordedCall[];
}

export interface TopicsHandlers {
	/** Ids the fake delivery reports back; defaults to two sent messages. */
	sent?: number[];
	[key: string]: unknown;
}

export function topicsBench(chatId: number, handlers: TopicsHandlers = {}): TopicsBench {
	const calls: RecordedCall[] = [];
	const record =
		(method: string) =>
		async (fields: Record<string, unknown>): Promise<unknown> => {
			calls.push({ method, fields });
			const handler = handlers[method];
			if (handler instanceof Error) throw handler;
			if (typeof handler === "function") return (handler as (fields: Record<string, unknown>) => unknown)(fields);
			if (method === "createForumTopic") return { message_thread_id: 42 };
			return true;
		};
	const api = {
		createForumTopic: record("createForumTopic"),
		editForumTopic: record("editForumTopic"),
		closeForumTopic: record("closeForumTopic"),
		reopenForumTopic: record("reopenForumTopic"),
	} as unknown as TelegramApi;
	const sent: Array<Record<string, unknown>> = [];
	const delivery = {
		send: async (fields: Record<string, unknown>) => {
			sent.push(fields);
			return handlers.sent ?? [11, 12];
		},
	} as unknown as TelegramDelivery;
	return {
		calls,
		sent,
		topics: createTopics({ api, delivery, chatId }),
		of: (method: string) => calls.filter(call => call.method === method),
	};
}
