/** Vibe mode session-level state, mirroring {@link ../plan-mode/state.ts}. */
export interface VibeModeState {
	enabled: boolean;
	/** Pre-vibe active tool names, journaled on mode_change for exit restore. */
	previousTools?: string[];
}
