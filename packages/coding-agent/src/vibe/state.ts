/** Vibe mode session-level state, mirroring {@link ../plan-mode/state.ts}. */
export interface VibeModeState {
	enabled: boolean;
	/** Plan mode holds this session's Vibe workers parked; structural transitions stay blocked until it exits. */
	suspendedForPlan?: boolean;
}
