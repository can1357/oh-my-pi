/**
 * How long after a page reports a download Chrome's item for it may still appear. Chrome announces the item right after
 * the report, so one unpaired for longer never got an item (Chrome refused the download) and must not take a later
 * download's.
 */
export const DOWNLOAD_PAIRING_MS = 5_000;
/**
 * How long a pair outlives its completed download. omp looks the file up as soon as the page reports the completion, so
 * a pair still here after this belongs to a tab that went away first.
 */
export const DOWNLOAD_LOOKUP_MS = 60_000;

/**
 * Pairs a driven page's download reports (`Page.downloadWillBegin`, named by guid) with Chrome's download items
 * (`chrome.downloads.onCreated`, named by id). Neither names the other, but Chrome reports a download to the page's
 * debugger right before it announces the item, so an item pairs with the oldest recent report of its URL. A download
 * in a tab omp does not drive has no report and pairs with nothing; if Chrome ever announced an item first, its lookup
 * would find no pair and fail rather than name another download's file.
 */
export class DownloadPairing {
	readonly #now: () => number;
	/** Chrome's item for each paired report, with when the download completed. */
	readonly #pairs = new Map<string, { id: number; completedAt?: number }>();
	/** Reports waiting for Chrome's item, oldest first. */
	readonly #reports: Array<{ guid: string; url: string; at: number }> = [];

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	report(guid: string, url: string): void {
		if (this.#pairs.has(guid) || this.#reports.some(report => report.guid === guid)) return;
		this.#dropAgedReports();
		this.#reports.push({ guid, url, at: this.#now() });
	}

	created(id: number, url: string): void {
		this.#dropAgedReports();
		const index = this.#reports.findIndex(report => report.url === url);
		if (index < 0) return;
		this.#pairs.set(this.#reports[index]!.guid, { id });
		this.#reports.splice(index, 1);
	}

	/** Reports are bounded by age alone: dropping a recent one would shift every later pairing of its URL. */
	#dropAgedReports(): void {
		const oldest = this.#now() - DOWNLOAD_PAIRING_MS;
		while (this.#reports.length > 0 && this.#reports[0]!.at < oldest) this.#reports.shift();
	}

	/**
	 * Chrome's item `id` stopped running. A canceled or failed download is never looked up, so its pair goes now; a
	 * completed one stays for the lookup, and pairs completed longer than {@link DOWNLOAD_LOOKUP_MS} ago go.
	 */
	finished(id: number, state: "interrupted" | "complete"): void {
		const now = this.#now();
		for (const [guid, pair] of this.#pairs) {
			if (pair.id === id) {
				if (state === "interrupted") this.#pairs.delete(guid);
				else pair.completedAt = now;
			} else if (pair.completedAt !== undefined && pair.completedAt < now - DOWNLOAD_LOOKUP_MS) {
				this.#pairs.delete(guid);
			}
		}
	}

	/** Chrome's download id for the report `guid`, if an item paired with it. */
	idFor(guid: string): number | undefined {
		return this.#pairs.get(guid)?.id;
	}

	/** Drop the pair once its download is over and looked up. */
	forget(guid: string): void {
		this.#pairs.delete(guid);
	}
}
