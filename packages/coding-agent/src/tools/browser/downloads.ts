import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Completed download metadata returned by tab download helpers. */
export interface BrowserDownload {
	path: string;
	suggestedFilename: string;
	url: string;
	bytes: number;
}

interface DownloadStarted {
	guid: string;
	url: string;
	suggestedFilename: string;
}

interface DownloadProgress {
	guid: string;
	state: "inProgress" | "completed" | "canceled";
	receivedBytes: number;
}

interface PendingDownload extends DownloadStarted {
	receivedBytes: number;
}

interface DownloadWaiter {
	resolve(value: BrowserDownload): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** Owns tab-scoped Chromium download behavior and completion events. */
export class DownloadManager {
	readonly #browser: Browser;
	readonly #page: Page;
	readonly #defaultDirectory: string;
	#directory?: string;
	#session?: CDPSession;
	#frameId?: string;
	readonly #pending = new Map<string, PendingDownload>();
	readonly #completed: BrowserDownload[] = [];
	readonly #unclaimed: BrowserDownload[] = [];
	readonly #waiters: DownloadWaiter[] = [];
	#willBegin?: (event: DownloadStarted & { frameId?: string }) => void;
	#progress?: (event: DownloadProgress) => void;

	constructor(browser: Browser, page: Page, tabId: string) {
		this.#browser = browser;
		this.#page = page;
		this.#defaultDirectory = path.join(os.tmpdir(), `omp-downloads-${tabId}`);
	}

	/** Enable downloads into an absolute directory, replacing the previous destination. */
	async enable(directory?: string): Promise<void> {
		const resolved = path.resolve(directory ?? this.#defaultDirectory);
		await fs.mkdir(resolved, { recursive: true });
		if (!this.#session) await this.#attach();
		const context = this.#page.browserContext() as { id?: string };
		await this.#session!.send("Browser.setDownloadBehavior", {
			behavior: "allow",
			downloadPath: resolved,
			eventsEnabled: true,
			...(context.id ? { browserContextId: context.id } : {}),
		});
		this.#directory = resolved;
	}

	/** Wait for the next unclaimed completed download. */
	async wait(signal?: AbortSignal): Promise<BrowserDownload> {
		if (!this.#session) await this.enable();
		const ready = this.#unclaimed.shift();
		if (ready) return { ...ready };
		if (signal?.aborted) throw signal.reason;
		return await new Promise<BrowserDownload>((resolve, reject) => {
			const waiter: DownloadWaiter = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					this.#removeWaiter(waiter);
					reject(signal.reason);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.#waiters.push(waiter);
		});
	}

	/** Return every completed download for this tab. */
	list(): BrowserDownload[] {
		return this.#completed.map(download => ({ ...download }));
	}

	/** Detach event listeners and reject outstanding waits. */
	async close(): Promise<void> {
		const session = this.#session;
		if (!session) return;
		if (this.#willBegin) session.off("Browser.downloadWillBegin", this.#willBegin);
		if (this.#progress) session.off("Browser.downloadProgress", this.#progress);
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new ToolError("Tab closed while waiting for a download"));
		}
		this.#session = undefined;
		await session.detach().catch(() => undefined);
	}

	async #attach(): Promise<void> {
		const pageSession = await this.#page.createCDPSession();
		try {
			const tree = (await pageSession.send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string } } };
			this.#frameId = tree.frameTree?.frame?.id;
		} finally {
			await pageSession.detach().catch(() => undefined);
		}
		const session = await this.#browser.target().createCDPSession();
		this.#willBegin = event => {
			if (this.#frameId && event.frameId && event.frameId !== this.#frameId) return;
			this.#pending.set(event.guid, { ...event, receivedBytes: 0 });
		};
		this.#progress = event => {
			const pending = this.#pending.get(event.guid);
			if (!pending) return;
			pending.receivedBytes = event.receivedBytes;
			if (event.state === "inProgress") return;
			this.#pending.delete(event.guid);
			if (event.state === "canceled") {
				this.#rejectNext(new ToolError(`Download canceled: ${pending.url}`));
				return;
			}
			void this.#complete(pending);
		};
		session.on("Browser.downloadWillBegin", this.#willBegin);
		session.on("Browser.downloadProgress", this.#progress);
		this.#session = session;
	}

	async #complete(pending: PendingDownload): Promise<void> {
		const directory = this.#directory ?? this.#defaultDirectory;
		const downloadPath = path.join(directory, pending.suggestedFilename);
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await fs.stat(downloadPath);
				break;
			} catch {
				await Bun.sleep(10);
			}
		}
		const download: BrowserDownload = {
			path: downloadPath,
			suggestedFilename: pending.suggestedFilename,
			url: pending.url,
			bytes: pending.receivedBytes,
		};
		this.#completed.push(download);
		const waiter = this.#waiters.shift();
		if (!waiter) {
			this.#unclaimed.push(download);
			return;
		}
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve({ ...download });
	}

	#rejectNext(error: ToolError): void {
		const waiter = this.#waiters.shift();
		if (!waiter) return;
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.reject(error);
	}

	#removeWaiter(waiter: DownloadWaiter): void {
		const index = this.#waiters.indexOf(waiter);
		if (index >= 0) this.#waiters.splice(index, 1);
	}
}
