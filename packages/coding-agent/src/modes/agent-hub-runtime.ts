import * as fs from "node:fs";
import type { AgentHubDeps, AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import {
	type AgentMetrics,
	aggregateMetrics,
	hubFallbackStatsSession,
	hubRowMetrics,
} from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import type { ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, hasLocalPresence, MAIN_AGENT_ID } from "../registry/agent-registry";
import { registerPersistedSubagents, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import { normalizeAssistantUsage, parseSessionEntries } from "../session/session-loader";

/** Filesystem and parser used by local and host-backed transcript viewers. */
export const agentTranscriptSource: AgentTranscriptSource = {
	fs,
	parseEntries: text => {
		const entries = parseSessionEntries(text).filter(
			entry => entry.type === "message" || entry.type === "model_change",
		);
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant") normalizeAssistantUsage(entry.message);
		}
		return entries;
	},
};

/** Host services used by the roster, without exposing runtime implementation to tui. */
export function createAgentHubRuntime(
	options: {
		registry?: AgentRegistry;
		lifecycle?: AgentLifecycleManager;
		irc?: IrcBus;
		activity?: AgentActivityIndex;
		remote?: AgentHubRemote;
		settings?: Settings;
		sessionFile?: string | null;
	} = {},
): Pick<
	AgentHubDeps<AgentRef>,
	| "registry"
	| "hasLocalPresence"
	| "lifecycle"
	| "irc"
	| "activity"
	| "manageActivityLive"
	| "transcript"
	| "loadPersisted"
	| "getRoleInfo"
> {
	const registry = options.registry ?? AgentRegistry.global();
	return {
		registry,
		hasLocalPresence,
		lifecycle: () => options.lifecycle ?? AgentLifecycleManager.forRegistry(registry),
		irc: options.irc ?? IrcBus.forRegistry(registry),
		activity: options.activity ?? new AgentActivityIndex({ remote: options.remote }),
		manageActivityLive: !options.activity,
		transcript: agentTranscriptSource,
		loadPersisted: shouldContinue => registerPersistedSubagents(registry, options.sessionFile, { shouldContinue }),
		getRoleInfo: options.settings ? role => getRoleInfo(role, options.settings!) : undefined,
	};
}

/**
 * Agent Hub cost total for the main session's subagent tree (descendants
 * included). Excludes the main session's own advisors, which the status line
 * bills separately. Refs with a transcript count only inside `rootSessionFile`'s
 * artifacts tree (the process-global registry keeps earlier sessions' agents);
 * file-less refs count only while this session's observer tracks them.
 */
export function sumSubagentTreeCost(args: {
	refs: readonly AgentRef[];
	observers: SessionObserverRegistry;
	rootSessionFile: string | undefined;
	sessionMetrics: WeakMap<object, { metrics: AgentMetrics | undefined }>;
}): number {
	const { observers, rootSessionFile, sessionMetrics } = args;
	const rows: AgentRef[] = [];
	const observedById = new Map<string, ObservableSession>();
	for (const ref of args.refs) {
		if (ref.id === MAIN_AGENT_ID) continue;
		if (ref.kind === "advisor" && (ref.parentId ?? MAIN_AGENT_ID) === MAIN_AGENT_ID) continue;
		const observed = observers.getSession(ref.id);
		const inTree = ref.sessionFile
			? rootSessionFile !== undefined && sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile)
			: observed !== undefined;
		if (!inTree) continue;
		rows.push(ref);
		if (observed) observedById.set(ref.id, observed);
	}
	return aggregateMetrics({
		rows,
		observedById,
		metricsFor: (ref, observed) => hubRowMetrics(ref, observed, sessionMetrics),
		fallbackStatsSession: hubFallbackStatsSession,
		sessionMetrics,
		refreshFallback: true,
	}).metrics.cost;
}
