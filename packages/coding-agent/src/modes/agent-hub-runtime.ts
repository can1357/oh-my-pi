import * as fs from "node:fs";
import type { AgentHubDeps, AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, hasLocalPresence } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import { parseSessionEntries } from "../session/session-loader";

/** Filesystem and parser used by local and host-backed transcript viewers. */
export const agentTranscriptSource: AgentTranscriptSource = {
	fs,
	parseEntries: text =>
		parseSessionEntries(text).filter(entry => entry.type === "message" || entry.type === "model_change"),
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
	"registry" | "hasLocalPresence" | "lifecycle" | "irc" | "activity" | "manageActivityLive" | "transcript" | "loadPersisted" | "getRoleInfo"
> {
	const registry = options.registry ?? AgentRegistry.global();
	return {
		registry,
		hasLocalPresence,
		lifecycle: () => options.lifecycle ?? AgentLifecycleManager.global(),
		irc: options.irc ?? IrcBus.forRegistry(registry),
		activity: options.activity ?? new AgentActivityIndex({ remote: options.remote }),
		manageActivityLive: !options.activity,
		transcript: agentTranscriptSource,
		loadPersisted: shouldContinue => registerPersistedSubagents(registry, options.sessionFile, { shouldContinue }),
		getRoleInfo: options.settings ? role => getRoleInfo(role, options.settings!) : undefined,
	};
}
