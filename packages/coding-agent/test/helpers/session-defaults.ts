import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	let enabledToolNames: string[] = [];
	let mountedToolNames: string[] = [];
	return {
		setActiveToolsByName: async (toolNames: string[]) => {
			enabledToolNames = [...toolNames];
		},
		async setActiveToolPresentation(
			this: Pick<AgentSession, "setActiveToolsByName">,
			toolNames: string[],
			mountedNames: string[],
		) {
			await this.setActiveToolsByName(toolNames);
			mountedToolNames = [...mountedNames];
		},
		getEnabledToolNames: () => [...enabledToolNames],
		getActiveToolNames: () => enabledToolNames.filter(name => !mountedToolNames.includes(name)),
		getMountedXdevToolNames: () => [...mountedToolNames],
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		holdIrcWakes: () => () => {},
		isParentIrcSteer: () => false,
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
		addDisposer: () => {},
	} satisfies Partial<AgentSession>;
}
