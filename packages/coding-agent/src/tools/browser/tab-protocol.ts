import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { CursorMode } from "./cursor";

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
			ignoreHttpsErrors?: boolean;
			/** Resolved cursor mode; auto policy is resolved before the worker starts. */
			cursorMode: CursorMode;
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
			/** Hostname patterns allowed for every page request. */
			allowedDomains?: string[];
			/** Document-start JavaScript sources registered before navigation. */
			initScripts?: string[];
			/** Absolute directory enabled for completed downloads. */
			downloadsPath?: string;
			/** Explicit tab user agent applied during worker initialization. */
			userAgent?: string;
			/** Ignore invalid HTTPS certificates for this page. */
			ignoreHttpsErrors?: boolean;
			/** Resolved cursor mode; auto policy is resolved before the worker starts. */
			cursorMode: CursorMode;
			url?: string;
			waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
			timeoutMs: number;
			/** Post-timeout recycle before adopting a blocked target. */
			recover?: boolean;
			/** Restore focus emulation when recycling an OMP-owned tab. */
			emulateFocus?: boolean;
			/** Preserve OMP ownership when an existing owned target is reattached after worker restart. */
			ownsPage?: boolean;
			/** Whether the worker may raise this tab before capturing a screenshot. */
			activateForScreenshot?: boolean;
	  };

export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

export type WorkerInbound =
	| { type: "init"; payload: WorkerInitPayload }
	| { type: "run"; id: string; name: string; code: string; timeoutMs: number; session: SessionSnapshot }
	| { type: "abort"; id: string; expectedCleanup?: boolean }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "detach" }
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
	| { type: "setup" }
	| { type: "page-created"; targetId: string }
	| { type: "cursor-preload-registered"; identifier: string }
	| { type: "ready"; info: ReadyInfo }
	| { type: "init-failed"; error: RunErrorPayload }
	| { type: "result"; id: string; ok: true; payload: RunResultOk }
	| { type: "result"; id: string; ok: false; error: RunErrorPayload }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "detached" }
	| { type: "closed" };

export interface Transport {
	send(msg: WorkerOutbound | WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound | WorkerInbound) => void): () => void;
	close(): void;
}
