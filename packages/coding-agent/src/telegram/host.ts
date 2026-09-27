/**
 * The bridge for one bot token, composed of the transport (delivery, topics,
 * poller), the turn conveyor/dialog desk, the mirror scanner and the session
 * host modules. It lives inside an omp process: `run()` polls until `stop()`,
 * topic sessions run in-process through {@link TelegramSessionFactory}, and the
 * interactive session of the hosting process can be relayed two-way with
 * `attach()`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { findSessionHolder, listLiveSessionPresence, type SessionPresence } from "../session/session-presence";
import { BOT_COMMANDS } from "./commands";
import type { TelegramBridgeContext } from "./context";
import { createDelivery } from "./deliver";
import { createSessionDesk, createTopicLauncher, type TopicSessionDesk } from "./desk";
import { createDialogDesk } from "./dialog-desk";
import type { PresenceSource } from "./liveness";
import { writeInboxFile } from "./inbox";
import { createMirror } from "./mirror";
import { createPoller } from "./poll";
import { openTopicRegistry } from "./registry";
import { createTopics } from "./topics";
import { createAttachedTopicSession, type TopicSessionRuntime } from "./topic-session";
import { createUpdates } from "./updates";
import type {
	AttachedSessionBinding,
	Clock,
	TelegramHost,
	TelegramHostOptions,
	TelegramHostState,
	TelegramHostStatus,
	TelegramUpdate,
	TopicEntry,
	TopicRegistry,
	TopicStatus,
} from "./types";
import { createWorkspace, findSessionFiles, sessionCwdOf } from "./workspace";
import { createAdopt } from "./adopt";

const defaultClock: Clock = { now: () => Date.now() };

interface AttachedState {
	binding: AttachedSessionBinding;
	runtime: TopicSessionRuntime;
	threadId: number;
	disposeDialogHost: () => void;
}

/**
 * Test seams for the launch-level dependencies a host cannot fabricate: the
 * machine's session presence, the session-file lookup behind `/resume`, the
 * filesystem probe, the home directory, the bot username `getMe` would report
 * and the registry the host opened. Production passes nothing.
 */
export interface TelegramHostSeams {
	presence?: Partial<PresenceSource>;
	findSessions?: (part: string) => Promise<string[]>;
	sessionCwd?: (file: string) => Promise<string | null>;
	existsDir?: (dir: string) => boolean;
	home?: string;
	/** Bot username `getMe` would report; `run()` overwrites it with the real one. */
	botUsername?: string | null;
	/** Receives the registry the host opened, for tests that read its live view. */
	onRegistry?: (registry: TopicRegistry) => void;
}

/**
 * The host plus the update entry point its poller feeds. Kept in the same
 * factory so routing tests exercise the exact wiring `run()` uses.
 */
export interface TelegramBridgeHost extends TelegramHost {
	handleUpdate(update: TelegramUpdate): Promise<string>;
}

export function createTelegramHost(options: TelegramHostOptions & { seams?: TelegramHostSeams }): TelegramBridgeHost {
	const clock = options.clock ?? defaultClock;
	const { config, api } = options;
	const delivery = createDelivery({ api });
	const topics = createTopics({ api, delivery, chatId: config.chatId });
	const registry = openTopicRegistry({ path: path.join(options.stateDir, "registry.json"), clock });
	options.seams?.onRegistry?.(registry);
	const dialogDesk = createDialogDesk({ api, delivery, chatId: config.chatId, clock });

	let attached: AttachedState | null = null;
	let state: TelegramHostState = "stopped";
	let botUsername: string | null = options.seams?.botUsername ?? null;
	let failure: string | null = null;
	let stopPromise: Promise<void> | null = null;
	const listeners = new Set<(status: TelegramHostStatus) => void>();

	const log = (event: string, fields?: Record<string, unknown>): void => {
		logger.debug(`telegram: ${event}`, fields);
	};

	const notify = (threadId: number | null, markdown: string): Promise<boolean> => topics.notify(threadId, markdown);

	const setStatus = (threadId: number, status: TopicStatus): void => {
		try {
			registry.update(threadId, { status });
		} catch (error) {
			log("could not update the registry status", { threadId, status, error: String(error) });
		}
	};

	const seams = options.seams;
	const presence: PresenceSource = {
		list: seams?.presence?.list ?? (() => listLiveSessionPresence()),
		findHolder:
			seams?.presence?.findHolder ?? (sessionFile => findSessionHolder(sessionFile, { exceptPid: process.pid })),
	};

	// The attached relay is held here (not in the desk alone) because the relay
	// survives `/close` and can be revived by the next message in its topic.
	const attachedRuntimeFor = (sessionFile: string): TopicSessionRuntime | null =>
		attached !== null && attached.binding.session.sessionFile === sessionFile ? attached.runtime : null;
	const isHeldHere = (sessionFile: string): boolean => {
		if (attached !== null && attached.binding.session.sessionFile === sessionFile) return true;
		return desk.sessions().some(runtime => runtime.alive() && runtime.sessionFile() === sessionFile);
	};

	/**
	 * A topic session of our own is tracked by the desk; the hosting TUI session
	 * is not, so it is recognised through its own presence record (kind
	 * `interactive`). That keeps the file protected between `detach()` and the
	 * next `attach()` — the window where the desk alone would see nothing.
	 */
	const isHeldLocally = async (sessionFile: string): Promise<boolean> => {
		if (isHeldHere(sessionFile)) return true;
		const resolved = path.resolve(sessionFile);
		const own = await presence.list();
		return own.some(
			session =>
				session.pid === process.pid &&
				session.kind === "interactive" &&
				path.resolve(session.sessionFile) === resolved,
		);
	};

	const livePresence = async (): Promise<SessionPresence[]> => {
		const sessions = await presence.list();
		return sessions.filter(session => session.pid !== process.pid);
	};

	const existsDir =
		seams?.existsDir ??
		((dir: string): boolean => {
			try {
				return fs.statSync(dir).isDirectory();
			} catch {
				return false;
			}
		});

	const ctx: TelegramBridgeContext = {
		config,
		api,
		topics,
		registry,
		dialogDesk,
		clock,
		home: seams?.home ?? os.homedir(),
		botUsername: () => botUsername,
		log,
		notify,
		existsDir,
		writeInbox: input => writeInboxFile({ stateDir: options.stateDir, ...input }),
		livePresence,
		findSessions: seams?.findSessions ?? (part => findSessionFiles(part)),
		sessionCwd: seams?.sessionCwd ?? (file => sessionCwdOf(file)),
		liveness: {
			livePresence,
			findHolder: sessionFile => presence.findHolder(sessionFile),
			isHeldLocally,
			notify,
		},
		// Wired below: the modules are mutually recursive, so the holder is filled in
		// after each constructor has the (so far incomplete) context object.
		desk: null as unknown as TopicSessionDesk,
		launch: null as unknown as TelegramBridgeContext["launch"],
		workspace: null as unknown as TelegramBridgeContext["workspace"],
		adopt: null as unknown as TelegramBridgeContext["adopt"],
		mirror: null as unknown as TelegramBridgeContext["mirror"],
		attachedRuntimeFor,
	};

	const deskDeps = {
		api,
		delivery,
		chatId: config.chatId,
		clock,
		model: config.model,
		registry,
		topics,
		dialogDesk,
		sessionFactory: options.sessionFactory,
		log,
		notify,
		setStatus,
		liveness: ctx.liveness,
		attachedRuntimeFor,
	};
	const desk = createSessionDesk(deskDeps);
	ctx.desk = desk;
	ctx.launch = createTopicLauncher({ ...deskDeps, desk });
	ctx.workspace = createWorkspace(ctx);
	ctx.adopt = createAdopt(ctx);
	ctx.mirror = createMirror({
		chatId: config.chatId,
		registry,
		topics,
		livePresence,
		isHeldHere: (entry: TopicEntry) => {
			const file = entry.sessionFile;
			return file !== null && isHeldHere(file);
		},
		clock,
	});

	const updates = createUpdates({ ctx, config, api, log });
	const poller = createPoller({
		api,
		handleUpdate: update => updates.handleUpdate(update),
		commands: BOT_COMMANDS,
	});

	const status = (): TelegramHostStatus => {
		const sessions = desk.sessions();
		const entries = registry.list();
		return {
			state,
			botUsername,
			topics: entries.filter(entry => entry.status !== "closed").length,
			liveSessions: sessions.filter(runtime => !runtime.attached && runtime.alive()).length,
			mirrors: entries.filter(entry => entry.status === "mirror").length,
			attachedThreadId: attached?.threadId ?? null,
			error: failure,
		};
	};

	const emit = (): void => {
		const snapshot = status();
		for (const listener of Array.from(listeners)) {
			try {
				listener(snapshot);
			} catch (error) {
				log("status listener failed", { error: String(error) });
			}
		}
	};

	const detach = async (): Promise<void> => {
		const current = attached;
		attached = null;
		if (current === null) return;
		current.disposeDialogHost();
		desk.unregister(current.threadId);
		await current.runtime.dispose();
		const entry = registry.get(current.threadId);
		if (entry !== null && entry.status !== "closed") registry.update(current.threadId, { status: "idle" });
		log("attached relay detached", { threadId: current.threadId });
		emit();
	};

	const attach = async (binding: AttachedSessionBinding): Promise<void> => {
		const sessionFile = binding.session.sessionFile ?? null;
		if (sessionFile === null) {
			throw new Error("The session has no session file yet — there is nothing to relay to Telegram.");
		}
		if (attached !== null) {
			if (attached.binding.session === binding.session) return;
			await detach();
		}
		// An owned runtime for the same file would be a second writer: the
		// attached session supersedes it.
		await desk.stopForFile(sessionFile);
		const cwd = binding.session.sessionManager.getCwd();
		const existing = registry.bySessionFile(sessionFile);
		let entry: TopicEntry;
		if (existing === null) {
			const name = registry.freeName(binding.session.sessionName ?? binding.fallbackTopicName);
			const threadId = await topics.create(name);
			if (threadId === null) throw new Error("Telegram created a topic without a thread id.");
			entry = registry.put({
				threadId,
				name,
				cwd,
				sessionFile,
				sessionId: binding.session.sessionId,
				status: "idle",
			});
		} else {
			entry = existing;
			if (existing.status === "closed") await topics.reopen(existing.threadId, existing.name);
			entry = registry.update(existing.threadId, {
				status: "idle",
				mirror: false,
				sessionFile,
				sessionId: binding.session.sessionId,
				cwd,
			});
		}
		const runtime = createAttachedTopicSession(deskDeps, entry, binding);
		// The thread getter answers null once the relay is not alive: `/close`
		// ends it without clearing `attached`, and a TUI dialog must not be
		// routed into a topic the host no longer relays. `reopen()` restores it.
		const disposeDialogHost = binding.addDialogHost(
			dialogDesk.remoteDialogHostFor(() =>
				attached !== null && attached.runtime.alive() ? attached.threadId : null,
			),
		);
		desk.register(entry.threadId, runtime);
		attached = { binding, runtime, threadId: entry.threadId, disposeDialogHost };
		log("attached relay registered", { threadId: entry.threadId, sessionFile });
		emit();
	};

	const run = async (): Promise<void> => {
		if (state === "running" || state === "starting") return;
		state = "starting";
		failure = null;
		emit();
		try {
			const me = await api.getMe();
			botUsername = me.username || null;
			state = "running";
			emit();
			await ctx.mirror.start();
			await poller.run();
			state = "stopped";
			emit();
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
			state = "failed";
			emit();
			throw error;
		} finally {
			ctx.mirror.stop();
		}
	};

	const doStop = async (): Promise<void> => {
		state = "stopping";
		emit();
		poller.stop();
		ctx.mirror.stop();
		dialogDesk.shutdown();
		await detach();
		await desk.shutdown();
		// The last statuses/mirror offsets are still in the queued writes.
		await registry.flush();
		state = "stopped";
		emit();
	};

	return {
		run,
		stop: () => {
			stopPromise ??= doStop();
			return stopPromise;
		},
		attach,
		detach,
		status,
		onStatusChange: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		handleUpdate: update => updates.handleUpdate(update),
	};
}
