/**
 * A browser tab shown as a Tern browser picture-in-picture: every helper of
 * the tab API drives the PiP's native web view through Tern's browser op
 * protocol (`wire.ts`). Pages are reached through `eval` (page world for user
 * code and page instrumentation, the isolated world for omp's kit), trusted
 * `input` events at element centres, `capture`, `pdf` and the Tern-level ops;
 * what the page reports on its own arrives through `events` polling.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, logger, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { JsRuntime } from "../../../eval/js/shared/runtime";
import { formatScreenshot, resizeImage } from "../../../utils/image-resize";
import { resolveToCwd } from "../../path-utils";
import { ToolAbortError, throwIfAborted } from "../../tool-errors";
import {
	type BrowserA11yOptions,
	type BrowserA11yResult,
	buildA11yPageScript,
	formatA11ySummary,
	normalizeA11yResult,
} from "../a11y/audit";
import { type AriaSnapshotOptions, parseAriaRefSelector } from "../aria/aria-snapshot";
import type {
	BrowserCaptureResult,
	BrowserConsoleEntry,
	BrowserConsoleLevel,
	BrowserConsoleOptions,
	BrowserErrorEntry,
	BrowserErrorOptions,
} from "../console-capture";
import type { DialogPolicy, DialogState } from "../dialogs";
import type { BrowserDownload } from "../downloads";
import type { BrowserEmulateOptions, ClipboardActionResult, ClipboardReadResult } from "../emulation";
import type { BrowserFrameInfo } from "../frames";
import type { InProcessRunContext, InProcessRunTab } from "../in-process-run";
import { loadedKnownDevices, loadPuppeteer } from "../launch";
import { pushStateInPage } from "../navigation";
import type {
	HarContentPolicy,
	NetworkPattern,
	NetworkRequestDetail,
	NetworkRequestRecord,
	NetworkRequestsOptions,
	NetworkResponseBody,
	NetworkRouteDescription,
	NetworkRouteOptions,
} from "../network";
import { normalizeAllowedDomains } from "../network";
import { resolveOpTimeouts, resolveWaitTimeout, ZERO_MATCH_FAIL_FAST_MS } from "../op-timeouts";
import { DEFAULT_STYLE_PROPERTIES } from "../queries";
import { extractReadableFromHtml, type ReadableExtractOptions, type ReadableFormat } from "../readable";
import {
	enableReact,
	REACT_HOOK_INIT_SOURCE,
	type ReactEnableResult,
	type ReactPageEnvelope,
	type ReactPageHost,
	requireReactHookResult,
} from "../react/devtools-hook";
import { type ReactRendersAction, type ReactRendersResult, reactRendersSource } from "../react/renders";
import { type ReactSuspenseBoundary, type ReactSuspenseOptions, reactSuspenseSource } from "../react/suspense";
import {
	type ReactInspectResult,
	reactInspectResult,
	reactInspectSource,
	type ReactTreeNode,
	type ReactTreeOptions,
	reactTreeSource,
} from "../react/tree";
import { collectVitals, VITALS_INIT_SOURCE, type VitalsOptions, type VitalsResult } from "../react/vitals";
import {
	installCursorOverlay,
	RecordingController,
	removeCursorOverlay,
	type RecordingFrameSource,
	type RecordingFrameSourceStartParams,
	type RecordingOptions,
	type RecordingStartResult,
	type RecordingStatus,
	type RecordingStopResult,
} from "../recording";
import {
	createPngDiff,
	type DiffScreenshotOptions,
	type DiffScreenshotResult,
	formatScreenshotLegend,
	type PdfOptions,
	pngPixelChangeRatio,
	type ScreenshotAnnotationTarget,
	type ScreenshotChangeResult,
	type ScreenshotHistory,
	type ScreenshotOptions,
	screenshotQuality,
	screenshotScope,
	screenshotThreshold,
} from "../screenshot";
import {
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	ariaSnapshotBaselineKey,
	diffAriaSnapshot,
	postProcessAriaSnapshot,
} from "../snapshot-plus";
import {
	assertStorageKind,
	type BrowserCookie,
	type ClearCookiesOptions,
	type CookieQueryOptions,
	clearStorageInPage,
	type LoadStateResult,
	normalizeCookieArguments,
	readOriginStorageInPage,
	readStorageInPage,
	readStorageStateFile,
	restoreOriginStorageInPage,
	type StorageKind,
	type StorageStateOrigin,
	storageEntries,
	storageStatePath,
	storageValue,
	writeStorageInPage,
} from "../storage-state";
import { assertTabPressArgs } from "../tab-arguments";
import type { Observation, ReadyInfo, SessionSnapshot } from "../tab-protocol";
import {
	installWebMcpPageHook,
	uninstallWebMcpPageHook,
	WEBMCP_BRIDGE_KEY,
	WebMcpController,
	type WebMcpEventsOptions,
	type WebMcpEventsResult,
	type WebMcpHookInvokeEnvelope,
	type WebMcpHookSnapshot,
	type WebMcpInvokeOptions,
	type WebMcpInvokeResult,
	type WebMcpListOptions,
	type WebMcpListResult,
	webMcpInvokeInPage,
	webMcpSnapshotInPage,
} from "../webmcp";
import { keyDownStep, keyUpStep, pressSteps, type TernInputStep, type TernModifier, ternKey, typeSteps } from "./keys";
import { TernNetworkLog, type TernRequestEntry } from "./network-log";
import { TERN_CAPTURE_GLOBAL, TERN_CAPTURE_INSTALLER, type TernPageEmulation, ternCaptureScript } from "./page-capture";
import {
	TERN_KIT_SOURCE,
	type TernAnnotation,
	type TernFrameInfo,
	type TernGeometry,
	type TernKitApi,
	type TernTarget,
	type TernTargetAction,
} from "./page-kit";
import { parseTernSelector, type TernSelector } from "./selectors";
import { TernError, type TernSocketClient } from "./wire";

type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type DragTarget = string | { readonly x: number; readonly y: number };
type MouseButtonName = "left" | "right" | "middle" | "back" | "forward";
type World = "page" | "isolated";

/** Where an operation runs: the main frame (`null`) or a registered frame path. */
type FramePath = string | null;

interface BoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface ViewportOptions {
	width: number;
	height: number;
	deviceScaleFactor?: number;
}

/** Options of {@link TernTab.open}. */
export interface TernOpenOptions {
	/** Managed tab name (names the saved-state file). */
	name: string;
	/** Pane that owns the PiP (`TERN_PANE`). */
	pane: number;
	/** First real navigation after configuration. */
	url?: string;
	/** Lifecycle the first navigation awaits. */
	waitUntil?: WaitUntil;
	/** Page layout size. */
	viewport: ViewportOptions;
	/** Budget of the whole open. */
	timeoutMs: number;
	/** Abandons the open. */
	signal?: AbortSignal;
	/** Automatic dialog policy. */
	dialogs?: DialogPolicy;
	/** Hostname allowlist. */
	allowedDomains?: string[];
	/** Document-start scripts. */
	initScripts?: string[];
	/** Download directory. */
	downloadsPath?: string;
	/** User agent override. */
	userAgent?: string;
	/** Accept invalid TLS certificates. */
	ignoreHttpsErrors?: boolean;
}

/** A Tern event (one entry of the `events` op). */
interface TernEvent {
	seq: number;
	type: string;
	[key: string]: unknown;
}

interface PendingDialog {
	type: string;
	message: string;
	defaultValue?: string;
}

interface InitScript {
	id: string;
	source: string;
}

type CaptureEntry = BrowserConsoleEntry | BrowserErrorEntry;

const EVENT_LOG_LIMIT = 4_000;
const CONSOLE_LIMIT = 500;
const NAVIGATION_IDLE_MS = 500;
const KIT_CALL =
	"async function (method, args) { const kit = globalThis.__ompTernKit; if (!kit) return { missing: true }; return { value: await kit[method](...args) }; }";
const HANDLE_ATTRIBUTE = "data-omp-tern-handle";

/** The tab-helper name for errors: `tab.pdf()`. */
function helper(name: string): string {
	return `tab.${name}()`;
}

/** A ToolError for a helper the Tern backend cannot provide. */
function unsupported(name: string, reason: string): ToolError {
	return new ToolError(`${helper(name)} is not supported on the Tern browser backend: ${reason}`);
}

/** The message of a page-side exception answered by Tern (`js` errors), without Tern's prefix. */
function pageErrorText(error: TernError): string {
	return error.message.replace(/^Tern browser \w+ failed \(js\): /, "");
}

/**
 * The page function running a user source string: an expression's value, or
 * — when the source is a statement list rather than an expression — the
 * statements as a function body. The choice is made by compiling (never
 * running) both candidates here, so the code runs exactly once in the page;
 * source that compiles as neither goes as an expression and the page reports
 * its syntax error.
 */
export function userSourceFunction(source: string): string {
	const expression = `return (\n${source}\n);`;
	try {
		new Function(expression);
		return `function () {\n${expression}\n}`;
	} catch {}
	try {
		new Function(source);
		return `function () {\n${source}\n}`;
	} catch {}
	return `function () {\n${expression}\n}`;
}

/** The first line of a page-side exception, without the `Error: ` prefix: agent-readable kit failures. */
function kitErrorText(error: TernError): string {
	return (pageErrorText(error).split("\n", 1)[0] ?? "").replace(/^Error: /, "");
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** Whether a cookie applies to `url` (domain, path and scheme). */
function cookieMatchesUrl(cookie: BrowserCookie, url: URL): boolean {
	const host = url.hostname.toLowerCase();
	const domain = cookie.domain.toLowerCase().replace(/^\./, "");
	const domainMatch = cookie.domain.startsWith(".") ? host === domain || host.endsWith(`.${domain}`) : host === domain;
	if (!domainMatch) return false;
	if (cookie.secure && url.protocol !== "https:") return false;
	const cookiePath = cookie.path || "/";
	return (
		url.pathname === cookiePath || url.pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`)
	);
}

/**
 * `args` without trailing `undefined`s. JSON turns an array's `undefined` into `null`, so an omitted
 * optional argument would reach the page function as `null` instead of `undefined`.
 */
function withoutTrailingUndefined(args: unknown[]): unknown[] {
	let end = args.length;
	while (end > 0 && args[end - 1] === undefined) end--;
	return end === args.length ? args : args.slice(0, end);
}

/** A Tern cookie as the tab API reports it. */
function cookieFromTern(value: unknown): BrowserCookie | null {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.value !== "string") return null;
	const sameSite = value.sameSite === "Strict" || value.sameSite === "None" ? value.sameSite : "Lax";
	return {
		name: value.name,
		value: value.value,
		domain: stringOr(value.domain, ""),
		path: stringOr(value.path, "/"),
		expires: numberOr(value.expires, -1),
		httpOnly: value.httpOnly === true,
		secure: value.secure === true,
		sameSite,
	};
}

/** A captured console message's level (unknown levels read as `log`). */
function consoleLevel(value: unknown): BrowserConsoleLevel {
	return value === "info" || value === "warn" || value === "error" || value === "debug" ? value : "log";
}

/**
 * The Tern backend's tab: one PiP (`block`) and the state its helpers keep —
 * the event cursor, console and request logs, dialog/download/frame state,
 * emulation, scripts, pointer and modifier state.
 */
export class TernTab implements InProcessRunTab {
	/** Guest file-name prefix of Tern runs. */
	readonly runLabel = "tern-run";
	/** The PiP's block id (daemon-native). */
	readonly block: number;
	readonly #client: TernSocketClient;
	readonly #name: string;
	#url = "about:blank";
	#title = "";
	#viewport: ViewportOptions;
	#cursor = 0;
	readonly #events: TernEvent[] = [];
	#pulling: Promise<void> | undefined;
	#runContext: InProcessRunContext | undefined;
	#runtime: JsRuntime | undefined;
	#pageFacade: TernPageFacade | undefined;
	#browserFacade: TernBrowserFacade | undefined;
	// Console capture.
	readonly #console: CaptureEntry[] = [];
	#consoleSeq = 1;
	#consoleDropped = 0;
	// Page state from events.
	#pendingDialog: PendingDialog | undefined;
	readonly #frameUrls = new Map<string, string>();
	readonly #downloads = new Map<number, { url: string; path?: string; state: string; error?: string }>();
	readonly #completedDownloads: BrowserDownload[] = [];
	readonly #unclaimedDownloads: BrowserDownload[] = [];
	#downloadDir: string | undefined;
	// Network, scripts and emulation.
	readonly #network = new TernNetworkLog();
	readonly #initScripts: InitScript[] = [];
	#nextInitScript = 1;
	#allowedDomains: string[] = [];
	readonly #emulation: BrowserEmulateOptions = {};
	#pageEmulation: TernPageEmulation = {};
	#deviceUserAgent: string | undefined;
	#reactHook = false;
	#cursorOverlay = false;
	// Input state.
	#pointer: { x: number; y: number } | undefined;
	readonly #buttons = new Set<"left" | "right" | "middle">();
	readonly #mods: TernModifier[] = [];
	// Screenshots, snapshots, recording, WebMCP.
	readonly #screenshotHistory = new Map<string, ScreenshotHistory>();
	readonly #ariaBaselines = new Map<string, AriaSnapshotBaseline>();
	readonly #recording = new RecordingController();
	#webmcp: WebMcpController | undefined;

	constructor(opts: { client: TernSocketClient; block: number; name: string; viewport: ViewportOptions }) {
		this.#client = opts.client;
		this.block = opts.block;
		this.#name = opts.name;
		this.#viewport = { ...opts.viewport };
	}

	/**
	 * Open a PiP over pane `opts.pane` at `about:blank`, wait for that load to
	 * report, configure the PiP (dialog policy, allowlist, agent, TLS, downloads,
	 * scripts) and only then make the first real navigation. The PiP closes
	 * again when configuration fails, and when the open was abandoned
	 * (timeout/abort) but Tern answered late.
	 */
	static async open(client: TernSocketClient, opts: TernOpenOptions): Promise<TernTab> {
		const startedAt = Date.now();
		const remainingMs = (): number => Math.max(1, opts.timeoutMs - (Date.now() - startedAt));
		const opened = await client.request(
			{
				op: "open",
				owner: opts.pane,
				url: "about:blank",
				width: Math.round(opts.viewport.width),
				height: Math.round(opts.viewport.height),
			},
			{
				timeoutMs: opts.timeoutMs,
				signal: opts.signal,
				onLateAnswer: late => {
					if (!isRecord(late) || typeof late.block !== "number") return;
					void client.request({ op: "close", block: late.block }, { timeoutMs: 5_000 }).catch(() => undefined);
				},
			},
		);
		if (!isRecord(opened) || typeof opened.block !== "number") {
			throw new ToolError("Tern answered the browser open without a block id");
		}
		const tab = new TernTab({ client, block: opened.block, name: opts.name, viewport: opts.viewport });
		try {
			await tab.#configure(opts, remainingMs());
			if (opts.url) {
				await tab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: remainingMs() });
			}
		} catch (error) {
			await tab.close({ timeoutMs: 5_000 }).catch(() => undefined);
			throw error;
		}
		return tab;
	}

	/** The `page` facade `tab.run` code sees. */
	get page(): TernPageFacade {
		this.#pageFacade ??= new TernPageFacade(this);
		return this.#pageFacade;
	}

	/** The `browser` facade `tab.run` code sees. */
	get browser(): TernBrowserFacade {
		this.#browserFacade ??= new TernBrowserFacade(this);
		return this.#browserFacade;
	}

	/** The tab's JavaScript runtime for `tab.run`. */
	ensureRuntime(session: SessionSnapshot): JsRuntime {
		this.#runtime ??= new JsRuntime({ initialCwd: session.cwd, sessionId: `tern-tab-${this.block}` });
		return this.#runtime;
	}

	/** Publish the active run. */
	setRunContext(context: InProcessRunContext): void {
		this.#runContext = context;
	}

	/** Forget the finished run. */
	clearRunContext(): void {
		this.#runContext = undefined;
	}

	/** Page facts the supervisor records for the tab. */
	async readyInfo(): Promise<ReadyInfo> {
		await this.#refreshState();
		return {
			url: this.#url,
			title: this.#title,
			viewport: { ...this.#viewport },
			targetId: String(this.block),
		};
	}

	/** Close the PiP (its page goes). A PiP already gone is no error. */
	async close(opts: { timeoutMs: number }): Promise<void> {
		await this.#recording.close().catch(error => {
			logger.warn("Failed to finalize a Tern browser recording during close", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		try {
			await this.#client.request({ op: "close", block: this.block }, { timeoutMs: opts.timeoutMs });
		} catch (error) {
			if (error instanceof TernError && (error.kind === "not_found" || error.kind === "closed")) return;
			throw error;
		}
	}

	// ─── Protocol plumbing ────────────────────────────────────────────────

	get #signal(): AbortSignal | undefined {
		return this.#runContext?.signal;
	}

	get #cellMs(): number {
		return this.#runContext?.timeoutMs ?? 30_000;
	}

	/** Send a block op; aborts with the run. */
	async #op(op: string, fields: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
		const signal = this.#signal;
		throwIfAborted(signal);
		return await this.#client.request(
			{ op, block: this.block, ...fields },
			{ timeoutMs: timeoutMs ?? resolveOpTimeouts(this.#cellMs).budgetBound, signal },
		);
	}

	/** Evaluate a function source; resolves its JSON value (`undefined` for none). */
	async #eval(source: string, args: unknown[], world: World, frame: FramePath, timeoutMs?: number): Promise<unknown> {
		const answer = await this.#op(
			"eval",
			{ function: source, args: withoutTrailingUndefined(args), world, ...(frame ? { frame } : {}) },
			timeoutMs,
		);
		return isRecord(answer) ? answer.value : undefined;
	}

	/** Call a kit method in `frame`'s isolated world, installing the kit when the document lacks it. */
	async #kit<T>(method: keyof TernKitApi, args: unknown[], frame: FramePath = null): Promise<T> {
		for (let attempt = 0; attempt < 2; attempt++) {
			let result: unknown;
			try {
				result = await this.#eval(KIT_CALL, [method, args], "isolated", frame);
			} catch (error) {
				if (error instanceof TernError && error.kind === "js") throw new ToolError(kitErrorText(error));
				throw error;
			}
			if (isRecord(result) && result.missing === true) {
				await this.#eval(`function () {\n${TERN_KIT_SOURCE}\n}`, [], "isolated", frame);
				continue;
			}
			return (isRecord(result) ? result.value : undefined) as T;
		}
		throw new ToolError("The Tern page kit could not be installed in this document");
	}

	/** Evaluate user code in the page world, surfacing page exceptions as ToolErrors. */
	async #evalUser(label: string, fn: unknown, args: unknown[], frame: FramePath): Promise<unknown> {
		try {
			if (typeof fn === "function") return await this.#eval(fn.toString(), args, "page", frame);
			if (typeof fn !== "string") throw new ToolError(`${label} expects a function or a source string`);
			return await this.#eval(userSourceFunction(fn), [], "page", frame);
		} catch (error) {
			if (error instanceof TernError && error.kind === "js") {
				throw new ToolError(`${label} threw a JavaScript exception:\n${pageErrorText(error)}`);
			}
			throw error;
		}
	}

	/** Evaluate an expression source (an IIFE string) in the main page world. */
	async #evalExpression(source: string, signal?: AbortSignal): Promise<unknown> {
		throwIfAborted(signal);
		return await this.#eval(`function () {\nreturn ${source};\n}`, [], "page", null);
	}

	/** Send trusted input steps. */
	async #input(steps: TernInputStep[]): Promise<void> {
		if (steps.length === 0) return;
		await this.#op("input", { events: steps });
	}

	/** Pull new Tern events into the tab's state (single-flight). */
	async #pull(): Promise<void> {
		if (this.#pulling) return await this.#pulling;
		const pulling = (async () => {
			const answer = await this.#op("events", { after: this.#cursor }, 10_000);
			if (!isRecord(answer) || !Array.isArray(answer.events)) return;
			for (const raw of answer.events) {
				if (!isRecord(raw) || typeof raw.seq !== "number" || typeof raw.type !== "string") continue;
				if (raw.seq <= this.#cursor) continue;
				this.#cursor = raw.seq;
				const event: TernEvent = { ...raw, seq: raw.seq, type: raw.type };
				this.#events.push(event);
				this.#ingest(event);
			}
			if (this.#events.length > EVENT_LOG_LIMIT) this.#events.splice(0, this.#events.length - EVENT_LOG_LIMIT);
			if (typeof answer.dropped === "number" && answer.dropped > 0) {
				logger.debug("Tern dropped browser events before omp read them", { dropped: answer.dropped });
			}
		})();
		this.#pulling = pulling;
		try {
			await pulling;
		} finally {
			this.#pulling = undefined;
		}
	}

	/** Apply one event to the tab's state. */
	#ingest(event: TernEvent): void {
		switch (event.type) {
			case "url":
			case "committed":
				if (typeof event.url === "string") this.#url = event.url;
				if (event.type === "committed") {
					this.#pendingDialog = undefined;
					this.#frameUrls.clear();
				}
				return;
			case "title":
				if (typeof event.title === "string") this.#title = event.title;
				return;
			case "frame":
				if (typeof event.name === "string" && typeof event.url === "string")
					this.#frameUrls.set(event.name, event.url);
				return;
			case "dialog":
				if (event.handled === null || event.handled === undefined) {
					this.#pendingDialog = {
						type: stringOr(event.kind, "alert"),
						message: stringOr(event.message, ""),
						...(event.kind === "prompt" ? { defaultValue: stringOr(event.default, "") } : {}),
					};
				}
				return;
			case "download":
				this.#ingestDownload(event);
				return;
			case "response":
				this.#network.ingestNavigationResponse(event);
				return;
			case "blocked":
				if (typeof event.url === "string") this.#network.ingestBlocked(event.url);
				return;
			case "message":
				this.#ingestMessage(event);
				return;
		}
	}

	#ingestMessage(event: TernEvent): void {
		if (event.world !== "page" || typeof event.body !== "string") return;
		let message: unknown;
		try {
			message = JSON.parse(event.body);
		} catch {
			return;
		}
		if (!isRecord(message) || message.omp !== "tern") return;
		if (typeof message.dropped === "number") this.#consoleDropped += message.dropped;
		const ts = numberOr(message.ts, Date.now());
		const location = typeof message.location === "string" ? message.location : undefined;
		switch (message.kind) {
			case "console":
				this.#pushConsole({
					seq: 0,
					ts,
					type: "console",
					level: consoleLevel(message.level),
					text: stringOr(message.text, ""),
					location,
					args: Array.isArray(message.args) ? message.args : [],
				});
				return;
			case "pageerror":
				this.#pushConsole({
					seq: 0,
					ts,
					type: "pageerror",
					level: "error",
					text: stringOr(message.text, ""),
					location,
					stack: typeof message.stack === "string" ? message.stack : undefined,
				});
				return;
			case "requestfailed":
				this.#network.ingestPageMessage(message);
				this.#pushConsole({
					seq: 0,
					ts,
					type: "requestfailed",
					level: "error",
					text: `${stringOr(message.error, "request failed")}: ${stringOr(message.url, "")}`,
					location: typeof message.url === "string" ? message.url : undefined,
				});
				return;
			case "request":
			case "response":
				this.#network.ingestPageMessage(message);
				return;
		}
	}

	#pushConsole(entry: CaptureEntry): void {
		entry.seq = this.#consoleSeq++;
		this.#console.push(entry);
		while (this.#console.length > CONSOLE_LIMIT) {
			this.#console.shift();
			this.#consoleDropped++;
		}
	}

	#ingestDownload(event: TernEvent): void {
		if (typeof event.id !== "number") return;
		const known = this.#downloads.get(event.id);
		const entry = {
			url: stringOr(event.url, known?.url ?? ""),
			path: typeof event.path === "string" ? event.path : known?.path,
			state: stringOr(event.state, "started"),
			error: typeof event.error === "string" ? event.error : undefined,
		};
		this.#downloads.set(event.id, entry);
		if (entry.state !== "finished" || !entry.path) return;
		let bytes = 0;
		try {
			bytes = fs.statSync(entry.path).size;
		} catch {}
		const download: BrowserDownload = {
			path: entry.path,
			suggestedFilename: path.basename(entry.path),
			url: entry.url,
			bytes,
		};
		this.#completedDownloads.push(download);
		this.#unclaimedDownloads.push(download);
	}

	/** Events newer than `since` (already pulled). */
	#eventsSince(since: number): TernEvent[] {
		return this.#events.filter(event => event.seq > since);
	}

	/**
	 * Poll `check` until it yields a value (not `undefined`), backing off
	 * 25→100 ms; `pull` also refreshes Tern events before each check.
	 */
	async #poll<T>(
		label: string,
		timeoutMs: number,
		check: () => T | undefined | Promise<T | undefined>,
		opts: { pull: boolean } = { pull: false },
	): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		let delay = 25;
		for (;;) {
			if (opts.pull) await this.#pull();
			const value = await check();
			if (value !== undefined) return value;
			const left = deadline - Date.now();
			if (left <= 0) throw new ToolError(`${label} timed out after ${timeoutMs}ms`);
			await untilAborted(this.#signal, () => Bun.sleep(Math.min(delay, left)));
			delay = Math.min(100, Math.round(delay * 1.5));
		}
	}

	/** Refresh url/title (and the known viewport) from Tern's `state`. */
	async #refreshState(): Promise<Record<string, unknown>> {
		const state = await this.#op("state", {}, resolveOpTimeouts(this.#cellMs).quickOpMs);
		if (!isRecord(state)) return {};
		if (typeof state.url === "string") this.#url = state.url;
		if (typeof state.title === "string") this.#title = state.title;
		if (typeof state.width === "number" && typeof state.height === "number") {
			this.#viewport = { ...this.#viewport, width: state.width, height: state.height };
		}
		return state;
	}

	// ─── Configuration and scripts ────────────────────────────────────────

	async #configure(opts: TernOpenOptions, timeoutMs: number): Promise<void> {
		// Tern answers `open` once the page takes calls, before its about:blank load reports. That load's
		// late `committed`/`loaded` events would otherwise settle the first navigation before it loads.
		await this.#poll(
			"The Tern page's initial about:blank load",
			timeoutMs,
			() => (this.#events.some(event => event.type === "loaded" || event.type === "failed") ? true : undefined),
			{ pull: true },
		);
		await this.#op("dialogs", { policy: opts.dialogs ?? "default" });
		if (opts.allowedDomains?.length) {
			this.#allowedDomains = normalizeAllowedDomains(opts.allowedDomains);
			await this.#op("allow", { hosts: this.#allowedDomains });
		}
		if (opts.userAgent !== undefined) {
			this.#emulation.userAgent = opts.userAgent;
			await this.#op("agent", { value: opts.userAgent });
		}
		if (opts.ignoreHttpsErrors) await this.#op("insecure", { value: true });
		if (opts.downloadsPath !== undefined) await this.#enableDownloads(opts.downloadsPath);
		for (const source of opts.initScripts ?? []) {
			this.#initScripts.push({ id: `tern-init-${this.#nextInitScript++}`, source });
		}
		await this.#syncScripts();
	}

	/** Every document-start script this tab needs, in order. */
	#scripts(): Array<{ source: string; world: World; frames: "main" | "all"; at: "start" | "end" }> {
		return [
			{
				source: ternCaptureScript({ routes: this.#network.rules(), emulation: this.#pageEmulation }),
				world: "page",
				frames: "all",
				at: "start",
			},
			{
				source: `(${installWebMcpPageHook.toString()})(${JSON.stringify(WEBMCP_BRIDGE_KEY)});`,
				world: "page",
				frames: "all",
				at: "start",
			},
			{ source: `${VITALS_INIT_SOURCE};`, world: "page", frames: "main", at: "start" },
			...(this.#reactHook
				? [
						{
							source: `${REACT_HOOK_INIT_SOURCE};`,
							world: "page" as const,
							frames: "main" as const,
							at: "start" as const,
						},
					]
				: []),
			...(this.#cursorOverlay
				? [
						{
							source: `(${installCursorOverlay.toString()})();`,
							world: "page" as const,
							frames: "main" as const,
							at: "start" as const,
						},
					]
				: []),
			...this.#initScripts.map(script => ({
				source: script.source,
				world: "page" as const,
				frames: "all" as const,
				at: "start" as const,
			})),
			{ source: TERN_KIT_SOURCE, world: "isolated", frames: "all", at: "start" },
		];
	}

	/** Send the script list (future documents). */
	async #syncScripts(): Promise<void> {
		await this.#op("scripts", { scripts: this.#scripts() });
	}

	/** Re-apply the capture configuration: future documents and every frame of the current one. */
	async #applyCapture(): Promise<void> {
		await this.#syncScripts();
		const config = { routes: this.#network.rules(), emulation: this.#pageEmulation };
		const children = await this.#kit<TernFrameInfo[]>("frames", []).catch(() => []);
		for (const frame of [null, ...children.map(child => child.path)]) {
			await this.#eval(TERN_CAPTURE_INSTALLER, [config], "page", frame).catch(error => {
				logger.debug("Tern capture update skipped for a frame", {
					frame,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	}

	// ─── Navigation ───────────────────────────────────────────────────────

	/**
	 * Wait for a navigation started after `since`: `load` = Tern's `loaded`
	 * event, `domcontentloaded` = committed and parsed, `networkidle*` = loaded
	 * and at most 0/2 page fetch/XHR in flight for 500 ms (page requests only).
	 * A load failure or allowlist block throws. When a navigation reports no
	 * events (same-document, cached), a settled `state` ends the wait.
	 */
	async #awaitNavigation(
		label: string,
		since: number,
		waitUntil: WaitUntil,
		timeoutMs: number,
		opts: { requireChange: boolean; startUrl: string },
	): Promise<TernRequestEntry | null> {
		let iteration = 0;
		let idleSince: number | undefined;
		let settledByState = false;
		await this.#poll(
			label,
			timeoutMs,
			async () => {
				iteration++;
				const events = this.#eventsSince(since);
				const failed = events.find(event => event.type === "failed");
				if (failed) throw new ToolError(`${label} failed: ${stringOr(failed.message, "load failed")}`);
				const blocked = events.find(event => event.type === "blocked");
				if (blocked) {
					throw new ToolError(`${label} was blocked by allowed_domains: ${stringOr(blocked.url, "")}`);
				}
				const committed = events.some(event => event.type === "committed");
				const changed = committed || events.some(event => event.type === "url");
				let loaded = events.some(event => event.type === "loaded");
				if (!loaded && iteration % 4 === 0) {
					const state = await this.#refreshState();
					if (state.loading === false && (changed || (!opts.requireChange && this.#url !== opts.startUrl))) {
						loaded = true;
						settledByState = true;
					}
				}
				if (opts.requireChange && !changed && !settledByState) return undefined;
				if (waitUntil === "domcontentloaded") {
					if (loaded) return true;
					if (!committed) return undefined;
					const ready = await this.#eval("function () { return document.readyState; }", [], "page", null).catch(
						() => "loading",
					);
					return ready === "loading" ? undefined : true;
				}
				if (!loaded) return undefined;
				if (waitUntil === "load") return true;
				const inflight = numberOr(
					await this.#eval(
						`function () { const capture = globalThis[${JSON.stringify(TERN_CAPTURE_GLOBAL)}]; return capture ? capture.inflight : 0; }`,
						[],
						"page",
						null,
					).catch(() => 0),
					0,
				);
				if (inflight > (waitUntil === "networkidle0" ? 0 : 2)) {
					idleSince = undefined;
					return undefined;
				}
				idleSince ??= Date.now();
				return Date.now() - idleSince >= NAVIGATION_IDLE_MS ? true : undefined;
			},
			{ pull: true },
		);
		const mainResponses = this.#network
			.settledAfter(0)
			.filter(record => record.resourceType === "document" && record.status !== undefined);
		const response = mainResponses.at(-1) ?? null;
		await this.#refreshState().catch(() => undefined);
		return response;
	}

	async #navigate(
		label: string,
		start: () => Promise<unknown>,
		waitUntil: WaitUntil | undefined,
		timeoutMs: number,
	): Promise<TernRequestEntry | null> {
		await this.#pull();
		const since = this.#cursor;
		const responseCursor = this.#network.cursor;
		const startUrl = this.#url;
		await start();
		const response = await this.#awaitNavigation(label, since, waitUntil ?? "load", timeoutMs, {
			requireChange: false,
			startUrl,
		});
		return response && response.seq >= responseCursor ? response : null;
	}

	/** Navigate and wait for `waitUntil` (default `load`). */
	async goto(url: string, opts?: { waitUntil?: WaitUntil; timeoutMs?: number }): Promise<void> {
		await this.gotoResponse(url, opts);
	}

	/** {@link goto}, resolving the main document's response (null when none was reported). */
	async gotoResponse(url: string, opts?: { waitUntil?: WaitUntil; timeoutMs?: number }): Promise<TernResponse | null> {
		const timeoutMs = opts?.timeoutMs ?? resolveOpTimeouts(this.#cellMs).budgetBound;
		const entry = await this.#navigate(
			`tab.goto(${JSON.stringify(url)})`,
			() => this.#op("goto", { url }, timeoutMs),
			opts?.waitUntil,
			timeoutMs,
		);
		return entry ? new TernResponse(entry, this) : null;
	}

	async #history(go: "back" | "forward" | "reload", opts?: { waitUntil?: WaitUntil }): Promise<string> {
		const timeoutMs = resolveOpTimeouts(this.#cellMs).budgetBound;
		if (go !== "reload") {
			const state = await this.#refreshState();
			if (state[go] === false) return this.#url;
		}
		await this.#navigate(`tab.${go}()`, () => this.#op("nav", { go }), opts?.waitUntil, timeoutMs);
		return this.#url;
	}

	/** Go back one history entry (no-op at the start of history). */
	async back(opts?: { waitUntil?: WaitUntil }): Promise<string> {
		return await this.#history("back", opts);
	}

	/** Go forward one history entry (no-op at the end of history). */
	async forward(opts?: { waitUntil?: WaitUntil }): Promise<string> {
		return await this.#history("forward", opts);
	}

	/** Reload the document. */
	async reload(opts?: { waitUntil?: WaitUntil }): Promise<string> {
		return await this.#history("reload", opts);
	}

	/** Client-side navigation (`history.pushState`). */
	async pushState(url: string): Promise<string> {
		const result = await this.#evalUser("tab.pushState()", pushStateInPage, [url], null);
		if (typeof result === "string") this.#url = result;
		return this.#url;
	}

	/** Wait for the next navigation (start it before the action that navigates). */
	async waitForNavigation(opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<TernResponse | null> {
		const timeoutMs = resolveWaitTimeout(this.#cellMs, opts?.timeout ?? resolveOpTimeouts(this.#cellMs).budgetBound);
		await this.#pull();
		const since = this.#cursor;
		const responseCursor = this.#network.cursor;
		const entry = await this.#awaitNavigation(
			"tab.waitForNavigation()",
			since,
			opts?.waitUntil ?? "load",
			timeoutMs,
			{
				requireChange: true,
				startUrl: this.#url,
			},
		);
		return entry && entry.seq >= responseCursor ? new TernResponse(entry, this) : null;
	}

	/** Wait until the URL contains `pattern` (string) or matches it (RegExp). */
	async waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string> {
		const timeoutMs = resolveWaitTimeout(this.#cellMs, opts?.timeout);
		let iteration = 0;
		return await this.#poll(
			`tab.waitForUrl(${String(pattern)})`,
			timeoutMs,
			async () => {
				if (++iteration % 4 === 0) await this.#refreshState();
				if (typeof pattern === "string") return this.#url.includes(pattern) ? this.#url : undefined;
				pattern.lastIndex = 0;
				return pattern.test(this.#url) ? this.#url : undefined;
			},
			{ pull: true },
		);
	}

	/** The current URL (as last reported). */
	url(): string {
		return this.#url;
	}

	/** The title as last reported (title events, state, observe), without asking the page. */
	get lastTitle(): string {
		return this.#title;
	}

	/** The document title. */
	async title(): Promise<string> {
		await this.#refreshState();
		return this.#title;
	}

	/** The page layout size. */
	viewport(): ReadyInfo["viewport"] {
		return { ...this.#viewport };
	}

	/** Resize the PiP's page (`viewport` op); `deviceScaleFactor` scales captures. */
	async setViewport(viewport: ViewportOptions): Promise<void> {
		await this.#op("viewport", { width: Math.round(viewport.width), height: Math.round(viewport.height) });
		this.#viewport = { ...viewport };
	}

	// ─── Selectors and targets ────────────────────────────────────────────

	#spec(selector: string | TernSelector): TernSelector {
		return typeof selector === "string" ? parseTernSelector(selector) : selector;
	}

	/** Viewport offset of `frame`'s content box in the main frame. */
	async #frameOffset(frame: FramePath): Promise<{ x: number; y: number }> {
		if (!frame) return { x: 0, y: 0 };
		const indices = frame.split(".");
		let x = 0;
		let y = 0;
		for (let depth = 0; depth < indices.length; depth++) {
			const parent = depth === 0 ? null : indices.slice(0, depth).join(".");
			const origin = await this.#kit<{ x: number; y: number } | null>(
				"frameOrigin",
				[Number(indices[depth])],
				parent,
			);
			if (!origin) throw new ToolError(`Frame ${frame} is no longer in the page`);
			x += origin.x;
			y += origin.y;
		}
		return { x, y };
	}

	/**
	 * The point to act on for `action`: waits for the element to be actionable
	 * (visible, enabled, editable, stable, not covered) up to the action
	 * ceiling, failing fast after 2 s of zero matches.
	 */
	async #target(
		label: string,
		selector: string | TernSelector,
		action: TernTargetAction,
		frame: FramePath,
		explicitTimeout?: number,
	): Promise<BoundingBox> {
		const spec = this.#spec(selector);
		const timeoutMs =
			explicitTimeout === undefined
				? resolveOpTimeouts(this.#cellMs).actionOpMs
				: resolveWaitTimeout(this.#cellMs, explicitTimeout);
		const started = Date.now();
		let delay = 30;
		let last: TernTarget;
		for (;;) {
			last = await this.#kit<TernTarget>("target", [spec, action], frame);
			if (last.ok) {
				const offset = await this.#frameOffset(frame);
				return { x: last.x + offset.x, y: last.y + offset.y, width: last.width, height: last.height };
			}
			const elapsed = Date.now() - started;
			if (elapsed >= timeoutMs) break;
			if (last.reason === "missing" && explicitTimeout === undefined && elapsed >= ZERO_MATCH_FAIL_FAST_MS) break;
			await untilAborted(this.#signal, () => Bun.sleep(delay));
			delay = Math.min(250, Math.round(delay * 1.5));
		}
		const why =
			last.reason === "missing"
				? "no element matches (wrong page or selector?)"
				: last.reason === "covered"
					? `the element is covered by ${last.detail ?? "another element"}`
					: last.reason === "hidden"
						? "the element is not visible"
						: last.reason === "disabled"
							? "the element is disabled"
							: last.reason === "notEditable"
								? "the element is not editable"
								: last.reason === "offViewport"
									? "the element is outside the viewport"
									: "the element keeps moving";
		throw new ToolError(`${label} timed out after ${Date.now() - started}ms: ${why} (${last.count} match(es))`);
	}

	#mouseStep(
		action: "move" | "down" | "up",
		point: { x: number; y: number },
		button: "left" | "right" | "middle",
		clicks?: number,
	): TernInputStep {
		return {
			type: "mouse",
			action,
			x: point.x,
			y: point.y,
			button,
			...(clicks === undefined ? {} : { clicks }),
			mods: [...this.#mods],
		};
	}

	/** Trusted clicks at `point` (`count` clicks, the last one with click count `count`). */
	async #clickAt(point: { x: number; y: number }, button: "left" | "right" | "middle", count: number): Promise<void> {
		const steps: TernInputStep[] = [this.#mouseStep("move", point, button, 0)];
		for (let click = 1; click <= count; click++) {
			steps.push(this.#mouseStep("down", point, button, click), this.#mouseStep("up", point, button, click));
		}
		this.#pointer = { ...point };
		await this.#input(steps);
	}

	async #clickSelector(
		label: string,
		selector: string | TernSelector,
		frame: FramePath,
		count: number,
		button: MouseButtonName = "left",
	): Promise<void> {
		const pressed = this.#button(button);
		const box = await this.#target(label, selector, count === 2 ? "dblclick" : "click", frame);
		await this.#clickAt(box, pressed, count);
	}

	// ─── Interaction ──────────────────────────────────────────────────────

	/** Click the element's centre with a trusted mouse click. */
	async click(selector: string): Promise<void> {
		await this.clickIn(selector, null);
	}

	/** {@link click} inside `frame`, optionally with another button or click count. */
	async clickIn(
		selector: string | TernSelector,
		frame: FramePath,
		options?: { button?: MouseButtonName; count?: number },
	): Promise<void> {
		const count = Math.max(1, Math.floor(options?.count ?? 1));
		await this.#clickSelector(`tab.click(${describe(selector)})`, selector, frame, count, options?.button);
	}

	/** Double-click the element's centre. */
	async dblclick(selector: string | TernSelector, frame: FramePath = null): Promise<void> {
		await this.#clickSelector(`tab.dblclick(${describe(selector)})`, selector, frame, 2);
	}

	/** Move the pointer over the element's centre. */
	async hover(selector: string | TernSelector, frame: FramePath = null): Promise<void> {
		const box = await this.#target(`tab.hover(${describe(selector)})`, selector, "hover", frame);
		this.#pointer = { x: box.x, y: box.y };
		await this.#input([this.#mouseStep("move", box, "left", 0)]);
	}

	/** Focus the element. */
	async focus(selector: string | TernSelector, frame: FramePath = null): Promise<void> {
		await this.#target(`tab.focus(${describe(selector)})`, selector, "focus", frame);
		await this.#kit("focus", [this.#spec(selector)], frame);
	}

	async #setChecked(selector: string | TernSelector, desired: boolean, frame: FramePath): Promise<void> {
		const label = `tab.${desired ? "check" : "uncheck"}(${describe(selector)})`;
		const spec = this.#spec(selector);
		const box = await this.#target(label, spec, "check", frame);
		const before = await this.#kit<{ checked: boolean }>("checkState", [spec], frame);
		if (before.checked === desired) return;
		await this.#clickAt(box, "left", 1);
		const after = await this.#kit<{ checked: boolean }>("checkState", [spec], frame);
		if (after.checked !== desired) {
			throw new ToolError(`${label} clicked the element but it is still ${desired ? "unchecked" : "checked"}`);
		}
	}

	/** Check a checkbox, radio or ARIA switch (clicks only when needed). */
	async check(selector: string | TernSelector, frame: FramePath = null): Promise<void> {
		await this.#setChecked(selector, true, frame);
	}

	/** Uncheck a checkbox or ARIA switch (clicks only when needed). */
	async uncheck(selector: string | TernSelector, frame: FramePath = null): Promise<void> {
		await this.#setChecked(selector, false, frame);
	}

	/** Type `text` at the end of the element's content with trusted key events. */
	async type(selector: string | TernSelector, text: string, frame: FramePath = null): Promise<void> {
		const spec = this.#spec(selector);
		await this.#target(`tab.type(${describe(selector)})`, spec, "type", frame);
		await this.#kit("caretToEnd", [spec], frame);
		await this.#input(typeSteps(String(text), this.#mods));
	}

	/** Replace the element's value (trusted text input for text controls). */
	async fill(selector: string | TernSelector, value: string, frame: FramePath = null): Promise<void> {
		const spec = this.#spec(selector);
		const text = String(value);
		await this.#target(`tab.fill(${describe(selector)})`, spec, "fill", frame);
		const prepared = await this.#kit<{ mode: "insert" | "done" }>("prepareFill", [spec, text], frame);
		if (prepared.mode === "done") return;
		await this.#input(text.length > 0 ? [{ type: "text", text }] : pressSteps("Backspace", this.#mods));
	}

	/** Press a key (or `Mod+Key` combo), optionally after focusing an element. */
	async press(key: string, opts?: { selector?: string }): Promise<void> {
		await this.pressIn(key, opts, null);
	}

	/** {@link press} inside `frame`. */
	async pressIn(key: string, opts: { selector?: string | TernSelector } | undefined, frame: FramePath): Promise<void> {
		assertTabPressArgs(key, opts);
		if (opts?.selector) await this.focus(opts.selector, frame);
		await this.#input(pressSteps(key, this.#mods));
	}

	/** Hold a key down (modifiers apply to later input). */
	async keyDown(key: string): Promise<void> {
		const resolved = ternKey(key);
		await this.#input([keyDownStep(resolved, this.#mods)]);
		if (resolved.modifier && !this.#mods.includes(resolved.modifier)) this.#mods.push(resolved.modifier);
	}

	/** Release a held key. */
	async keyUp(key: string): Promise<void> {
		const resolved = ternKey(key);
		if (resolved.modifier) {
			const index = this.#mods.indexOf(resolved.modifier);
			if (index >= 0) this.#mods.splice(index, 1);
		}
		await this.#input([keyUpStep(resolved, this.#mods)]);
	}

	#button(name: MouseButtonName | undefined): "left" | "right" | "middle" {
		const button = name ?? "left";
		if (button === "back" || button === "forward") {
			throw unsupported("mouseDown", `the ${button} mouse button cannot be synthesised (left, right, middle only)`);
		}
		return button;
	}

	async #viewportCentre(): Promise<{ x: number; y: number }> {
		const geometry = await this.#kit<TernGeometry>("geometry", []);
		return { x: geometry.innerWidth / 2, y: geometry.innerHeight / 2 };
	}

	/** Move the pointer (interpolated over `steps`); a held button drags. */
	async mouseMove(x: number, y: number, opts?: { steps?: number }): Promise<void> {
		if (!Number.isFinite(x) || !Number.isFinite(y))
			throw new ToolError("mouseMove coordinates must be finite numbers");
		const from = this.#pointer ?? { x, y };
		const steps = Math.max(1, Math.floor(opts?.steps ?? 1));
		const held = [...this.#buttons][0] ?? "left";
		const events: TernInputStep[] = [];
		for (let step = 1; step <= steps; step++) {
			const point = { x: from.x + ((x - from.x) * step) / steps, y: from.y + ((y - from.y) * step) / steps };
			events.push(this.#mouseStep("move", point, held, 0));
		}
		this.#pointer = { x, y };
		await this.#input(events);
	}

	/** Press a mouse button at the pointer. */
	async mouseDown(opts?: { button?: MouseButtonName; clickCount?: number }): Promise<void> {
		const button = this.#button(opts?.button);
		const point = this.#pointer ?? (await this.#viewportCentre());
		this.#buttons.add(button);
		await this.#input([this.#mouseStep("down", point, button, opts?.clickCount ?? 1)]);
	}

	/** Release a mouse button at the pointer. */
	async mouseUp(opts?: { button?: MouseButtonName; clickCount?: number }): Promise<void> {
		const button = this.#button(opts?.button);
		const point = this.#pointer ?? (await this.#viewportCentre());
		this.#buttons.delete(button);
		await this.#input([this.#mouseStep("up", point, button, opts?.clickCount ?? 1)]);
	}

	/** Click at viewport coordinates. */
	async clickAt(x: number, y: number, opts?: { button?: MouseButtonName; clickCount?: number }): Promise<void> {
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ToolError("clickAt coordinates must be finite numbers");
		await this.#clickAt({ x, y }, this.#button(opts?.button), Math.max(1, Math.floor(opts?.clickCount ?? 1)));
	}

	/** A trusted wheel event at the pointer (the viewport centre before any pointer move). */
	async wheel(deltaX: number, deltaY: number): Promise<void> {
		if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY))
			throw new ToolError("wheel deltas must be finite numbers");
		const point = this.#pointer ?? (await this.#viewportCentre());
		await this.#input([{ type: "wheel", x: point.x, y: point.y, dx: deltaX, dy: deltaY, mods: [...this.#mods] }]);
	}

	/** Scroll the page (trusted wheel at the viewport centre) or an element (`scrollBy`). */
	async scroll(dx: number, dy: number, opts?: { selector?: string }): Promise<void> {
		if (opts?.selector) {
			const spec = this.#spec(opts.selector);
			await this.#target(`tab.scroll(${describe(opts.selector)})`, spec, "point", null);
			await this.#kit("scrollBy", [spec, dx, dy]);
			return;
		}
		const centre = await this.#viewportCentre();
		await this.#input([{ type: "wheel", x: centre.x, y: centre.y, dx, dy, mods: [...this.#mods] }]);
	}

	async #dragPoint(target: DragTarget, role: string): Promise<{ x: number; y: number }> {
		if (typeof target === "string") {
			const box = await this.#target(`tab.drag() ${role} ${JSON.stringify(target)}`, target, "drag", null);
			return { x: box.x, y: box.y };
		}
		if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) return { x: target.x, y: target.y };
		throw new ToolError("Drag target must be a selector string or { x: number, y: number } point");
	}

	/** Trusted drag from one selector/point to another. */
	async drag(from: DragTarget, to: DragTarget): Promise<void> {
		const start = await this.#dragPoint(from, "from");
		const end = await this.#dragPoint(to, "to");
		const steps: TernInputStep[] = [
			this.#mouseStep("move", start, "left", 0),
			this.#mouseStep("down", start, "left", 1),
		];
		for (let step = 1; step <= 10; step++) {
			const point = { x: start.x + ((end.x - start.x) * step) / 10, y: start.y + ((end.y - start.y) * step) / 10 };
			steps.push(this.#mouseStep("move", point, "left", 0));
		}
		steps.push(this.#mouseStep("up", end, "left", 1));
		this.#pointer = { ...end };
		await this.#input(steps);
	}

	/** Outline the element for `duration` ms (default 2000). */
	async highlight(selector: string | TernSelector, opts?: { duration?: number }): Promise<void> {
		const duration = opts?.duration ?? 2_000;
		if (!Number.isFinite(duration) || duration < 0)
			throw new ToolError("highlight duration must be a non-negative number");
		const spec = this.#spec(selector);
		await this.#target(`tab.highlight(${describe(selector)})`, spec, "point", null);
		const id = `omp-highlight-${crypto.randomUUID()}`;
		await this.#kit("highlight", [spec, id]);
		try {
			await untilAborted(this.#signal, () => Bun.sleep(duration));
		} finally {
			await this.#kit("removeOverlay", [id]).catch(() => undefined);
		}
	}

	/** Scroll the element into view. */
	async scrollIntoView(selector: string | TernSelector): Promise<void> {
		const spec = this.#spec(selector);
		await this.#target(`tab.scrollIntoView(${describe(selector)})`, spec, "point", null);
		await this.#kit("scrollIntoView", [spec]);
	}

	/** Select `<select>` options by value (then label). */
	async select(selector: string | TernSelector, ...values: string[]): Promise<string[]> {
		const spec = this.#spec(selector);
		await this.#target(`tab.select(${describe(selector)})`, spec, "point", null);
		return await this.#kit<string[]>("select", [spec, values.map(String)]);
	}

	/**
	 * Upload files: a file input (or its label) gets the files through Tern's
	 * native chooser (preset, then opened); any other element gets them dropped.
	 */
	async uploadFile(selector: string | TernSelector, ...filePaths: string[]): Promise<void> {
		if (filePaths.length === 0) throw new ToolError("tab.uploadFile() requires at least one file path");
		const cwd = this.#requireRunContext("tab.uploadFile()").session.cwd;
		const absolute = filePaths.map(filePath => resolveToCwd(filePath, cwd));
		for (const file of absolute) {
			try {
				await fs.promises.access(file);
			} catch {
				throw new ToolError(`tab.uploadFile() cannot read ${file}`);
			}
		}
		const spec = this.#spec(selector);
		await this.#target(`tab.uploadFile(${describe(selector)})`, spec, "upload", null);
		if (await this.#kit<boolean>("isFileInput", [spec])) {
			await this.#pull();
			const since = this.#cursor;
			await this.#op("files", { paths: absolute });
			if ((await this.#kit<string>("openChooser", [spec])) === "input") {
				const answered = await this.#poll(
					"tab.uploadFile() chooser",
					3_000,
					() => (this.#eventsSince(since).some(event => event.type === "chooser") ? true : undefined),
					{ pull: true },
				).catch(() => false);
				if (answered) return;
			}
			// No chooser asked for the preset: disarm it before dropping the files instead.
			await this.#op("files", { paths: null });
		}
		const files = [];
		for (const file of absolute) {
			const handle = Bun.file(file);
			files.push({
				name: path.basename(file),
				type: handle.type || "application/octet-stream",
				data: Buffer.from(await fs.promises.readFile(file)).toString("base64"),
			});
		}
		await this.#kit("setFiles", [spec, files]);
	}

	// ─── Queries ──────────────────────────────────────────────────────────

	async #read<T>(
		selector: string | TernSelector,
		prop: string,
		arg?: unknown,
		frame: FramePath = null,
	): Promise<T | null> {
		return await this.#kit<T | null>("read", [this.#spec(selector), prop, arg], frame);
	}

	/** The element's rendered text, or null. */
	async text(selector: string | TernSelector, frame: FramePath = null): Promise<string | null> {
		return await this.#read<string>(selector, "text", undefined, frame);
	}

	/** The element's inner HTML, or null. */
	async html(selector: string | TernSelector, frame: FramePath = null): Promise<string | null> {
		return await this.#read<string>(selector, "html", undefined, frame);
	}

	/** The form element's value, or null. */
	async value(selector: string | TernSelector, frame: FramePath = null): Promise<string | null> {
		return await this.#read<string | null>(selector, "value", undefined, frame);
	}

	/** One attribute, or null. */
	async attr(selector: string | TernSelector, name: string, frame: FramePath = null): Promise<string | null> {
		return await this.#read<string | null>(selector, "attr", name, frame);
	}

	/** How many elements match. */
	async count(selector: string | TernSelector, frame: FramePath = null): Promise<number> {
		return await this.#kit<number>("count", [this.#spec(selector)], frame);
	}

	/** The element's box in main-frame viewport px, or null. */
	async box(selector: string | TernSelector, frame: FramePath = null): Promise<BoundingBox | null> {
		const box = await this.#read<BoundingBox>(selector, "box", undefined, frame);
		if (!box || !frame) return box;
		const offset = await this.#frameOffset(frame);
		return { ...box, x: box.x + offset.x, y: box.y + offset.y };
	}

	/** Computed styles, or null. */
	async styles(
		selector: string | TernSelector,
		props: string[] = [...DEFAULT_STYLE_PROPERTIES],
	): Promise<Record<string, string> | null> {
		return await this.#read<Record<string, string>>(selector, "styles", props);
	}

	/** Whether the element is visible. */
	async isVisible(selector: string | TernSelector, frame: FramePath = null): Promise<boolean> {
		return (await this.#read<boolean>(selector, "visible", undefined, frame)) === true;
	}

	/** Whether the element is enabled. */
	async isEnabled(selector: string | TernSelector): Promise<boolean> {
		return (await this.#read<boolean>(selector, "enabled")) === true;
	}

	/** Whether the element is checked. */
	async isChecked(selector: string | TernSelector): Promise<boolean> {
		return (await this.#read<boolean>(selector, "checked")) === true;
	}

	/** Wait until `text` appears in the body (or a matching element). */
	async waitForText(text: string, opts: { timeout?: number; selector?: string; exact?: boolean } = {}): Promise<void> {
		const root = opts.selector ? this.#spec(opts.selector) : null;
		await this.#poll(
			`tab.waitForText(${JSON.stringify(text)})`,
			resolveWaitTimeout(this.#cellMs, opts.timeout),
			async () => ((await this.#kit<boolean>("hasText", [text, root, opts.exact === true])) ? true : undefined),
		);
	}

	/** Wait for a visible matching element and return its handle. */
	async waitFor(selector: string, opts?: { timeout?: number }): Promise<TernElementHandle> {
		return await this.waitForIn(selector, opts, null);
	}

	/** {@link waitFor} inside `frame`. */
	async waitForIn(
		selector: string | TernSelector,
		opts: { timeout?: number } | undefined,
		frame: FramePath,
	): Promise<TernElementHandle> {
		const spec = this.#spec(selector);
		await this.#poll(
			`tab.waitFor(${describe(selector)})`,
			resolveWaitTimeout(this.#cellMs, opts?.timeout),
			async () => ((await this.#read<boolean>(spec, "visible", undefined, frame)) === true ? true : undefined),
		);
		return new TernElementHandle(this, spec, frame);
	}

	/** Wait for a matching element (`visible`/`hidden` like Puppeteer); null once hidden/absent. */
	async waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<TernElementHandle | null> {
		return await this.waitForSelectorIn(selector, opts, null);
	}

	/** {@link waitForSelector} inside `frame`. */
	async waitForSelectorIn(
		selector: string | TernSelector,
		opts: { timeout?: number; visible?: boolean; hidden?: boolean } | undefined,
		frame: FramePath,
	): Promise<TernElementHandle | null> {
		const spec = this.#spec(selector);
		const timeoutMs = resolveWaitTimeout(this.#cellMs, opts?.timeout);
		const found = await this.#poll(`tab.waitForSelector(${describe(selector)})`, timeoutMs, async () => {
			if (opts?.hidden) {
				const count = await this.#kit<number>("count", [spec], frame);
				if (count === 0) return false;
				return (await this.#read<boolean>(spec, "visible", undefined, frame)) === true ? undefined : false;
			}
			if (opts?.visible)
				return (await this.#read<boolean>(spec, "visible", undefined, frame)) === true ? true : undefined;
			return (await this.#kit<number>("count", [spec], frame)) > 0 ? true : undefined;
		});
		return found ? new TernElementHandle(this, spec, frame) : null;
	}

	/** One handle per current match of `selector`, in document order. */
	async handlesFor(selector: string): Promise<TernElementHandle[]> {
		const tokens = await this.#kit<string[]>("markAll", [this.#spec(selector)]);
		return tokens.map(token => new TernElementHandle(this, { engine: "handle", token }, null));
	}

	/** Handle for observation id `id` (from the last `observe()`). */
	async id(id: number): Promise<TernElementHandle> {
		const spec: TernSelector = { engine: "id", id };
		await this.#kit("count", [spec]);
		return new TernElementHandle(this, spec, null);
	}

	/** Handle for ARIA snapshot ref `eN` (from the last `ariaSnapshot()`). */
	async ref(id: string): Promise<TernElementHandle> {
		const ref = parseAriaRefSelector(id) ?? id.trim();
		const spec: TernSelector = { engine: "ariaRef", ref };
		if ((await this.#kit<number>("count", [spec])) === 0) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		return new TernElementHandle(this, spec, null);
	}

	/** Type `text` into whatever has focus (trusted key events). */
	async keyboardType(text: string): Promise<void> {
		await this.#input(typeSteps(String(text), this.#mods));
	}

	/** Poll a page-world predicate until it returns a truthy value. */
	async waitForFunction(
		fn: string | ((...args: unknown[]) => unknown | Promise<unknown>),
		opts: { timeout?: number; polling?: number } | undefined,
		args: unknown[],
	): Promise<unknown> {
		const interval = typeof opts?.polling === "number" && opts.polling > 0 ? opts.polling : 100;
		const deadline = Date.now() + resolveWaitTimeout(this.#cellMs, opts?.timeout);
		for (;;) {
			const value = await this.#evalUser("page.waitForFunction()", fn, args, null);
			if (value) return value;
			if (Date.now() >= deadline) {
				throw new ToolError(
					`page.waitForFunction() timed out after ${resolveWaitTimeout(this.#cellMs, opts?.timeout)}ms`,
				);
			}
			await untilAborted(this.#signal, () => Bun.sleep(interval));
		}
	}

	/** Evaluate a function (or expression/statement source) in the page world. */
	async evaluate<R, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R> {
		return (await this.#evalUser("tab.evaluate()", fn, args, null)) as R;
	}

	/** {@link evaluate} inside `frame`. */
	async evaluateIn(fn: unknown, args: unknown[], frame: FramePath): Promise<unknown> {
		return await this.#evalUser("frame.evaluate()", fn, args, frame);
	}

	/** Evaluate `fn(element, ...args)` in the page world for the element `spec` matches. */
	async evaluateOnElement(spec: TernSelector, fn: unknown, args: unknown[], frame: FramePath): Promise<unknown> {
		const source = typeof fn === "function" ? fn.toString() : String(fn);
		const token = await this.#kit<string | null>("mark", [spec], frame);
		if (!token) throw new ToolError("Element handle selector no longer resolves");
		const wrapper = `async function (token, args) {
			const find = root => {
				const direct = root.querySelector('[${HANDLE_ATTRIBUTE}~="' + CSS.escape(token) + '"]');
				if (direct) return direct;
				for (const node of root.querySelectorAll("*")) {
					if (node.shadowRoot) {
						const found = find(node.shadowRoot);
						if (found) return found;
					}
				}
				return null;
			};
			const element = find(document);
			if (!element) throw new Error("Element handle selector no longer resolves");
			return await (${source})(element, ...args);
		}`;
		try {
			return await this.#eval(wrapper, [token, args], "page", frame);
		} catch (error) {
			if (error instanceof TernError && error.kind === "js") {
				throw new ToolError(`elementHandle.evaluate() threw a JavaScript exception:\n${pageErrorText(error)}`);
			}
			throw error;
		} finally {
			// Only this call's token goes; concurrent evaluations on the element keep theirs.
			await this.#kit("unmark", [token], frame).catch(() => undefined);
		}
	}

	// ─── Inspection ───────────────────────────────────────────────────────

	/** Structured observation of interactive (or all) elements; ids feed `tab.id(n)`. */
	async observe(opts?: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		selector?: string;
		compact?: boolean;
	}): Promise<Observation> {
		const observation = await this.#kit<Observation>("observe", [
			{
				includeAll: opts?.includeAll,
				viewportOnly: opts?.viewportOnly,
				compact: opts?.compact,
				...(opts?.selector ? { root: this.#spec(opts.selector) } : {}),
			},
		]);
		this.#url = observation.url;
		if (observation.title !== undefined) this.#title = observation.title;
		return observation;
	}

	/** Playwright-format ARIA snapshot (refs resolve through `ref()`/`aria-ref=`). */
	async ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string | AriaSnapshotDiffResult> {
		return await this.ariaSnapshotIn(selector, opts, null);
	}

	/** {@link ariaSnapshot} inside `frame`. */
	async ariaSnapshotIn(
		selector: string | undefined,
		opts: AriaSnapshotOptions | undefined,
		frame: FramePath,
	): Promise<string | AriaSnapshotDiffResult> {
		const payload = await this.#kit<{ snapshot: string; hrefs: Record<string, string> }>(
			"ariaSnapshot",
			[selector ? this.#spec(selector) : null, { depth: opts?.depth, boxes: opts?.boxes }, opts?.urls === true],
			frame,
		);
		const snapshot = postProcessAriaSnapshot(payload.snapshot, opts, payload.hrefs);
		if (!opts?.diff || frame) return snapshot;
		await this.#refreshState();
		return diffAriaSnapshot(this.#ariaBaselines, ariaSnapshotBaselineKey(selector, opts), this.#url, snapshot);
	}

	/** axe-core audit of the main document (run in the isolated world). */
	async a11y(options: BrowserA11yOptions = {}): Promise<BrowserA11yResult> {
		const context = this.#requireRunContext("tab.a11y()");
		const raw = await this.#eval(
			`function () {\nreturn ${buildA11yPageScript(options)};\n}`,
			[],
			"isolated",
			null,
			context.timeoutMs,
		).catch(error => {
			if (error instanceof TernError && error.kind === "js") {
				throw new ToolError(`tab.a11y() failed: ${kitErrorText(error)}`);
			}
			throw error;
		});
		const result = normalizeA11yResult(this.#url, raw, options.includeIncomplete === true);
		context.output.push({ type: "text", text: formatA11ySummary(result) });
		return result;
	}

	/** Readable text/markdown of the page. */
	async extract(format: ReadableFormat = "markdown", opts?: ReadableExtractOptions): Promise<string> {
		const html = await this.pageContent();
		const readable = await extractReadableFromHtml(html, this.#url, format, opts);
		if (!readable)
			throw new ToolError(`tab.extract(${JSON.stringify(format)}) found no readable content on ${this.#url}`);
		const content = format === "markdown" ? readable.markdown : readable.text;
		if (!content) {
			throw new ToolError(
				`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${this.#url}`,
			);
		}
		return content;
	}

	/** The document's outer HTML. */
	async pageContent(): Promise<string> {
		const html = await this.#eval("function () { return document.documentElement.outerHTML; }", [], "isolated", null);
		return typeof html === "string" ? html : "";
	}

	// ─── Screenshots, PDF ─────────────────────────────────────────────────

	/** Capture raw image bytes: viewport, full page, or an element (optionally in a frame). */
	async captureBytes(
		opts: { selector?: string | TernSelector; fullPage?: boolean; format: "png" | "jpeg"; quality?: number },
		frame: FramePath = null,
	): Promise<Buffer> {
		const scale = this.#viewport.deviceScaleFactor ?? 1;
		const fields: Record<string, unknown> = { scale, format: opts.format };
		if (opts.format === "jpeg") fields.quality = opts.quality ?? 80;
		if (opts.selector !== undefined) {
			// Scrolls the element into view and waits for it to be visible before measuring it.
			await this.#target(`tab.screenshot(${describe(opts.selector)})`, opts.selector, "point", frame);
			const rect = await this.box(opts.selector, frame);
			if (!rect) throw new ToolError("Screenshot selector did not resolve to a visible element");
			fields.rect = rect;
		} else if (opts.fullPage) {
			fields.full = true;
		}
		// Let the page paint the state the caller just produced.
		await this.#eval(
			"function () { return new Promise(resolve => requestAnimationFrame(() => resolve(true))); }",
			[],
			"isolated",
			null,
		).catch(() => undefined);
		const answer = await this.#op("capture", fields, resolveOpTimeouts(this.#cellMs).quickOpMs);
		if (!isRecord(answer) || typeof answer.data !== "string")
			throw new ToolError("Tern capture answered without image data");
		return Buffer.from(answer.data, "base64");
	}

	/** Screenshot with selector/fullPage/annotate/format/quality and change detection. */
	async screenshot(opts: ScreenshotOptions = {}): Promise<string | ScreenshotChangeResult> {
		return await this.screenshotIn(opts, null);
	}

	/** {@link screenshot} inside `frame` (selector captures). */
	async screenshotIn(opts: ScreenshotOptions, frame: FramePath): Promise<string | ScreenshotChangeResult> {
		const context = this.#requireRunContext("tab.screenshot()");
		screenshotQuality(opts);
		const threshold = screenshotThreshold(opts.threshold);
		const changeDetection = opts.ifChanged === true || opts.threshold !== undefined;
		const format = opts.format ?? "png";
		const mime = format === "jpeg" ? "image/jpeg" : "image/png";
		let annotation: TernAnnotation | undefined;
		const legend: ScreenshotAnnotationTarget[] = [];
		if (opts.annotate) {
			const observation = await this.observe();
			annotation = await this.#kit<TernAnnotation>("annotate", [observation.elements.map(element => element.id)]);
			for (const box of annotation.boxes) {
				const element = observation.elements.find(candidate => candidate.id === box.id);
				legend.push({ ...box, role: element?.role ?? "generic", name: element?.name });
			}
		}
		let comparison: Buffer;
		let buffer: Buffer;
		try {
			const capture = { selector: opts.selector, fullPage: opts.fullPage };
			comparison = await this.captureBytes({ ...capture, format: "png" }, frame);
			buffer =
				format === "png"
					? comparison
					: await this.captureBytes({ ...capture, format, quality: opts.quality }, frame);
		} finally {
			if (annotation) await this.#kit("removeOverlay", [annotation.token]).catch(() => undefined);
		}
		let change: ScreenshotChangeResult | undefined;
		if (changeDetection) {
			const scope = screenshotScope(opts);
			const previous = this.#screenshotHistory.get(scope);
			const pixelChangeRatio = previous ? pngPixelChangeRatio(previous.png, comparison) : 1;
			const changed = !previous || pixelChangeRatio > threshold;
			const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;
			this.#screenshotHistory.set(scope, { png: comparison, revision });
			change = { changed, revision, pixelChangeRatio };
			if (!changed) return change;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toString("base64"), mimeType: mime },
			{
				maxWidth: 1024,
				maxHeight: 1024,
				maxBytes: 150 * 1024,
				jpegQuality: 70,
				excludeWebP: context.session.excludeWebP,
			},
		);
		const saveFullRes = !!context.session.browserScreenshotDir || opts.format !== undefined;
		const savedBuffer = saveFullRes ? buffer : Buffer.from(resized.buffer);
		const savedMimeType = saveFullRes ? mime : resized.mimeType;
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest = context.session.browserScreenshotDir
			? path.join(
					context.session.browserScreenshotDir,
					`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
				)
			: path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.${ext}`);
		await Bun.write(dest, savedBuffer);
		context.screenshots.push({
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		});
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			if (opts.annotate) lines.push(formatScreenshotLegend(legend));
			context.output.push({ type: "text", text: lines.join("\n") });
			context.output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return change ? { ...change, path: dest } : dest;
	}

	/** Compare the viewport with a PNG baseline and show the highlighted diff. */
	async diffScreenshot(baselinePath: string, opts: DiffScreenshotOptions = {}): Promise<DiffScreenshotResult> {
		const context = this.#requireRunContext("tab.diffScreenshot()");
		const baseline = await untilAborted(context.signal, () =>
			fs.promises.readFile(resolveToCwd(baselinePath, context.session.cwd)),
		);
		const current = await this.captureBytes({ format: "png" });
		const diff = createPngDiff(baseline, current);
		const changed = diff.pixelChangeRatio > screenshotThreshold(opts.threshold);
		const diffPath = opts.output
			? resolveToCwd(opts.output, context.session.cwd)
			: path.join(os.tmpdir(), `omp-screenshot-diff-${Snowflake.next()}.png`);
		await Bun.write(diffPath, diff.png);
		const resized = await resizeImage(
			{ type: "image", data: diff.png.toString("base64"), mimeType: "image/png" },
			{
				maxWidth: 1024,
				maxHeight: 1024,
				maxBytes: 150 * 1024,
				jpegQuality: 70,
				excludeWebP: context.session.excludeWebP,
			},
		);
		context.screenshots.push({
			dest: diffPath,
			mimeType: "image/png",
			bytes: diff.png.length,
			width: resized.width,
			height: resized.height,
		});
		context.output.push({
			type: "text",
			text: `Screenshot diff: ${diff.pixelChangeRatio.toFixed(6)} changed-pixel ratio (${changed ? "changed" : "unchanged"}); saved to ${diffPath}`,
		});
		context.output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		return { pixelChangeRatio: diff.pixelChangeRatio, changed, diffPath };
	}

	/** Print the page to PDF (WKWebView pagination; layout options unsupported). */
	async pdf(opts: PdfOptions = {}): Promise<string> {
		const ignored = (["format", "landscape", "scale", "printBackground", "margin", "pageRanges"] as const).filter(
			key => opts[key] !== undefined,
		);
		if (ignored.length > 0) {
			throw unsupported(
				"pdf",
				`options ${ignored.join(", ")} are unavailable (WKWebView prints the whole document with its own pagination); only path is supported`,
			);
		}
		const context = this.#requireRunContext("tab.pdf()");
		const answer = await this.#op("pdf", {}, resolveOpTimeouts(this.#cellMs).budgetBound);
		if (!isRecord(answer) || typeof answer.data !== "string") throw new ToolError("Tern pdf answered without data");
		const dest = opts.path
			? resolveToCwd(opts.path, context.session.cwd)
			: path.join(os.tmpdir(), `omp-browser-${Snowflake.next()}.pdf`);
		await Bun.write(dest, Buffer.from(answer.data, "base64"));
		return dest;
	}

	// ─── Frames and dialogs ───────────────────────────────────────────────

	/** Main and child frames; child ids are Tern frame paths (`0`, `1.0`). */
	async frames(): Promise<BrowserFrameInfo[]> {
		await this.#pull();
		const children = await this.#kit<TernFrameInfo[]>("frames", []);
		const result: BrowserFrameInfo[] = [{ id: "main", name: "", url: this.#url, parentId: null }];
		for (const child of children) {
			const parent = child.path.includes(".") ? child.path.slice(0, child.path.lastIndexOf(".")) : "main";
			const info: BrowserFrameInfo = {
				id: child.path,
				name: child.name ?? child.id ?? "",
				url: child.url ?? this.#frameUrls.get(child.path) ?? child.src ?? "",
				parentId: parent,
			};
			if (child.id) info.selector = `iframe[id=${JSON.stringify(child.id)}]`;
			else if (child.name) info.selector = `iframe[name=${JSON.stringify(child.name)}]`;
			result.push(info);
		}
		return result;
	}

	/** A child frame by `<iframe>` selector, frame name, frame id/path, or exact URL. */
	async frame(selectorOrNameOrUrl: string): Promise<TernFrame> {
		let spec: TernSelector | undefined;
		try {
			spec = parseTernSelector(selectorOrNameOrUrl);
		} catch {
			spec = undefined;
		}
		if (spec) {
			const found = await this.#kit<string | null>("frameOf", [spec]).catch(() => null);
			if (found) return new TernFrame(this, found);
		}
		const match = (await this.frames()).find(
			frame =>
				frame.parentId !== null &&
				(frame.id === selectorOrNameOrUrl ||
					frame.name === selectorOrNameOrUrl ||
					frame.url === selectorOrNameOrUrl),
		);
		if (!match) throw new ToolError(`tab.frame(${JSON.stringify(selectorOrNameOrUrl)}) found no matching frame`);
		return new TernFrame(this, match.id);
	}

	/** The confirm/prompt Tern holds for a decision. */
	async dialog(): Promise<DialogState> {
		await this.#pull();
		const pending = this.#pendingDialog;
		if (!pending) return { open: false };
		return {
			open: true,
			type: pending.type,
			message: pending.message,
			...(pending.defaultValue !== undefined ? { defaultValue: pending.defaultValue } : {}),
		};
	}

	/** Accept or dismiss the held dialog. */
	async handleDialog(opts: { accept: boolean; text?: string }): Promise<void> {
		try {
			await this.#op("dialog", {
				accept: opts.accept === true,
				...(opts.text !== undefined ? { text: opts.text } : {}),
			});
		} catch (error) {
			if (error instanceof TernError && error.kind === "failed") {
				throw new ToolError("tab.handleDialog() found no pending confirm or prompt");
			}
			throw error;
		}
		this.#pendingDialog = undefined;
	}

	/** Change the automatic dialog policy (null: alerts accepted, confirms/prompts held). */
	async setDialogs(policy: DialogPolicy | null): Promise<void> {
		await this.#op("dialogs", { policy: policy ?? "default" });
		await this.#pull();
		if (policy && this.#pendingDialog) await this.handleDialog({ accept: policy === "accept" });
	}

	// ─── Emulation and clipboard ──────────────────────────────────────────

	/** Merge emulation overrides; unsupported ones throw before anything applies. */
	async emulate(options: BrowserEmulateOptions = {}): Promise<BrowserEmulateOptions> {
		if (options.timezone !== undefined && options.timezone !== null) {
			throw unsupported("emulate", "timezone cannot be overridden in WKWebView (Date keeps the system time zone)");
		}
		if (options.headers !== undefined && options.headers !== null && Object.keys(options.headers).length > 0) {
			throw unsupported("emulate", "extra HTTP headers cannot be added to WKWebView navigations and subresources");
		}
		if (options.reducedMotion !== undefined) {
			throw unsupported(
				"emulate",
				"prefers-reduced-motion cannot be overridden in WKWebView (CSS media queries follow the system)",
			);
		}
		if (options.cpuThrottling !== undefined && options.cpuThrottling !== null && options.cpuThrottling !== 1) {
			throw unsupported("emulate", "CPU throttling needs the Chromium DevTools protocol");
		}
		if (options.network !== undefined && options.network !== null) {
			throw unsupported(
				"emulate",
				"network throttling needs the Chromium DevTools protocol (use offline: true for offline)",
			);
		}
		let pageChanged = false;
		if (options.device !== undefined) {
			await loadPuppeteer();
			const device = loadedKnownDevices()[options.device];
			if (!device)
				throw new ToolError(`Unknown Puppeteer device ${JSON.stringify(options.device)}. Use tab.devices().`);
			await this.setViewport({
				width: device.viewport.width,
				height: device.viewport.height,
				deviceScaleFactor: device.viewport.deviceScaleFactor,
			});
			this.#deviceUserAgent = device.userAgent;
			await this.#op("agent", { value: options.userAgent ?? device.userAgent });
			this.#emulation.device = options.device;
		}
		if (options.viewport) {
			await this.setViewport({
				width: options.viewport.width,
				height: options.viewport.height,
				deviceScaleFactor: options.viewport.scale,
			});
			this.#emulation.viewport = { ...options.viewport };
		}
		if (options.userAgent !== undefined) {
			await this.#op("agent", { value: options.userAgent ?? this.#deviceUserAgent ?? null });
			this.#emulation.userAgent = options.userAgent;
		}
		if (options.colorScheme !== undefined) {
			await this.#op("appearance", { value: options.colorScheme === "no-preference" ? null : options.colorScheme });
			this.#emulation.colorScheme = options.colorScheme;
		}
		if (options.credentials !== undefined) {
			await this.#op(
				"credentials",
				options.credentials
					? { username: options.credentials.username, password: options.credentials.password }
					: {},
			);
			this.#emulation.credentials = options.credentials ? { ...options.credentials } : null;
		}
		if (options.geolocation !== undefined) {
			this.#pageEmulation = { ...this.#pageEmulation, geolocation: options.geolocation ?? undefined };
			this.#emulation.geolocation = options.geolocation ? { ...options.geolocation } : null;
			pageChanged = true;
		}
		if (options.locale !== undefined) {
			this.#pageEmulation = { ...this.#pageEmulation, locale: options.locale ?? undefined };
			this.#emulation.locale = options.locale;
			pageChanged = true;
		}
		if (options.offline !== undefined) {
			this.#pageEmulation = { ...this.#pageEmulation, offline: options.offline };
			this.#emulation.offline = options.offline;
			pageChanged = true;
		}
		for (const key of ["timezone", "headers", "cpuThrottling", "network"] as const) {
			if (options[key] !== undefined) Object.assign(this.#emulation, { [key]: options[key] });
		}
		if (pageChanged) await this.#applyCapture();
		return structuredClone(this.#emulation);
	}

	/** Puppeteer known-device names. */
	async devices(): Promise<string[]> {
		await loadPuppeteer();
		return Object.keys(loadedKnownDevices()).sort();
	}

	/** Read the system clipboard (Tern's `clipboard` op). */
	async clipboardRead(): Promise<ClipboardReadResult> {
		const answer = await this.#client.request({ op: "clipboard" }, { signal: this.#signal });
		const text = isRecord(answer) && typeof answer.text === "string" ? answer.text : "";
		return { text, source: "page" };
	}

	/** Write the system clipboard. */
	async clipboardWrite(text: string): Promise<ClipboardActionResult> {
		await this.#client.request({ op: "clipboard", text: String(text) }, { signal: this.#signal });
		return { source: "page" };
	}

	/** Copy the page selection to the system clipboard. */
	async clipboardCopy(): Promise<ClipboardActionResult> {
		await this.#op("edit", { action: "copy" });
		return { source: "page" };
	}

	/** Paste the system clipboard into the focused control. */
	async clipboardPaste(): Promise<ClipboardActionResult> {
		await this.#op("edit", { action: "paste" });
		return { source: "page" };
	}

	// ─── Cookies and storage ──────────────────────────────────────────────

	async #allCookies(): Promise<BrowserCookie[]> {
		const answer = await this.#op("cookies");
		if (!isRecord(answer) || !Array.isArray(answer.cookies)) return [];
		return answer.cookies.map(cookieFromTern).filter((cookie): cookie is BrowserCookie => cookie !== null);
	}

	/** Cookies visible to the current page (or `urls`). */
	async cookies(options: CookieQueryOptions = {}): Promise<BrowserCookie[]> {
		if (!Array.isArray(options.urls) && options.urls !== undefined) {
			throw new ToolError("tab.cookies() expects urls to be an array");
		}
		const urls: URL[] = [];
		for (const raw of options.urls?.length ? options.urls : [this.#url]) {
			try {
				urls.push(new URL(raw));
			} catch {
				throw new ToolError(`tab.cookies() received an invalid URL ${JSON.stringify(raw)}`);
			}
		}
		return (await this.#allCookies()).filter(cookie => urls.some(url => cookieMatchesUrl(cookie, url)));
	}

	/** Store cookies (objects, Cookie headers, cURL dumps, JSON arrays). */
	async setCookies(...args: unknown[]): Promise<void> {
		for (const cookie of normalizeCookieArguments(args)) {
			let domain = cookie.domain;
			let cookiePath = cookie.path;
			let secure = cookie.secure;
			const base = cookie.url ?? (domain ? undefined : this.#url);
			if (base) {
				let parsed: URL;
				try {
					parsed = new URL(base);
				} catch {
					throw new ToolError(`tab.setCookies() needs a domain or url for cookie ${JSON.stringify(cookie.name)}`);
				}
				domain ??= parsed.hostname;
				cookiePath ??= "/";
				secure ??= parsed.protocol === "https:";
			}
			if (!domain)
				throw new ToolError(`tab.setCookies() needs a domain or url for cookie ${JSON.stringify(cookie.name)}`);
			await this.#op("setCookie", {
				cookie: {
					name: cookie.name,
					value: cookie.value,
					domain,
					path: cookiePath ?? "/",
					expires: cookie.expires === undefined || cookie.expires < 0 ? null : cookie.expires,
					httpOnly: cookie.httpOnly ?? false,
					secure: secure ?? false,
					sameSite: cookie.sameSite ?? null,
				},
			});
		}
	}

	/** Delete the current page's cookies (or only `names`). */
	async clearCookies(options: ClearCookiesOptions = {}): Promise<void> {
		if (!Array.isArray(options.names) && options.names !== undefined) {
			throw new ToolError("tab.clearCookies() expects names to be an array");
		}
		const wanted = options.names ? new Set(options.names) : undefined;
		for (const cookie of await this.cookies()) {
			if (wanted && !wanted.has(cookie.name)) continue;
			await this.#op("deleteCookie", { name: cookie.name, domain: cookie.domain, path: cookie.path });
		}
	}

	/** One Web Storage area of the current origin, or one key. */
	async storage(kind: StorageKind, options: { key?: string } = {}): Promise<Record<string, string> | string | null> {
		assertStorageKind(kind);
		if (options.key !== undefined && typeof options.key !== "string") {
			throw new ToolError("tab.storage() expects key to be a string");
		}
		const value = await this.#evalUser("tab.storage()", readStorageInPage, [kind, options.key], null);
		return typeof value === "string" || isRecord(value) ? (value as Record<string, string> | string) : null;
	}

	/** Set one key or several. */
	async setStorage(kind: StorageKind, keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
		assertStorageKind(kind);
		const entries: Array<[string, string]> =
			typeof keyOrEntries === "string" ? [[keyOrEntries, storageValue(value)]] : storageEntries(keyOrEntries);
		await this.#evalUser("tab.setStorage()", writeStorageInPage, [kind, entries], null);
	}

	/** Clear one Web Storage area. */
	async clearStorage(kind: StorageKind): Promise<void> {
		assertStorageKind(kind);
		await this.#evalUser("tab.clearStorage()", clearStorageInPage, [kind], null);
	}

	/** Save every cookie of the PiP's store plus the current origin's storage. */
	async saveState(requestedPath?: string): Promise<string> {
		const context = this.#requireRunContext("tab.saveState()");
		const destination = storageStatePath(this.#name, requestedPath, context.session.cwd);
		const [cookies, origin] = await Promise.all([
			this.#allCookies(),
			this.#evalUser("tab.saveState()", readOriginStorageInPage, [], null),
		]);
		const origins = isRecord(origin) ? [origin as unknown as StorageStateOrigin] : [];
		await Bun.write(destination, `${JSON.stringify({ cookies, origins }, null, 2)}\n`);
		return destination;
	}

	/** Restore cookies and the current origin's storage; other origins are reported as skipped. */
	async loadState(requestedPath: string): Promise<LoadStateResult> {
		const context = this.#requireRunContext("tab.loadState()");
		const state = await readStorageStateFile(requestedPath, context.session.cwd, context.signal);
		if (state.cookies.length > 0) await this.setCookies(...state.cookies);
		let currentOrigin = "null";
		try {
			currentOrigin = new URL(this.#url).origin;
		} catch {}
		const loadedOrigins: string[] = [];
		const skippedOrigins: string[] = [];
		for (const origin of state.origins) {
			if (origin.origin === currentOrigin) {
				await this.#evalUser("tab.loadState()", restoreOriginStorageInPage, [origin], null);
				loadedOrigins.push(origin.origin);
			} else {
				skippedOrigins.push(origin.origin);
			}
		}
		return { loadedOrigins, skippedOrigins };
	}

	// ─── Init scripts and downloads ───────────────────────────────────────

	/** Run `source` in every future document (all frames). */
	async addInitScript(source: string): Promise<{ id: string }> {
		if (typeof source !== "string") throw new ToolError("tab.addInitScript(source) requires a string");
		const id = `tern-init-${this.#nextInitScript++}`;
		this.#initScripts.push({ id, source });
		try {
			await this.#syncScripts();
		} catch (error) {
			this.#initScripts.pop();
			throw error;
		}
		return { id };
	}

	/** Stop running a registered script in future documents. */
	async removeInitScript(id: string): Promise<void> {
		if (typeof id !== "string" || id.length === 0)
			throw new ToolError("tab.removeInitScript(id) requires a non-empty script id");
		const index = this.#initScripts.findIndex(script => script.id === id);
		if (index < 0) throw new ToolError(`Unknown init script ${JSON.stringify(id)}`);
		this.#initScripts.splice(index, 1);
		await this.#syncScripts();
	}

	/** Registered init scripts. */
	async initScripts(): Promise<Array<{ id: string; source: string }>> {
		return this.#initScripts.map(script => ({ ...script }));
	}

	async #enableDownloads(dir?: string): Promise<void> {
		const resolved = path.resolve(dir ?? path.join(os.tmpdir(), `omp-downloads-tern-${this.block}`));
		if (this.#downloadDir === resolved) return;
		await fs.promises.mkdir(resolved, { recursive: true });
		await this.#op("downloads", { dir: resolved });
		this.#downloadDir = resolved;
	}

	/** Wait for the next completed download. */
	async waitForDownload(opts?: { timeout?: number }): Promise<BrowserDownload> {
		if (!this.#downloadDir) await this.#enableDownloads();
		const failedBefore = new Set(
			[...this.#downloads].filter(([, entry]) => entry.state === "failed").map(([id]) => id),
		);
		return await this.#poll(
			"tab.waitForDownload()",
			resolveWaitTimeout(this.#cellMs, opts?.timeout ?? resolveOpTimeouts(this.#cellMs).budgetBound),
			() => {
				const ready = this.#unclaimedDownloads.shift();
				if (ready) return { ...ready };
				for (const [id, entry] of this.#downloads) {
					if (entry.state === "failed" && !failedBefore.has(id)) {
						throw new ToolError(`Download of ${entry.url} failed: ${entry.error ?? "unknown error"}`);
					}
				}
				return undefined;
			},
			{ pull: true },
		);
	}

	/** Completed downloads of this tab. */
	async downloads(): Promise<BrowserDownload[]> {
		if (!this.#downloadDir) await this.#enableDownloads();
		await this.#pull();
		return this.#completedDownloads.map(download => ({ ...download }));
	}

	// ─── Console, network ─────────────────────────────────────────────────

	async #capture(
		kind: "console" | "errors",
		options: BrowserConsoleOptions | BrowserErrorOptions,
	): Promise<BrowserCaptureResult<CaptureEntry>> {
		await this.#pull();
		const since = Number.isFinite(options.since) ? Math.floor(options.since ?? 0) : 0;
		const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit ?? 500)) : 500;
		const level = "level" in options ? options.level : undefined;
		const entries = this.#console
			.filter(entry => entry.seq > since)
			.filter(entry =>
				kind === "console"
					? entry.type === "console" && (!level || entry.level === level)
					: entry.type !== "console",
			)
			.slice(0, limit)
			.map(entry => ({ ...entry }));
		const result = {
			entries,
			nextSeq: entries.length ? entries[entries.length - 1]!.seq : this.#consoleSeq - 1,
			dropped: this.#consoleDropped,
		};
		if (options.clear) this.#clearConsoleBuffer();
		return result;
	}

	#clearConsoleBuffer(): void {
		this.#console.length = 0;
		this.#consoleDropped = 0;
	}

	/** Captured console messages (page world, from document start). */
	async console(options: BrowserConsoleOptions = {}): Promise<BrowserCaptureResult<BrowserConsoleEntry>> {
		const result = await this.#capture("console", options);
		return {
			...result,
			entries: result.entries.filter((entry): entry is BrowserConsoleEntry => entry.type === "console"),
		};
	}

	/** Captured uncaught errors and failed requests. */
	async errors(options: BrowserErrorOptions = {}): Promise<BrowserCaptureResult<BrowserErrorEntry>> {
		const result = await this.#capture("errors", options);
		return {
			...result,
			entries: result.entries.filter((entry): entry is BrowserErrorEntry => entry.type !== "console"),
		};
	}

	/** Clear the console/error buffer. */
	async clearConsole(): Promise<void> {
		await this.#pull();
		this.#clearConsoleBuffer();
	}

	/**
	 * Load a captured response body from the frame that made the request,
	 * waiting (within the op budget and the run's signal) for a body the page
	 * is still reading.
	 */
	loadBody = async (entry: TernRequestEntry): Promise<NetworkResponseBody | null> => {
		if (!entry.pageId) return null;
		const body = await this.#eval(
			`function (id) { const capture = globalThis[${JSON.stringify(TERN_CAPTURE_GLOBAL)}]; return capture && capture.body ? capture.body(id) : null; }`,
			[entry.pageId],
			"page",
			entry.frame ?? null,
		).catch((error: unknown) => {
			if (error instanceof ToolAbortError || (error instanceof Error && error.name === "AbortError")) throw error;
			return null;
		});
		if (!isRecord(body) || typeof body.contentType !== "string") return null;
		const value =
			typeof body.value === "string"
				? body.value
				: isRecord(body.value) && typeof body.value.base64 === "string"
					? { base64: body.value.base64 }
					: null;
		if (value === null) return null;
		return {
			value,
			contentType: body.contentType,
			truncated: body.truncated === true,
			bytes: numberOr(body.bytes, 0),
			isText: body.isText === true,
		};
	};

	/** Register a persistent fetch/XHR route. */
	async route(pattern: NetworkPattern, options: NetworkRouteOptions = {}): Promise<void> {
		this.#network.route(pattern, options);
		await this.#applyCapture();
	}

	/** Remove matching routes, or all. */
	async unroute(pattern?: NetworkPattern): Promise<void> {
		this.#network.unroute(pattern);
		await this.#applyCapture();
	}

	/** Registered routes. */
	async routes(): Promise<NetworkRouteDescription[]> {
		return this.#network.routes();
	}

	/** Query the request log. */
	async requests(options: NetworkRequestsOptions = {}): Promise<NetworkRequestRecord[]> {
		await this.#pull();
		return this.#network.requests(options);
	}

	/** One request with its captured body. */
	async request(id: string | number): Promise<NetworkRequestDetail> {
		await this.#pull();
		return await this.#network.request(id, this.loadBody);
	}

	/** Clear the request log. */
	async clearRequests(): Promise<void> {
		await this.#pull();
		this.#network.clear();
	}

	/** Start a HAR recording. */
	async harStart(options: { content?: HarContentPolicy } = {}): Promise<void> {
		await this.#pull();
		this.#network.harStart(options.content ?? "none");
	}

	/** Stop the HAR recording and write it. */
	async harStop(options: { path?: string } = {}): Promise<string> {
		const context = this.#requireRunContext("tab.harStop()");
		await this.#pull();
		const har = await this.#network.harStop(this.loadBody);
		const destination = options.path
			? resolveToCwd(options.path, context.session.cwd)
			: path.join(os.tmpdir(), `omp-browser-${Snowflake.next()}.har`);
		await Bun.write(destination, `${JSON.stringify(har, null, 2)}\n`);
		return destination;
	}

	/** The normalised hostname allowlist. */
	async allowedDomains(): Promise<string[]> {
		return [...this.#allowedDomains];
	}

	/** Wait for a matching fetch/XHR/navigation response after now. */
	async waitForResponse(
		pattern: string | RegExp | ((response: TernResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<TernResponse> {
		await this.#pull();
		// Responses arriving from now on, in arrival order (requests already in flight included).
		let cursor = this.#network.settleCursor;
		return await this.#poll(
			"tab.waitForResponse()",
			resolveWaitTimeout(this.#cellMs, opts?.timeout ?? resolveOpTimeouts(this.#cellMs).budgetBound),
			async () => {
				for (const record of this.#network.settledAfter(cursor)) {
					cursor = record.settledSeq ?? cursor;
					if (record.status === undefined) continue;
					const response = new TernResponse(record, this);
					if (typeof pattern === "function") {
						if (await pattern(response)) return response;
					} else if (typeof pattern === "string" ? record.url.includes(pattern) : pattern.test(record.url)) {
						return response;
					}
				}
				return undefined;
			},
			{ pull: true },
		);
	}

	// ─── Performance, React, WebMCP ───────────────────────────────────────

	/** Navigation timing of the current document. */
	async metrics(): Promise<Record<string, number> & { domContentLoaded: number; load: number }> {
		const value = await this.#eval(
			`function () {
				const nav = performance.getEntriesByType("navigation")[0];
				const round = value => Math.round((Number(value) || 0) * 100) / 100;
				return {
					domContentLoaded: round(nav && nav.domContentLoadedEventEnd),
					load: round(nav && nav.loadEventEnd),
					Nodes: document.getElementsByTagName("*").length,
					Timestamp: round(performance.now()),
				};
			}`,
			[],
			"isolated",
			null,
		);
		if (!isRecord(value)) throw new ToolError("tab.metrics() could not read navigation timing");
		const result: Record<string, number> = {};
		for (const key in value) result[key] = numberOr(value[key], 0);
		return { ...result, domContentLoaded: result.domContentLoaded ?? 0, load: result.load ?? 0 };
	}

	#reactHost(): ReactPageHost {
		return {
			evaluate: (source, signal) => this.#evalExpression(source, signal),
			addInitSource: async source => {
				if (source === REACT_HOOK_INIT_SOURCE) this.#reactHook = true;
				await this.#syncScripts();
			},
			reload: async () => {
				await this.reload({ waitUntil: "load" });
			},
		};
	}

	/** Web Vitals of the current document (observers run from document start). */
	async vitals(options: VitalsOptions = {}): Promise<VitalsResult> {
		return await collectVitals(this.#reactHost(), options, this.#signal);
	}

	/** Install the React DevTools hook and reload. */
	async reactEnable(): Promise<ReactEnableResult> {
		return await enableReact(this.#reactHost(), this.#signal);
	}

	/** The mounted React tree. */
	async reactTree(options: ReactTreeOptions = {}): Promise<ReactTreeNode[]> {
		const envelope = await this.#evalExpression(reactTreeSource(options));
		return requireReactHookResult(envelope as ReactPageEnvelope<ReactTreeNode[]>);
	}

	/** One React fiber. */
	async reactInspect(id: number): Promise<ReactInspectResult> {
		return reactInspectResult(await this.#evalExpression(reactInspectSource(id)), id);
	}

	/** React render recording. */
	async reactRenders(options: { action: ReactRendersAction }): Promise<ReactRendersResult> {
		const envelope = await this.#evalExpression(reactRendersSource(options.action));
		return requireReactHookResult(envelope as ReactPageEnvelope<ReactRendersResult>);
	}

	/** React Suspense boundaries. */
	async reactSuspense(options: ReactSuspenseOptions = {}): Promise<ReactSuspenseBoundary[]> {
		const envelope = await this.#evalExpression(reactSuspenseSource(options));
		return requireReactHookResult(envelope as ReactPageEnvelope<ReactSuspenseBoundary[]>);
	}

	#webMcp(): WebMcpController {
		this.#webmcp ??= new WebMcpController(
			{
				frames: async () => [
					{
						id: "main",
						snapshot: async () =>
							(await this.#eval(
								webMcpSnapshotInPage.toString(),
								[WEBMCP_BRIDGE_KEY],
								"page",
								null,
							)) as WebMcpHookSnapshot,
						invoke: async (name, params) =>
							(await this.#eval(
								webMcpInvokeInPage.toString(),
								[WEBMCP_BRIDGE_KEY, name, params],
								"page",
								null,
							)) as WebMcpHookInvokeEnvelope,
					},
				],
				nativeTools: () => [],
				dispose: async () => {
					await this.#eval(uninstallWebMcpPageHook.toString(), [WEBMCP_BRIDGE_KEY], "page", null).catch(
						() => undefined,
					);
				},
			},
			{
				nativeSupported: false,
				unavailableReason: "No page-side WebMCP tool registrations were observed in the main frame.",
			},
		);
		return this.#webmcp;
	}

	/** Page-provided WebMCP tools (main frame). */
	async webmcpList(options: WebMcpListOptions = {}): Promise<WebMcpListResult> {
		return await this.#webMcp().list(options);
	}

	/** Invoke one page-provided WebMCP tool. */
	async webmcpInvoke(
		name: string,
		params: Record<string, unknown>,
		options: WebMcpInvokeOptions = {},
	): Promise<WebMcpInvokeResult> {
		return await this.#webMcp().invoke(name, params, options);
	}

	/** WebMCP catalog changes. */
	async webmcpEvents(options: WebMcpEventsOptions = {}): Promise<WebMcpEventsResult> {
		return await this.#webMcp().events(options);
	}

	// ─── Recording ────────────────────────────────────────────────────────

	#recordingSource(): RecordingFrameSource {
		let active = false;
		let loop: Promise<void> | undefined;
		const tab = this;
		const capture = async (quality: number): Promise<Uint8Array> =>
			await tab.captureBytes({ format: "jpeg", quality: Math.max(1, Math.min(100, Math.round(quality))) });
		return {
			viewport: async () => {
				const geometry = await tab.#kit<TernGeometry>("geometry", []);
				return { width: geometry.innerWidth, height: geometry.innerHeight };
			},
			start: async (params: RecordingFrameSourceStartParams) => {
				active = true;
				const intervalMs = Math.max(33, (params.everyNthFrame ?? 2) * (1000 / 60));
				loop = (async () => {
					while (active) {
						const startedAt = Date.now();
						try {
							const data = await tab.#client.request(
								{ op: "capture", block: tab.block, format: "jpeg", quality: params.quality, scale: 1 },
								{ timeoutMs: 10_000 },
							);
							if (active && isRecord(data) && typeof data.data === "string") {
								await params.onFrame({ data: Buffer.from(data.data, "base64"), timestampMs: startedAt });
							}
						} catch (error) {
							logger.debug("Tern recording frame capture failed", {
								error: error instanceof Error ? error.message : String(error),
							});
							if (error instanceof TernError && (error.kind === "closed" || error.kind === "not_found")) return;
						}
						await Bun.sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
					}
				})();
			},
			stop: async () => {
				active = false;
				await loop;
			},
			captureFrame: async quality => await capture(quality),
			installCursor: async () => {
				tab.#cursorOverlay = true;
				await tab.#syncScripts();
				await tab.#eval(installCursorOverlay.toString(), [], "page", null).catch(() => undefined);
			},
			removeCursor: async () => {
				tab.#cursorOverlay = false;
				await tab.#syncScripts().catch(() => undefined);
				await tab.#eval(removeCursorOverlay.toString(), [], "page", null).catch(() => undefined);
			},
		};
	}

	/** Record the PiP to MP4/WebM from repeated captures. */
	async recordStart(rawPath: string, options?: RecordingOptions): Promise<RecordingStartResult> {
		const context = this.#requireRunContext("tab.recordStart()");
		return await this.#recording.start(
			this.#recordingSource(),
			rawPath,
			context.session.cwd,
			options,
			context.signal,
		);
	}

	/** Finalize the recording. */
	async recordStop(): Promise<RecordingStopResult> {
		const context = this.#requireRunContext("tab.recordStop()");
		return await this.#recording.stop({
			signal: context.signal,
			output: context.output,
			excludeWebP: context.session.excludeWebP,
		});
	}

	/** Finalize and immediately start another recording. */
	async recordRestart(rawPath: string, options?: RecordingOptions): Promise<RecordingStartResult> {
		const context = this.#requireRunContext("tab.recordRestart()");
		return await this.#recording.restart(this.#recordingSource(), rawPath, context.session.cwd, options, {
			signal: context.signal,
			output: context.output,
			excludeWebP: context.session.excludeWebP,
		});
	}

	/** Recording state. */
	async recording(): Promise<RecordingStatus> {
		return this.#recording.status();
	}

	// ─── Unsupported ──────────────────────────────────────────────────────

	/** Unsupported: WKWebView has no tracing protocol. */
	async traceStart(_options: { screenshots?: boolean; categories?: string[] } = {}): Promise<never> {
		throw unsupported("traceStart", "WKWebView exposes no performance-trace protocol");
	}

	/** Unsupported: WKWebView has no tracing protocol. */
	async traceStop(_options: { path?: string } = {}): Promise<never> {
		throw unsupported("traceStop", "WKWebView exposes no performance-trace protocol");
	}

	/** Unsupported: WKWebView has no CPU profiler protocol. */
	async profileStart(): Promise<never> {
		throw unsupported("profileStart", "WKWebView exposes no CPU-profiler protocol");
	}

	/** Unsupported: WKWebView has no CPU profiler protocol. */
	async profileStop(_options: { path?: string } = {}): Promise<never> {
		throw unsupported("profileStop", "WKWebView exposes no CPU-profiler protocol");
	}

	#requireRunContext(operation: string): InProcessRunContext {
		if (!this.#runContext) throw new ToolError(`${operation} requires an active Tern browser run`);
		return this.#runContext;
	}
}

/** Selector text for helper labels. */
function describe(selector: string | TernSelector): string {
	return JSON.stringify(selector);
}

/** A response seen by the Tern tab: fetch/XHR (body from the page) or a navigation (no body). */
export class TernResponse {
	readonly #record: TernRequestEntry;
	readonly #tab: TernTab;

	constructor(record: TernRequestEntry, tab: TernTab) {
		this.#record = record;
		this.#tab = tab;
	}

	/** The response URL. */
	url(): string {
		return this.#record.url;
	}

	/** The HTTP status. */
	status(): number {
		return this.#record.status ?? 0;
	}

	/** The status text. */
	statusText(): string {
		return this.#record.statusText ?? "";
	}

	/** Whether the status is 2xx. */
	ok(): boolean {
		return this.#record.ok === true;
	}

	/** Response headers (lower-case names). */
	headers(): Record<string, string> {
		return { ...this.#record.responseHeaders };
	}

	/** The request's method and URL. */
	request(): { url(): string; method(): string; resourceType(): string } {
		const record = this.#record;
		return { url: () => record.url, method: () => record.method, resourceType: () => record.resourceType };
	}

	/** The body as text (fetch/XHR responses the page still holds). */
	async text(): Promise<string> {
		const body = await this.#tab.loadBody(this.#record);
		if (!body) {
			throw new ToolError(
				`The body of ${this.#record.url} is not available on the Tern backend (only fetch/XHR bodies of the current document are captured)`,
			);
		}
		return typeof body.value === "string" ? body.value : Buffer.from(body.value.base64, "base64").toString("utf8");
	}

	/** The body parsed as JSON. */
	async json(): Promise<unknown> {
		return JSON.parse(await this.text());
	}
}

/** Element handle of the Tern tab (`tab.id(n)`, `tab.ref(eN)`, `waitFor`). */
export class TernElementHandle {
	readonly #tab: TernTab;
	readonly #spec: TernSelector;
	readonly #frame: FramePath;

	constructor(tab: TernTab, spec: TernSelector, frame: FramePath) {
		this.#tab = tab;
		this.#spec = spec;
		this.#frame = frame;
	}

	/** Trusted click at the element's centre. */
	async click(options?: { button?: MouseButtonName; count?: number }): Promise<void> {
		await this.#tab.clickIn(this.#spec, this.#frame, options);
	}

	/** Trusted double click. */
	async dblclick(): Promise<void> {
		await this.#tab.dblclick(this.#spec, this.#frame);
	}

	/** Check it. */
	async check(): Promise<void> {
		await this.#tab.check(this.#spec, this.#frame);
	}

	/** Uncheck it. */
	async uncheck(): Promise<void> {
		await this.#tab.uncheck(this.#spec, this.#frame);
	}

	/** Outline it. */
	async highlight(opts?: { duration?: number }): Promise<void> {
		await this.#tab.highlight(this.#spec, opts);
	}

	/** Type at the end of its content. */
	async type(text: string): Promise<void> {
		await this.#tab.type(this.#spec, text, this.#frame);
	}

	/** Replace its value. */
	async fill(value: string): Promise<void> {
		await this.#tab.fill(this.#spec, value, this.#frame);
	}

	/** Focus it and press a key. */
	async press(key: string): Promise<void> {
		await this.#tab.pressIn(key, { selector: this.#spec }, this.#frame);
	}

	/** Hover it. */
	async hover(): Promise<void> {
		await this.#tab.hover(this.#spec, this.#frame);
	}

	/** Focus it. */
	async focus(): Promise<void> {
		await this.#tab.focus(this.#spec, this.#frame);
	}

	/** Select options. */
	async select(...values: string[]): Promise<string[]> {
		return await this.#tab.select(this.#spec, ...values);
	}

	/** Upload files. */
	async uploadFile(...filePaths: string[]): Promise<void> {
		await this.#tab.uploadFile(this.#spec, ...filePaths);
	}

	/** Scroll it into view. */
	async scrollIntoView(): Promise<void> {
		await this.#tab.scrollIntoView(this.#spec);
	}

	/** Its box in main-frame viewport px. */
	async boundingBox(): Promise<BoundingBox | null> {
		return await this.#tab.box(this.#spec, this.#frame);
	}

	/** Whether it is visible. */
	async isVisible(): Promise<boolean> {
		return await this.#tab.isVisible(this.#spec, this.#frame);
	}

	/** Whether it is hidden. */
	async isHidden(): Promise<boolean> {
		return !(await this.#tab.isVisible(this.#spec, this.#frame));
	}

	/** Its rendered text. */
	async text(): Promise<string> {
		return (await this.#tab.text(this.#spec, this.#frame)) ?? "";
	}

	/** Its inner HTML. */
	async html(): Promise<string> {
		return (await this.#tab.html(this.#spec, this.#frame)) ?? "";
	}

	/** Its form value. */
	async value(): Promise<string | null> {
		return await this.#tab.value(this.#spec, this.#frame);
	}

	/** One attribute. */
	async attr(name: string): Promise<string | null> {
		return await this.#tab.attr(this.#spec, name, this.#frame);
	}

	/** Computed styles. */
	async styles(props?: string[]): Promise<Record<string, string>> {
		return (await this.#tab.styles(this.#spec, props)) ?? {};
	}

	/** Whether it is enabled. */
	async isEnabled(): Promise<boolean> {
		return await this.#tab.isEnabled(this.#spec);
	}

	/** Whether it is checked. */
	async isChecked(): Promise<boolean> {
		return await this.#tab.isChecked(this.#spec);
	}

	/** Evaluate `fn(element, ...args)` in the page world. */
	async evaluate<R, TArgs extends unknown[]>(
		fn: string | ((element: unknown, ...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R> {
		return (await this.#tab.evaluateOnElement(this.#spec, fn, args, this.#frame)) as R;
	}

	/** Handles hold no page resources. */
	async dispose(): Promise<void> {}
}

/** A child frame of the Tern tab (`tab.frame(...)`), addressed by its Tern frame path. */
export class TernFrame {
	readonly #tab: TernTab;
	readonly #path: string;

	constructor(tab: TernTab, framePath: string) {
		this.#tab = tab;
		this.#path = framePath;
	}

	/** The frame path (`0`, `1.0`). */
	get path(): string {
		return this.#path;
	}

	/** Click inside the frame. */
	async click(selector: string): Promise<void> {
		await this.#tab.clickIn(selector, this.#path);
	}

	/** Fill inside the frame. */
	async fill(selector: string, value: string): Promise<void> {
		await this.#tab.fill(selector, value, this.#path);
	}

	/** Type inside the frame. */
	async type(selector: string, text: string): Promise<void> {
		await this.#tab.type(selector, text, this.#path);
	}

	/** Press a key, optionally after focusing an element in the frame. */
	async press(key: string, options?: { selector?: string }): Promise<void> {
		await this.#tab.pressIn(key, options, this.#path);
	}

	/** Element text. */
	async text(selector: string): Promise<string> {
		return (await this.#tab.text(selector, this.#path)) ?? "";
	}

	/** Element inner HTML. */
	async html(selector: string): Promise<string> {
		return (await this.#tab.html(selector, this.#path)) ?? "";
	}

	/** Form value. */
	async value(selector: string): Promise<string> {
		return (await this.#tab.value(selector, this.#path)) ?? "";
	}

	/** One attribute. */
	async attr(selector: string, name: string): Promise<string | null> {
		return await this.#tab.attr(selector, name, this.#path);
	}

	/** Match count. */
	async count(selector: string): Promise<number> {
		return await this.#tab.count(selector, this.#path);
	}

	/** Visibility. */
	async isVisible(selector: string): Promise<boolean> {
		return await this.#tab.isVisible(selector, this.#path);
	}

	/** ARIA snapshot of the frame. */
	async ariaSnapshot(selector?: string, options?: AriaSnapshotOptions): Promise<string> {
		const snapshot = await this.#tab.ariaSnapshotIn(selector, options, this.#path);
		return typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
	}

	/** Evaluate in the frame's page world. */
	async evaluate<R, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R> {
		return (await this.#tab.evaluateIn(fn, args, this.#path)) as R;
	}

	/** Wait for a visible element; reports whether it appeared. */
	async waitFor(selector: string, options?: { timeout?: number }): Promise<boolean> {
		await this.#tab.waitForIn(selector, options, this.#path);
		return true;
	}

	/** Wait for an element; reports whether it appeared. */
	async waitForSelector(
		selector: string,
		options?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<boolean> {
		return (await this.#tab.waitForSelectorIn(selector, options, this.#path)) !== null;
	}

	/** Capture an element of the frame. */
	async screenshot(selector: string): Promise<string> {
		const result = await this.#tab.screenshotIn({ selector }, this.#path);
		return typeof result === "string" ? result : (result.path ?? "");
	}
}

/** `page.locator()` of the Tern page facade. */
class TernLocator {
	readonly #tab: TernTab;
	readonly #selector: string;
	#timeoutMs: number | undefined;

	constructor(tab: TernTab, selector: string) {
		this.#tab = tab;
		this.#selector = selector;
	}

	setTimeout(timeoutMs: number): this {
		this.#timeoutMs = timeoutMs;
		return this;
	}

	async click(): Promise<void> {
		await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
		await this.#tab.click(this.#selector);
	}

	async fill(value: string): Promise<void> {
		await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
		await this.#tab.fill(this.#selector, value);
	}

	async hover(): Promise<void> {
		await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
		await this.#tab.hover(this.#selector);
	}

	async waitHandle(): Promise<TernElementHandle> {
		return await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
	}
}

/**
 * The `page` object `tab.run` code sees on the Tern backend: a Puppeteer-like
 * subset (navigation, evaluate, content, locator/$/$$, waits, screenshot,
 * keyboard, mouse, cookies, user agent) over the tab's helpers.
 */
export class TernPageFacade {
	readonly #tab: TernTab;
	/** Keyboard input (trusted key events). */
	readonly keyboard: {
		press: (key: string) => Promise<void>;
		type: (text: string) => Promise<void>;
		down: (key: string) => Promise<void>;
		up: (key: string) => Promise<void>;
	};
	/** Pointer input (trusted mouse events). */
	readonly mouse: {
		move: (x: number, y: number, options?: { steps?: number }) => Promise<void>;
		down: (options?: { button?: MouseButtonName }) => Promise<void>;
		up: (options?: { button?: MouseButtonName }) => Promise<void>;
		click: (x: number, y: number, options?: { button?: MouseButtonName; count?: number }) => Promise<void>;
		wheel: (delta: { deltaX?: number; deltaY?: number }) => Promise<void>;
	};

	constructor(tab: TernTab) {
		this.#tab = tab;
		this.keyboard = {
			press: key => tab.press(key),
			type: text => tab.keyboardType(text),
			down: key => tab.keyDown(key),
			up: key => tab.keyUp(key),
		};
		this.mouse = {
			move: (x, y, options) => tab.mouseMove(x, y, options),
			down: options => tab.mouseDown(options),
			up: options => tab.mouseUp(options),
			click: (x, y, options) => tab.clickAt(x, y, { button: options?.button, clickCount: options?.count }),
			wheel: delta => tab.wheel(delta.deltaX ?? 0, delta.deltaY ?? 0),
		};
	}

	url(): string {
		return this.#tab.url();
	}

	async title(): Promise<string> {
		return await this.#tab.title();
	}

	viewport(): ReadyInfo["viewport"] {
		return this.#tab.viewport();
	}

	async setViewport(viewport: ViewportOptions): Promise<void> {
		await this.#tab.setViewport(viewport);
	}

	async setUserAgent(userAgent: string): Promise<void> {
		await this.#tab.emulate({ userAgent });
	}

	async goto(url: string, opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<TernResponse | null> {
		return await this.#tab.gotoResponse(url, { waitUntil: opts?.waitUntil, timeoutMs: opts?.timeout });
	}

	async reload(opts?: { waitUntil?: WaitUntil }): Promise<null> {
		await this.#tab.reload(opts);
		return null;
	}

	async goBack(opts?: { waitUntil?: WaitUntil }): Promise<null> {
		await this.#tab.back(opts);
		return null;
	}

	async goForward(opts?: { waitUntil?: WaitUntil }): Promise<null> {
		await this.#tab.forward(opts);
		return null;
	}

	async evaluate<R, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R> {
		return await this.#tab.evaluate(fn, ...args);
	}

	async content(): Promise<string> {
		return await this.#tab.pageContent();
	}

	locator(selector: string): TernLocator {
		return new TernLocator(this.#tab, selector);
	}

	async $(selector: string): Promise<TernElementHandle | null> {
		return (await this.#tab.count(selector)) > 0 ? await this.#tab.waitForSelector(selector, { timeout: 1 }) : null;
	}

	async $$(selector: string): Promise<TernElementHandle[]> {
		return await this.#tab.handlesFor(selector);
	}

	async click(selector: string): Promise<void> {
		await this.#tab.click(selector);
	}

	async type(selector: string, text: string): Promise<void> {
		await this.#tab.type(selector, text);
	}

	async waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<TernElementHandle | null> {
		return await this.#tab.waitForSelector(selector, opts);
	}

	async waitForFunction(
		fn: string | ((...args: unknown[]) => unknown | Promise<unknown>),
		opts?: { timeout?: number; polling?: number },
		...args: unknown[]
	): Promise<unknown> {
		return await this.#tab.waitForFunction(fn, opts, args);
	}

	async waitForResponse(
		pattern: string | RegExp | ((response: TernResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<TernResponse> {
		return await this.#tab.waitForResponse(pattern, opts);
	}

	async waitForNavigation(opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<TernResponse | null> {
		return await this.#tab.waitForNavigation(opts);
	}

	async screenshot(
		opts: { encoding?: "base64" | "binary"; fullPage?: boolean; type?: "png" | "jpeg"; quality?: number } = {},
	): Promise<Buffer | string> {
		const bytes = await this.#tab.captureBytes({
			fullPage: opts.fullPage,
			format: opts.type ?? "png",
			quality: opts.quality,
		});
		return opts.encoding === "base64" ? bytes.toString("base64") : bytes;
	}

	async cookies(...urls: string[]): Promise<BrowserCookie[]> {
		return await this.#tab.cookies(urls.length ? { urls } : {});
	}

	async setCookie(...cookies: unknown[]): Promise<void> {
		await this.#tab.setCookies(...cookies);
	}
}

/** The `browser` object `tab.run` code sees on the Tern backend. */
export class TernBrowserFacade {
	readonly #tab: TernTab;
	/** Whether the facade still counts as connected. */
	connected = true;

	constructor(tab: TernTab) {
		this.#tab = tab;
	}

	async pages(): Promise<TernPageFacade[]> {
		return [this.#tab.page];
	}

	async version(): Promise<string> {
		return "Tern WKWebView";
	}

	wsEndpoint(): string {
		return `tern://block/${this.#tab.block}`;
	}

	disconnect(): void {
		this.connected = false;
	}

	async close(): Promise<void> {
		this.connected = false;
	}
}
