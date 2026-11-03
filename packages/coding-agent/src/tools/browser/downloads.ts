import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasFsCode, isEnoent, toError, untilAborted } from "@oh-my-pi/pi-utils";
import type { Browser, CDPSession, Frame, Page } from "puppeteer-core";
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
	/**
	 * The omp relay, which has no browser-level target: downloads are heard as the page's own `Page.download*` events on
	 * the sessions of its frames, Chrome saves them where its own settings say, and the relay names each saved file.
	 */
	readonly #pageEvents: boolean;
	#directory?: string;
	#arming?: Promise<void>;
	#session?: CDPSession;
	readonly #pageSessions = new Set<CDPSession>();
	#onFrame?: (frame: Frame) => void;
	readonly #pending = new Map<string, PendingDownload>();
	readonly #completed: BrowserDownload[] = [];
	readonly #unclaimed: BrowserDownload[] = [];
	readonly #waiters: DownloadWaiter[] = [];
	#willBegin?: (event: DownloadStarted & { frameId: string }) => void;
	#progress?: (event: DownloadProgress) => void;

	/**
	 * `perTab` gives each tab its own folder by saving under download GUIDs and moving each tab's own files. Leave it off
	 * for a browser the user drives (connected, relay): there the folder also receives the user's own downloads, which
	 * would otherwise be saved under bare GUIDs nobody renames. `pageEvents` is for the omp relay.
	 */
	constructor(browser: Browser, page: Page, tabId: string, options: { perTab: boolean; pageEvents: boolean }) {
		this.#browser = browser;
		this.#page = page;
		this.#defaultDirectory = path.join(os.tmpdir(), `omp-downloads-${tabId}`);
		this.#perTab = options.perTab;
		this.#pageEvents = options.pageEvents;
	}

	/**
	 * Start a new tab's downloads: point them at `directory` when the tab was opened with one. Page events change no
	 * browser setting, so the relay tracks them from here and a download clicked before any wait is listed.
	 */
	async start(directory?: string): Promise<void> {
		if (this.#pageEvents) this.#hearPage();
		else if (directory) await this.enable(directory);
	}

	/**
	 * Point the browser's one download folder at this tab's folder. Per tab, files are saved under their download GUID
	 * so tabs never overwrite each other's, and each tab moves its own into its folder under the suggested name. The
	 * relay cannot point Chrome anywhere (the tab supervisor refuses a folder for it), so there this only listens.
	 */
	async enable(directory?: string): Promise<void> {
		if (this.#pageEvents) {
			this.#hearPage();
			return;
		}
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
		if (this.#onFrame) {
			this.#page.off("frameattached", this.#onFrame);
			this.#page.off("framenavigated", this.#onFrame);
			this.#onFrame = undefined;
			for (const session of this.#pageSessions) this.#unsubscribe(session, "Page");
			this.#pageSessions.clear();
		}
		const session = this.#session;
		if (session) this.#unsubscribe(session, "Browser");
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new ToolError("Tab closed while waiting for a download"));
		}
		if (!session) return;
		this.#session = undefined;
		await session.detach().catch(() => undefined);
	}

	async #attach(): Promise<void> {
		const session = await this.#browser.target().createCDPSession();
		this.#subscribe(session, "Browser");
		this.#session = session;
	}

	/** Hear the page's download events on the session of each of its frames: a cross-site frame has its own. */
	#hearPage(): void {
		if (this.#onFrame) return;
		this.#onFrame = frame => {
			if (this.#pageSessions.has(frame.client)) return;
			this.#pageSessions.add(frame.client);
			this.#subscribe(frame.client, "Page");
		};
		this.#page.on("frameattached", this.#onFrame);
		// A frame that navigates to another site moves to a new session.
		this.#page.on("framenavigated", this.#onFrame);
		for (const frame of this.#page.frames()) this.#onFrame(frame);
	}

	#subscribe(session: CDPSession, domain: "Browser" | "Page"): void {
		this.#willBegin ??= event => {
			// Every browser session hears every download in the browser; keep the ones this tab's frames started.
			if (!this.#page.frames().some(frame => devtoolsFrameId(frame) === event.frameId)) return;
			this.#pending.set(event.guid, { ...event, receivedBytes: 0 });
		};
		this.#progress ??= event => {
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
		session.on(`${domain}.downloadWillBegin`, this.#willBegin);
		session.on(`${domain}.downloadProgress`, this.#progress);
	}

	#unsubscribe(session: CDPSession, domain: "Browser" | "Page"): void {
		if (this.#willBegin) session.off(`${domain}.downloadWillBegin`, this.#willBegin);
		if (this.#progress) session.off(`${domain}.downloadProgress`, this.#progress);
	}

	/** Where Chrome saved a download its page reported, which the omp relay looks up in Chrome's download list. */
	async #savedPath(url: string): Promise<string> {
		// Puppeteer's protocol map cannot express the relay-private method; the send signature is otherwise identical.
		const session = this.#page.mainFrame().client as unknown as {
			send(method: string, params: { url: string }): Promise<unknown>;
		};
		const reply = await session.send("OMP.downloadPath", { url });
		if (reply && typeof reply === "object" && "filePath" in reply && typeof reply.filePath === "string") {
			return reply.filePath;
		}
		throw new Error("the browser did not say where it saved the file");
	}

	async #complete(pending: PendingDownload, filePath: string | undefined): Promise<void> {
		const directory = this.#directory ?? this.#defaultDirectory;
		const source =
			filePath ??
			(this.#pageEvents
				? await this.#savedPath(pending.url)
				: path.join(directory, this.#perTab ? pending.guid : pending.suggestedFilename));
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
