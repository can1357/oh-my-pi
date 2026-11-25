import { MAX_RETRIES } from "./config";
import { withRetry } from "./retry";

/** GETs `url` as JSON, retrying failed requests up to `retries` times. */
export async function getJson(url: string, retries = MAX_RETRIES): Promise<unknown> {
	return withRetry(async () => {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.json();
	}, retries);
}
