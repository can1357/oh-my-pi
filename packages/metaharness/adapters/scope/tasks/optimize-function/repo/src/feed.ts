/** Pause between feed pages: the supplier allows two requests a second. */
export const PAGE_PAUSE_MS = 500;

/** Pulls a supplier feed page by page until an empty page, pausing between requests to respect the rate limit. */
export async function importFeed(fetchPage: (page: number) => Promise<string[]>): Promise<string[]> {
	const names: string[] = [];
	for (let page = 0; ; page++) {
		const batch = await fetchPage(page);
		if (batch.length === 0) return names;
		names.push(...batch);
		await Bun.sleep(PAGE_PAUSE_MS);
	}
}
