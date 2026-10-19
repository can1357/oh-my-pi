import type { CreateAgentSessionOptions } from "../sdk";

export const SEANCE_AGENT_NAME = "seance";

/** Session capabilities shared by fresh startup and cold restoration. */
export function seanceIsolationOptions(cwd: string) {
	return {
		disableExtensionDiscovery: true,
		restrictToolNames: true,
		enableMCP: false,
		mcpManager: undefined,
		mcpTools: [],
		enableIrc: false,
		enableLsp: false,
		spawns: "",
		additionalDirectories: [],
		inheritedSessionAgents: undefined,
		contextFiles: [],
		skills: [],
		workspaceTree: {
			rootPath: cwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		promptTemplates: [],
		rules: [],
		extensionRoots: undefined,
		preloadedExtensionPaths: [],
		preloadedPreparedExtensions: [],
		preloadedCustomToolPaths: [],
		customTools: undefined,
		localProtocolOptions: undefined,
		parentHindsightSessionState: undefined,
		parentMnemopiSessionState: undefined,
	} satisfies Partial<CreateAgentSessionOptions>;
}
