import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

export type Transferable = Bun.Transferable;

export interface ObservationEntry {
	id: number;
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	states: string[];
}

export interface Observation {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	scroll: {
		x: number;
		y: number;
		width: number;
		height: number;
		scrollWidth: number;
		scrollHeight: number;
	};
	elements: ObservationEntry[];
}

export interface ScreenshotResult {
	dest: string;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
}

export interface SessionSnapshot {
	cwd: string;
	browserScreenshotDir?: string;
	/** Force non-WebP screenshot encoding (e.g. for Ollama). Unset honors `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
}

/**
 * The page an attach worker drives. `create`: open and own a background tab in a
 * spawned browser or relay; `nearTargetId` selects the relay browser when given.
 * `owned`: an omp tab adopted after recycle. `borrowed`: a user's page, never closed,
 * and focus-emulated only in a browser the user drives (see `userDriven`).
 */
export type AttachPage = { kind: "create"; nearTargetId?: string } | { kind: "owned" | "borrowed"; targetId: string };

/** omp created the payload's page: closing the tab closes the page. */
export function ownsPage(payload: WorkerInitPayload): boolean {
	return payload.mode === "headless" || payload.page.kind !== "borrowed";
}

/** Globals every page has and omp's Bun runtime lacks: run code that cannot find one was written for the page. */
const PAGE_ONLY_GLOBAL_RE =
	/^(document|window|location|history|localStorage|sessionStorage|customElements|getComputedStyle|CSS|HTML\w*Element|Element|Node) is not defined$/;

/**
 * Whether run code itself, in omp's runtime, reached for a page-only global. An exception thrown in the page arrives
 * as a plain `Error` that Puppeteer names after it, so it never counts. A floating rejection arrives wrapped: one
 * reason as the wrapper's `cause`, or, once an in-process run returned, all of them in its `rejections`.
 */
export function isMissingPageGlobal(error: unknown): boolean {
	if (error instanceof ReferenceError) return PAGE_ONLY_GLOBAL_RE.test(error.message);
	if (!(error instanceof Error)) return false;
	if (error.cause instanceof ReferenceError) return isMissingPageGlobal(error.cause);
	const rejections = error instanceof ToolError ? error.context?.rejections : undefined;
	return Array.isArray(rejections) && rejections.some(isMissingPageGlobal);
}

export type WorkerInitPayload =
	| {
			mode: "headless";
			browserWSEndpoint: string;
			safeDir: string;
			/** The tab's upload staging folder, which outlives a recycled worker; see `UploadStaging`. */
			uploadDir: string;
			/** Keep the page tied to an OMP-owned worker without pinning a visible window's layout viewport. */
			emulateViewport?: boolean;
			viewport?: { width: number; height: number; deviceScaleFactor?: number };
			dialogs?: "accept" | "dismiss";
			/** Hostname patterns allowed for every page request. */
			allowedDomains?: string[];
			/** Document-start JavaScript sources registered before navigation. */
			initScripts?: string[];
			/** Absolute directory enabled for completed downloads. */
			downloadsPath?: string;
			/** Explicit tab user agent applied during worker initialization. */
			userAgent?: string;
			/** Ignore invalid HTTPS certificates for this page. */
			insecure?: boolean;
			/** The browser draws its windows on the user's screen (a visible launch), so a call can raise native ones. */
			showsWindows?: boolean;
	  }
	| {
			mode: "attach";
			browserWSEndpoint: string;
			safeDir: string;
			/** The tab's upload staging folder, which outlives a recycled worker; see `UploadStaging`. */
			uploadDir: string;
			page: AttachPage;
			viewport?: { width: number; height: number; deviceScaleFactor?: number };
			dialogs?: "accept" | "dismiss";
			/** Hostname patterns allowed for every page request. */
			allowedDomains?: string[];
			/** Document-start JavaScript sources registered before navigation. */
			initScripts?: string[];
			/** Absolute directory enabled for completed downloads. */
			downloadsPath?: string;
			/** Explicit tab user agent applied during worker initialization. */
			userAgent?: string;
			/** Ignore invalid HTTPS certificates for this page. */
			insecure?: boolean;
			/**
			 * Post-timeout recycle: before adopting the page, dismiss any open JS dialog and
			 * stop a pending navigation so a blocked target cannot stall worker init (which
			 * previously force-killed the tab). Never set for first-time Electron attach.
			 */
			recover?: boolean;
			/**
			 * The user drives this browser (connected, relay): downloads keep its one browser-wide folder and real file
			 * names, since the user's own downloads land there too. The page, borrowed user tabs included, is also
			 * focus-emulated so a background tab takes trusted input without being selected; the emulation ends with
			 * the CDP session (on the relay, with the bridge's last session of the tab). Unset means an OMP-launched
			 * browser.
			 */
			userDriven?: boolean;
			/** The browser is the omp relay: downloads arrive as page events, and the relay names where Chrome saved them. */
			relay?: boolean;
			/**
			 * The browser draws its windows on the user's screen, so a call can raise native ones. Unset for a headless
			 * browser, whose recycled tabs attach too.
			 */
			showsWindows?: boolean;
	  };

/** Result of one host tool requested by browser-run JavaScript. */
export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

export type WorkerInbound =
	| { type: "init"; payload: WorkerInitPayload }
	| { type: "run"; id: string; name: string; code: string; timeoutMs: number; session: SessionSnapshot }
	| { type: "abort"; id: string; expectedCleanup?: boolean }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	/** `keepPage` leaves a page omp created open in its browser; only the worker's hold on it goes. */
	| { type: "close"; keepPage?: boolean };

export interface ReadyInfo {
	url: string;
	title?: string;
	viewport: { width: number; height: number; deviceScaleFactor?: number };
	targetId: string;
}

export interface RunResultOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ScreenshotResult[];
	/** The run finished but tab-scoped browser state was not restored; the tab must be recycled. */
	recoverTab?: boolean;
}

export interface RunErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
	/** The worker could not restore tab-scoped browser state and must be recycled. */
	recoverTab?: boolean;
	/** The run's own code reached for a page-only global ({@link isMissingPageGlobal}). */
	missingPageGlobal?: boolean;
	/** `tab.goto` outlasted its budget; the page stays on what loaded. */
	navigationTimeout?: boolean;
	/** The page's renderer crashed; the worker runs nothing more and must be recycled. */
	rendererCrashed?: boolean;
	/**
	 * Chrome ended the debugger attachment the page is driven through (omp browser relay) `during` this run, after
	 * its code started, or `before` it, so nothing ran; the worker runs nothing more. `reason` is Chrome's
	 * (`target_closed`, `canceled_by_user`): after a user cancel the relay hides the tab, otherwise it is re-adopted.
	 */
	debuggerDetached?: { when: "during" | "before"; reason: string };
}

export type WorkerOutbound =
	| {
			/**
			 * Puppeteer loaded, browser connected. Sent before page acquisition so the supervisor's cold-start budget
			 * bounds only the realm setup (cold import + connect); page creation runs under the ready wait.
			 */
			type: "setup";
	  }
	| {
			/**
			 * The headless page was created (before the potentially slow post-creation CDP work such as stealth and
			 * viewport). Lets the supervisor close exactly this target if it kills the worker during init — a killed
			 * worker can't clean up after itself.
			 */
			type: "page-created";
			targetId: string;
	  }
	| { type: "ready"; info: ReadyInfo }
	| { type: "init-failed"; error: RunErrorPayload }
	| { type: "result"; id: string; ok: true; payload: RunResultOk }
	| { type: "result"; id: string; ok: false; error: RunErrorPayload }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "closed" };

export interface Transport {
	send(msg: WorkerOutbound | WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound | WorkerInbound) => void): () => void;
	close(): void;
}
