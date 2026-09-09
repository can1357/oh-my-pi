import type { AgentRef, AgentStatus, RegistryEvent } from "../../registry/agent-registry";
import { AgentRegistry } from "../../registry/agent-registry";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "../../task/types";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { EventBus } from "../../utils/event-bus";

const SUBAGENT_SNAPSHOT_LIMIT = 512;
const OBSERVABILITY_LABEL_LIMIT = 256;

export type SubagentId = string;
export type SubagentStatus =
	| "registered"
	| "running"
	| "idle"
	| "parked"
	| "completed"
	| "failed"
	| "aborted"
	| "removed";
export type SubagentKind = "root" | "task" | "eval" | "other";

export interface SubagentProgress {
	readonly updatedAt: number;
	readonly phase?: string;
	readonly currentTool?: string;
	readonly toolCount?: number;
	readonly tokens?: number;
	readonly contextTokens?: number;
	readonly costUsd?: number;
	readonly resolvedModel?: string;
	readonly effort?: ConfiguredThinkingLevel;
}

export interface SubagentRecord {
	readonly agentId: SubagentId;
	readonly rootAgentId: SubagentId;
	readonly parentAgentId?: SubagentId;
	readonly parentToolCallId?: string;
	readonly kind: SubagentKind;
	readonly status: SubagentStatus;
	readonly detached: boolean;
	readonly sessionId?: string;
	readonly startedAt: number;
	readonly lastActivityAt: number;
	readonly progress?: SubagentProgress;
}

export interface SubagentSnapshot {
	readonly version: 1;
	readonly rootAgentId: SubagentId;
	readonly revision: number;
	readonly capturedAt: number;
	readonly agents: readonly SubagentRecord[];
}

export interface SubagentEventBase {
	readonly version: 1;
	readonly revision: number;
	readonly observedAt: number;
	readonly rootAgentId: SubagentId;
	readonly agentId: SubagentId;
}

export type SubagentEvent =
	| (SubagentEventBase & { readonly type: "registered"; readonly agent: SubagentRecord })
	| (SubagentEventBase & {
			readonly type: "lifecycle";
			readonly from: SubagentStatus;
			readonly to: SubagentStatus;
			readonly agent: SubagentRecord;
	  })
	| (SubagentEventBase & {
			readonly type: "progress";
			readonly progress: SubagentProgress;
			readonly agent: SubagentRecord;
	  })
	| (SubagentEventBase & { readonly type: "removed"; readonly finalStatus: SubagentStatus });

type SubagentEventInput = SubagentEvent extends infer Event
	? Event extends SubagentEvent
		? Omit<Event, "version" | "revision" | "observedAt" | "rootAgentId">
		: never
	: never;

/** Read-only, sanitized view of the current root session's agent tree. */
export interface SubagentObservability {
	readonly version: 1;
	getSnapshot(): SubagentSnapshot;
	subscribe(listener: (event: SubagentEvent) => void): () => void;
}

export interface CreateSubagentObservabilityOptions {
	registry?: AgentRegistry;
	eventBus: EventBus;
	rootAgentId: string;
	now?: () => number;
}

export interface SubagentObservabilityController extends SubagentObservability {
	dispose(): void;
}

/** Resolve an agent's root from stable registry parent links. */
export function resolveRootAgentId(registry: AgentRegistry, agentId: string): string {
	let current = registry.get(agentId);
	const visited = new Set<string>();
	while (current?.parentId && !visited.has(current.id)) {
		visited.add(current.id);
		const parent = registry.get(current.parentId);
		if (!parent) return current.parentId;
		current = parent;
	}
	return current?.id ?? agentId;
}

function registryStatus(status: AgentStatus): SubagentStatus {
	return status;
}

function lifecycleStatus(status: SubagentLifecyclePayload["status"]): SubagentStatus {
	return status === "started" ? "running" : status;
}

function copyProgress(progress: SubagentProgress): SubagentProgress {
	return { ...progress };
}

function copyRecord(record: SubagentRecord): SubagentRecord {
	return { ...record, ...(record.progress ? { progress: copyProgress(record.progress) } : {}) };
}

function copyEvent(event: SubagentEvent): SubagentEvent {
	if (event.type === "removed") return { ...event };
	if (event.type === "progress") {
		return { ...event, progress: copyProgress(event.progress), agent: copyRecord(event.agent) };
	}
	return { ...event, agent: copyRecord(event.agent) };
}

function sanitizedLabel(value: string): string {
	return Array.from(value)
		.filter(character => {
			const code = character.codePointAt(0) ?? 0;
			return code >= 32 && code !== 127;
		})
		.join("")
		.slice(0, OBSERVABILITY_LABEL_LIMIT);
}

export function createSubagentObservability(
	options: CreateSubagentObservabilityOptions,
): SubagentObservabilityController {
	const registry = options.registry ?? AgentRegistry.global();
	const now = options.now ?? Date.now;
	const listeners = new Set<(event: SubagentEvent) => void>();
	const statuses = new Map<string, SubagentStatus>();
	const metadata = new Map<string, { parentToolCallId?: string; detached?: boolean; progress?: SubagentProgress }>();
	let revision = 0;
	let disposed = false;

	const rootOf = (ref: AgentRef): string => {
		let current = ref;
		const visited = new Set<string>();
		while (current.parentId && !visited.has(current.id)) {
			visited.add(current.id);
			const parent = registry.get(current.parentId);
			if (!parent) return current.parentId;
			current = parent;
		}
		return current.id;
	};
	const belongs = (ref: AgentRef): boolean => rootOf(ref) === options.rootAgentId;
	const getRef = (agentId: string): AgentRef | undefined => {
		const ref = registry.get(agentId);
		return ref && belongs(ref) ? ref : undefined;
	};
	const makeProgress = (payload: SubagentProgressPayload): SubagentProgress => ({
		updatedAt: now(),
		...(payload.progress.currentTool ? { currentTool: sanitizedLabel(payload.progress.currentTool) } : {}),
		toolCount: payload.progress.toolCount,
		tokens: payload.progress.tokens,
		...(payload.progress.contextTokens === undefined ? {} : { contextTokens: payload.progress.contextTokens }),
		costUsd: payload.progress.cost,
		...(payload.progress.resolvedModelIdentity
			? { resolvedModel: sanitizedLabel(payload.progress.resolvedModelIdentity) }
			: {}),
		...(payload.progress.resolvedThinkingLevel ? { effort: payload.progress.resolvedThinkingLevel } : {}),
	});
	const makeRecord = (ref: AgentRef): SubagentRecord => {
		const extra = metadata.get(ref.id);
		const sessionId = ref.session?.sessionId;
		return {
			agentId: ref.id,
			rootAgentId: options.rootAgentId,
			...(ref.parentId ? { parentAgentId: ref.parentId } : {}),
			...(extra?.parentToolCallId ? { parentToolCallId: extra.parentToolCallId } : {}),
			kind: ref.id === options.rootAgentId ? "root" : ref.kind === "sub" ? (ref.invocationKind ?? "task") : "other",
			status: statuses.get(ref.id) ?? registryStatus(ref.status),
			detached: extra?.detached ?? false,
			...(sessionId ? { sessionId } : {}),
			startedAt: ref.createdAt,
			lastActivityAt: ref.lastActivity,
			...(extra?.progress ? { progress: copyProgress(extra.progress) } : {}),
		};
	};
	const publish = (event: SubagentEventInput): void => {
		if (disposed) return;
		const full = {
			...event,
			version: 1 as const,
			revision: ++revision,
			observedAt: now(),
			rootAgentId: options.rootAgentId,
		} as SubagentEvent;
		for (const listener of listeners) {
			try {
				listener(copyEvent(full));
			} catch {
				// Public observers are isolated from execution and from one another.
			}
		}
	};

	for (const ref of registry.list()) {
		if (belongs(ref)) statuses.set(ref.id, registryStatus(ref.status));
	}

	const handleRegistry = (event: RegistryEvent): void => {
		if (!belongs(event.ref)) return;
		if (event.type === "registered") {
			statuses.set(event.ref.id, registryStatus(event.ref.status));
			publish({ type: "registered", agentId: event.ref.id, agent: makeRecord(event.ref) });
			return;
		}
		if (event.type === "status_changed") {
			const from = statuses.get(event.ref.id) ?? "registered";
			const to = registryStatus(event.ref.status);
			statuses.set(event.ref.id, to);
			if (from !== to) {
				publish({ type: "lifecycle", agentId: event.ref.id, from, to, agent: makeRecord(event.ref) });
			}
			return;
		}
		if (event.type === "removed") {
			const finalStatus = statuses.get(event.ref.id) ?? registryStatus(event.ref.status);
			publish({ type: "removed", agentId: event.ref.id, finalStatus });
			statuses.delete(event.ref.id);
			metadata.delete(event.ref.id);
		}
	};
	const registryUnsubscribe = registry.onChange(handleRegistry);
	const lifecycleUnsubscribe = options.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		const payload = data as SubagentLifecyclePayload;
		const ref = getRef(payload.id);
		if (!ref) return;
		const prior = metadata.get(payload.id) ?? {};
		metadata.set(payload.id, {
			...prior,
			...(payload.parentToolCallId ? { parentToolCallId: payload.parentToolCallId } : {}),
			...(payload.detached === undefined ? {} : { detached: payload.detached }),
		});
		const from = statuses.get(payload.id) ?? registryStatus(ref.status);
		const to = lifecycleStatus(payload.status);
		statuses.set(payload.id, to);
		publish({ type: "lifecycle", agentId: payload.id, from, to, agent: makeRecord(ref) });
	});
	const progressUnsubscribe = options.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
		const payload = data as SubagentProgressPayload;
		const ref = getRef(payload.progress.id);
		if (!ref) return;
		const progress = makeProgress(payload);
		const prior = metadata.get(ref.id) ?? {};
		metadata.set(ref.id, {
			...prior,
			progress,
			...(payload.parentToolCallId ? { parentToolCallId: payload.parentToolCallId } : {}),
			...(payload.detached === undefined ? {} : { detached: payload.detached }),
		});
		publish({ type: "progress", agentId: ref.id, progress: copyProgress(progress), agent: makeRecord(ref) });
	});

	return {
		version: 1,
		getSnapshot: () => {
			const sorted = registry
				.list()
				.filter(belongs)
				.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
			const root = sorted.find(ref => ref.id === options.rootAgentId);
			const retained = sorted.filter(ref => ref !== root).slice(-(SUBAGENT_SNAPSHOT_LIMIT - (root ? 1 : 0)));
			return {
				version: 1,
				rootAgentId: options.rootAgentId,
				revision,
				capturedAt: now(),
				agents: [...(root ? [root] : []), ...retained].map(ref => copyRecord(makeRecord(ref))),
			};
		},
		subscribe: listener => {
			if (disposed) return () => {};
			listeners.add(listener);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				listeners.delete(listener);
			};
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			registryUnsubscribe();
			lifecycleUnsubscribe();
			progressUnsubscribe();
			listeners.clear();
			statuses.clear();
			metadata.clear();
		},
	};
}
