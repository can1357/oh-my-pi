import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	return {
		setActiveToolsByName: async (_toolNames: string[]) => {},
		getMountedToolCommandNames: () => [],
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		isRunActive: false,
		wakeSources: undefined,
		waitForRunEnd: async () => {},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		holdIrcWakes: () => () => {},
		isParentIrcSteer: () => false,
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
		addDisposer: () => {},
		getWorkPoolYieldItems: () => [],
		sessionManager: { getEntries: () => [] } as unknown as AgentSession["sessionManager"],
	} satisfies Partial<AgentSession>;
}
