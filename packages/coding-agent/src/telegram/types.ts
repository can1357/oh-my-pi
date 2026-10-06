/**
 * Cross-module contract of the native Telegram bridge.
 *
 * Every module under `src/telegram/` is written against these shapes; the
 * semantics behind them live in the bridge contract (docs of each owner
 * module). Bot API payloads received from Telegram keep their wire names
 * (snake_case); parameter objects sent through {@link TelegramApi} use
 * camelCase and are converted by the client.
 */
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { RemoteDialogHost } from "../modes/remote-dialogs";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { AuthStorage } from "../session/auth-storage";
import type { SessionPresence } from "../session/session-presence";

// ═══════════════════════════════════════════════════════════════════════════
// Shared primitives
// ═══════════════════════════════════════════════════════════════════════════

/** Telegram chat id: negative for groups/supergroups, positive for private chats. */
export type TelegramChatId = number;

/** Injectable wall clock (epoch milliseconds). */
export interface Clock {
	now(): number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bot API payloads (received, snake_case)
// ═══════════════════════════════════════════════════════════════════════════

export interface TelegramUser {
	id: number;
	is_bot?: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
	/** `getMe` only: the bot has Threaded Mode (topics in private chats) enabled. */
	has_topics_enabled?: boolean;
}

export interface TelegramChat {
	id: TelegramChatId;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	is_forum?: boolean;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TelegramDocument {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramForumTopicCreated {
	name: string;
	icon_color?: number;
	icon_custom_emoji_id?: string;
}

export interface TelegramForumTopicEdited {
	name?: string;
	icon_custom_emoji_id?: string;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	is_topic_message?: boolean;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	reply_to_message?: TelegramMessage;
	forum_topic_created?: TelegramForumTopicCreated;
	forum_topic_edited?: TelegramForumTopicEdited;
	forum_topic_closed?: Record<string, never>;
	forum_topic_reopened?: Record<string, never>;
	general_forum_topic_hidden?: Record<string, never>;
	general_forum_topic_unhidden?: Record<string, never>;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

/** The user pressed stop on a streamed private-chat draft. */
export interface TelegramStoppedGeneration {
	chat: TelegramChat;
	message_thread_id?: number;
	from?: TelegramUser;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
	stopped_message_generation?: TelegramStoppedGeneration;
}

export interface TelegramForumTopic {
	message_thread_id: number;
	name: string;
	icon_color?: number;
	icon_custom_emoji_id?: string;
}

export interface TelegramSticker {
	file_id: string;
	emoji?: string;
	custom_emoji_id?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bot API parameters (sent, camelCase)
// ═══════════════════════════════════════════════════════════════════════════

export interface TelegramInlineKeyboardButton {
	text: string;
	/** At most 64 bytes of UTF-8. */
	callbackData?: string;
	url?: string;
}

export interface TelegramInlineKeyboardMarkup {
	inlineKeyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramBotCommand {
	command: string;
	description: string;
}

export interface TelegramReaction {
	type: "emoji";
	emoji: string;
}

export type TelegramRichDraft = { markdown: string } | { html: string };

/**
 * Bot API client. Every method rejects with `TelegramApiError` (`api.ts`) on a
 * refusal, retries HTTP 429 up to its attempt budget honouring `retry_after`,
 * never includes the bot token in an error, and lets an `AbortError` through
 * untouched.
 */
export interface TelegramApi {
	getMe(signal?: AbortSignal): Promise<TelegramUser>;
	getChat(params: { chatId: TelegramChatId }): Promise<TelegramChat>;
	getUpdates(
		params: { offset?: number; timeout?: number; allowedUpdates?: readonly string[] },
		signal?: AbortSignal,
	): Promise<TelegramUpdate[]>;
	setMyCommands(commands: readonly TelegramBotCommand[]): Promise<boolean>;
	sendMessage(params: {
		chatId: TelegramChatId;
		threadId?: number;
		text: string;
		parseMode?: "HTML";
		replyMarkup?: TelegramInlineKeyboardMarkup;
		disableNotification?: boolean;
		replyTo?: number;
	}): Promise<TelegramMessage>;
	sendRichMessage(params: {
		chatId: TelegramChatId;
		threadId?: number;
		richMessage: { markdown: string };
		replyMarkup?: TelegramInlineKeyboardMarkup;
		disableNotification?: boolean;
	}): Promise<TelegramMessage>;
	editMessageText(params: {
		chatId: TelegramChatId;
		messageId: number;
		text?: string;
		parseMode?: "HTML";
		richMessage?: { markdown: string };
		replyMarkup?: TelegramInlineKeyboardMarkup;
	}): Promise<TelegramMessage | true>;
	editMessageReplyMarkup(params: {
		chatId: TelegramChatId;
		messageId: number;
		replyMarkup?: TelegramInlineKeyboardMarkup;
	}): Promise<TelegramMessage | true>;
	sendRichMessageDraft(params: {
		chatId: TelegramChatId;
		threadId?: number;
		draftId: number;
		richMessage: TelegramRichDraft;
		canStop?: boolean;
	}): Promise<true>;
	setMessageReaction(params: {
		chatId: TelegramChatId;
		messageId: number;
		reaction: readonly TelegramReaction[];
	}): Promise<true>;
	getForumTopicIconStickers(): Promise<TelegramSticker[]>;
	createForumTopic(params: { chatId: TelegramChatId; name: string }): Promise<TelegramForumTopic>;
	editForumTopic(params: {
		chatId: TelegramChatId;
		threadId: number;
		name?: string;
		iconCustomEmojiId?: string;
	}): Promise<true>;
	closeForumTopic(params: { chatId: TelegramChatId; threadId: number }): Promise<true>;
	reopenForumTopic(params: { chatId: TelegramChatId; threadId: number }): Promise<true>;
	answerCallbackQuery(params: { id: string; text?: string }): Promise<true>;
	sendChatAction(params: {
		chatId: TelegramChatId;
		threadId?: number;
		action: "typing" | "upload_document";
	}): Promise<true>;
	downloadFile(fileId: string, signal?: AbortSignal): Promise<Uint8Array>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Delivery and topics (slice A)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sends omp-flavoured markdown through the rich → HTML → plain ladder,
 * chunking long text. Never throws: failures are logged and reported through
 * the return value.
 */
export interface TelegramDelivery {
	/** Message ids actually sent (empty when nothing got through). The keyboard rides the last chunk. */
	send(params: {
		chatId: TelegramChatId;
		threadId?: number | null;
		markdown: string;
		replyMarkup?: TelegramInlineKeyboardMarkup | null;
		disableNotification?: boolean;
	}): Promise<number[]>;
	/**
	 * Replaces a message. Overflow continues as new messages in the thread; later edits of the same
	 * message update those continuations in place instead of posting them again. "Not modified" counts as success.
	 */
	edit(params: {
		chatId: TelegramChatId;
		messageId: number;
		threadId?: number | null;
		markdown: string;
		replyMarkup?: TelegramInlineKeyboardMarkup | null;
	}): Promise<boolean>;
	/** Private-chat streaming draft (optionally with a thinking block). false when drafts are unavailable. */
	draft(params: {
		chatId: TelegramChatId;
		threadId?: number | null;
		draftId: number;
		markdown?: string;
		thinking?: string | null;
		canStop?: boolean;
	}): Promise<boolean>;
}

/** Topic-level helpers over one paired chat. Forum chats use forum calls; private threaded chats rename. */
export interface TelegramTopics {
	/** Posts bridge markdown into `threadId` (null = the chat's general thread). false when nothing was sent. */
	notify(threadId: number | null, markdown: string): Promise<boolean>;
	/** Creates a topic; resolves its thread id, or null when Telegram returned none. Throws on API refusal. */
	create(name: string): Promise<number | null>;
	/** Forum: closeForumTopic, falling back to the closed title; private: renames to the closed title. */
	close(threadId: number, name: string): Promise<boolean>;
	/** Forum: reopenForumTopic, then restores `name`; private: restores `name`. */
	reopen(threadId: number, name: string): Promise<boolean>;
	/** Renames a topic. Throws on API refusal. */
	rename(threadId: number, name: string): Promise<void>;
}

/** Long-poll loop over `getUpdates`. */
export interface TelegramPoller {
	/** Registers the bot command menu, then polls until {@link stop}. Rejects on a fatal refusal (401, 409). */
	run(): Promise<void>;
	/** Ends the loop, including one waiting in backoff or in a long poll. */
	stop(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Session presence consumer view (slice B owns `session/session-presence.ts`)
// ═══════════════════════════════════════════════════════════════════════════

/** Live sessions of *other* processes; rejects when presence cannot be read (liveness unknown). */
export type LivePresenceSource = () => Promise<SessionPresence[]>;

// ═══════════════════════════════════════════════════════════════════════════
// Topic registry (slice C)
// ═══════════════════════════════════════════════════════════════════════════

export type TopicStatus = "idle" | "running" | "closed" | "mirror";

/** One Telegram topic ↔ one omp session. Persisted in `<stateDir>/registry.json`. */
export interface TopicEntry {
	threadId: number;
	/** Topic name; unique (case-insensitive) among entries that are not closed. */
	name: string;
	cwd: string;
	sessionFile: string | null;
	sessionId: string | null;
	status: TopicStatus;
	/** The session lives in another omp process; the topic mirrors it read-only. */
	mirror?: boolean;
	/** Byte offset in `sessionFile` up to which a mirror has relayed. */
	tailOffset?: number;
	createdAt: number;
	updatedAt: number;
}

export type TopicEntryDraft = Omit<TopicEntry, "createdAt" | "updatedAt"> &
	Partial<Pick<TopicEntry, "createdAt" | "updatedAt">>;

export type TopicEntryPatch = Partial<Omit<TopicEntry, "threadId" | "createdAt" | "updatedAt">>;

/**
 * File-backed registry with a synchronous in-memory view. Mutations apply
 * immediately and are persisted in order, atomically, off the caller's path;
 * {@link flush} resolves once every queued write has landed. A broken file is
 * refused, never overwritten.
 */
export interface TopicRegistry {
	readonly path: string;
	list(): TopicEntry[];
	get(threadId: number): TopicEntry | null;
	/** Case-insensitive; prefers an entry that is not closed. */
	byName(name: string): TopicEntry | null;
	bySessionFile(sessionFile: string): TopicEntry | null;
	/** Throws `TopicRegistryError` (`no_name`, `name_taken`). */
	put(entry: TopicEntryDraft): TopicEntry;
	/** Throws `TopicRegistryError` (`unknown_thread`, `name_taken`). */
	update(threadId: number, patch: TopicEntryPatch): TopicEntry;
	remove(threadId: number): TopicEntry | null;
	/** `base`, else `base 2`, `base 3`, … — the first name no open entry uses. */
	freeName(base: string): string;
	/** Resolves once every mutation made so far is on disk; rejects with the first failed write. */
	flush(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sessions (slice C)
// ═══════════════════════════════════════════════════════════════════════════

export interface TelegramSessionRequest {
	cwd: string;
	/** Session file to resume; omitted → a new session in `cwd`. */
	sessionFile?: string;
	/** Model selector for a new session (`telegram.model`); ignored on resume. */
	model?: string;
}

export interface TelegramSessionHandle {
	session: AgentSession;
	setToolUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void;
}

/** Creates a topic session in this process through the SDK. */
export type TelegramSessionFactory = (request: TelegramSessionRequest) => Promise<TelegramSessionHandle>;

export interface TelegramSessionFactoryOptions {
	/** Launch-level session options, captured before any interactive-only additions. */
	baseOptions: CreateAgentSessionOptions;
	/** Launch settings; each topic session gets `settings.cloneForCwd(cwd)`. */
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	/** `false` inside the TUI process so topic sessions never take over the TUI session's process state. */
	bindProcessState: boolean;
	/** Defaults to `createAgentSession`. */
	createSession?(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
}

/** The interactive session of the process hosting the bridge, relayed two-way in its own topic. */
export interface AttachedSessionBinding {
	session: AgentSession;
	/** Registers a dialog host racing the TUI for answers; the disposer removes it. */
	addDialogHost(host: RemoteDialogHost): () => void;
	/** Topic name used when the session has no name yet. */
	fallbackTopicName: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Turn conveyor and dialogs (slice D)
// ═══════════════════════════════════════════════════════════════════════════

/** What the conveyor needs from a session; `AgentSession` satisfies it. */
export interface TurnEventSource {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	getContextUsage(): { percent: number } | undefined;
}

export interface TurnConveyorDeps {
	source: TurnEventSource;
	api: TelegramApi;
	delivery: TelegramDelivery;
	chatId: TelegramChatId;
	threadId: number;
	clock?: Clock;
	/** Attached TUI session: relay prompts typed in the terminal as quotes. */
	echoLocalPrompts?: boolean;
	/** Fired on `agent_start` of a turn. */
	onTurnStart?(): void;
	/** Fired after a terminal `agent_end` (or an undispatched prompt) has settled. */
	onTurnEnd?(): void;
}

/**
 * Renders one topic's turns: reactions on the human messages, ⚡ topic icon,
 * streamed answer with thinking, tool-step card with a stop button, retry and
 * compaction notices. Subscribes to the source on creation.
 */
export interface TurnConveyor {
	/** A Telegram message the current or next turn answers. */
	seen(messageId: number): void;
	/** A message queued behind the running turn (👀). */
	queued(messageId: number): Promise<void>;
	/** Stop requested: the turn settles as stopped (🫡) instead of done. */
	halt(): Promise<void>;
	/** The turn died (dispatch threw, session failed): card finishes as failed, 💔. */
	fail(reason: string): Promise<void>;
	/** The prompt was handled without invoking the agent (`prompt()` → false): settle without a turn. */
	settleUndispatched(): Promise<void>;
	/** True while a turn is being rendered. */
	active(): boolean;
	/** Unsubscribes; a live turn finishes as stopped. Idempotent. */
	dispose(): Promise<void>;
}

export interface DialogDeskDeps {
	api: TelegramApi;
	delivery: TelegramDelivery;
	chatId: TelegramChatId;
	clock?: Clock;
}

/** Pending Telegram dialogs of every topic: keyboards, text replies, ask flows. */
export interface DialogDesk {
	/** Full `ExtensionUIContext` for a topic session this host owns (select/confirm/input/editor/askDialog). */
	uiContextFor(threadId: number): ExtensionUIContext;
	/** Dialog host for the attached TUI session; `threadId()` null means no topic → requests return null. */
	remoteDialogHostFor(threadId: () => number | null): RemoteDialogHost;
	/** Consumes a keyboard press; false when the callback is not a dialog's (e.g. the stop button). */
	handleCallback(query: TelegramCallbackQuery): Promise<boolean>;
	/** Consumes free text that answers a pending text dialog in `threadId`. */
	answerText(threadId: number, text: string): Promise<boolean>;
	/** Topic closed or its session stopped: pending dialogs resolve as cancelled/unavailable. */
	dropTopic(threadId: number): void;
	/** Host stopping: every pending dialog resolves as cancelled/unavailable. */
	shutdown(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Mirrors (slice F)
// ═══════════════════════════════════════════════════════════════════════════

export interface MirrorDeps {
	chatId: TelegramChatId;
	registry: TopicRegistry;
	topics: TelegramTopics;
	livePresence: LivePresenceSource;
	/** True when this host runs the entry's session in-process (owned or attached). */
	isHeldHere(entry: TopicEntry): boolean;
	clock?: Clock;
	/** Repeating timer; the disposer cancels it. Defaults to setInterval. */
	every?(ms: number, tick: () => Promise<void>): () => void;
}

/** Read-only topics for interactive sessions live in other omp processes. */
export interface MirrorService {
	/** First scan now, then scan every 60 s and tail every 3 s. */
	start(): Promise<void>;
	stop(): void;
	scan(): Promise<void>;
	tail(): Promise<void>;
	/** Text in a mirror topic: `/close` ends correspondence, `/rename` renames the topic, anything else is refused. */
	handle(entry: TopicEntry, text: string): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Host (slice C) and its configuration (slice E)
// ═══════════════════════════════════════════════════════════════════════════

/** Validated bridge configuration built from `telegram.*` settings. */
export interface TelegramBridgeConfig {
	/** Never logged or printed. */
	token: string;
	/** Numeric prefix of the token; keys the state directory and the host lock. */
	botId: string;
	chatId: TelegramChatId;
	allowedUserIds: readonly number[];
	/** Absolute directory for `/new` without a directory. */
	defaultCwd: string;
	/** Model selector for new topic sessions; null → settings default. */
	model: string | null;
}

export interface TelegramHostOptions {
	config: TelegramBridgeConfig;
	api: TelegramApi;
	sessionFactory: TelegramSessionFactory;
	/** `<getTelegramDir()>/<botId>`: registry.json and inbox/. Created on demand. */
	stateDir: string;
	clock?: Clock;
}

export type TelegramHostState = "starting" | "running" | "stopping" | "stopped" | "failed";

export interface TelegramHostStatus {
	state: TelegramHostState;
	/** Bot username without the leading `@`, once `getMe` answered. */
	botUsername: string | null;
	/** Registry entries that are not closed. */
	topics: number;
	/** Topic sessions running in this process (owned, not the attached one). */
	liveSessions: number;
	mirrors: number;
	/** Topic of the attached TUI session, when attached. */
	attachedThreadId: number | null;
	/** Why the host failed, when it did. */
	error: string | null;
}

/** The bridge for one bot token in this process. */
export interface TelegramHost {
	/** Polls until {@link stop}; rejects on a fatal startup refusal (bad token, another poller: 409). */
	run(): Promise<void>;
	/** Stops polling and mirrors, stops owned sessions (registry status → idle), detaches. Idempotent. */
	stop(): Promise<void>;
	/** Relays `binding.session` two-way in the topic registered for its session file (created when missing). */
	attach(binding: AttachedSessionBinding): Promise<void>;
	/** Ends the attached relay; the TUI session is untouched. */
	detach(): Promise<void>;
	status(): TelegramHostStatus;
	onStatusChange(listener: (status: TelegramHostStatus) => void): () => void;
}
