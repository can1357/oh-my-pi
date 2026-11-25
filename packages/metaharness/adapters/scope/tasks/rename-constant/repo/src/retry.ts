import { BASE_DELAY_MS, MAX_RETRIES } from "./config";

/** Runs `fn` until it resolves or `attempts` calls have failed, backing off between calls. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = MAX_RETRIES): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt + 1 < attempts) await Bun.sleep(BASE_DELAY_MS * 2 ** attempt);
		}
	}
	throw lastError;
}
