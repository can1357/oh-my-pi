import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type { DaemonClient } from "../daemon/client";
import { calculateTokensPerSecond } from "../utils/token-rate";
import {
	type DaemonEvent,
	type DaemonEventDelivery,
	type DaemonSnapshotFrame,
	decodeDaemonSnapshotChunks,
} from "../daemon/protocol";
import type { BashResult } from "../exec/bash-executor";
import type {
	RpcAvailableSlashCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
	RpcSessionState,
} from "../modes/rpc/rpc-types";
import { buildAvailableSlashCommands, getClientOwnedBuiltinSlashCommands } from "../slash-commands/available-commands";
import type { TodoPhase } from "../tools/todo";
import type { AgentSession, AgentSessionEvent, HandoffResult, ModelCycleResult, SessionStats } from "./agent-session";
import type { SessionEntry, SessionHeader } from "./session-entries";

export type DaemonTerminalEvent =
	| { type: "terminal_output"; data: string }
	| { type: "terminal_closed"; reason: "detach" | "exit" | "error"; error?: string };
export type SessionHandleEvent = AgentSessionEvent | DaemonTerminalEvent;
export interface SessionHandleSnapshot {
	readonly state: RpcSessionState;
	readonly header: SessionHeader | null;
	readonly entries: readonly SessionEntry[];
}

export type SessionHandleListener = (event: SessionHandleEvent) => void;
export type SessionHandleConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "detached";

export type SessionHandleCommand = RpcCommand extends infer C
	? C extends { id?: string }
		? Omit<C, "id">
		: never
	: never;
type ExtensionUIListener = (request: RpcExtensionUIRequest) => void;
type HostToolListener = (request: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;
type HostUriListener = (request: RpcHostUriRequest | RpcHostUriCancelRequest) => void;

export interface SessionHandle {
	readonly snapshot: SessionHandleSnapshot;
	readonly kind: "local" | "remote";
	readonly state: RpcSessionState;
	readonly connectionState: SessionHandleConnectionState;
	getState(): RpcSessionState;
	whenReady(): Promise<void>;
	command(command: SessionHandleCommand): Promise<unknown>;
	getAvailableCommands(): Promise<RpcAvailableSlashCommand[]>;
	subscribe(listener: SessionHandleListener): () => void;
	prompt(
		text: string,
		options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<boolean>;
	steer(text: string, images?: ImageContent[]): Promise<void>;
	followUp(text: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	setModel(model: Model): Promise<void>;
	cycleModel(direction?: "forward" | "backward"): Promise<Model | undefined>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	cycleThinkingLevel(): Promise<ThinkingLevel | undefined>;
	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setInterruptMode(mode: "immediate" | "wait"): Promise<void>;
	setTodos(phases: TodoPhase[]): Promise<void>;
	getAvailableModels(): Promise<Model[]>;
	compact(customInstructions?: string): Promise<CompactionResult>;
	setAutoCompactionEnabled(enabled: boolean): Promise<void>;
	setAutoRetryEnabled(enabled: boolean): Promise<void>;
	abortRetry(): Promise<void>;
	executeBash(command: string): Promise<BashResult>;
	abortBash(): Promise<void>;
	getSessionStats(): Promise<SessionStats>;
	exportToHtml(outputPath?: string): Promise<string>;
	newSession(parentSession?: string): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	branch(entryId: string): Promise<{ text: string; cancelled: boolean }>;
	getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
	getLastAssistantText(): Promise<string | undefined>;
	setSessionName(name: string): Promise<void>;
	handoff(customInstructions?: string): Promise<{ savedPath?: string } | null>;
	getMessages(): Promise<unknown[]>;
	setHostTools(tools: RpcHostToolDefinition[]): Promise<void>;
	setHostUriSchemes(schemes: RpcHostUriSchemeDefinition[]): Promise<void>;
	subscribeExtensionUI(listener: ExtensionUIListener): () => void;
	subscribeHostTool(listener: HostToolListener): () => void;
	subscribeHostUri(listener: HostUriListener): () => void;
	respondExtensionUI(response: RpcExtensionUIResponse): Promise<void>;
	respondHostTool(response: RpcHostToolUpdate | RpcHostToolResult): Promise<void>;
	respondHostUri(response: RpcHostUriResult): Promise<void>;
	dispose(): Promise<void>;
}

function freezeState(state: RpcSessionState): RpcSessionState {
	const model = state.model ? Object.freeze({ ...state.model }) : undefined;
	const todoPhases = state.todoPhases.map(phase =>
		Object.freeze({ ...phase, tasks: phase.tasks.map(task => Object.freeze({ ...task })) }),
	);
	return Object.freeze({ ...state, model, todoPhases }) as unknown as RpcSessionState;
}
function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
	return Object.freeze(value) as T;
}
function freezeSnapshot(
	state: RpcSessionState,
	header: SessionHeader | null,
	entries: readonly SessionEntry[],
): SessionHandleSnapshot {
	const clonedHeader = header === null ? null : deepFreeze(structuredClone(header));
	const clonedEntries = deepFreeze(structuredClone(entries) as SessionEntry[]);
	return Object.freeze({
		state,
		header: clonedHeader,
		entries: clonedEntries,
	});
}

function defaultState(sessionId: string): RpcSessionState {
	return {
		sessionId,
		thinkingLevel: undefined,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		autoCompactionEnabled: true,
		messageCount: 0,
		queuedMessageCount: 0,
		todoPhases: [],
		fastModeEnabled: false,
		fastModeActive: false,
		tokensPerSecond: null,
	};
}

function stateFromLocal(session: AgentSession): RpcSessionState {
	return freezeState({
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.state.messages.length,
		queuedMessageCount: session.queuedMessageCount,
		todoPhases: session.getTodoPhases(),
		fastModeEnabled: session.isFastModeEnabled(),
		fastModeActive: session.isFastModeActive(),
		tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
		contextUsage: session.getContextUsage(),
	});
}

function withCommandId<T extends SessionHandleCommand>(value: T, id = crypto.randomUUID()): T & { id: string } {
	return { ...value, id } as T & { id: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFrom(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** Adapter that keeps existing local AgentSession semantics intact. */
export class LocalSessionHandle implements SessionHandle {
	readonly kind = "local" as const;
	readonly connectionState = "connected" as const;
	readonly #session: AgentSession;
	readonly #extensionUiListeners = new Set<ExtensionUIListener>();
	readonly #hostToolListeners = new Set<HostToolListener>();
	readonly #hostUriListeners = new Set<HostUriListener>();
	constructor(session: AgentSession) {
		this.#session = session;
	}
	get state(): RpcSessionState {
		return stateFromLocal(this.#session);
	}
	get snapshot(): SessionHandleSnapshot {
		return freezeSnapshot(
			this.state,
			this.#session.sessionManager.getHeader(),
			this.#session.sessionManager.getEntries(),
		);
	}
	getState(): RpcSessionState {
		return this.state;
	}
	whenReady(): Promise<void> {
		return Promise.resolve();
	}
	async command(value: SessionHandleCommand): Promise<unknown> {
		switch (value.type) {
			case "get_available_commands":
				return { commands: await this.getAvailableCommands() };
			case "get_state":
				return this.state;
			default:
				throw new Error(`Unsupported local SessionHandle command: ${value.type}`);
		}
	}
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		return buildAvailableSlashCommands(this.#session);
	}
	subscribe(listener: SessionHandleListener): () => void {
		return this.#session.subscribe(event => listener(event));
	}
	prompt(
		text: string,
		options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<boolean> {
		return this.#session.prompt(text, options);
	}
	steer(text: string, images?: ImageContent[]): Promise<void> {
		return this.#session.steer(text, images);
	}
	followUp(text: string, images?: ImageContent[]): Promise<void> {
		return this.#session.followUp(text, images);
	}
	abort(): Promise<void> {
		return this.#session.abort();
	}
	async setModel(model: Model): Promise<void> {
		await this.#session.setModel(model);
	}
	getAvailableModels(): Promise<Model[]> {
		return Promise.resolve(this.#session.getAvailableModels());
	}
	compact(customInstructions?: string): Promise<CompactionResult> {
		return this.#session.compact(customInstructions);
	}
	setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		this.#session.setAutoCompactionEnabled(enabled);
		return Promise.resolve();
	}
	setAutoRetryEnabled(enabled: boolean): Promise<void> {
		this.#session.setAutoRetryEnabled(enabled);
		return Promise.resolve();
	}
	abortRetry(): Promise<void> {
		this.#session.abortRetry();
		return Promise.resolve();
	}
	executeBash(command: string): Promise<BashResult> {
		return this.#session.executeBash(command);
	}
	abortBash(): Promise<void> {
		this.#session.abortBash();
		return Promise.resolve();
	}
	getSessionStats(): Promise<SessionStats> {
		return Promise.resolve(this.#session.getSessionStats());
	}
	exportToHtml(outputPath?: string): Promise<string> {
		return this.#session.exportToHtml(outputPath);
	}
	newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return this.#session.newSession({ parentSession }).then(success => ({ cancelled: !success }));
	}
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.#session.switchSession(sessionPath).then(success => ({ cancelled: !success }));
	}
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const result = await this.#session.branch(entryId);
		return { text: result.selectedText, cancelled: result.cancelled };
	}
	getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return Promise.resolve(this.#session.getUserMessagesForBranching());
	}
	getLastAssistantText(): Promise<string | undefined> {
		return Promise.resolve(this.#session.getLastAssistantText());
	}
	async setSessionName(name: string): Promise<void> {
		if (!(await this.#session.setSessionName(name, "user"))) throw new Error("Session name cannot be empty");
	}
	async handoff(customInstructions?: string): Promise<{ savedPath?: string } | null> {
		const result: HandoffResult | undefined = await this.#session.handoff(customInstructions);
		return result ? { savedPath: result.savedPath } : null;
	}
	getMessages(): Promise<unknown[]> {
		return Promise.resolve(this.#session.messages);
	}
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<Model | undefined> {
		const result: ModelCycleResult | undefined = await this.#session.cycleModel(direction);
		return result?.model;
	}
	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.#session.setThinkingLevel(level);
		return Promise.resolve();
	}
	cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		return Promise.resolve(this.#session.cycleThinkingLevel() as ThinkingLevel | undefined);
	}
	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.#session.setSteeringMode(mode);
		return Promise.resolve();
	}
	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.#session.setFollowUpMode(mode);
		return Promise.resolve();
	}
	setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
		this.#session.setInterruptMode(mode);
		return Promise.resolve();
	}
	setTodos(phases: TodoPhase[]): Promise<void> {
		this.#session.setTodoPhases(phases);
		return Promise.resolve();
	}
	setHostTools(_tools: RpcHostToolDefinition[]): Promise<void> {
		return Promise.reject(new Error("Host tools are only available on remote session handles"));
	}
	setHostUriSchemes(_schemes: RpcHostUriSchemeDefinition[]): Promise<void> {
		return Promise.reject(new Error("Host URI schemes are only available on remote session handles"));
	}
	subscribeExtensionUI(listener: ExtensionUIListener): () => void {
		this.#extensionUiListeners.add(listener);
		return () => this.#extensionUiListeners.delete(listener);
	}
	subscribeHostTool(listener: HostToolListener): () => void {
		this.#hostToolListeners.add(listener);
		return () => this.#hostToolListeners.delete(listener);
	}
	subscribeHostUri(listener: HostUriListener): () => void {
		this.#hostUriListeners.add(listener);
		return () => this.#hostUriListeners.delete(listener);
	}
	respondExtensionUI(_response: RpcExtensionUIResponse): Promise<void> {
		return Promise.reject(new Error("Extension UI responses are only available on remote session handles"));
	}
	respondHostTool(_response: RpcHostToolUpdate | RpcHostToolResult): Promise<void> {
		return Promise.reject(new Error("Host tool responses are only available on remote session handles"));
	}
	respondHostUri(_response: RpcHostUriResult): Promise<void> {
		return Promise.reject(new Error("Host URI responses are only available on remote session handles"));
	}
	dispose(): Promise<void> {
		return this.#session.dispose();
	}
}

export type RemoteSessionHandleOptions = {
	attachmentId?: string;
	lastSeq?: number;
	delivery?: DaemonEventDelivery;
	recover?: () => Promise<void>;
	/**
	 * Upper bound on how long a command issued during a connection outage waits
	 * for reconnection before failing.
	 */
	reconnectWaitMs?: number;
};

/** Daemon-owned session adapter with ordered event replay and immutable state snapshots. */
export class RemoteSessionHandle implements SessionHandle {
	readonly kind = "remote" as const;
	readonly #client: DaemonClient;
	readonly #sessionId: string;
	readonly #attachmentId: string;
	readonly #recover: (() => Promise<void>) | undefined;
	readonly #delivery: DaemonEventDelivery;
	readonly #listeners = new Set<SessionHandleListener>();
	readonly #extensionUiListeners = new Set<ExtensionUIListener>();
	readonly #hostToolListeners = new Set<HostToolListener>();
	readonly #hostUriListeners = new Set<HostUriListener>();
	readonly #unsubscribeClient: Array<() => void> = [];
	#state: RpcSessionState;
	#snapshot: SessionHandleSnapshot;
	#connectionState: SessionHandleConnectionState = "connecting";
	#lastSeq = 0;
	#snapshotBarrier = -1;
	#snapshotChunks = new Map<number, unknown>();
	#disposed = false;
	#attached = false;
	#reattachTask: Promise<void> | undefined;
	#connectionWait: Promise<void> | undefined;
	#resolveConnectionWait: (() => void) | undefined;
	#daemonId: string | undefined;
	readonly #reconnectWaitMs: number;
	readonly #ready: Promise<void>;

	constructor(client: DaemonClient, sessionId: string, options: RemoteSessionHandleOptions = {}) {
		this.#client = client;
		this.#sessionId = sessionId;
		this.#attachmentId = options.attachmentId ?? crypto.randomUUID();
		this.#recover = options.recover;
		this.#delivery = options.delivery ?? "all";
		this.#reconnectWaitMs = Math.max(1, options.reconnectWaitMs ?? 15_000);
		this.#state = freezeState(defaultState(sessionId));
		this.#snapshot = freezeSnapshot(this.#state, null, []);
		this.#lastSeq = options.lastSeq ?? 0;
		this.#daemonId = client.snapshot.state === "connected" ? client.snapshot.daemonId : undefined;
		this.#unsubscribeClient.push(
			client.onSnapshot(snapshot => {
				if (this.#disposed) return;
				if (snapshot.state === "connected") {
					if (snapshot.daemonId !== undefined) {
						if (this.#daemonId !== undefined && snapshot.daemonId !== this.#daemonId) {
							this.#lastSeq = 0;
							this.#snapshotBarrier = -1;
							this.#snapshotChunks.clear();
						}
						this.#daemonId = snapshot.daemonId;
					}
					if (!this.#attached) {
						this.#connectionState = "connected";
						return;
					}
					this.#beginReattach();
				} else if (snapshot.state === "reconnecting" || snapshot.state === "connecting") {
					this.#connectionState = snapshot.state;
					if (this.#attached && !this.#connectionWait) {
						const gate = Promise.withResolvers<void>();
						this.#connectionWait = gate.promise;
						this.#resolveConnectionWait = gate.resolve;
					}
				} else if (snapshot.state === "unavailable" || snapshot.state === "incompatible") {
					this.#connectionState = "disconnected";
					if (snapshot.state === "incompatible" || this.#client.closed) {
						this.#wakeConnectionWait();
						return;
					}
					if (this.#attached && !this.#connectionWait) {
						const gate = Promise.withResolvers<void>();
						this.#connectionWait = gate.promise;
						this.#resolveConnectionWait = gate.resolve;
					}
				}
			}),
		);
		this.#unsubscribeClient.push(client.onSnapshotFrame(frame => this.#applySnapshotFrame(frame)));
		this.#unsubscribeClient.push(client.onEvent(frame => this.#applyEventFrame(frame)));
		this.#ready = this.#attach(options.lastSeq);
	}
	get state(): RpcSessionState {
		return this.#state;
	}
	get snapshot(): SessionHandleSnapshot {
		return this.#snapshot;
	}
	get connectionState(): SessionHandleConnectionState {
		return this.#connectionState;
	}
	getState(): RpcSessionState {
		return this.#state;
	}
	whenReady(): Promise<void> {
		return this.#ready;
	}
	async command(value: SessionHandleCommand): Promise<unknown> {
		const result = await this.#send(withCommandId(value));
		if (value.type === "get_state" && isRecord(result)) {
			this.#replaceState(this.#stateFromSnapshot(result));
		}
		return result;
	}
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		const result = await this.command({ type: "get_available_commands" });
		const daemonCommands =
			isRecord(result) && Array.isArray(result.commands) ? (result.commands as RpcAvailableSlashCommand[]) : [];
		const seenNames = new Set(daemonCommands.map(command => command.name));
		const clientCommands = getClientOwnedBuiltinSlashCommands()
			.filter(command => !seenNames.has(command.name))
			.map(command => command as RpcAvailableSlashCommand);
		return [...daemonCommands, ...clientCommands];
	}
	subscribe(listener: SessionHandleListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	async prompt(
		text: string,
		options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<boolean> {
		const result = await this.#send(
			withCommandId({
				type: "prompt",
				message: text,
				images: options?.images,
				streamingBehavior: options?.streamingBehavior,
			}),
		);
		return isRecord(result) && typeof result.agentInvoked === "boolean" ? result.agentInvoked : true;
	}
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this.#send(withCommandId({ type: "steer", message: text, images }));
	}
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		await this.#send(withCommandId({ type: "follow_up", message: text, images }));
	}
	async abort(): Promise<void> {
		await this.#send(withCommandId({ type: "abort" }));
		this.#replaceState({ ...this.#state, isStreaming: false });
	}
	async setModel(model: Model): Promise<void> {
		const result = await this.#send(
			withCommandId({ type: "set_model", provider: model.provider, modelId: model.id }),
		);
		if (isRecord(result)) this.#replaceState({ ...this.#state, model: result as unknown as Model });
	}
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<Model | undefined> {
		const result = await this.#send(
			withCommandId({ type: "cycle_model", ...(direction === "forward" ? {} : { direction }) }),
		);
		if (!isRecord(result) || !isRecord(result.model)) return undefined;
		this.#replaceState({
			...this.#state,
			model: result.model as unknown as Model,
			thinkingLevel: result.thinkingLevel as ThinkingLevel | undefined,
		});
		return result.model as unknown as Model;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send(withCommandId({ type: "set_thinking_level", level }));
		this.#replaceState({ ...this.#state, thinkingLevel: level });
	}
	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		const result = await this.#send(withCommandId({ type: "cycle_thinking_level" }));
		if (!isRecord(result) || typeof result.level !== "string") return undefined;
		const level = result.level as ThinkingLevel;
		this.#replaceState({ ...this.#state, thinkingLevel: level });
		return level;
	}
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send(withCommandId({ type: "set_steering_mode", mode }));
		this.#replaceState({ ...this.#state, steeringMode: mode });
	}
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send(withCommandId({ type: "set_follow_up_mode", mode }));
		this.#replaceState({ ...this.#state, followUpMode: mode });
	}
	async setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
		await this.#send(withCommandId({ type: "set_interrupt_mode", mode }));
		this.#replaceState({ ...this.#state, interruptMode: mode });
	}
	async setTodos(phases: TodoPhase[]): Promise<void> {
		await this.#send(withCommandId({ type: "set_todos", phases }));
		this.#replaceState({ ...this.#state, todoPhases: phases });
	}
	async getAvailableModels(): Promise<Model[]> {
		const result = await this.#send(withCommandId({ type: "get_available_models" }));
		return isRecord(result) && Array.isArray(result.models) ? (result.models as Model[]) : [];
	}
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return (await this.#send(withCommandId({ type: "compact", customInstructions }))) as CompactionResult;
	}
	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		await this.#send(withCommandId({ type: "set_auto_compaction", enabled }));
		this.#replaceState({ ...this.#state, autoCompactionEnabled: enabled });
	}
	async setAutoRetryEnabled(enabled: boolean): Promise<void> {
		await this.#send(withCommandId({ type: "set_auto_retry", enabled }));
	}
	async abortRetry(): Promise<void> {
		await this.#send(withCommandId({ type: "abort_retry" }));
	}
	async executeBash(command: string): Promise<BashResult> {
		return (await this.#send(withCommandId({ type: "bash", command }))) as BashResult;
	}
	async abortBash(): Promise<void> {
		await this.#send(withCommandId({ type: "abort_bash" }));
	}
	async getSessionStats(): Promise<SessionStats> {
		return (await this.#send(withCommandId({ type: "get_session_stats" }))) as SessionStats;
	}
	async exportToHtml(outputPath?: string): Promise<string> {
		const result = await this.#send(withCommandId({ type: "export_html", outputPath }));
		if (!isRecord(result) || typeof result.path !== "string")
			throw new Error("Daemon returned an invalid export path");
		return result.path;
	}
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return (await this.#send(withCommandId({ type: "new_session", parentSession }))) as { cancelled: boolean };
	}
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return (await this.#send(withCommandId({ type: "switch_session", sessionPath }))) as { cancelled: boolean };
	}
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return (await this.#send(withCommandId({ type: "branch", entryId }))) as { text: string; cancelled: boolean };
	}
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const result = await this.#send(withCommandId({ type: "get_branch_messages" }));
		return isRecord(result) && Array.isArray(result.messages)
			? (result.messages as Array<{ entryId: string; text: string }>)
			: [];
	}
	async getLastAssistantText(): Promise<string | undefined> {
		const result = await this.#send(withCommandId({ type: "get_last_assistant_text" }));
		if (!isRecord(result) || typeof result.text !== "string") return undefined;
		return result.text;
	}
	async setSessionName(name: string): Promise<void> {
		await this.#send(withCommandId({ type: "set_session_name", name }));
	}
	async handoff(customInstructions?: string): Promise<{ savedPath?: string } | null> {
		const result = await this.#send(withCommandId({ type: "handoff", customInstructions }));
		return result === null ? null : (result as { savedPath?: string });
	}
	async getMessages(): Promise<unknown[]> {
		const result = await this.#send(withCommandId({ type: "get_messages" }));
		return isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
	}
	async setHostTools(tools: RpcHostToolDefinition[]): Promise<void> {
		await this.#send(withCommandId({ type: "set_host_tools", tools }));
	}
	async setHostUriSchemes(schemes: RpcHostUriSchemeDefinition[]): Promise<void> {
		await this.#send(withCommandId({ type: "set_host_uri_schemes", schemes }));
	}
	subscribeExtensionUI(listener: ExtensionUIListener): () => void {
		this.#extensionUiListeners.add(listener);
		return () => this.#extensionUiListeners.delete(listener);
	}
	subscribeHostTool(listener: HostToolListener): () => void {
		this.#hostToolListeners.add(listener);
		return () => this.#hostToolListeners.delete(listener);
	}
	subscribeHostUri(listener: HostUriListener): () => void {
		this.#hostUriListeners.add(listener);
		return () => this.#hostUriListeners.delete(listener);
	}
	async respondExtensionUI(response: RpcExtensionUIResponse): Promise<void> {
		await this.#sendRaw(response);
	}
	async respondHostTool(response: RpcHostToolUpdate | RpcHostToolResult): Promise<void> {
		await this.#sendRaw(response);
	}
	async respondHostUri(response: RpcHostUriResult): Promise<void> {
		await this.#sendRaw(response);
	}
	async detach(): Promise<void> {
		if (this.#disposed) return;
		this.#wakeConnectionWait();
		await this.#ready;
		if (this.#client.snapshot.state !== "connected") throw new Error("Cannot detach: daemon is disconnected");
		await this.#client.request("detach", { sessionId: this.#sessionId, attachmentId: this.#attachmentId });
		this.#disposed = true;
		this.#connectionState = "detached";
		for (const unsubscribe of this.#unsubscribeClient.splice(0)) unsubscribe();
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		try {
			await this.detach();
		} catch (error) {
			this.#disposed = true;
			this.#connectionState = "detached";
			this.#wakeConnectionWait();
			for (const unsubscribe of this.#unsubscribeClient.splice(0)) unsubscribe();
			throw errorFrom(error);
		}
	}
	#beginReattach(): void {
		if (this.#disposed || !this.#attached || this.#reattachTask || this.#client.snapshot.state !== "connected")
			return;
		this.#connectionState = "connecting";
		this.#reattachTask = this.#reattachUntilConnected().finally(() => {
			this.#reattachTask = undefined;
			if (this.#client.snapshot.state === "connected" && this.#connectionState !== "connected")
				this.#beginReattach();
		});
	}
	async #reattachUntilConnected(): Promise<void> {
		const deadline = Date.now() + this.#reconnectWaitMs;
		let delayMs = 100;
		while (!this.#disposed && this.#client.snapshot.state === "connected") {
			this.#connectionState = "connecting";
			try {
				await this.#attach(this.#lastSeq);
				this.#connectionState = "connected";
				this.#wakeConnectionWait();
				return;
			} catch {
				if (Date.now() >= deadline) {
					this.#connectionState = "disconnected";
					this.#wakeConnectionWait();
					return;
				}
				await Bun.sleep(delayMs);
				delayMs = Math.min(delayMs * 2, 1_000);
			}
		}
	}
	async #attach(lastSeq?: number): Promise<void> {
		try {
			await this.#client.connect();
			try {
				await this.#client.request("session_load", { sessionId: this.#sessionId });
			} catch (error) {
				const parsed = errorFrom(error);
				if (!this.#recover || !/\bnot_found\b/.test(parsed.message)) throw parsed;
				await this.#recover();
			}
			const result = await this.#client.request("attach", {
				sessionId: this.#sessionId,
				attachmentId: this.#attachmentId,
				mode: "interactive",
				...(lastSeq === undefined ? {} : { lastSeq }),
				delivery: this.#delivery,
			});
			this.#attached = true;
			this.#connectionState = "connected";
			if (isRecord(result) && Array.isArray(result.frames))
				for (const frame of result.frames) this.#applyUnknownFrame(frame);
		} catch (error) {
			this.#connectionState = "disconnected";
			throw errorFrom(error);
		}
	}
	/** Settle the reconnect gate so parked senders re-evaluate connection state. */
	#wakeConnectionWait(): void {
		this.#resolveConnectionWait?.();
		this.#resolveConnectionWait = undefined;
		this.#connectionWait = undefined;
	}
	async #sendRaw(payload: unknown): Promise<unknown> {
		await this.#ready;
		if (this.#connectionWait) {
			const deadline = Promise.withResolvers<false>();
			const timer = setTimeout(() => deadline.resolve(false), this.#reconnectWaitMs);
			try {
				const reconnected = await Promise.race([this.#connectionWait.then(() => true), deadline.promise]);
				if (!reconnected && this.#connectionState !== "connected") {
					throw new Error(
						`Session handle is disconnected: daemon did not reconnect within ${this.#reconnectWaitMs}ms`,
					);
				}
			} finally {
				clearTimeout(timer);
			}
		}
		if (this.#reattachTask) await this.#reattachTask;
		this.#ensureConnected();
		return this.#client.request("session_command", {
			sessionId: this.#sessionId,
			attachmentId: this.#attachmentId,
			command: payload,
		});
	}
	async #send(payload: RpcCommand): Promise<unknown> {
		return this.#sendRaw(payload);
	}
	#ensureConnected(): void {
		if (this.#disposed || this.#connectionState === "detached") throw new Error("Session handle is detached");
		if (this.#connectionState !== "connected" || this.#client.snapshot.state !== "connected")
			throw new Error("Session handle is disconnected");
	}
	#replaceState(state: RpcSessionState): void {
		this.#state = freezeState(state);
		this.#snapshot = freezeSnapshot(this.#state, this.#snapshot.header, this.#snapshot.entries);
	}
	#replaceSnapshot(snapshot: SessionHandleSnapshot): void {
		this.#state = freezeState(snapshot.state);
		this.#snapshot = freezeSnapshot(this.#state, snapshot.header, snapshot.entries);
	}
	#applyUnknownFrame(frame: unknown): void {
		if (!isRecord(frame)) return;
		if (frame.tag === "event" && typeof frame.seq === "number") {
			this.#applyEvent(frame.seq, frame.event);
			return;
		}
		if (
			frame.tag === "snapshot_begin" ||
			frame.tag === "snapshot_chunk" ||
			frame.tag === "snapshot_end" ||
			frame.tag === "snapshot_restart"
		) {
			this.#applySnapshotFrame(frame as unknown as DaemonSnapshotFrame);
			return;
		}
		if (
			frame.type === "snapshot_begin" ||
			frame.type === "snapshot_chunk" ||
			frame.type === "snapshot_end" ||
			frame.type === "snapshot_restart"
		) {
			this.#applySnapshotFrame({
				...frame,
				v: 0,
				tag: frame.type,
				sessionId: this.#sessionId,
				attachmentId: this.#attachmentId,
			} as unknown as DaemonSnapshotFrame);
			return;
		}
		if (frame.type === "event" && typeof frame.seq === "number") this.#applyEvent(frame.seq, frame.event);
	}
	#applySnapshotFrame(frame: DaemonSnapshotFrame): void {
		if (frame.sessionId !== this.#sessionId || frame.attachmentId !== this.#attachmentId) return;
		if (frame.tag === "snapshot_begin") {
			this.#snapshotBarrier = frame.barrierSeq;
			this.#snapshotChunks.clear();
			return;
		}
		if (frame.tag === "snapshot_chunk") {
			if (frame.barrierSeq === this.#snapshotBarrier) this.#snapshotChunks.set(frame.index, frame.chunk);
			return;
		}
		if (frame.tag === "snapshot_restart") {
			this.#snapshotChunks.clear();
			this.#snapshotBarrier = -1;
			return;
		}
		if (frame.tag === "snapshot_end" && frame.barrierSeq === this.#snapshotBarrier) {
			const chunks = [...this.#snapshotChunks.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
			if (chunks.length > 0) this.#replaceSnapshot(this.#snapshotFromSnapshot(decodeDaemonSnapshotChunks(chunks)));
			this.#lastSeq = Math.max(this.#lastSeq, frame.nextSeq - 1);
			void this.#ack(this.#lastSeq);
		}
	}
	#snapshotFromSnapshot(value: unknown): SessionHandleSnapshot {
		const state = this.#stateFromSnapshot(value);
		const source = isRecord(value) && isRecord(value.state) ? value : isRecord(value) ? value : {};
		const header =
			isRecord(source.header) && source.header.type === "session"
				? (source.header as unknown as SessionHeader)
				: null;
		const entries = Array.isArray(source.entries) ? (source.entries as SessionEntry[]) : [];
		return freezeSnapshot(state, header, entries);
	}
	#stateFromSnapshot(value: unknown): RpcSessionState {
		const source = isRecord(value) && isRecord(value.state) ? value.state : value;
		if (!isRecord(source)) return defaultState(this.#sessionId);
		const base = defaultState(this.#sessionId);
		return {
			...base,
			...source,
			sessionId: typeof source.sessionId === "string" ? source.sessionId : this.#sessionId,
			todoPhases: Array.isArray(source.todoPhases) ? (source.todoPhases as TodoPhase[]) : [],
		} as RpcSessionState;
	}
	#applyEventFrame(frame: DaemonEvent): void {
		if (frame.sessionId === this.#sessionId) this.#applyEvent(frame.seq, frame.event);
	}
	#applyEvent(seq: number, event: unknown): void {
		if (!Number.isInteger(seq) || seq <= this.#lastSeq) return;
		if (seq !== this.#lastSeq + 1 && this.#lastSeq !== 0) {
			this.#connectionState = "reconnecting";
			return;
		}
		this.#lastSeq = seq;
		if (isRecord(event) && isRecord(event.state)) this.#replaceState(this.#stateFromSnapshot(event.state));
		else if (isRecord(event)) {
			if (event.type === "agent_start" || event.type === "turn_start")
				this.#replaceState({ ...this.#state, isStreaming: true });
			if (event.type === "agent_end" || event.type === "turn_end")
				this.#replaceState({ ...this.#state, isStreaming: false });
			if (event.type === "thinking_level_changed")
				this.#replaceState({ ...this.#state, thinkingLevel: event.thinkingLevel as ThinkingLevel | undefined });
			if (event.type === "message_end")
				this.#replaceState({ ...this.#state, messageCount: this.#state.messageCount + 1 });
			if (event.type === "extension_ui_request")
				for (const listener of this.#extensionUiListeners) listener(event as unknown as RpcExtensionUIRequest);
			if (event.type === "host_tool_call" || event.type === "host_tool_cancel")
				for (const listener of this.#hostToolListeners)
					listener(event as unknown as RpcHostToolCallRequest | RpcHostToolCancelRequest);
			if (event.type === "host_uri_request" || event.type === "host_uri_cancel")
				for (const listener of this.#hostUriListeners)
					listener(event as unknown as RpcHostUriRequest | RpcHostUriCancelRequest);
		}
		for (const listener of this.#listeners) listener(event as SessionHandleEvent);
		void this.#ack(seq);
	}
	async #ack(seq: number): Promise<void> {
		if (this.#connectionState !== "connected") return;
		await this.#client
			.request("snapshot_ack", { sessionId: this.#sessionId, attachmentId: this.#attachmentId, seq })
			.catch(() => undefined);
	}
}
