import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

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

export type WorkerInitPayload =
	| {
			mode: "headless";
			browserWSEndpoint: string;
			safeDir: string;
			viewport?: { width: number; height: number; deviceScaleFactor?: number };
			dialogs?: "accept" | "dismiss";
			url?: string;
			waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
			timeoutMs: number;
	  }
	| {
			mode: "attach";
			browserWSEndpoint: string;
			safeDir: string;
			targetId: string;
			dialogs?: "accept" | "dismiss";
			url?: string;
			waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
			timeoutMs: number;
			/**
			 * Post-timeout recycle: before adopting the page, dismiss any open JS dialog and
			 * stop a pending navigation so a blocked target cannot stall worker init (which
			 * previously force-killed the tab). Never set for first-time Electron attach.
			 */
			recover?: boolean;
			/**
			 * Whether the worker may raise this tab before capturing a screenshot. Unset
			 * behaves as `true`; the supervisor clears it for browsers we did not launch.
			 */
			activateForScreenshot?: boolean;
	  };

export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

export type WorkerInbound =
	| { type: "init"; payload: WorkerInitPayload }
	| { type: "run"; id: string; name: string; code: string; timeoutMs: number; session: SessionSnapshot }
	| { type: "abort"; id: string; expectedCleanup?: boolean }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

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
}

export interface RunErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
	/** The worker could not restore tab-scoped browser state and must be recycled. */
	recoverTab?: boolean;
}

export type WorkerOutbound =
	| {
			/**
			 * Puppeteer loaded, browser connected. Sent before page acquisition so the supervisor's cold-start budget
			 * bounds only the realm setup (cold import + connect); page creation and the first navigation run under the
			 * ready wait.
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
