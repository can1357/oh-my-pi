/**
 * Bot API client over `fetch`.
 *
 * Parameter objects are camelCase and converted to the wire's snake_case
 * (nested objects and arrays included, `undefined` dropped). HTTP 429 replies
 * are retried up to the attempt budget honouring `retry_after`; every other
 * refusal becomes a {@link TelegramApiError}. The bot token never appears in an
 * error and an `AbortError` passes through untouched, so cancellation is never
 * reported as a Telegram refusal.
 */

import { withTimeoutSignal } from "../utils/fetch-timeout";
import type {
	TelegramApi,
	TelegramBotCommand,
	TelegramChat,
	TelegramChatId,
	TelegramForumTopic,
	TelegramInlineKeyboardMarkup,
	TelegramMessage,
	TelegramReaction,
	TelegramRichDraft,
	TelegramSticker,
	TelegramUpdate,
	TelegramUser,
} from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const RATE_LIMITED = 429;
const DEFAULT_ATTEMPTS = 3;
const RETRY_AFTER_FALLBACK_SEC = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_MARGIN_MS = 10_000;

/** Wire names that do not follow the generic camelCase → snake_case rule. */
const WIRE_KEYS: Record<string, string> = {
	threadId: "message_thread_id",
	replyTo: "reply_to_message_id",
	id: "callback_query_id",
};

const wireKey = (key: string): string =>
	Object.hasOwn(WIRE_KEYS, key) ? WIRE_KEYS[key] : key.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`);

function wireValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(wireValue);
	if (value !== null && typeof value === "object") return wireParams(value as Record<string, unknown>);
	return value;
}

function wireParams(params: Record<string, unknown> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		out[wireKey(key)] = wireValue(value);
	}
	return out;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const isAbort = (error: unknown): boolean =>
	typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Replaces every occurrence of the bot token (raw or percent-encoded) with `***`. */
export function redactToken(text: string, token: string): string {
	const shown = String(text ?? "");
	const secret = String(token ?? "");
	if (secret === "") return shown;
	return shown.split(secret).join("***").split(encodeURIComponent(secret)).join("***");
}

/** Numeric prefix of a bot token (`123456` in `123456:ABC`), or null when it has none. */
export function botIdOf(token: string): string | null {
	const match = /^(\d+):/u.exec(String(token ?? ""));
	return match === null ? null : match[1];
}

/** A Telegram refusal: the method, its error code and (for 429) the stated wait. */
export class TelegramApiError extends Error {
	readonly method: string;
	readonly code: number | null;
	readonly retryAfter: number | null;

	constructor(
		method: string,
		options: { code?: number | null; description?: string; retryAfter?: number | null } = {},
	) {
		super(options.description ?? "");
		this.name = "TelegramApiError";
		this.method = method;
		this.code = options.code ?? null;
		this.retryAfter = options.retryAfter ?? null;
	}
}

interface RateLimited {
	limit: number;
}

interface Refused {
	refusal: { code: number; description: string };
}

interface Answered {
	result: unknown;
}

type Transmit = RateLimited | Refused | Answered;

async function answerOf(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function retryAfterOf(response: Response, body: Record<string, unknown> | null): number {
	const stated = Number(asRecord(body?.parameters)?.retry_after);
	if (Number.isFinite(stated) && stated >= 0) return stated;
	const headers = response.headers as Headers | undefined;
	const header = typeof headers?.get === "function" ? headers.get("retry-after") : null;
	const seconds = typeof header === "string" && header.trim() !== "" ? Number(header) : Number.NaN;
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : RETRY_AFTER_FALLBACK_SEC;
}

/** Bot API client for one token. */
export class TelegramBotApi implements TelegramApi {
	readonly #token: string;
	readonly #root: string;
	readonly #files: string;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #attempts: number;

	constructor(options: {
		token: string;
		fetch?: typeof fetch;
		baseUrl?: string;
		fileBaseUrl?: string;
		sleep?: (ms: number) => Promise<void>;
		attempts?: number;
	}) {
		this.#token = String(options.token ?? "");
		this.#root = String(options.baseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/u, "");
		this.#files = String(options.fileBaseUrl ?? `${this.#root}/file`).replace(/\/+$/u, "");
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#sleep =
			options.sleep ??
			(async (ms: number) => {
				await Bun.sleep(ms);
			});
		this.#attempts = options.attempts ?? DEFAULT_ATTEMPTS;
	}

	#hide(text: string): string {
		return redactToken(text, this.#token);
	}

	#signalFor(method: string, wire: Record<string, unknown>, signal?: AbortSignal): AbortSignal {
		// A long poll legitimately waits for its own timeout; anything else gets a short leash.
		const timeoutMs =
			method === "getUpdates" ? LONG_POLL_MARGIN_MS + Number(wire.timeout ?? 0) * 1000 : REQUEST_TIMEOUT_MS;
		return withTimeoutSignal(timeoutMs, signal);
	}

	async #transmit(method: string, wire: Record<string, unknown>, signal?: AbortSignal): Promise<Transmit> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#root}/bot${this.#token}/${method}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(wire),
				signal: this.#signalFor(method, wire, signal),
			});
		} catch (error) {
			if (isAbort(error)) throw error;
			throw new TelegramApiError(method, {
				description: `Request to Telegram failed: ${this.#hide(messageOf(error))}`,
			});
		}
		const body = asRecord(await answerOf(response));
		if (response.status === RATE_LIMITED || body?.error_code === RATE_LIMITED) {
			return { limit: retryAfterOf(response, body) };
		}
		if (body === null) {
			throw new TelegramApiError(method, {
				code: response.status,
				description: `Telegram answered with non-JSON (HTTP ${response.status}) for ${method}; retry later.`,
			});
		}
		if (body.ok !== true) {
			return {
				refusal: {
					code: Number.isInteger(body.error_code) ? (body.error_code as number) : response.status,
					description: this.#hide(
						String(body.description ?? `Telegram refused without a description (HTTP ${response.status}).`),
					),
				},
			};
		}
		return { result: body.result };
	}

	async #request(method: string, wire: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		for (let attempt = 1; ; attempt += 1) {
			const answer = await this.#transmit(method, wire, signal);
			if (!("limit" in answer)) {
				if ("refusal" in answer) throw new TelegramApiError(method, answer.refusal);
				return answer.result;
			}
			if (attempt >= this.#attempts) {
				throw new TelegramApiError(method, {
					code: RATE_LIMITED,
					description: `Telegram rate-limited ${method}; retry later.`,
					retryAfter: answer.limit,
				});
			}
			await this.#sleep(answer.limit * 1000);
		}
	}

	async #call(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return await this.#request(method, wireParams(params), signal);
	}

	async getMe(signal?: AbortSignal): Promise<TelegramUser> {
		return (await this.#call("getMe", {}, signal)) as TelegramUser;
	}

	async getChat(params: { chatId: TelegramChatId }): Promise<TelegramChat> {
		return (await this.#call("getChat", { chatId: params.chatId })) as TelegramChat;
	}

	async getUpdates(
		params: { offset?: number; timeout?: number; allowedUpdates?: readonly string[] },
		signal?: AbortSignal,
	): Promise<TelegramUpdate[]> {
		return (await this.#call(
			"getUpdates",
			{ offset: params.offset, timeout: params.timeout, allowedUpdates: params.allowedUpdates },
			signal,
		)) as TelegramUpdate[];
	}

	async setMyCommands(commands: readonly TelegramBotCommand[]): Promise<boolean> {
		return (await this.#call("setMyCommands", { commands })) as boolean;
	}

	async sendMessage(params: {
		chatId: TelegramChatId;
		threadId?: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: TelegramInlineKeyboardMarkup;
		disableNotification?: boolean;
		replyTo?: number;
	}): Promise<TelegramMessage> {
		return (await this.#call("sendMessage", { ...params })) as TelegramMessage;
	}

	async sendRichMessage(params: {
		chatId: TelegramChatId;
		threadId?: number;
		richMessage: { markdown: string };
		replyMarkup?: TelegramInlineKeyboardMarkup;
		disableNotification?: boolean;
	}): Promise<TelegramMessage> {
		return (await this.#call("sendRichMessage", { ...params })) as TelegramMessage;
	}

	async editMessageText(params: {
		chatId: TelegramChatId;
		messageId: number;
		text?: string;
		parseMode?: "HTML";
		richMessage?: { markdown: string };
		replyMarkup?: TelegramInlineKeyboardMarkup;
	}): Promise<TelegramMessage | true> {
		return (await this.#call("editMessageText", { ...params })) as TelegramMessage | true;
	}

	async editMessageReplyMarkup(params: {
		chatId: TelegramChatId;
		messageId: number;
		replyMarkup?: TelegramInlineKeyboardMarkup;
	}): Promise<TelegramMessage | true> {
		return (await this.#call("editMessageReplyMarkup", { ...params })) as TelegramMessage | true;
	}

	async sendRichMessageDraft(params: {
		chatId: TelegramChatId;
		threadId?: number;
		draftId: number;
		richMessage: TelegramRichDraft;
		canStop?: boolean;
	}): Promise<true> {
		return (await this.#call("sendRichMessageDraft", { ...params })) as true;
	}

	async setMessageReaction(params: {
		chatId: TelegramChatId;
		messageId: number;
		reaction: readonly TelegramReaction[];
	}): Promise<true> {
		return (await this.#call("setMessageReaction", { ...params })) as true;
	}

	async getForumTopicIconStickers(): Promise<TelegramSticker[]> {
		return (await this.#call("getForumTopicIconStickers", {})) as TelegramSticker[];
	}

	async createForumTopic(params: { chatId: TelegramChatId; name: string }): Promise<TelegramForumTopic> {
		return (await this.#call("createForumTopic", { ...params })) as TelegramForumTopic;
	}

	async editForumTopic(params: {
		chatId: TelegramChatId;
		threadId: number;
		name?: string;
		iconCustomEmojiId?: string;
	}): Promise<true> {
		return (await this.#call("editForumTopic", { ...params })) as true;
	}

	async closeForumTopic(params: { chatId: TelegramChatId; threadId: number }): Promise<true> {
		return (await this.#call("closeForumTopic", { ...params })) as true;
	}

	async reopenForumTopic(params: { chatId: TelegramChatId; threadId: number }): Promise<true> {
		return (await this.#call("reopenForumTopic", { ...params })) as true;
	}

	async answerCallbackQuery(params: { id: string; text?: string }): Promise<true> {
		return (await this.#call("answerCallbackQuery", { ...params })) as true;
	}

	async sendChatAction(params: {
		chatId: TelegramChatId;
		threadId?: number;
		action: "typing" | "upload_document";
	}): Promise<true> {
		return (await this.#call("sendChatAction", { ...params })) as true;
	}

	async downloadFile(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
		const file = (await this.#call("getFile", { fileId }, signal)) as { file_path?: unknown } | null;
		const filePath = typeof file?.file_path === "string" ? file.file_path : "";
		if (filePath === "") {
			throw new TelegramApiError("downloadFile", {
				description: "Telegram did not return file_path from getFile; nothing to download.",
			});
		}
		let response: Response;
		try {
			response = await this.#fetch(`${this.#files}/bot${this.#token}/${filePath}`, {
				signal: withTimeoutSignal(REQUEST_TIMEOUT_MS, signal),
			});
		} catch (error) {
			if (isAbort(error)) throw error;
			throw new TelegramApiError("downloadFile", {
				description: `File download failed: ${this.#hide(messageOf(error))}`,
			});
		}
		if (!response.ok) {
			throw new TelegramApiError("downloadFile", {
				code: response.status,
				description: `File download failed: Telegram answered HTTP ${response.status}.`,
			});
		}
		return new Uint8Array(await response.arrayBuffer());
	}
}
