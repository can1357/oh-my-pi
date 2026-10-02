/**
 * Test harness for the bridge host: a recording fake Bot API, a fake session
 * factory producing minimal fake sessions, and a host wired exactly as
 * `createTelegramHost` wires it, driven through `handleUpdate`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionPresence } from "@oh-my-pi/pi-coding-agent/session/session-presence";
import { createTelegramHost, type TelegramBridgeHost } from "@oh-my-pi/pi-coding-agent/telegram/host";
import type {
	TelegramApi,
	TelegramBridgeConfig,
	TelegramCallbackQuery,
	TelegramMessage,
	TelegramSessionFactory,
	TelegramSessionHandle,
	TelegramSessionRequest,
	TelegramUpdate,
	TopicEntry,
	TopicRegistry,
} from "@oh-my-pi/pi-coding-agent/telegram/types";

export const CHAT = 555;
export const OTHER_CHAT = 777;
export const USER = 1;
export const OTHER_USER = 2;

export interface ApiCall {
	method: string;
	fields: Record<string, unknown>;
}

export interface FakeApi {
	api: TelegramApi;
	calls: ApiCall[];
	of(method: string): ApiCall[];
	sentTexts(): string[];
	threadTexts(threadId: number): string[];
	nextThread: number;
}

const delivered = (call: ApiCall): string => {
	const rich = call.fields.richMessage as { markdown?: string } | undefined;
	return rich?.markdown ?? (call.fields.text as string | undefined) ?? "";
};

export function fakeApi(): FakeApi {
	const calls: ApiCall[] = [];
	let sent = 100;
	const fake: FakeApi = {
		calls,
		of: method => calls.filter(call => call.method === method),
		sentTexts: () =>
			calls.filter(call => call.method === "sendRichMessage" || call.method === "sendMessage").map(delivered),
		threadTexts: threadId =>
			calls
				.filter(call => call.method === "sendRichMessage" || call.method === "sendMessage")
				.filter(call => String(call.fields.threadId) === String(threadId))
				.map(delivered),
		nextThread: 900,
		api: null as unknown as TelegramApi,
	};
	const record = (method: string, fields: Record<string, unknown>): void => {
		calls.push({ method, fields });
	};
	fake.api = {
		getMe: async () => {
			record("getMe", {});
			return { id: 1, first_name: "Bridge", username: "omp_bridge" };
		},
		getChat: async fields => {
			record("getChat", fields);
			return { id: fields.chatId, type: "supergroup", is_forum: true };
		},
		getUpdates: async fields => {
			record("getUpdates", fields);
			return [];
		},
		setMyCommands: async commands => {
			record("setMyCommands", { commands });
			return true;
		},
		sendMessage: async fields => {
			record("sendMessage", fields);
			sent += 1;
			return { message_id: sent, chat: { id: fields.chatId, type: "supergroup" }, date: 0 };
		},
		sendRichMessage: async fields => {
			record("sendRichMessage", fields);
			sent += 1;
			return { message_id: sent, chat: { id: fields.chatId, type: "supergroup" }, date: 0 };
		},
		sendRichMessageDraft: async fields => {
			record("sendRichMessageDraft", fields);
			return true;
		},
		setMessageReaction: async fields => {
			record("setMessageReaction", fields);
			return true;
		},
		getForumTopicIconStickers: async () => {
			record("getForumTopicIconStickers", {});
			return [];
		},
		editMessageText: async fields => {
			record("editMessageText", fields);
			return { message_id: fields.messageId, chat: { id: fields.chatId, type: "supergroup" }, date: 0 };
		},
		editMessageReplyMarkup: async fields => {
			record("editMessageReplyMarkup", fields);
			return { message_id: fields.messageId, chat: { id: fields.chatId, type: "supergroup" }, date: 0 };
		},
		createForumTopic: async fields => {
			record("createForumTopic", fields);
			return { message_thread_id: fake.nextThread, name: fields.name };
		},
		editForumTopic: async fields => {
			record("editForumTopic", fields);
			return true;
		},
		closeForumTopic: async fields => {
			record("closeForumTopic", fields);
			return true;
		},
		reopenForumTopic: async fields => {
			record("reopenForumTopic", fields);
			return true;
		},
		answerCallbackQuery: async fields => {
			record("answerCallbackQuery", fields);
			return true;
		},
		sendChatAction: async fields => {
			record("sendChatAction", fields);
			return true;
		},
		downloadFile: async fileId => {
			record("downloadFile", { fileId });
			return Buffer.from("attachment");
		},
	};
	return fake;
}

export interface FakeSession {
	session: TelegramSessionHandle["session"];
	calls: Array<Record<string, unknown>>;
	emit(event: AgentSessionEvent): Promise<void>;
	setStreaming(value: boolean): void;
	name: string | null;
	file: string | null;
	id: string;
}

interface FakeSessionOptions {
	name?: string | null;
	file?: string | null;
	id?: string;
	cwd?: string;
	state?: Record<string, unknown>;
}

export function fakeSession(options: FakeSessionOptions = {}): FakeSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const calls: Array<Record<string, unknown>> = [];
	const fake: FakeSession = {
		calls,
		emit: async event => {
			for (const listener of Array.from(listeners)) listener(event);
		},
		setStreaming: value => {
			streaming = value;
		},
		name: options.name ?? null,
		file: options.file ?? null,
		id: options.id ?? "session-1",
		session: null as unknown as TelegramSessionHandle["session"],
	};
	let streaming = false;
	const model = { id: "claude-opus-4", provider: "anthropic", name: "Claude Opus 4", api: "anthropic-messages" };
	let thinking: string | undefined = "high";
	const sessionManager = { getCwd: () => options.cwd ?? "/work" };
	fake.session = {
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getContextUsage: () => ({ percent: 25, tokens: 1000, contextWindow: 4000 }),
		getTodoPhases: () => [],
		prompt: async (text: string, promptOptions?: unknown) => {
			calls.push({ method: "prompt", text, options: promptOptions });
			return true;
		},
		promptCustomMessage: async (message: unknown, promptOptions?: unknown) => {
			calls.push({ method: "promptCustomMessage", message, options: promptOptions });
			return true;
		},
		steer: async (text: string) => {
			calls.push({ method: "steer", text });
		},
		abort: async (abortOptions?: unknown) => {
			calls.push({ method: "abort", options: abortOptions });
		},
		compact: async () => {
			calls.push({ method: "compact" });
		},
		setModel: async (value: unknown, role?: string, setOptions?: unknown) => {
			calls.push({ method: "setModel", model: value, role, options: setOptions });
			return { switched: true };
		},
		setThinkingLevel: (level: unknown) => {
			calls.push({ method: "setThinkingLevel", level });
			thinking = level as string;
		},
		setSessionName: async (name: string, source?: string) => {
			calls.push({ method: "setSessionName", name, source });
			fake.name = name;
			return true;
		},
		setUsageFallbackConfirmer: (confirmer: unknown) => {
			calls.push({ method: "setUsageFallbackConfirmer", confirmer });
		},
		dispose: async () => {
			calls.push({ method: "dispose" });
		},
		get model() {
			return model;
		},
		get thinkingLevel() {
			return thinking;
		},
		get isStreaming() {
			return streaming;
		},
		get isCompacting() {
			return false;
		},
		get queuedMessageCount() {
			return 0;
		},
		get sessionName() {
			return fake.name;
		},
		get sessionFile() {
			return fake.file;
		},
		get sessionId() {
			return fake.id;
		},
		sessionManager,
		settings: { isolated: true },
		modelRegistry: { getAvailable: () => [] },
	} as unknown as TelegramSessionHandle["session"];
	return fake;
}

export interface BridgeHarness {
	host: TelegramBridgeHost;
	api: FakeApi;
	dir: string;
	sessionFactory: TelegramSessionFactory;
	requests: TelegramSessionRequest[];
	sessions: FakeSession[];
	/** Registers the next session the factory will hand out. */
	queue(session: FakeSession): void;
	config: TelegramBridgeConfig;
	/** Live presence of other processes as the host sees it. */
	presence: SessionPresence[];
	/** Session lookup behind `/resume`; assign to control resolution. */
	found: string[];
	/** Set to make presence unreadable (liveness unknown). */
	breakPresence: boolean;
	/** cwd reported for a resolved session file. */
	sessionCwd: (file: string) => string | null;
	/** Directory probe; defaults to "every directory exists". */
	existsDir: (dir: string) => boolean;
	/** Bot username the host starts with; `null` until `run()` answers `getMe`. */
	botUsername: string | null;
	/** The host's live registry view — mutations are synchronous, the file lands on `flush`. */
	readRegistry(): TopicEntry[];
	/** Builds a new host over the same state directory (a bridge restart). */
	restart(): void;
	cleanup(): void;
}

export function bridgeHarness(
	options: {
		config?: Partial<TelegramBridgeConfig>;
		clock?: { now(): number };
	} = {},
): BridgeHarness {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-host-"));
	const api = fakeApi();
	const requests: TelegramSessionRequest[] = [];
	const sessions: FakeSession[] = [];
	const pending: FakeSession[] = [];
	const factory: TelegramSessionFactory = async request => {
		requests.push(request);
		const session = pending.shift() ?? fakeSession({ file: request.sessionFile ?? null });
		sessions.push(session);
		return {
			session: session.session,
			setToolUIContext: (uiContext: unknown, hasUI: boolean) => {
				session.calls.push({ method: "setToolUIContext", uiContext, hasUI });
			},
		} as TelegramSessionHandle;
	};
	const config: TelegramBridgeConfig = {
		token: "12345:test-token",
		botId: "12345",
		chatId: CHAT,
		allowedUserIds: [USER],
		defaultCwd: "/work",
		model: null,
		...options.config,
	};
	let registry: TopicRegistry | null = null;
	const harness: BridgeHarness = {
		host: null as unknown as TelegramBridgeHost,
		api,
		dir,
		sessionFactory: factory,
		requests,
		sessions,
		queue: session => pending.push(session),
		config,
		presence: [],
		found: [],
		breakPresence: false,
		sessionCwd: () => null,
		existsDir: () => true,
		botUsername: "omp_bridge",
		readRegistry: () => registry?.list() ?? [],
		restart: () => {
			harness.host = host();
		},
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
	const presence = {
		list: async () => {
			if (harness.breakPresence) throw new Error("presence directory unreadable");
			return harness.presence;
		},
		findHolder: async (sessionFile: string) => {
			if (harness.breakPresence) throw new Error("presence directory unreadable");
			return (
				harness.presence.find(session => session.sessionFile === sessionFile && session.pid !== process.pid) ?? null
			);
		},
	};
	const host = (): TelegramBridgeHost =>
		createTelegramHost({
			config,
			api: api.api,
			sessionFactory: factory,
			stateDir: path.join(dir, "state"),
			clock: options.clock,
			seams: {
				presence,
				findSessions: async () => harness.found,
				sessionCwd: async file => harness.sessionCwd(file),
				existsDir: target => harness.existsDir(target),
				home: "/home/dev",
				botUsername: harness.botUsername,
				onRegistry: value => {
					registry = value;
				},
			},
		});
	harness.host = host();
	return harness;
}

export function message(input: {
	threadId?: number | null;
	text?: string;
	from?: number;
	chat?: number;
	messageId?: number;
	extra?: Partial<TelegramMessage>;
}): TelegramMessage {
	const fields: TelegramMessage = {
		message_id: input.messageId ?? 1,
		from: { id: input.from ?? USER, first_name: "Dev" },
		chat: { id: input.chat ?? CHAT, type: "supergroup" },
		date: 0,
		text: input.text ?? "",
		...input.extra,
	};
	if (input.threadId !== null && input.threadId !== undefined) fields.message_thread_id = input.threadId;
	return fields;
}

export function callback(
	input: {
		threadId?: number | null;
		data?: string;
		from?: number;
		chat?: number;
	} = {},
): TelegramCallbackQuery {
	const query: TelegramCallbackQuery = {
		id: "cb1",
		from: { id: input.from ?? USER, first_name: "Dev" },
		data: input.data ?? "",
		message: {
			message_id: 50,
			chat: { id: input.chat ?? CHAT, type: "supergroup" },
			date: 0,
			...(input.threadId === null || input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
		},
	};
	return query;
}

export function update(input: Partial<TelegramUpdate>): TelegramUpdate {
	return { update_id: 1, ...input };
}
