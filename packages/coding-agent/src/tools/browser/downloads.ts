import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasFsCode, isEnoent, toError, untilAborted } from "@oh-my-pi/pi-utils";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { replaceFileAcrossDevices, replaceFileAtomically } from "../../utils/atomic-file";
import { devtoolsFrameId } from "./frames";

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
	/** Saved location on completion, in whichever folder Chromium was pointed at last. */
	filePath?: string;
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

/** Chromium names an `allowAndName` download after its GUID, a lowercase UUID. */
const DOWNLOAD_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owns tab-scoped Chromium download behavior and completion events. */
export class DownloadManager {
	readonly #browser: Browser;
	readonly #page: Page;
	readonly #defaultDirectory: string;
	readonly #perTab: boolean;
	#directory?: string;
	#arming?: Promise<void>;
	#session?: CDPSession;
	readonly #pending = new Map<string, PendingDownload>();
	readonly #completed: BrowserDownload[] = [];
	readonly #unclaimed: BrowserDownload[] = [];
	readonly #waiters: DownloadWaiter[] = [];
	#willBegin?: (event: DownloadStarted & { frameId: string }) => void;
	#progress?: (event: DownloadProgress) => void;

	/**
	 * `perTab` gives each tab its own folder by saving under download GUIDs and moving each tab's own files. Leave it off
	 * for a browser the user drives (connected, relay): there the folder also receives the user's own downloads, which
	 * would otherwise be saved under bare GUIDs nobody renames.
	 */
	constructor(browser: Browser, page: Page, tabId: string, options: { perTab: boolean }) {
		this.#browser = browser;
		this.#page = page;
		this.#defaultDirectory = path.join(os.tmpdir(), `omp-downloads-${tabId}`);
		this.#perTab = options.perTab;
	}

	/**
	 * Point the browser's one download folder at this tab's folder. Per tab, files are saved under their download GUID
	 * so tabs never overwrite each other's, and each tab moves its own into its folder under the suggested name.
	 */
	async enable(directory?: string): Promise<void> {
		const resolved = path.resolve(directory ?? this.#defaultDirectory);
		await fs.mkdir(resolved, { recursive: true });
		if (!this.#session) await this.#attach();
		const context = this.#page.browserContext() as { id?: string };
		await this.#session!.send("Browser.setDownloadBehavior", {
			behavior: this.#perTab ? "allowAndName" : "allow",
			downloadPath: resolved,
			eventsEnabled: true,
			...(context.id ? { browserContextId: context.id } : {}),
		});
		this.#directory = resolved;
	}

	/** Enabling started by a `wait()` that has not yet applied; settles once downloads are tracked. */
	get arming(): Promise<void> | undefined {
		return this.#arming;
	}

	/** Wait for the next unclaimed completed download. */
	async wait(signal?: AbortSignal): Promise<BrowserDownload> {
		if (this.#unclaimed.length === 0) {
			// A rejected `arming` nobody awaits would surface as an unhandled rejection.
			if (signal?.aborted) throw signal.reason;
			// The tab that pointed Chromium last resets it to the browser's default folder when it closes, so re-point it.
			const arming = (this.#arming ??= this.enable(this.#directory).finally(() => {
				this.#arming = undefined;
			}));
			try {
				await untilAborted(signal, arming);
			} catch (error) {
				// Abort with the caller's reason, as the waits below do.
				if (signal?.aborted) throw signal.reason;
				throw error;
			}
		}
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
		const session = await this.#browser.target().createCDPSession();
		this.#willBegin = event => {
			// Every session hears every download in the browser; keep the ones this tab's frames started.
			if (!this.#page.frames().some(frame => devtoolsFrameId(frame) === event.frameId)) return;
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
			void this.#complete(pending, event.filePath).catch(error => {
				this.#rejectNext(new ToolError(`Download failed: ${pending.url}: ${toError(error).message}`));
			});
		};
		session.on("Browser.downloadWillBegin", this.#willBegin);
		session.on("Browser.downloadProgress", this.#progress);
		this.#session = session;
	}

	async #complete(pending: PendingDownload, filePath: string | undefined): Promise<void> {
		const directory = this.#directory ?? this.#defaultDirectory;
		const source = filePath ?? path.join(directory, this.#perTab ? pending.guid : pending.suggestedFilename);
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await fs.stat(source);
				break;
			} catch {
				await Bun.sleep(10);
			}
		}
		const name = typeof pending.suggestedFilename === "string" ? path.basename(pending.suggestedFilename) : "";
		const target = path.join(directory, name);
		// Only the last segment of the suggested name is used; anything else, or a download that cannot be moved, is
		// reported where Chromium saved it.
		const movable =
			this.#perTab &&
			name !== "" &&
			name !== "." &&
			name !== ".." &&
			(await canMoveDownload(source, pending.guid, target));
		const downloadPath = movable
			? await moveDownload(source, target).then(
					() => target,
					() => source,
				)
			: source;
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

/**
 * Whether `source` is a regular file saved under a UUID-shaped download GUID, and `target` is free or a file it may
 * replace. The peer names the GUID, the saved path and the suggested name, so a symlink or directory stays where it is.
 */
async function canMoveDownload(source: string, guid: string, target: string): Promise<boolean> {
	if (!DOWNLOAD_GUID.test(guid) || path.basename(source) !== guid) return false;
	return (await entryKind(source)) === "file" && (await entryKind(target)) !== "other";
}

/** What a path names, without following a symlink there. */
async function entryKind(file: string): Promise<"file" | "missing" | "other"> {
	try {
		return (await fs.lstat(file)).isFile() ? "file" : "other";
	} catch (error) {
		return isEnoent(error) ? "missing" : "other";
	}
}

/** Move a completed download into a tab's folder, replacing a same-named file as Chromium's own saves do. */
async function moveDownload(source: string, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	try {
		await replaceFileAtomically(source, target);
	} catch (error) {
		if (!hasFsCode(error, "EXDEV")) throw error;
		await replaceFileAcrossDevices(source, target);
	}
}
