import { TelegramApiError } from "../../src/telegram/api";
import { createDelivery } from "../../src/telegram/deliver";
import type { TelegramApi, TelegramDelivery, TelegramInlineKeyboardMarkup } from "../../src/telegram/types";

export const MARKUP: TelegramInlineKeyboardMarkup = {
	inlineKeyboard: [[{ text: "⏹ Stop", callbackData: "turn:stop" }]],
};

export const longText = (): string =>
	Array.from({ length: 3000 }, (_unused, index) => `line ${index} ${"x".repeat(20)}`).join("\n");

export const refused = (method: string): TelegramApiError =>
	new TelegramApiError(method, { code: 400, description: "Bad Request: chat not found" });

export const missing = (method: string): TelegramApiError =>
	new TelegramApiError(method, { code: 404, description: "Not Found: method not found" });

export const limited = (method: string): TelegramApiError =>
	new TelegramApiError(method, { code: 429, description: "Too Many Requests: retry after 5" });

export interface RecordedCall {
	method: string;
	fields: Record<string, unknown>;
	/** Message id a `sendRichMessage`/`sendMessage` returned. */
	messageId?: number;
}

export interface DeliveryBench {
	calls: RecordedCall[];
	api: TelegramApi;
	delivery: TelegramDelivery;
	of(method: string): RecordedCall[];
}

export function bench(handlers: Record<string, unknown> = {}): DeliveryBench {
	const calls: RecordedCall[] = [];
	let id = 100;
	const record =
		(method: string) =>
		async (fields: Record<string, unknown>): Promise<unknown> => {
			const call: RecordedCall = { method, fields };
			calls.push(call);
			const handler = handlers[method];
			if (handler instanceof Error) throw handler;
			if (typeof handler === "function") return (handler as (fields: Record<string, unknown>) => unknown)(fields);
			if (method === "sendRichMessage" || method === "sendMessage") {
				call.messageId = id += 1;
				return { message_id: call.messageId };
			}
			return true;
		};
	const api: Record<string, unknown> = {
		sendRichMessage: record("sendRichMessage"),
		sendRichMessageDraft: record("sendRichMessageDraft"),
		sendMessage: record("sendMessage"),
		editMessageText: record("editMessageText"),
		sendChatAction: record("sendChatAction"),
	};
	if (handlers.withoutRich === true) delete api.sendRichMessage;
	return {
		calls,
		api: api as unknown as TelegramApi,
		delivery: createDelivery({ api: api as unknown as TelegramApi }),
		of: (method: string) => calls.filter(call => call.method === method),
	};
}
