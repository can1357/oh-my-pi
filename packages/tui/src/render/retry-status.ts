/** Render connection waits from their explicit state, not a numeric retry limit. */
export function formatRetryStatus(
	state: { attempt: number; maxAttempts: number; connectivity?: boolean },
	prefix = "retry",
): string {
	return state.connectivity ? "waiting for connection" : `${prefix} ${state.attempt}/${state.maxAttempts}`;
}
