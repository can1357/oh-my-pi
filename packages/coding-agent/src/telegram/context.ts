/**
 * Composition context shared by the session-host modules. `host.ts` builds it
 * once per bot and hands the same object to the registry-backed workspace,
 * adoption, launcher, desk and update router, which are mutually recursive:
 * `/new` places a topic through the launcher, the launcher raises a session
 * through the desk, and the desk's lazy raise goes back through the launcher.
 */
import type { SessionPresence } from "../session/session-presence";
import type { TelegramAdopt } from "./adopt";
import type { TopicLauncher, TopicSessionDesk } from "./desk";
import type { LivenessDeps } from "./liveness";
import type { TopicSessionRuntime } from "./topic-session";
import type { TelegramWorkspace } from "./workspace";
import type {
	Clock,
	DialogDesk,
	MirrorService,
	TelegramApi,
	TelegramBridgeConfig,
	TelegramTopics,
	TopicRegistry,
} from "./types";

/** Everything the host wires together for one bot, plus the cross-module hooks. */
export interface TelegramBridgeContext {
	config: TelegramBridgeConfig;
	api: TelegramApi;
	topics: TelegramTopics;
	registry: TopicRegistry;
	dialogDesk: DialogDesk;
	clock: Clock;
	home: string;
	/** Username of the bot this host runs as, learned from `getMe`; null before the host starts. */
	botUsername(): string | null;

	log(event: string, fields?: Record<string, unknown>): void;
	notify(threadId: number | null, markdown: string): Promise<boolean>;
	existsDir(dir: string): boolean;
	writeInbox(input: { threadId: number; name: string; data: Uint8Array }): Promise<string>;
	/** Live sessions of *other* omp processes; rejects when presence is unreadable. */
	livePresence(): Promise<SessionPresence[]>;
	/** `/resume` lookup across every session root. */
	findSessions(part: string): Promise<string[]>;
	/** Working directory recorded in a session file's header. */
	sessionCwd(file: string): Promise<string | null>;
	/** Presence-backed second-writer gate shared by the desk, `/resume` and the launcher. */
	liveness: LivenessDeps;

	// Filled in by `createTelegramHost` after construction (mutual recursion).
	desk: TopicSessionDesk;
	launch: TopicLauncher;
	workspace: TelegramWorkspace;
	adopt: TelegramAdopt;
	mirror: MirrorService;
	/** Attached runtime for a session file; `null` when this host relays no such file. */
	attachedRuntimeFor(sessionFile: string): TopicSessionRuntime | null;
}
