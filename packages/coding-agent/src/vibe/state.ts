import type { VibeCli, VibeSessionState } from "@oh-my-pi/pi-tui/tools/vibe";

/** Vibe mode session-level state, mirroring {@link ../plan-mode/state.ts}. */
export interface VibeModeState {
	enabled: boolean;
}

/** Minimal per-worker roster line for the director's rebuilt context message. */
export interface VibeRosterEntry {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	turns: number;
	/** One-line gist of the latest activity, when known. */
	lastActivity?: string;
}
