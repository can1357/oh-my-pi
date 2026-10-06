/**
 * Shared fixtures for slice D's tests: a recording `TelegramApi`, a recording
 * `TelegramDelivery`, a manually advanced `Clock`, a `TurnEventSource` the test
 * drives with native-shaped events, and a controllable sleeper for the card's
 * throttled republish.
 */
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
	Clock,
	TelegramApi,
	TelegramCallbackQuery,
	TelegramChatId,
	TelegramDelivery,
	TelegramMessage,
	TelegramSticker,
	TelegramUpdate,
	TelegramUser,
	TurnEventSource,
} from "@oh-my-pi/pi-coding-agent/telegram/types";

export interface RecordedCall {
	method: string;
	fields: Record<string, unknown>;
	/** Message ids a `send` actually produced. */
	ids?: number[];
}

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields => (value ?? {}) as Fields;

export interface FakeApi extends TelegramApi {
	calls: RecordedCall[];
	of(method: string): RecordedCall[];
}

/** Recording Telegram client: every method resolves with a benign payload. */
export function fakeApi(overrides: Partial<TelegramApi> = {}): FakeApi {
	const calls: RecordedCall[] = [];
	const push = (method: string, value?: unknown): void => {
		calls.push({ method, fields: fields(value) });
	};
	const bot: TelegramUser = { id: 42, first_name: "bridge", is_bot: true };
	const api: FakeApi = {
		calls,
		of: method => calls.filter(call => call.method === method),
		async getMe() {
			push("getMe");
			return bot;
		},
		async getChat(params: { chatId: TelegramChatId }) {
			push("getChat", params);
			return { id: params.chatId, type: "supergroup", is_forum: true };
		},
		async getUpdates() {
			push("getUpdates");
			return [] as TelegramUpdate[];
		},
		async setMyCommands() {
			push("setMyCommands");
			return true;
		},
		async sendMessage(params) {
			push("sendMessage", params);
			return message(params.threadId ?? 0);
		},
		async sendRichMessage(params) {
			push("sendRichMessage", params);
			return message(params.threadId ?? 0);
		},
		async editMessageText(params) {
			push("editMessageText", params);
			return true;
		},
		async editMessageReplyMarkup(params) {
			push("editMessageReplyMarkup", params);
			return true;
		},
		async sendRichMessageDraft(params) {
			push("sendRichMessageDraft", params);
			return true;
		},
		async setMessageReaction(params) {
			push("setMessageReaction", params);
			return true;
		},
		async getForumTopicIconStickers() {
			push("getForumTopicIconStickers");
			return [] as TelegramSticker[];
		},
		async createForumTopic(params) {
			push("createForumTopic", params);
			return { message_thread_id: 1, name: params.name };
		},
		async editForumTopic(params) {
			push("editForumTopic", params);
			return true;
		},
		async closeForumTopic(params) {
			push("closeForumTopic", params);
			return true;
		},
		async reopenForumTopic(params) {
			push("reopenForumTopic", params);
			return true;
		},
		async answerCallbackQuery(params) {
			push("answerCallbackQuery", params);
			return true;
		},
		async sendChatAction(params) {
			push("sendChatAction", params);
			return true;
		},
		async downloadFile(fileId: string) {
			push("downloadFile", { fileId });
			return new Uint8Array();
		},
		...overrides,
	};
	return api;
}

export interface FakeDelivery extends TelegramDelivery {
	calls: RecordedCall[];
	of(method: string): RecordedCall[];
	/** Message bodies sent or edited, in order. */
	markdowns(): string[];
}

/** Recording delivery: `send` mints message ids, `draft` answers `drafts`. */
export function fakeDelivery(options: { drafts?: boolean; failDraft?: boolean } = {}): FakeDelivery {
	const calls: RecordedCall[] = [];
	let nextId = 100;
	const drafts = options.drafts !== false;
	const delivery: FakeDelivery = {
		calls,
		of: method => calls.filter(call => call.method === method),
		markdowns: () => calls.map(call => String(call.fields.markdown ?? "")),
		async send(params) {
			nextId += 1;
			const call: RecordedCall = { method: "send", fields: fields(params), ids: [nextId - 1] };
			calls.push(call);
			return call.ids ?? [];
		},
		async edit(params) {
			calls.push({ method: "edit", fields: fields(params) });
			return true;
		},
		async draft(params: {
			chatId: TelegramChatId;
			threadId?: number | null;
			draftId: number;
			markdown?: string;
			thinking?: string | null;
			canStop?: boolean;
		}) {
			calls.push({ method: "draft", fields: fields(params) });
			if (options.failDraft === true) throw new Error("drafts unavailable");
			return drafts;
		},
	};
	return delivery;
}

export interface FakeClock extends Clock {
	advance(ms: number): void;
}

/** Clock the test moves by hand, so throttling is deterministic. */
export function fakeClock(start = 0): FakeClock {
	let current = start;
	return {
		now: () => current,
		advance(ms: number) {
			current += ms;
		},
	};
}

export interface FakeTurnSource {
	source: TurnEventSource;
	/** Delivers one event to every subscriber, then lets rendering settle. */
	emit(event: object): Promise<void>;
}

/** A `TurnEventSource` the test drives; `percent` is what `getContextUsage` reports. */
export function fakeTurnSource(contextPercent?: number): FakeTurnSource {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const source: TurnEventSource = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getContextUsage: () => (contextPercent === undefined ? undefined : { percent: contextPercent }),
	};
	return {
		source,
		async emit(event) {
			for (const listener of Array.from(listeners)) listener(event as AgentSessionEvent);
			await drain();
		},
	};
}

/** Lets every queued microtask and timer-free continuation run. */
export async function drain(): Promise<void> {
	for (let round = 0; round < 4; round += 1) await Bun.sleep(0);
}

export interface Sleeper {
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	/** Releases every waiter, as if its delay elapsed. */
	release(): void;
	/** Waiters still pending or aborted-pending. */
	held(): number;
}

/** Sleeper the test releases by hand, for deferred (throttled) publishes. */
export function manualSleeper(): Sleeper {
	const waiters = new Set<{ resolve: () => void }>();
	return {
		sleep: (_ms, signal) =>
			new Promise<void>((resolve, reject) => {
				const entry = { resolve: () => {} };
				const drop = (): void => {
					waiters.delete(entry);
				};
				entry.resolve = () => {
					drop();
					resolve();
				};
				waiters.add(entry);
				signal.addEventListener(
					"abort",
					() => {
						drop();
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			}),
		release() {
			for (const entry of Array.from(waiters)) entry.resolve();
		},
		held: () => waiters.size,
	};
}

export function callbackQuery(data: string, id = "cb1"): TelegramCallbackQuery {
	return { id, from: { id: 7, first_name: "operator" }, data, message: message(7) };
}

export function message(threadId: number, text = ""): TelegramMessage {
	return { message_id: 1, message_thread_id: threadId, chat: { id: -1000, type: "supergroup" }, date: 0, text };
}
