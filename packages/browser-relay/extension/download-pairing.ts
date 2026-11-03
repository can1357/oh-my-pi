/**
 * How long after a page reports a download Chrome's item for it may still appear. Chrome announces the item right after
 * the report, so one unpaired for longer never got an item (Chrome refused the download) and must not take a later
 * download's.
 */
export const DOWNLOAD_PAIRING_MS = 5_000;
/** Unpaired reports kept at most. */
const MAX_REPORTS = 32;
/** Paired downloads kept at most; one nobody looks up (canceled, say) is dropped in time. */
const MAX_PAIRED = 256;

/**
 * Pairs a driven page's download reports (`Page.downloadWillBegin`, named by guid) with Chrome's download items
 * (`chrome.downloads.onCreated`, named by id). Neither names the other, but Chrome reports a download to the page's
 * debugger right before it announces the item, so an item pairs with the oldest recent report of its URL. A download
 * in a tab omp does not drive has no report and pairs with nothing; if Chrome ever announced an item first, its lookup
 * would find no pair and fail rather than name another download's file.
 */
export class DownloadPairing {
	readonly #now: () => number;
	readonly #ids = new Map<string, number>();
	/** Reports waiting for Chrome's item, oldest first. */
	readonly #reports: Array<{ guid: string; url: string; at: number }> = [];

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	report(guid: string, url: string): void {
		if (this.#ids.has(guid) || this.#reports.some(report => report.guid === guid)) return;
		this.#reports.push({ guid, url, at: this.#now() });
		if (this.#reports.length > MAX_REPORTS) this.#reports.shift();
	}

	created(id: number, url: string): void {
		const oldest = this.#now() - DOWNLOAD_PAIRING_MS;
		while (this.#reports.length > 0 && this.#reports[0]!.at < oldest) this.#reports.shift();
		const index = this.#reports.findIndex(report => report.url === url);
		if (index < 0) return;
		this.#ids.set(this.#reports[index]!.guid, id);
		this.#reports.splice(index, 1);
		if (this.#ids.size > MAX_PAIRED) this.#ids.delete(this.#ids.keys().next().value!);
	}

	/** Chrome's download id for the report `guid`, if an item paired with it. */
	idFor(guid: string): number | undefined {
		return this.#ids.get(guid);
	}

	/** Drop the pair once its download is over and looked up. */
	forget(guid: string): void {
		this.#ids.delete(guid);
	}
}
