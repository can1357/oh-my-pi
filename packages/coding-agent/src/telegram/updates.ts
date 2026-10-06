/**
 * Update routing: the security gate (chat id + allowed users), then
 * message/callback/stopped-generation dispatch. Denials are logged and never
 * answered — an unpaired chat must not learn that the bot is listening.
 */
import { parseCommand, type ParsedCommand } from "./commands";
import type { TelegramBridgeContext } from "./context";
import { inTopic } from "./in-topic";
import type { TopicSessionRuntime } from "./topic-session";
import { TURN_STOP_CALLBACK } from "./turn-card";
import type {
	TelegramApi,
	TelegramBridgeConfig,
	TelegramCallbackQuery,
	TelegramMessage,
	TelegramUpdate,
	TopicEntry,
} from "./types";

/** Commands that never raise a session on their own. */
const NO_PROCESS_COMMANDS = new Set(["close", "help", "new", "rename", "resume", "sessions", "status", "stop"]);

export interface UpdatesDeps {
	ctx: TelegramBridgeContext;
	config: TelegramBridgeConfig;
	api: TelegramApi;
	log(event: string, fields?: Record<string, unknown>): void;
}

export interface TelegramUpdateRouter {
	handleUpdate(update: TelegramUpdate): Promise<string>;
}

export function createUpdates(deps: UpdatesDeps): TelegramUpdateRouter {
	const { ctx, config, api, log } = deps;

	const permitted = (from: TelegramMessage["from"], chat: TelegramMessage["chat"] | undefined): boolean => {
		if (String(chat?.id ?? "") !== String(config.chatId)) return false;
		const id = Number(from?.id);
		if (!Number.isFinite(id)) return false;
		return config.allowedUserIds.map(Number).includes(id);
	};

	/**
	 * A forum group delivers every message to every bot, so `/close@otherbot`
	 * is that bot's command: only dispatch a suffixed command when the suffix
	 * is known to name this bot (an unknown own username means "not ours").
	 */
	const addressedToOtherBot = (command: ParsedCommand): boolean => {
		const addressee = command.addressee;
		if (addressee === null) return false;
		const me = ctx.botUsername();
		return me === null || me.toLowerCase() !== addressee.toLowerCase();
	};

	const runtimeFor = async (
		entry: TopicEntry,
		command: { name: string } | null,
	): Promise<{ ok: true; runtime: TopicSessionRuntime | null } | { ok: false; reason: string }> => {
		const running = ctx.desk.get(entry.threadId);
		if (running !== null && running.alive()) return { ok: true, runtime: running };
		// Commands that work without a session must not raise one just to answer.
		if (command !== null && NO_PROCESS_COMMANDS.has(command.name)) return { ok: true, runtime: running };
		return ctx.launch.start(entry);
	};

	const handleMessage = async (message: TelegramMessage): Promise<string> => {
		const from = message.from;
		const chat = message.chat;
		const threadId = typeof message.message_thread_id === "number" ? message.message_thread_id : null;
		if (!permitted(from, chat)) {
			log("update.denied", { kind: "message", userId: from?.id ?? null, chatId: chat?.id ?? null, threadId });
			return "denied";
		}
		const edited = message.forum_topic_edited;
		if (threadId !== null && edited !== undefined && edited !== null) {
			const name = String(edited.name ?? "").trim();
			if (name !== "") {
				if (ctx.registry.get(threadId) === null) await ctx.adopt.renamed(threadId, name);
				else await ctx.workspace.renameTopic(threadId, name);
			}
			return "topic_renamed";
		}
		const text = String(message.text ?? message.caption ?? "");
		const command = parseCommand(text);
		if (command !== null && addressedToOtherBot(command)) {
			log("update.other_bot", { command: command.name, addressee: command.addressee, threadId });
			return "other_bot";
		}
		if (threadId === null) return ctx.workspace.handle({ message, text });
		const entry = ctx.registry.get(threadId);
		if (entry === null) return ctx.adopt.handle({ message, text, threadId });
		if (entry.mirror === true) return ctx.mirror.handle(entry, text);
		if (command === null && text.trim() !== "" && (await ctx.dialogDesk.answerText(threadId, text)))
			return "ui_answer";
		const opened = await runtimeFor(entry, command);
		if (!opened.ok) return opened.reason;
		return inTopic({ ctx, runtime: opened.runtime, entry, message, text });
	};

	const abortTurn = async (threadId: number | null): Promise<boolean> => {
		const runtime = threadId === null ? null : ctx.desk.get(threadId);
		if (runtime === null) return false;
		await runtime.abort();
		return true;
	};

	const handleStopped = async (stopped: TelegramUpdate["stopped_message_generation"]): Promise<string> => {
		const chat = stopped?.chat;
		const threadId = typeof stopped?.message_thread_id === "number" ? stopped.message_thread_id : null;
		if (String(chat?.id ?? "") !== String(config.chatId)) {
			log("update.denied", { kind: "stopped", chatId: chat?.id ?? null, threadId });
			return "denied";
		}
		await abortTurn(threadId);
		return "stopped";
	};

	const handleCallback = async (query: TelegramCallbackQuery): Promise<string> => {
		const from = query.from;
		const chat = query.message?.chat;
		if (!permitted(from, chat)) {
			log("update.denied", {
				kind: "callback",
				userId: from?.id ?? null,
				chatId: chat?.id ?? null,
				threadId: query.message?.message_thread_id ?? null,
			});
			return "denied";
		}
		if (String(query.data ?? "") !== TURN_STOP_CALLBACK) {
			const consumed = await ctx.dialogDesk.handleCallback(query);
			if (!consumed) {
				try {
					await api.answerCallbackQuery({ id: query.id, text: "This question is already closed" });
				} catch (error) {
					log("answering a stale callback failed", { error: String(error) });
				}
				return "stale_callback";
			}
			return "callback";
		}
		const answered = await abortTurn(query.message?.message_thread_id ?? null);
		try {
			await api.answerCallbackQuery({ id: query.id, text: answered ? "Stopping" : "No turn running" });
		} catch (error) {
			log("answering the stop button failed", { error: String(error) });
		}
		return "stopped";
	};

	const handleUpdate = async (update: TelegramUpdate): Promise<string> => {
		try {
			if (update?.message !== undefined && update.message !== null) return await handleMessage(update.message);
			if (update?.callback_query !== undefined && update.callback_query !== null) {
				return await handleCallback(update.callback_query);
			}
			if (update?.stopped_message_generation !== undefined && update.stopped_message_generation !== null) {
				return await handleStopped(update.stopped_message_generation);
			}
			log("update.skipped", { kinds: Object.keys(update ?? {}).join(",") });
			return "skipped";
		} catch (error) {
			// One malformed update must never end the poll loop.
			log("update.failed", { error: error instanceof Error ? error.message : String(error) });
			return "error";
		}
	};

	return { handleUpdate };
}
