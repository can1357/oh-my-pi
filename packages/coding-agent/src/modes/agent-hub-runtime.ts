import * as fs from "node:fs";
import { applyEntryPatches, isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";
import type { AgentHubRemote } from "./view-model/overlays/agent-hub";
import type { AgentRecordLike } from "../registry/agent-hub-types";
import { type AgentCostSnapshot, type AgentTreeSpend, aggregateCost } from "./view-model/overlays/agent-hub-projection";
import type { AgentTranscriptEntry, AgentTranscriptSource } from "./view-model/overlays/agent-transcript-viewer";
import type { ObservableSession, SessionObserverRegistry } from "../task/session-observer-registry";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus, type IrcBusApi } from "../irc/bus";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { isSessionTreeRef, registerPersistedSubagents, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import { WINDOW_ENTRY_PATCH_HOOKS } from "../session/entry-patches";
import { normalizeAssistantUsage, parseSessionEntries } from "../session/session-loader";
import type { AgentHubProps } from "../ui/overlays/pickers/agent-hub";

/**
 * Filesystem and parser used by local and host-backed transcript viewers. The
 * parser applies a read's `entry_patch` records to its entries and returns the
 * records too, for the viewer to apply to entries of earlier reads.
 */
export const agentTranscriptSource: AgentTranscriptSource = {
	fs,
	parseEntries: text => {
		const parsed = parseSessionEntries(text);
		applyEntryPatches(parsed, WINDOW_ENTRY_PATCH_HOOKS);
		const entries: AgentTranscriptEntry[] = [];
		for (const entry of parsed) {
			if (entry.type === "message") {
				if (entry.message.role === "assistant") normalizeAssistantUsage(entry.message);
				entries.push(entry);
			} else if (entry.type === "model_change" || isEntryPatchRecord(entry)) {
				entries.push(entry);
			}
		}
		return entries;
	},
};

/** Host services the Agent Hub reads (registry, lifecycle, IRC, activity), plus the transcript source its viewer reads. */
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
	AgentHubProps<AgentRef>,
	"registry" | "inSession" | "lifecycle" | "irc" | "activity" | "manageActivityLive" | "loadPersisted" | "getRoleInfo"
> & { transcript: AgentTranscriptSource } {
	const registry = options.registry ?? AgentRegistry.global();
	const rootSessionFile = options.sessionFile?.endsWith(".jsonl") ? options.sessionFile : undefined;
	const copied = new Set<AgentRecordLike>();
	return {
		registry,
		// Local roster only: a collab guest mirrors the host's registry, whose
		// transcript paths never sit under the guest's replica session.
		inSession:
			rootSessionFile && !options.remote
				? ref => isSessionTreeRef(ref, rootSessionFile) || copied.has(ref)
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
 * Agent Hub spend (dollars and AI credits) for the main session's subagent tree
 * (descendants included). Excludes the main session's own advisors, which the
 * status line bills separately. Refs with a transcript count only inside
 * `rootSessionFile`'s artifacts tree (the process-global registry keeps earlier
 * sessions' agents); file-less refs count only while this session's observer
 * tracks them, so without `observers` only transcript-backed refs count.
 */
export function sumSubagentTreeCost(args: {
	refs: readonly AgentRef[];
	observers?: SessionObserverRegistry;
	rootSessionFile: string | undefined;
	sessionCosts: WeakMap<object, AgentCostSnapshot>;
}): AgentTreeSpend {
	const { observers, rootSessionFile, sessionCosts } = args;
	const rows: AgentRef[] = [];
	const observedById = new Map<string, ObservableSession>();
	// Multi-session hosts (ACP, SDK) register each root as `kind: "main"` under
	// its own id, not `MAIN_AGENT_ID`. A root and its advisors are billed apart
	// from the tree, and a root's transcript always belongs to itself.
	const mainIds = new Set([MAIN_AGENT_ID]);
	for (const ref of args.refs) if (ref.kind === "main") mainIds.add(ref.id);
	for (const ref of args.refs) {
		if (mainIds.has(ref.id)) continue;
		if (ref.kind === "advisor" && mainIds.has(ref.parentId ?? MAIN_AGENT_ID)) continue;
		const observed = observers?.getSession(ref.id);
		const inTree = ref.sessionFile
			? rootSessionFile !== undefined && sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile)
			: observed !== undefined;
		if (!inTree) continue;
		rows.push(ref);
		if (observed) observedById.set(ref.id, observed);
	}
	return aggregateCost({ rows, observedById, sessionCosts });
}
