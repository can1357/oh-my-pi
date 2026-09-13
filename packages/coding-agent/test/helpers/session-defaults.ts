import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	return {
		setActiveToolsByName: async (_toolNames: string[]) => {},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
	} satisfies Partial<AgentSession>;
}
