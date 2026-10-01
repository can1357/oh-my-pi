import { log } from "../log";

export interface RetryOptions {
	maxAttempts?: number;
	delayMs?: number;
}

export async function retryFailed(task: () => Promise<void>, opts: RetryOptions = {}): Promise<boolean> {
	const maxAttempts = opts.maxAttempts ?? 3;
	const delayMs = opts.delayMs ?? 500;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await task();
			return true;
		} catch (err) {
			log.warn("attempt failed", { attempt, error: String(err) });
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
	}
	log.error("giving up", { maxAttempts });
	return false;
}
