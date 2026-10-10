export const SEANCE_AGENT_NAME = "seance";

/** Options cleared on both fresh seance creation and cold revival. */
export interface SeanceIsolationOptions {
	disableExtensionDiscovery: true;
	additionalDirectories: undefined;
	inheritedSessionAgents: undefined;
	contextFiles: never[];
	autoloadSkills: never[];
	skills: never[];
	workspaceTree: undefined;
	promptTemplates: never[];
	rules: never[];
	extensionRoots: undefined;
	preloadedExtensionPaths: never[];
	preloadedPreparedExtensions: never[];
	preloadedCustomToolPaths: never[];
	customTools: undefined;
	localProtocolOptions: undefined;
	parentArtifactManager: undefined;
	parentHindsightSessionState: undefined;
	parentMnemopiSessionState: undefined;
}

export function seanceIsolationOptions(): SeanceIsolationOptions {
	return {
		disableExtensionDiscovery: true,
		additionalDirectories: undefined,
		inheritedSessionAgents: undefined,
		autoloadSkills: [],
		contextFiles: [],
		skills: [],
		workspaceTree: undefined,
		promptTemplates: [],
		rules: [],
		extensionRoots: undefined,
		preloadedExtensionPaths: [],
		preloadedPreparedExtensions: [],
		preloadedCustomToolPaths: [],
		customTools: undefined,
		localProtocolOptions: undefined,
		parentArtifactManager: undefined,
		parentHindsightSessionState: undefined,
		parentMnemopiSessionState: undefined,
	};
}
