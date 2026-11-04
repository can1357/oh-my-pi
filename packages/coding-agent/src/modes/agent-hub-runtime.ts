import type { AgentHubDeps, AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentRecordLike } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { type AgentCostSnapshot, aggregateCost } from "@oh-my-pi/pi-tui/overlays/agent-hub-projection";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import type { ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus, type IrcBusApi } from "../irc/bus";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { registerPersistedSubagents, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import { normalizeAssistantUsage, parseSessionEntries } from "../session/session-loader";
import { defaultSessionStorage, readSessionTextFrom, type SessionStorage } from "../session/session-storage";

/**
 * Transcript reads and parser used by local and host-backed transcript viewers.
 * Reads go through `storage()`, the session storage holding the transcripts:
 * under `session.storage: sql` a transcript is a row with no file behind it.
 */
function transcriptSource(storage: () => SessionStorage): AgentTranscriptSource {
	return {
		stat: file => storage().statSync(file),
		readFrom: async (file, offset) => (await readSessionTextFrom(storage(), file, offset)).text,
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
}

/** {@link transcriptSource} over the default session storage, for viewers without a session at hand. */
export const agentTranscriptSource: AgentTranscriptSource = transcriptSource(defaultSessionStorage);

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
		/** Storage the session's subagent tree lives in (its session manager's); default: the default session storage. */
		storage?: SessionStorage;
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
	const { storage } = options;
	const rootSessionFile = options.sessionFile?.endsWith(".jsonl") ? options.sessionFile : undefined;
	const copied = new Set<AgentRecordLike>();
	return {
		registry,
		// Local roster only: a collab guest mirrors the host's registry, whose
		// transcript paths never sit under the guest's replica session.
		inSession:
			rootSessionFile && !options.remote
				? ref => !ref.sessionFile || sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile) || copied.has(ref)
				: undefined,
		lifecycle: () => options.lifecycle ?? AgentLifecycleManager.global(),
		irc: options.irc ?? IrcBus.global(),
		activity: options.activity ?? new AgentActivityIndex({ remote: options.remote, storage }),
		manageActivityLive: !options.activity,
		transcript: storage ? transcriptSource(() => storage) : agentTranscriptSource,
		loadPersisted: shouldContinue =>
			registerPersistedSubagents(registry, options.sessionFile, {
				shouldContinue,
				storage,
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
		const inTree = ref.sessionFile
			? rootSessionFile !== undefined && sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile)
			: observed !== undefined;
		if (!inTree) continue;
		rows.push(ref);
		if (observed) observedById.set(ref.id, observed);
	}
	return aggregateCost({ rows, observedById, sessionCosts });
}
