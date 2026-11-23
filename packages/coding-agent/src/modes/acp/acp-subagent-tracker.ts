/**
 * AIR-private child-session tracking for ACP.
 *
 * JetBrains AIR renders task-tool subagents from a private extension contract,
 * not the upstream ACP subagents RFD:
 * - `subagent_spawned` custom update (`{ subagentSessionId, name, task, capabilities: {} }`)
 *   on the parent session announces a child; the client then treats the id as a
 *   native child session.
 * - Updates carrying `_meta.jetbrains.air.subagentSessionId` route to that
 *   child's transcript (`AcpV1RuntimeUpdateMapper.routeNativeSubagentEvents`).
 * - `subagent_state_update` (`{ subagentSessionId, state }` with a terminal
 *   `SessionSubagentState` wire name) settles the child.
 *
 * The wire names were verified against the decompiled AIR backend
 * (`AcpSessionRuntimeFactProcessor.mapCustomUpdate` /
 * `mapSubagentSpawned` / `mapSubagentTerminal`, `AcpSubagentSessionIdsKt`):
 * blank ids are ignored, `name` must be non-blank, `task` or a non-blank
 * `description` is required, and `capabilities` must be an object.
 */

/** AIR extension version advertised in `initialize` `_meta.jetbrains.air.version`. */
export const AIR_EXTENSION_VERSION = 1;

import type { SessionNotification } from "@oh-my-pi/pi-utils/acp";
import type { EventBus } from "../../utils/event-bus";
import type { SubagentLifecyclePayload, SubagentProgressPayload } from "../../task/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../task/types";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";

/** AIR extension capability that gates native child sessions. */
export const AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY = "nativeSubagentSessions";

/** Terminal states accepted by AIR's `SessionSubagentState.fromWireName` + `isTerminal`. */
export type AcpSubagentTerminalState = "completed" | "failed" | "cancelled";

/** One tracked child: registry id doubles as the AIR child session id. */
export interface AcpSubagentChild {
	/** Task-executor registry id (`agent://` name); sent as `subagentSessionId`. */
	id: string;
	/** Display name for the AIR roster row. */
	name: string;
	/** Assignment text shown as the child task. */
	task: string;
	/** Latest progress snapshot, when one arrived. */
	progress: AgentProgress | undefined;
	/** Whether `subagent_spawned` was delivered for this child. */
	announced: boolean;
	/** Terminal state, once the child settles. */
	terminal: AcpSubagentTerminalState | undefined;
}

/** The `_meta.jetbrains.air` object the AIR backend reads capabilities and routing keys from. */
function jetbrainsAirMeta(
	clientCapabilities: { _meta?: Record<string, unknown> | null } | undefined,
): Record<string, unknown> | undefined {
	const meta = clientCapabilities?._meta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	const jetbrains = meta.jetbrains;
	if (!jetbrains || typeof jetbrains !== "object" || Array.isArray(jetbrains)) return undefined;
	const air = (jetbrains as Record<string, unknown>).air;
	if (!air || typeof air !== "object" || Array.isArray(air)) return undefined;
	return air as Record<string, unknown>;
}

/** Minimal AIR-client detection: an object at `_meta.jetbrains.air` in client `_meta`. */
export function isAirClient(clientCapabilities: { _meta?: Record<string, unknown> | null } | undefined): boolean {
	return jetbrainsAirMeta(clientCapabilities) !== undefined;
}

/** Whether the client declared `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`. */
export function declaresNativeSubagents(
	clientCapabilities: { _meta?: Record<string, unknown> | null } | undefined,
): boolean {
	const air = jetbrainsAirMeta(clientCapabilities);
	if (!air) return false;
	const capabilities = air.capabilities;
	return Array.isArray(capabilities) && capabilities.includes(AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY);
}

/** Sender for raw `session/update` notifications whose update shape is outside the typed union. */
export type AcpRawUpdateSender = (params: { sessionId: string; update: Record<string, unknown> }) => Promise<void>;

/** Tag an update payload with the child routing key AIR reads. */
export function withSubagentMeta(
	update: SessionNotification["update"],
	subagentSessionId: string,
): SessionNotification["update"] {
	const meta = (update._meta ?? {}) as Record<string, unknown>;
	const jetbrains = (meta.jetbrains ?? {}) as Record<string, unknown>;
	const air = (jetbrains.air ?? {}) as Record<string, unknown>;
	return { ...update, _meta: { ...meta, jetbrains: { ...jetbrains, air: { ...air, subagentSessionId } } } };
}

function childName(payload: SubagentLifecyclePayload): string {
	const agent = payload.agent?.trim();
	return agent && agent.length > 0 ? agent : `Agent ${payload.id.slice(-8)}`;
}

function childTask(payload: SubagentLifecyclePayload): string {
	const description = payload.description?.trim();
	if (description) return description;
	return `Delegated task for ${childName(payload)}`;
}

function terminalState(status: SubagentLifecyclePayload["status"]): AcpSubagentTerminalState | undefined {
	switch (status) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "aborted":
			return "cancelled";
		default:
			return undefined;
	}
}

/**
 * Lifecycle table keyed by subagent registry id, projecting executor frames
 * onto the AIR-private child-session contract.
 */
export class AcpSubagentTracker {
	readonly #children = new Map<string, AcpSubagentChild>();
	readonly #toolCallOwners = new Map<string, string>();
	/**
	 * Parent tool calls claimed by more than one child. A batched `task`
	 * call shares one tool call id across siblings, so no single child owns
	 * its combined progress: the shared frames stay on the parent transcript
	 * instead of following whichever sibling started (or settled) last.
	 * Sticky once set; only `dispose` clears it.
	 */
	readonly #ambiguousToolCalls = new Set<string>();
	readonly #parentSessionId: string;
	readonly #send: AcpRawUpdateSender;
	#unsubscribers: Array<() => void> = [];

	#disposed = false;

	constructor(options: { parentSessionId: string; send: AcpRawUpdateSender }) {
		this.#parentSessionId = options.parentSessionId;
		this.#send = options.send;
	}

	/** Live child entries (announced or pending). */
	get children(): ReadonlyMap<string, AcpSubagentChild> {
		return this.#children;
	}

	/** Child that owns a parent-side tool call, via the spawn's `parentToolCallId`. */
	childForToolCall(toolCallId: string): string | undefined {
		if (this.#ambiguousToolCalls.has(toolCallId)) return undefined;
		const id = this.#toolCallOwners.get(toolCallId);
		return id !== undefined && this.#children.has(id) ? id : undefined;
	}

	/** Subscribe to the session tree's subagent bus; returns the unsubscribe-all function. */
	subscribe(bus: EventBus | undefined): void {
		if (!bus || this.#disposed) return;
		this.#unsubscribers.push(
			bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				void this.handleLifecycle(data as SubagentLifecyclePayload).catch(() => {});
			}),
			bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as SubagentProgressPayload);
			}),
		);
	}

	dispose(): void {
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#children.clear();
		this.#toolCallOwners.clear();
		this.#ambiguousToolCalls.clear();
	}

	async handleLifecycle(payload: SubagentLifecyclePayload): Promise<void> {
		if (!payload || typeof payload.id !== "string" || payload.id.length === 0) return;
		if (payload.status === "started") {
			let child = this.#children.get(payload.id);
			if (!child) {
				child = {
					id: payload.id,
					name: childName(payload),
					task: childTask(payload),
					progress: undefined,
					announced: false,
					terminal: undefined,
				};
				this.#children.set(payload.id, child);
			}
			if (typeof payload.parentToolCallId === "string" && payload.parentToolCallId.length > 0) {
				const existing = this.#toolCallOwners.get(payload.parentToolCallId);
				if (existing === undefined) {
					this.#toolCallOwners.set(payload.parentToolCallId, payload.id);
				} else if (existing !== payload.id) {
					this.#toolCallOwners.delete(payload.parentToolCallId);
					this.#ambiguousToolCalls.add(payload.parentToolCallId);
				}
			}
			if (child.announced) return;
			child.announced = true;
			await this.#send({
				sessionId: this.#parentSessionId,
				update: {
					sessionUpdate: "subagent_spawned",
					subagentSessionId: child.id,
					name: child.name,
					task: child.task,
					capabilities: {},
				},
			});
			return;
		}
		const state = terminalState(payload.status);
		if (!state) return;
		const child = this.#children.get(payload.id);
		if (!child || child.terminal !== undefined) return;
		child.terminal = state;
		await this.#send({
			sessionId: this.#parentSessionId,
			update: {
				sessionUpdate: "subagent_state_update",
				subagentSessionId: child.id,
				state,
			},
		});
		for (const [toolCallId, ownerId] of this.#toolCallOwners) {
			if (ownerId === payload.id) this.#toolCallOwners.delete(toolCallId);
		}
		this.#children.delete(payload.id);
	}

	handleProgress(payload: SubagentProgressPayload): void {
		const progress = payload?.progress;
		if (!progress || typeof progress.id !== "string" || progress.id.length === 0) return;
		const child = this.#children.get(progress.id);
		if (!child || child.terminal !== undefined) return;
		child.progress = progress;
	}
}
