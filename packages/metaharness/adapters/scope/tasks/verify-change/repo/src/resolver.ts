import type { Upstream } from "./upstream";

const BASE_DELAY_MS = 250;

/**
 * Resolves `slug` through the redirect service, retrying with exponential backoff.
 * @throws the last upstream error once `attempts` calls have failed.
 */
export async function resolveWithRetry(upstream: Upstream, slug: string, attempts = 5): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await upstream.resolve(slug);
		} catch (err) {
			if (attempt >= attempts) throw err;
			await Bun.sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
		}
	}
}
