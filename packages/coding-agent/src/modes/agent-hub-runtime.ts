import * as fs from "node:fs";
import type { AgentHubDeps, AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { type AgentCostSnapshot, aggregateCost } from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import type { ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { LiveTaskAgentRun } from "@oh-my-pi/pi-tui/tools/task";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus, type IrcBusApi } from "../irc/bus";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
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
		registry?: AgentRegistryApi;
		lifecycle?: AgentLifecycleApi;
		irc?: IrcBusApi;
		activity?: AgentActivityIndex;
		remote?: AgentHubRemote;
		settings?: Settings;
		sessionFile?: string | null;
	} = {},
): Pick<
	AgentHubDeps<AgentRef>,
	| "registry"
	| "inSession"
	| "lifecycle"
	| "irc"
	| "activity"
	| "manageActivityLive"
	| "transcript"
	| "loadPersisted"
	| "getRoleInfo"
> {
	const registry = options.registry ?? AgentRegistry.global();
	const rootSessionFile = options.sessionFile?.endsWith(".jsonl") ? options.sessionFile : undefined;
	const copied = new Set<AgentRecordLike>();
	return {
		registry,
		// Local roster only: a collab guest mirrors the host's registry, whose
		// transcript paths never sit under the guest's replica session.
		inSession:
			rootSessionFile && !options.remote
				? ref => inSessionTree(ref, rootSessionFile, true) || copied.has(ref)
				: undefined,
		lifecycle: () => options.lifecycle ?? AgentLifecycleManager.global(),
		irc: options.irc ?? IrcBus.global(),
		activity: options.activity ?? new AgentActivityIndex({ remote: options.remote }),
		manageActivityLive: !options.activity,
		transcript: agentTranscriptSource,
		loadPersisted: shouldContinue =>
			registerPersistedSubagents(registry, options.sessionFile, {
				shouldContinue,
				onCopiedRef: ref => copied.add(ref),
			}),
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
	sessionCosts: WeakMap<object, AgentCostSnapshot>;
}): number {
	const { observers, rootSessionFile, sessionCosts } = args;
	const rows: AgentRef[] = [];
	const observedById = new Map<string, ObservableSession>();
	for (const ref of args.refs) {
		if (ref.id === MAIN_AGENT_ID) continue;
		if (ref.kind === "advisor" && (ref.parentId ?? MAIN_AGENT_ID) === MAIN_AGENT_ID) continue;
		const observed = observers.getSession(ref.id);
		if (!inSessionTree(ref, rootSessionFile, observed !== undefined)) continue;
		rows.push(ref);
		if (observed) observedById.set(ref.id, observed);
	}
	return aggregateCost({ rows, observedById, sessionCosts });
}

/**
 * Whether `ref` sits in `rootSessionFile`'s session tree: a ref with a
 * transcript when that transcript is inside the session's artifacts tree; a
 * file-less ref as `fileLess` says, since only its caller knows who owns it.
 */
export function inSessionTree(
	ref: { readonly sessionFile?: string | null },
	rootSessionFile: string | undefined,
	fileLess: boolean,
): boolean {
	return ref.sessionFile
		? rootSessionFile !== undefined && sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile)
		: fileLess;
}

/**
 * Whether a task card in `rootSessionFile`'s transcript may draw `ref` running:
 * the registry outlives `/new` and session switches, and another session's
 * agent can hold the same id. Without a session file every ref counts.
 */
export function inTaskCardSession(
	ref: { readonly sessionFile?: string | null },
	rootSessionFile: string | undefined,
): boolean {
	return !rootSessionFile || inSessionTree(ref, rootSessionFile, true);
}

/**
 * What a settled task card row draws of agent `ref` while it runs again
 * (revived or woken by IRC or hub chat, or still running after its call
 * settled); undefined otherwise. Running is the registry's call, as for the
 * HUD's agents segment; `observed` progress adds the current tool. `inSession`
 * says whether the card's session owns the ref (see {@link inTaskCardSession}).
 */
export function liveTaskAgent(
	ref: AgentRef | undefined,
	observed: ObservableSession | undefined,
	inSession: (ref: AgentRef) => boolean,
): LiveTaskAgentRun | undefined {
	// A ref still `running` after its run handed over the final result is that run's tail, not a new run.
	if (ref?.kind !== "sub" || ref.status !== "running" || ref.lifecycle?.acceptedAt !== undefined) return undefined;
	if (!inSession(ref)) return undefined;
	// A started turn keeps the previous turn's last snapshot but clears `progressAt` until its own first frame.
	const current =
		observed?.status === "active" && observed.progressAt !== undefined && observed.progress?.status === "running";
	return { progress: current ? observed.progress : undefined };
}
