/** `maxAttempts: 0` denotes an unlimited provider-connection wait. */
export function formatRetryStatus(attempt: number, maxAttempts: number, prefix = "retry"): string {
	return maxAttempts === 0 ? "waiting for connection" : `${prefix} ${attempt}/${maxAttempts}`;
}
