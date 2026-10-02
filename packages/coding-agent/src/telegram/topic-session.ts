/**
 * One topic's live session, behind one interface for the two kinds the bridge
 * drives:
 *
 * - **owned** — created through {@link TelegramSessionFactory} and disposed by
 *   the host;
 * - **attached** — the interactive TUI session of the hosting process, relayed
 *   two-way and never disposed here.
 *
 * Dispatching a Telegram message never awaits a whole turn: `prompt()` and
 * `promptCustomMessage()` return once the input is accepted or queued, and the
 * conveyor renders the turn from session events.
 */
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import type { AgentSession } from "../session/agent-session";
import { TELEGRAM_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL, type TelegramPromptDetails } from "../session/messages";
import { mdText } from "./rich";
import type { TelegramStatusState } from "./status";
import { createTurnConveyor } from "./turn-conveyor";
import type {
	AttachedSessionBinding,
	Clock,
	DialogDesk,
	TelegramApi,
	TelegramChatId,
	TelegramDelivery,
	TelegramSessionFactory,
	TelegramTopics,
	TopicEntry,
	TopicRegistry,
	TopicStatus,
	TurnConveyor,
} from "./types";

export interface TopicSessionDeps {
	api: TelegramApi;
	delivery: TelegramDelivery;
	chatId: TelegramChatId;
	clock: Clock;
	/** `telegram.model` selector for new sessions; null → settings default. */
	model: string | null;
	registry: TopicRegistry;
	topics: TelegramTopics;
	dialogDesk: DialogDesk;
	sessionFactory: TelegramSessionFactory;
	log(event: string, fields?: Record<string, unknown>): void;
	notify(threadId: number | null, markdown: string): Promise<boolean>;
	setStatus(threadId: number, status: TopicStatus): void;
}

export interface TopicSayPayload {
	text: string;
	images?: ImageContent[];
	messageId: number;
	/** Telegram sender display name, used for the attached relay's attribution. */
	from: string;
}

export interface TopicSessionRuntime {
	readonly threadId: number;
	readonly attached: boolean;
	alive(): boolean;
	busy(): boolean;
	say(payload: TopicSayPayload): Promise<void>;
	steer(text: string, from: string): Promise<void>;
	abort(): Promise<void>;
	state(): TelegramStatusState;
	sessionFile(): string | null;
	sessionId(): string | null;
	rename(name: string): Promise<void>;
	setModel(selector: string): Promise<void>;
	setThinking(level: string): Promise<void>;
	compact(): Promise<void>;
	/** `/close`: owned disposes the session, attached ends this relay. */
	close(): Promise<void>;
	/** Host shutdown: stop without marking the topic closed. */
	stop(): Promise<void>;
	/** Attached only: start relaying again after {@link close}. */
	reopen(): Promise<void>;
	/** Attached only: end the relay for good. */
	dispose(): Promise<void>;
}

function statusOf(session: AgentSession): TelegramStatusState {
	return {
		model: session.model === undefined ? null : { provider: session.model.provider, id: session.model.id },
		thinkingLevel: session.thinkingLevel ?? null,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		queuedMessageCount: session.queuedMessageCount,
		contextUsage: session.getContextUsage() ?? null,
		todoPhases: session.getTodoPhases(),
		sessionName: session.sessionName ?? null,
	};
}

/** A Telegram prompt relayed into the attached TUI session as the sender's own words. */
function relayPrompt(
	session: AgentSession,
	input: { from: string; text: string; images?: ImageContent[] },
	streamingBehavior: "followUp" | "steer",
): Promise<boolean> {
	const images = input.images;
	const content: string | (TextContent | ImageContent)[] =
		images !== undefined && images.length > 0 ? [{ type: "text", text: input.text }, ...images] : input.text;
	return session.promptCustomMessage(
		{
			customType: TELEGRAM_PROMPT_MESSAGE_TYPE,
			content,
			display: true,
			details: { from: input.from } satisfies TelegramPromptDetails,
			attribution: "user",
		},
		{ streamingBehavior, queueChipText: input.text },
	);
}

/**
 * Starts a dispatch without awaiting it: a prompt that starts a turn resolves
 * only when that turn ends, and the poll loop must keep serving updates (the
 * stop button, dialog answers) meanwhile. Failures reach the conveyor and the
 * topic instead of the caller.
 */
function dispatchInBackground(
	deps: Pick<TopicSessionDeps, "notify" | "log">,
	threadId: number,
	conveyor: TurnConveyor | null,
	dispatch: () => Promise<boolean>,
): void {
	dispatch()
		.then(
			async dispatched => {
				if (dispatched === false) await conveyor?.settleUndispatched();
			},
			async (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				await conveyor?.fail(message);
				await deps.notify(threadId, `⚠️ Passing the message failed: ${mdText(message)}`);
			},
		)
		.catch((error: unknown) => deps.log("dispatch report failed", { threadId, error: String(error) }));
}

/**
 * Attached relay for the hosting process's interactive session. The session
 * itself is never disposed; `close()` only stops relaying into its topic.
 */
export function createAttachedTopicSession(
	deps: TopicSessionDeps,
	entry: TopicEntry,
	binding: AttachedSessionBinding,
): TopicSessionRuntime {
	const session = binding.session;
	let relaying = false;
	let disposed = false;
	let conveyor: TurnConveyor | null = null;

	const connect = (): void => {
		conveyor = createTurnConveyor({
			source: session,
			api: deps.api,
			delivery: deps.delivery,
			chatId: deps.chatId,
			threadId: entry.threadId,
			clock: deps.clock,
			echoLocalPrompts: true,
			onTurnStart: () => deps.setStatus(entry.threadId, "running"),
			onTurnEnd: () => {
				if (relaying) deps.setStatus(entry.threadId, "idle");
			},
		});
	};

	const endRelay = async (): Promise<void> => {
		if (!relaying && conveyor === null) return;
		relaying = false;
		const current = conveyor;
		conveyor = null;
		if (current !== null) await current.dispose();
		deps.dialogDesk.dropTopic(entry.threadId);
	};

	const runtime: TopicSessionRuntime = {
		threadId: entry.threadId,
		attached: true,
		alive: () => relaying && !disposed,
		busy: () => conveyor?.active() ?? false,
		say: async payload => {
			const active = conveyor;
			if (!relaying || active === null) throw new Error("the relay for this topic is closed");
			// Register the message first: a queued one must end on the turn's final
			// reaction (👌/🫡), not just keep the eyes it was painted with.
			active.seen(payload.messageId);
			if (active.active()) await active.queued(payload.messageId);
			dispatchInBackground(deps, entry.threadId, active, () => relayPrompt(session, payload, "followUp"));
		},
		steer: async (text, from) => {
			if (!relaying) throw new Error("the relay for this topic is closed");
			dispatchInBackground(deps, entry.threadId, conveyor, () => relayPrompt(session, { from, text }, "steer"));
		},
		abort: async () => {
			const active = conveyor;
			if (active === null) return;
			await active.halt();
			await session.abort({ reason: USER_INTERRUPT_LABEL });
		},
		state: () => statusOf(session),
		sessionFile: () => session.sessionFile ?? null,
		sessionId: () => session.sessionId,
		rename: async name => {
			await session.setSessionName(name, "user");
		},
		setModel: async selector => {
			const model = resolveModelFromString(
				selector,
				session.modelRegistry.getAvailable(),
				getModelMatchPreferences(session.settings),
			);
			if (model === undefined) throw new Error(`No model matches "${selector}"`);
			await session.setModel(model, "default", { selector });
		},
		setThinking: async level => {
			const parsed = parseConfiguredThinkingLevel(level);
			if (parsed === undefined) throw new Error(`Unknown thinking level "${level}"`);
			session.setThinkingLevel(parsed);
		},
		compact: async () => {
			await session.compact();
		},
		close: async () => {
			await endRelay();
			deps.setStatus(entry.threadId, "closed");
			deps.log("attached relay closed", { threadId: entry.threadId });
		},
		stop: async () => {
			await endRelay();
		},
		reopen: async () => {
			if (disposed || relaying) return;
			relaying = true;
			connect();
			deps.setStatus(entry.threadId, "idle");
		},
		dispose: async () => {
			await endRelay();
			disposed = true;
		},
	};
	relaying = true;
	connect();
	return runtime;
}

/** Owned topic session: created here, disposed here. */
export async function createOwnedTopicSession(deps: TopicSessionDeps, entry: TopicEntry): Promise<TopicSessionRuntime> {
	const handle = await deps.sessionFactory({
		cwd: entry.cwd,
		sessionFile: entry.sessionFile ?? undefined,
		model: deps.model ?? undefined,
	});
	const session = handle.session;
	const uiContext = deps.dialogDesk.uiContextFor(entry.threadId);
	handle.setToolUIContext(uiContext, true);
	session.setUsageFallbackConfirmer((confirmation, signal) => {
		const reserve =
			confirmation.remainingPercent === undefined
				? "inside the configured reserve margin"
				: `${confirmation.remainingPercent.toFixed(1)}% remaining`;
		return uiContext.confirm(
			"Coding-plan reserve reached",
			`${confirmation.from} has ${reserve}. Switch to ${confirmation.to}? Choose No to keep using the current plan.`,
			{ signal },
		);
	});

	let stopped = false;
	let conveyor: TurnConveyor | null = createTurnConveyor({
		source: session,
		api: deps.api,
		delivery: deps.delivery,
		chatId: deps.chatId,
		threadId: entry.threadId,
		clock: deps.clock,
		onTurnStart: () => deps.setStatus(entry.threadId, "running"),
		onTurnEnd: () => {
			if (!stopped) deps.setStatus(entry.threadId, "idle");
		},
	});

	const teardown = async (status: TopicStatus): Promise<void> => {
		if (stopped) return;
		stopped = true;
		const active = conveyor;
		conveyor = null;
		if (active !== null) await active.dispose();
		deps.dialogDesk.dropTopic(entry.threadId);
		await session.dispose();
		deps.setStatus(entry.threadId, status);
		deps.log("owned session stopped", { threadId: entry.threadId, status });
	};

	return {
		threadId: entry.threadId,
		attached: false,
		alive: () => !stopped,
		busy: () => conveyor?.active() ?? false,
		say: async payload => {
			const active = conveyor;
			if (stopped || active === null) throw new Error("the session for this topic is not running");
			// Register the message first: a queued one must end on the turn's final
			// reaction (👌/🫡), not just keep the eyes it was painted with.
			active.seen(payload.messageId);
			if (active.active()) await active.queued(payload.messageId);
			const images = payload.images;
			dispatchInBackground(deps, entry.threadId, active, () =>
				session.prompt(payload.text, {
					streamingBehavior: "followUp",
					...(images !== undefined && images.length > 0 ? { images } : {}),
				}),
			);
		},
		steer: async text => {
			if (stopped) throw new Error("the session for this topic is not running");
			dispatchInBackground(deps, entry.threadId, conveyor, async () => {
				await session.steer(text);
				return true;
			});
		},
		abort: async () => {
			const active = conveyor;
			if (active === null) return;
			await active.halt();
			await session.abort({ reason: USER_INTERRUPT_LABEL });
		},
		state: () => statusOf(session),
		sessionFile: () => session.sessionFile ?? null,
		sessionId: () => session.sessionId,
		rename: async name => {
			await session.setSessionName(name, "user");
		},
		setModel: async selector => {
			const model = resolveModelFromString(
				selector,
				session.modelRegistry.getAvailable(),
				getModelMatchPreferences(session.settings),
			);
			if (model === undefined) throw new Error(`No model matches "${selector}"`);
			await session.setModel(model, "default", { selector });
		},
		setThinking: async level => {
			const parsed = parseConfiguredThinkingLevel(level);
			if (parsed === undefined) throw new Error(`Unknown thinking level "${level}"`);
			session.setThinkingLevel(parsed);
		},
		compact: async () => {
			await session.compact();
		},
		close: async () => {
			await teardown("closed");
		},
		stop: async () => {
			await teardown("idle");
		},
		reopen: async () => {},
		dispose: async () => {
			await teardown("idle");
		},
	};
}
