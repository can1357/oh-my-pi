import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	const sessionManager = SessionManager.inMemory();
	const runStateListeners = new Set<(state: "running" | "idle") => void>();
	const sessionChangeCallbacks = new Set<() => void>();
	const disposers: Array<() => void> = [];
	let disposed = false;
	return {
		sessionManager,
		// Persisted-run disposal captures overlay writes even when the session is not kept alive.
		settings: Settings.isolated({}),
		// These fixtures model ordinary assignment work, never a diagnostic reminder turn.
		isStallDiagnosticTurn: () => false,
		setActiveToolsByName: async (_toolNames: string[]) => {},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			for (const dispose of disposers.splice(0)) dispose();
			runStateListeners.clear();
			sessionChangeCallbacks.clear();
			await sessionManager.close();
		},
		setIrcWakeTurnObserver: () => {},
		isAdvisorActive: () => false,
		subscribeRunState: (listener: (state: "running" | "idle") => void) => {
			runStateListeners.add(listener);
			return () => {
				runStateListeners.delete(listener);
			};
		},
		registerSessionChangeCallback: (callback: () => void) => {
			sessionChangeCallbacks.add(callback);
			return () => {
				sessionChangeCallbacks.delete(callback);
			};
		},
		addDisposer: (dispose: () => void) => {
			disposers.push(dispose);
		},
	} satisfies Partial<AgentSession>;
}
