/**
 * Worker-side handle for an agent session homed on another thread (the main
 * thread or a sibling worker).
 *
 * One canonical instance per instance key (see `./session-directory`), built
 * by the `"agent-session"` codec. Every synchronous member is a `callSync` to
 * the main thread's bridge, which answers from its local session or its
 * `RemoteAgentSession` mirror; commands go to main asynchronously and main
 * routes them to the home thread. `subscribe`/`subscribeRunState` keep one
 * main-side forwarding subscription each, shared by every local listener.
 */
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { EffectiveExtensionRoots } from "../capability/types";
import type {
	AgentSessionAdvisorOverview,
	AgentSessionHandle,
	AgentSessionLoopHandle,
	AgentSessionManagerHandle,
} from "../session/agent-session-handle";
import type { AgentSessionEvent, AgentSessionEventListener } from "../session/agent-session-events";
import type {
	AgentSessionDisposeOptions,
	PromptOptions,
	SessionStats,
	SteerOptions,
} from "../session/agent-session-types";
import type { CustomMessage } from "../session/messages";
import type { ServingModel } from "../session/retry-fallback-chains";
import type { AgentDefinition } from "../task/types";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import type { ThreadId } from "./identity";
import { emptyMirrorState } from "./remote-agent-session";
import { findRemoteSession, rememberRemoteSession } from "./session-directory";
import type {
	PeerStateField,
	SessionAbortOptions,
	SessionBridgeClient,
	SessionMirrorState,
	SessionRunState,
} from "./session-mirror";

let bridge: SessionBridgeClient | undefined;

/** Worker boot only: the main thread's session bridge every peer handle talks through. */
export function installPeerBridge(client: SessionBridgeClient): void {
	bridge = client;
}

function mainBridge(): SessionBridgeClient {
	if (!bridge) throw new Error("Agent session bridge is not installed on this worker");
	return bridge;
}

/** Canonical worker-side handle for the session `key` homed on `home` (another thread). */
export function peerAgentSession(key: string, home: ThreadId): PeerAgentSession {
	const known = findRemoteSession(key);
	if (known instanceof PeerAgentSession) return known;
	const session = new PeerAgentSession(key, home);
	rememberRemoteSession(key, session);
	return session;
}

const DEFAULTS = emptyMirrorState();

/** {@link AgentSessionHandle} for a session homed on another thread; see the module doc. */
export class PeerAgentSession implements AgentSessionHandle {
	readonly instanceKey: string;
	/** Thread the session lives on. */
	readonly home: ThreadId;
	readonly agent: AgentSessionLoopHandle;
	readonly sessionManager: AgentSessionManagerHandle;
	readonly #listeners = new Set<AgentSessionEventListener>();
	readonly #runStateListeners = new Set<(state: SessionRunState) => void>();
	#unsubscribe: (() => void) | undefined;
	#unsubscribeRunState: (() => void) | undefined;

	/** Use {@link peerAgentSession}; direct construction breaks identity. */
	constructor(key: string, home: ThreadId) {
		this.instanceKey = key;
		this.home = home;
		const peer = this;
		const loopState = {
			get messages(): AgentMessage[] {
				return peer.messages;
			},
			get streamMessage(): AgentMessage | null {
				return peer.#field("streamMessage");
			},
			get pendingToolCalls(): Set<string> {
				return new Set(peer.#field("pendingToolCalls"));
			},
		};
		this.agent = {
			get isPaused(): boolean {
				return peer.#field("isPaused");
			},
			state: loopState,
		};
		this.sessionManager = {
			getCwd: () => this.#field("cwd"),
			getSessionId: () => this.#field("sessionId"),
			getSessionFile: () => this.#field("sessionFile"),
			getArtifactsDir: () => this.#field("artifactsDir"),
			getUsageStatistics: () => this.#field("usageStatistics"),
		};
	}

	get isStreaming(): boolean {
		return this.#field("isStreaming");
	}

	get runStartedAt(): number | undefined {
		return this.#field("runStartedAt");
	}

	get ircWakesPending(): boolean {
		return this.#field("ircWakesPending");
	}

	get messages(): AgentMessage[] {
		return mainBridge().remote.callSync("readMessages", this);
	}

	get sessionFile(): string | undefined {
		return this.#field("sessionFile");
	}

	get model(): Model | undefined {
		return this.#field("model");
	}

	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#field("thinkingLevel");
	}

	get servingModel(): ServingModel | undefined {
		return this.#field("servingModel");
	}

	get effectiveExtensionRoots(): EffectiveExtensionRoots {
		return this.#field("effectiveExtensionRoots");
	}

	get hindsightActive(): boolean {
		return this.#field("hindsightActive");
	}

	getSessionStats(): SessionStats {
		return this.#field("sessionStats");
	}

	getAdvisorStatusOverview(): AgentSessionAdvisorOverview {
		return this.#field("advisorOverview");
	}

	getSessionAgents(): AgentDefinition[] {
		return this.#field("sessionAgents");
	}

	hasQueuedIrcFrom(from: string): boolean {
		return mainBridge().remote.callSync("hasQueuedIrcFrom", this, from);
	}

	/** Only ever called on the caller's own session; a peer is never that. */
	hasIrcInterrupts(): boolean {
		throw new Error(`hasIrcInterrupts must run on the session's home thread (${this.home}), not on a peer handle`);
	}

	emitIrcRelayObservation(record: CustomMessage): void {
		mainBridge().remote.notify("emitIrcRelayObservation", this, record);
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.add(listener);
		if (!this.#unsubscribe) {
			this.#unsubscribe = mainBridge().remote.callSync("subscribe", this, event => this.#dispatch(event));
		}
		return () => {
			if (!this.#listeners.delete(listener) || this.#listeners.size > 0) return;
			const unsubscribe = this.#unsubscribe;
			this.#unsubscribe = undefined;
			unsubscribe?.();
		};
	}

	subscribeRunState(listener: (state: SessionRunState) => void): () => void {
		this.#runStateListeners.add(listener);
		if (!this.#unsubscribeRunState) {
			this.#unsubscribeRunState = mainBridge().remote.callSync("subscribeRunState", this, state =>
				this.#dispatchRunState(state),
			);
		}
		return () => {
			if (!this.#runStateListeners.delete(listener) || this.#runStateListeners.size > 0) return;
			const unsubscribe = this.#unsubscribeRunState;
			this.#unsubscribeRunState = undefined;
			unsubscribe?.();
		};
	}

	deliverIrcMessage(msg: IrcMessage): Promise<"injected" | "woken"> {
		return mainBridge().remote.call("deliverIrcMessage", this, msg);
	}

	waitForIrcReplies(): Promise<void> {
		return mainBridge().remote.call("waitForIrcReplies", this);
	}

	prompt(text: string, options?: PromptOptions): Promise<boolean> {
		return mainBridge().remote.call("prompt", this, text, options);
	}

	steer(text: string, images?: ImageContent[], options?: SteerOptions): Promise<void> {
		return mainBridge().remote.call("steer", this, text, images, options);
	}

	abort(options?: SessionAbortOptions): Promise<void> {
		return mainBridge().remote.call("abort", this, options);
	}

	setWorkPoolYieldItems(items: readonly WorkPoolYieldItem[]): Promise<void> {
		return mainBridge().remote.call("setWorkPoolYieldItems", this, items);
	}

	dispose(options?: AgentSessionDisposeOptions): Promise<void> {
		return mainBridge().remote.call("dispose", this, options);
	}

	#field<K extends PeerStateField>(field: K): SessionMirrorState[K] {
		const value = mainBridge().remote.callSync("read", this, [field])[field];
		return value === undefined ? DEFAULTS[field] : value;
	}

	#dispatch(event: AgentSessionEvent): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch (error) {
				logger.warn("PeerAgentSession listener threw", {
					key: this.instanceKey,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#dispatchRunState(state: SessionRunState): void {
		for (const listener of [...this.#runStateListeners]) {
			try {
				listener(state);
			} catch (error) {
				logger.warn("PeerAgentSession run-state listener threw", {
					key: this.instanceKey,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}
