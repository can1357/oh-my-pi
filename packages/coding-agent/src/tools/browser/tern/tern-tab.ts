/**
 * A browser tab shown as a Tern browser picture-in-picture: every helper of
 * the tab API drives the PiP's native web view through Tern's browser op
 * protocol (`wire.ts`). Pages are reached through `eval` (page world for user
 * code and page instrumentation, the isolated world for omp's kit), trusted
 * `input` events at element centres, `capture`, `pdf` and the Tern-level ops;
 * what the page reports on its own arrives through `events` polling.
 *
 * A Tern whose engine answers DOM reads itself (the `dom` op, `dom.ts`) is
 * read natively instead: observation, selector resolution, actionability,
 * element reads and waits send no `eval`, and every action is trusted
 * `input` at the point the engine resolved. The kit is then installed only
 * when a helper needs what no read or input provides (`select`, `highlight`
 * and screenshot annotations, `styles`, `uploadFile`, `ariaSnapshot`, frame
 * listing, focusing an element that takes no text, element `evaluate`).
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
	screenshotArea,
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
import { readFilePayloads } from "../upload-files";
import {
	type WebMcpEventsOptions,
	type WebMcpEventsResult,
	type WebMcpInvokeOptions,
	type WebMcpInvokeResult,
	type WebMcpListOptions,
	type WebMcpListResult,
} from "../webmcp";
import {
	type DomInclude,
	type DomMatches,
	type DomNode,
	type DomObservation,
	type DomQuery,
	type DomRef,
	type DomReply,
	type DomRequest,
	type DomResolveAction,
	type DomWaitState,
	describeDomNode,
	domCandidateSelector,
	domQueryFor,
	domReply,
	HANDLE_ATTRIBUTE,
	innerHtmlOf,
	observationFrom,
} from "./dom";
import { keyDownStep, keyUpStep, pressSteps, type TernInputStep, type TernModifier, ternKey, typeSteps } from "./keys";
import { TernNetworkLog, type TernRequestEntry } from "./network-log";
import { TERN_CAPTURE_GLOBAL, TERN_CAPTURE_INSTALLER, type TernPageEmulation, ternCaptureScript } from "./page-capture";
import {
	TERN_FRAME_ANNOUNCE_SOURCE,
	TERN_KIT_SOURCE,
	type TernAnnotation,
	type TernFrameInfo,
	type TernGeometry,
	type TernKitApi,
	type TernTarget,
	type TernTargetAction,
	type TernTargetFailure,
} from "./page-kit";
import { parseTernSelector, type TernSelector } from "./selectors";
import type { TernBlockEntry } from "./blocks";
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
	insecure?: boolean;
	/**
	 * Seed of the engine's fingerprinting noise, sent as the `identity` op
	 * right after the open. Only omp's WebKit host answers that op: a Tern
	 * open never sets this.
	 */
	identitySeed?: string;
}

/** Options of {@link TernTab.adopt}: like an open, but every page setting only when given. */
export interface TernAdoptOptions extends Omit<TernOpenOptions, "pane" | "viewport" | "identitySeed"> {
	/** The user's browser block to drive. */
	block: TernBlockEntry;
	/** Page layout size for an adopted PiP; a docked block's page keeps the block's size. */
	viewport?: ViewportOptions;
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
/** Rendering updates an element's rect must hold still for before a native action aims at it. */
const RESOLVE_STABLE_UPDATES = 2;
/** How long one native `resolve` waits for a stable rect before omp asks again. */
const RESOLVE_SETTLE_MS = 1_000;
/** Wheels one native target may spend bringing its element into view. */
const SCROLL_WHEEL_LIMIT = 8;
/** How long past its own timeout a native `wait` may take to answer. */
const WAIT_REPLY_GRACE_MS = 5_000;
/** Matches `handlesFor` asks the native reads for (they stop at 100 by default). */
const HANDLE_LIMIT = 10_000;
/** The native `resolve` action checking what the kit's `target()` checks for each action. */
const RESOLVE_ACTIONS: Record<TernTargetAction, DomResolveAction> = {
	click: "click",
	dblclick: "click",
	check: "click",
	upload: "click",
	hover: "hover",
	drag: "hover",
	type: "type",
	fill: "type",
	focus: "none",
	point: "none",
};
/** Input types whose value `fill` sets through the kit: it is picked, not typed. */
const PICKED_INPUT_TYPES: Readonly<Record<string, true>> = {
	date: true,
	"datetime-local": true,
	month: true,
	week: true,
	time: true,
	color: true,
	range: true,
};
/** Tags whose form value reads as an empty string, not null, when the engine reports none. */
const FORM_VALUE_TAGS: Readonly<Record<string, true>> = { input: true, textarea: true, select: true };
/** Why the WebMCP helpers throw on backend `product`, and the open option (`app: "chromium"`) that gets Chromium instead. */
function noWebMcp(product: string): string {
	return `the ${product} web view has no native WebMCP; open the tab with \`app: "chromium"\` to use Chromium`;
}

/** The tab-helper name for errors: `tab.pdf()`. */
function helper(name: string): string {
	return `tab.${name}()`;
}

/** The message of a page-side exception answered by the backend (`js` errors), without the client's `<product> browser <op> failed (js): ` prefix. */
function pageErrorText(error: TernError): string {
	return error.message.replace(/^\S+ browser \w+ failed \(js\): /, "");
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

/** Why an element never became actionable, as the kit's `target()` and the native `resolve` loop report it. */
interface TargetFailure {
	reason: TernTargetFailure;
	count: number;
	detail?: string;
}

/** The error of an action whose element did not become actionable within `elapsedMs`. */
function targetTimeout(label: string, elapsedMs: number, failure: TargetFailure): ToolError {
	const why =
		failure.reason === "missing"
			? "no element matches (wrong page or selector?)"
			: failure.reason === "covered"
				? `the element is covered by ${failure.detail ?? "another element"}`
				: failure.reason === "hidden"
					? "the element is not visible"
					: failure.reason === "disabled"
						? "the element is disabled"
						: failure.reason === "notEditable"
							? "the element is not editable"
							: failure.reason === "offViewport"
								? "the element is outside the viewport"
								: "the element keeps moving";
	return new ToolError(`${label} timed out after ${elapsedMs}ms: ${why} (${failure.count} match(es))`);
}

/** The error of an observation id whose element left the page. */
function staleId(id: number): ToolError {
	return new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
}

/** Whether `fill` sets this control's value through the kit instead of typing into it. */
function isPickedControl(node: DomNode): boolean {
	return (
		node.tag === "select" ||
		(node.tag === "input" && PICKED_INPUT_TYPES[(node.attributes?.type ?? "").toLowerCase()] === true)
	);
}

/** An actionable element of the native reads: the point to act on, its size, and the node. */
interface ResolvedTarget extends BoundingBox {
	ref: DomRef;
	node: DomNode;
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

/** Whether `requested` is the address `current` already shows (`https://a.test` is `https://a.test/`). */
function sameAddress(requested: string, current: string): boolean {
	if (requested === current) return true;
	try {
		return new URL(requested).href === new URL(current).href;
	} catch {
		return false;
	}
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

/** The capture installer for a document that may not have the capture: it only updates one that is there. */
const TERN_CAPTURE_UPDATER = `function (config) { if (!globalThis[${JSON.stringify(TERN_CAPTURE_GLOBAL)}]) return false; return (${TERN_CAPTURE_INSTALLER})(config); }`;

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
	/** Guest file-name prefix of this backend's runs (`tern-run`, `webkit-run`). */
	readonly runLabel: string;
	/**
	 * The backend's display name (`Tern`, `WebKit`), from the connection: what
	 * every message of this tab that a user or the model reads calls the backend.
	 */
	readonly product: string;
	/** The PiP's block id (daemon-native). */
	readonly block: number;
	readonly #client: TernSocketClient;
	readonly #name: string;
	/** The user's block this tab adopted (released, never closed); undefined for omp's own PiP. */
	readonly adopted: TernBlockEntry | undefined;
	#url = "about:blank";
	#title = "";
	#shown: boolean | undefined;
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
	readonly #network: TernNetworkLog;
	/** Whether the server reports console messages and uncaught exceptions itself (its welcome lists `console`). */
	readonly #nativeConsole: boolean;
	/** Whether the server reports every resource load itself (its welcome lists `network`); such loads keep no body. */
	readonly nativeNetwork: boolean;
	/**
	 * Whether a page of this tab is observed without any omp script in its
	 * world (both of the above): the capture and vitals scripts are then
	 * installed only once a helper needs them ({@link #captureNeeded}, `vitals`).
	 */
	readonly #observesNatively: boolean;
	/** Whether the Web Vitals observers are a document-start script. */
	#vitalsScript: boolean;
	/** Whether the current main document has (or is getting) the capture script. */
	#captureInDocument = false;
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
	// Screenshots, snapshots, recording.
	// Native reads: what the last observe's ids stand for, and the owner element of each frame path.
	#observed = new Map<number, DomRef>();
	readonly #frameRoots = new Map<string, DomRef>();
	readonly #screenshotHistory = new Map<string, ScreenshotHistory>();
	readonly #ariaBaselines = new Map<string, AriaSnapshotBaseline>();
	readonly #recording = new RecordingController();

	constructor(opts: {
		client: TernSocketClient;
		block: number;
		name: string;
		viewport: ViewportOptions;
		adopted?: TernBlockEntry;
	}) {
		this.#client = opts.client;
		this.product = opts.client.product;
		this.runLabel = `${this.product.toLowerCase()}-run`;
		this.#nativeConsole = opts.client.supports("console");
		this.nativeNetwork = opts.client.supports("network");
		this.#observesNatively = this.#nativeConsole && this.nativeNetwork;
		this.#vitalsScript = !this.#observesNatively;
		this.#network = new TernNetworkLog(this.product, this.nativeNetwork);
		this.block = opts.block;
		this.#name = opts.name;
		this.#viewport = { ...opts.viewport };
		this.adopted = opts.adopted;
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
			throw new ToolError(`${client.product} answered the browser open without a block id`);
		}
		const tab = new TernTab({ client, block: opened.block, name: opts.name, viewport: opts.viewport });
		try {
			await tab.#configure(opts, remainingMs());
			// The PiP already shows about:blank, and a Tern web view never reloads an unchanged address.
			if (opts.url && opts.url !== "about:blank") {
				await tab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: remainingMs() });
			}
		} catch (error) {
			await tab.close({ timeoutMs: 5_000 }).catch(() => undefined);
			throw error;
		}
		return tab;
	}

	/**
	 * Drive the user's existing browser block `opts.block` (docked or PiP)
	 * without opening anything: skip the events it reported before, apply only
	 * the page settings the caller gave (plus omp's document-start scripts,
	 * installed into the current document too), and navigate only when `url`
	 * is given. A failure releases the block again; it is never closed.
	 */
	static async adopt(client: TernSocketClient, opts: TernAdoptOptions): Promise<TernTab> {
		const startedAt = Date.now();
		const remainingMs = (): number => Math.max(1, opts.timeoutMs - (Date.now() - startedAt));
		const tab = new TernTab({
			client,
			block: opts.block.block,
			name: opts.name,
			viewport: opts.viewport ?? { width: 0, height: 0 },
			adopted: opts.block,
		});
		try {
			const answer = await tab.#op("events", { after: 0 }, remainingMs());
			if (isRecord(answer) && typeof answer.next === "number") tab.#cursor = answer.next;
			// The address the block shows: a `goto` to it must become a reload (see `gotoResponse`).
			await tab.#refreshState();
			if (opts.dialogs !== undefined) await tab.#op("dialogs", { policy: opts.dialogs });
			await tab.#applySettings(opts);
			if (opts.viewport && opts.block.owner !== null) await tab.setViewport(opts.viewport);
			await tab.#applyCapture();
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

	/**
	 * Whether the block was on screen at the last `state` (undefined before one,
	 * or from a Tern that does not say). A PiP shows only while the tab holding
	 * its owner pane is the one the user looks at.
	 */
	get shown(): boolean | undefined {
		return this.#shown;
	}

	/**
	 * Close omp's PiP (its page goes), or release an adopted block: Tern stops
	 * driving it and resets what omp set, the user's page stays. A Tern without
	 * `release` (answers `invalid`) only gets omp's scripts cleared, best-effort.
	 * A block already gone is no error.
	 */
	async close(opts: { timeoutMs: number }): Promise<void> {
		await this.#recording.close().catch(error => {
			logger.warn("Failed to finalize a Tern browser recording during close", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		try {
			await this.#client.request(
				{ op: this.adopted ? "release" : "close", block: this.block },
				{ timeoutMs: opts.timeoutMs },
			);
		} catch (error) {
			if (error instanceof TernError && (error.kind === "not_found" || error.kind === "closed")) return;
			if (!(this.adopted && error instanceof TernError && error.kind === "invalid")) throw error;
			await this.#client
				.request({ op: "scripts", block: this.block, scripts: [] }, { timeoutMs: opts.timeoutMs })
				.catch(() => undefined);
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

	/** Whether this Tern's engine answers DOM reads itself (`dom` op), so the page kit stays out of them. */
	get #native(): boolean {
		return this.#client.supports("dom");
	}

	/** One native read; an engine `{ error }` reply throws a {@link TernError}. */
	async #dom<R extends DomRequest>(request: R, timeoutMs?: number): Promise<DomReply<R>> {
		return domReply(this.product, request, await this.#op("dom", { ...request }, timeoutMs));
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
		throw new ToolError(`The ${this.product} page kit could not be installed in this document`);
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
				this.#network.forgetInflight();
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
					// The new document runs the script list as it is now, and the old one's loads are gone.
					this.#captureInDocument = this.#captureNeeded();
					this.#network.forgetInflight();
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
				if (this.nativeNetwork && typeof event.id === "number") this.#network.ingestNative(event);
				else this.#network.ingestNavigationResponse(event);
				return;
			case "request":
			case "requestFinished":
				if (this.nativeNetwork) this.#network.ingestNative(event);
				return;
			case "requestFailed": {
				if (!this.nativeNetwork) return;
				const failed = this.#network.ingestNative(event);
				if (failed) {
					this.#pushConsole({
						seq: 0,
						ts: Date.now(),
						type: "requestfailed",
						level: "error",
						text: `${failed.failureText ?? "request failed"}: ${failed.url}`,
						location: failed.url || undefined,
					});
				}
				return;
			}
			case "console":
				if (this.#nativeConsole) this.#ingestConsole(event);
				return;
			case "blocked":
				if (typeof event.url === "string") this.#network.ingestBlocked(event.url);
				return;
			case "message":
				this.#ingestMessage(event);
				return;
		}
	}

	/**
	 * A native `console` event: an uncaught exception (`source: "javascript"`,
	 * `level: "error"`) is a page error, everything else a console message. The
	 * engine gives the rendered text only, so `args` is that text.
	 */
	#ingestConsole(event: TernEvent): void {
		const text = stringOr(event.text, "");
		const location =
			typeof event.url === "string" && event.url
				? `${event.url}${typeof event.line === "number" ? `:${event.line}` : ""}`
				: undefined;
		if (event.source === "javascript" && event.level === "error") {
			this.#pushConsole({ seq: 0, ts: Date.now(), type: "pageerror", level: "error", text, location });
			return;
		}
		this.#pushConsole({
			seq: 0,
			ts: Date.now(),
			type: "console",
			level: event.level === "warning" ? "warn" : consoleLevel(event.level),
			text,
			location,
			args: [text],
		});
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
		// A capture script installed for a route or an emulation still wraps the console: the engine's own report is the log's.
		if (this.#nativeConsole && (message.kind === "console" || message.kind === "pageerror")) return;
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
				// On a server that reports loads itself, only a request the capture failed itself is news.
				if (!this.#network.ingestPageMessage(message)) return;
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
		if (typeof state.shown === "boolean") this.#shown = state.shown;
		if (typeof state.width === "number" && typeof state.height === "number") {
			this.#viewport = { ...this.#viewport, width: state.width, height: state.height };
		}
		return state;
	}

	// ─── Configuration and scripts ────────────────────────────────────────

	async #configure(opts: TernOpenOptions, timeoutMs: number): Promise<void> {
		// Before any page script can read a canvas: the blank page runs none.
		if (opts.identitySeed !== undefined) await this.#op("identity", { seed: opts.identitySeed });
		// Tern answers `open` once the page takes calls, before its about:blank load reports. That load's
		// late `committed`/`loaded` events would otherwise settle the first navigation before it loads.
		await this.#poll(
			`The ${this.product} page's initial about:blank load`,
			timeoutMs,
			() => (this.#events.some(event => event.type === "loaded" || event.type === "failed") ? true : undefined),
			{ pull: true },
		);
		await this.#op("dialogs", { policy: opts.dialogs ?? "default" });
		await this.#applySettings(opts);
		await this.#syncScripts();
	}

	/** The page settings the caller gave: allowlist, agent, TLS, downloads, init scripts (sent with the next script sync). */
	async #applySettings(opts: Omit<TernOpenOptions, "pane" | "viewport">): Promise<void> {
		if (opts.allowedDomains?.length) {
			this.#allowedDomains = normalizeAllowedDomains(opts.allowedDomains);
			await this.#op("allow", { hosts: this.#allowedDomains });
		}
		if (opts.userAgent !== undefined) {
			this.#emulation.userAgent = opts.userAgent;
			await this.#op("agent", { value: opts.userAgent });
		}
		if (opts.insecure) await this.#op("insecure", { value: true });
		if (opts.downloadsPath !== undefined) await this.#enableDownloads(opts.downloadsPath);
		for (const source of opts.initScripts ?? []) {
			this.#initScripts.push({ id: `tern-init-${this.#nextInitScript++}`, source });
		}
	}

	/**
	 * Whether the page-world capture script must run in this tab's documents.
	 * Always on a server that leaves console or request observation to it;
	 * on one that observes both natively only for what needs code in the page:
	 * a route, or an emulation the capture implements (geolocation, locale, offline).
	 */
	#captureNeeded(): boolean {
		if (!this.#observesNatively) return true;
		const { geolocation, locale, offline } = this.#pageEmulation;
		return this.#network.rules().length > 0 || geolocation !== undefined || locale !== undefined || offline === true;
	}

	/** Every document-start script this tab needs, in order. */
	#scripts(): Array<{ source: string; world: World; frames: "main" | "all"; at: "start" | "end" }> {
		return [
			...(this.#captureNeeded()
				? [
						{
							source: ternCaptureScript({ routes: this.#network.rules(), emulation: this.#pageEmulation }),
							world: "page" as const,
							frames: "all" as const,
							at: "start" as const,
						},
					]
				: []),
			...(this.#vitalsScript
				? [
						{
							source: `${VITALS_INIT_SOURCE};`,
							world: "page" as const,
							frames: "main" as const,
							at: "start" as const,
						},
					]
				: []),
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
			// Native reads need no kit in every document, only the frame paths `eval` addresses.
			{
				source: this.#native ? TERN_FRAME_ANNOUNCE_SOURCE : TERN_KIT_SOURCE,
				world: "isolated",
				frames: "all",
				at: "start",
			},
		];
	}

	/** Send the script list (future documents). */
	async #syncScripts(): Promise<void> {
		await this.#op("scripts", { scripts: this.#scripts() });
	}

	/**
	 * Re-apply the capture configuration: future documents and every frame of
	 * the current one. Where the capture is on demand ({@link #captureNeeded})
	 * a document that never had it is left without it, and one that has it keeps
	 * it (the page's wrapped built-ins cannot be unwrapped) with the new
	 * configuration until the next navigation.
	 */
	async #applyCapture(): Promise<void> {
		await this.#syncScripts();
		const needed = this.#captureNeeded();
		if (needed) this.#captureInDocument = true;
		if (!this.#captureInDocument) return;
		const installer = needed ? TERN_CAPTURE_INSTALLER : TERN_CAPTURE_UPDATER;
		const config = { routes: this.#network.rules(), emulation: this.#pageEmulation };
		const children = await this.#kit<TernFrameInfo[]>("frames", []).catch(() => []);
		for (const frame of [null, ...children.map(child => child.path)]) {
			await this.#eval(installer, [config], "page", frame).catch(error => {
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
	 * and at most 0/2 page fetch/XHR in flight for 500 ms (page requests only;
	 * every resource load on a server that reports loads itself).
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
				// A server that reports loads itself counts every resource; the capture counts the page's fetch/XHR.
				const inflight = this.nativeNetwork
					? this.#network.inflight
					: numberOr(
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
		// A Tern web view never reloads an unchanged address (Terns before the fix answer the
		// `goto` and report no navigation, so the wait would never end). Reloading is what a goto
		// to the shown address means anyway, and what Tern's own address field does: `nav reload`
		// always reports a fresh load. Settling by `state` instead would race a Tern that does
		// reload: `loading` can still read false before the reload starts. Decided after
		// `#navigate`'s event pull, so the shown address is current.
		const entry = await this.#navigate(
			`tab.goto(${JSON.stringify(url)})`,
			() =>
				sameAddress(url, this.#url)
					? this.#op("nav", { go: "reload" }, timeoutMs)
					: this.#op("goto", { url }, timeoutMs),
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

	/**
	 * Whether `file:` pages may read other files (the `fileAccess` op of omp's
	 * WebKit host; Tern has no such op). Documents loaded afterwards see it.
	 */
	async setFileAccess(allow: boolean): Promise<void> {
		await this.#op("fileAccess", { value: allow });
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
		if (this.#native) return await this.#resolveTarget(label, spec, action, frame, explicitTimeout);
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
		throw targetTimeout(label, Date.now() - started, last);
	}

	// ─── Native reads ─────────────────────────────────────────────────────

	/** The ref observation id `id` stands for. */
	#observedRef(id: number): DomRef {
		const ref = this.#observed.get(id);
		if (ref === undefined) {
			throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		}
		return ref;
	}

	/** The ref of the element carrying kit handle `token`, or null. */
	async #refOfToken(token: string): Promise<DomRef | null> {
		const { nodes } = await this.#dom({ read: "query", ...domQueryFor({ engine: "handle", token }), limit: 1 });
		return nodes[0]?.ref ?? null;
	}

	/**
	 * The ref of the element the kit resolves `spec` to, or null: ARIA snapshot
	 * refs live in the kit, which marks the element for the engine to find.
	 */
	async #refThroughKit(spec: TernSelector, frame: FramePath): Promise<DomRef | null> {
		const token = await this.#kit<string | null>("mark", [spec], frame);
		if (!token) return null;
		try {
			return await this.#refOfToken(token);
		} finally {
			await this.#kit("unmark", [token], frame).catch(() => undefined);
		}
	}

	/**
	 * The owner element of frame path `frame`, which scopes a native read to
	 * the frame's document. Frame paths are the kit's (`window.frames`
	 * indices), so the parent's kit marks its frame elements once and the
	 * engine names the one hosting the path; later calls only check the
	 * remembered owner is still in the page.
	 */
	async #frameRoot(frame: string): Promise<DomRef> {
		const known = this.#frameRoots.get(frame);
		if (known !== undefined) {
			if ((await this.#dom({ read: "query", by: "ref", value: known, limit: 1 })).nodes.length > 0) return known;
			this.#frameRoots.delete(frame);
		}
		const cut = frame.lastIndexOf(".");
		const parent = cut < 0 ? null : frame.slice(0, cut);
		const index = frame.slice(cut + 1);
		const tokens = await this.#kit<string[]>("markAll", [{ engine: "pierce", query: "iframe,frame" }], parent);
		let owner: DomRef | null = null;
		try {
			for (const token of tokens) {
				const hosted = await this.#kit<string | null>("frameOf", [{ engine: "handle", token }], parent);
				if (hosted !== index) continue;
				owner = await this.#refOfToken(token);
				break;
			}
		} finally {
			if (tokens.length > 0) await this.#kit("unmark", [tokens], parent).catch(() => undefined);
		}
		if (owner === null) throw new ToolError(`Frame ${frame} is no longer in the page`);
		this.#frameRoots.set(frame, owner);
		return owner;
	}

	/** The native query for `spec` inside `frame`; null when an ARIA ref no longer names an element. */
	async #queryFor(spec: TernSelector, frame: FramePath): Promise<DomQuery | null> {
		if (spec.engine === "id") return { by: "ref", value: this.#observedRef(spec.id) };
		if (spec.engine === "ariaRef") {
			const ref = await this.#refThroughKit(spec, frame);
			return ref === null ? null : { by: "ref", value: ref };
		}
		const query = domQueryFor(spec);
		return frame && query.by !== "ref" ? { ...query, root: await this.#frameRoot(frame) } : query;
	}

	/** The matches of `spec` inside `frame`. An observation id whose element left the page throws as stale. */
	async #query(
		spec: TernSelector,
		frame: FramePath,
		extra: Pick<DomQuery, "limit" | "include" | "visibleOnly"> = {},
	): Promise<DomMatches> {
		const query = await this.#queryFor(spec, frame);
		if (!query) return { nodes: [], total: 0 };
		const matches = await this.#dom({ read: "query", ...query, ...extra });
		if (spec.engine === "id" && matches.nodes.length === 0) throw staleId(spec.id);
		return matches;
	}

	/** The first match of `spec` with the `include`d extras, or undefined. */
	async #first(spec: TernSelector, frame: FramePath, include?: DomInclude[]): Promise<DomNode | undefined> {
		return (await this.#query(spec, frame, { limit: 1, ...(include ? { include } : {}) })).nodes[0];
	}

	/** The element `spec` names and how many elements match; a ref or an observation id needs no read. */
	async #locate(spec: TernSelector, frame: FramePath): Promise<{ ref: DomRef; count: number } | null> {
		if (spec.engine === "ref") return { ref: spec.ref, count: 1 };
		if (spec.engine === "id") return { ref: this.#observedRef(spec.id), count: 1 };
		const { nodes, total } = await this.#query(spec, frame, { limit: 1 });
		const ref = nodes[0]?.ref;
		return ref === undefined ? null : { ref, count: total };
	}

	/**
	 * {@link #target} on native reads: find the element, then `resolve` it
	 * until it is actionable. An element out of view is brought in with the
	 * wheel the engine names (a bounded number of times), a covered one gets
	 * the one re-centring wheel the engine offers. `enabled` also refuses a
	 * disabled element for an action the engine does not check it for.
	 */
	async #resolveTarget(
		label: string,
		spec: TernSelector,
		action: TernTargetAction,
		frame: FramePath,
		explicitTimeout?: number,
		enabled = false,
	): Promise<ResolvedTarget> {
		const timeoutMs =
			explicitTimeout === undefined
				? resolveOpTimeouts(this.#cellMs).actionOpMs
				: resolveWaitTimeout(this.#cellMs, explicitTimeout);
		const resolveAction = RESOLVE_ACTIONS[action];
		const started = Date.now();
		let delay = 30;
		let wheels = 0;
		let recentred = false;
		let last: TargetFailure;
		for (;;) {
			const found = await this.#locate(spec, frame);
			if (!found) {
				last = { reason: "missing", count: 0 };
			} else {
				const resolved = await this.#dom({
					read: "resolve",
					ref: found.ref,
					action: resolveAction,
					// A wheel omp just sent may still be moving the page under a read that checks nothing else.
					stable: resolveAction !== "none" || wheels > 0 ? RESOLVE_STABLE_UPDATES : 0,
					timeout: Math.max(1, Math.min(RESOLVE_SETTLE_MS, timeoutMs - (Date.now() - started))),
				});
				if (resolved.state === "ok") {
					if (!resolved.point || !resolved.node) {
						throw new TernError(
							"protocol",
							`${this.product} answered dom resolve \`ok\` without a point and node`,
						);
					}
					if (!enabled || !resolved.node.states?.includes("disabled")) {
						return {
							x: resolved.point[0],
							y: resolved.point[1],
							width: resolved.node.rect[2],
							height: resolved.node.rect[3],
							ref: found.ref,
							node: resolved.node,
						};
					}
					last = { reason: "disabled", count: found.count };
				} else if (
					resolved.scroll &&
					(resolved.state === "offViewport"
						? wheels < SCROLL_WHEEL_LIMIT
						: resolved.state === "covered" && !recentred)
				) {
					if (resolved.state === "covered") recentred = true;
					wheels++;
					const { at, dx, dy } = resolved.scroll;
					await this.#input([{ type: "wheel", x: at[0], y: at[1], dx, dy, mods: [] }]);
					continue;
				} else if (resolved.state === "detached") {
					if (spec.engine === "id") throw staleId(spec.id);
					last = { reason: "missing", count: 0 };
					// A dead ref never names an element again.
					if (spec.engine === "ref") break;
				} else if (resolved.state === "covered") {
					last = {
						reason: "covered",
						count: found.count,
						detail: resolved.coveredBy ? describeDomNode(resolved.coveredBy) : undefined,
					};
				} else {
					last = { reason: resolved.state, count: found.count };
				}
			}
			const elapsed = Date.now() - started;
			if (elapsed >= timeoutMs) break;
			if (last.reason === "missing" && explicitTimeout === undefined && elapsed >= ZERO_MATCH_FAIL_FAST_MS) break;
			await untilAborted(this.#signal, () => Bun.sleep(delay));
			delay = Math.min(250, Math.round(delay * 1.5));
		}
		throw targetTimeout(label, Date.now() - started, last);
	}

	/**
	 * Wait natively until the matches of `spec` reach `state`; resolves the
	 * matches (of an `attached`/`visible` wait) and rejects on timeout as
	 * {@link #poll} does.
	 */
	async #waitNative(
		label: string,
		spec: TernSelector,
		frame: FramePath,
		state: DomWaitState,
		timeoutMs: number,
	): Promise<DomNode[]> {
		let left = timeoutMs;
		let query = await this.#queryFor(spec, frame);
		if (!query) {
			// An ARIA ref the kit does not know matches nothing, and nothing to wait on until it does.
			if (state === "hidden" || state === "detached") return [];
			const started = Date.now();
			query = await this.#poll(label, timeoutMs, async () => (await this.#queryFor(spec, frame)) ?? undefined);
			left = Math.max(1, timeoutMs - (Date.now() - started));
		}
		const waited = await this.#dom({ read: "wait", for: query, state, timeout: left }, left + WAIT_REPLY_GRACE_MS);
		if (!waited.matched) throw new ToolError(`${label} timed out after ${timeoutMs}ms`);
		return waited.nodes ?? [];
	}

	/** What a handle holds for the element a native wait matched: its ref (of a `visible` wait, the first visible match's). */
	async #waitedSpec(spec: TernSelector, frame: FramePath, nodes: DomNode[], visible: boolean): Promise<TernSelector> {
		let ref = nodes[0]?.ref;
		if (visible && nodes.length > 1) {
			ref = (await this.#query(spec, frame, { limit: 1, visibleOnly: true })).nodes[0]?.ref ?? ref;
		}
		return ref === undefined ? spec : { engine: "ref", ref };
	}

	/**
	 * Stamp a kit handle token on the node `ref`, for a helper only the kit
	 * provides: the kit marks the elements with the node's tag and attributes,
	 * the engine says which mark the node carries, and the other marks go
	 * again. Looks in `frame`, or in the main frame and then its child frames.
	 */
	async #markRef(ref: DomRef, frame: FramePath): Promise<{ token: string; frame: FramePath }> {
		const describeRef = async (): Promise<DomNode | undefined> =>
			(await this.#dom({ read: "query", by: "ref", value: ref, include: ["attributes"] })).nodes[0];
		const node = await describeRef();
		if (!node) throw new ToolError("Element handle selector no longer resolves");
		const candidates: TernSelector = { engine: "pierce", query: domCandidateSelector(node) };
		const markIn = async (path: FramePath): Promise<string | undefined> => {
			const tokens = await this.#kit<string[]>("markAll", [candidates], path);
			if (tokens.length === 0) return undefined;
			let own: string | undefined;
			try {
				const carried = ((await describeRef())?.attributes?.[HANDLE_ATTRIBUTE] ?? "").split(/\s+/);
				own = tokens.find(token => carried.includes(token));
			} finally {
				const rest = tokens.filter(token => token !== own);
				if (rest.length > 0) await this.#kit("unmark", [rest], path).catch(() => undefined);
			}
			return own;
		};
		const own = await markIn(frame);
		if (own) return { token: own, frame };
		if (frame === null) {
			for (const child of await this.#kit<TernFrameInfo[]>("frames", [])) {
				const token = await markIn(child.path).catch(() => undefined);
				if (token) return { token, frame: child.path };
			}
		}
		throw new ToolError(
			"This helper runs in the page, and page script cannot reach the element (it sits in a closed shadow root or in a frame of another site)",
		);
	}

	/**
	 * Run a kit helper on the element `spec` names. The kit resolves its own
	 * selectors; an element only the engine can name (a ref, an observation id
	 * of a native observe) is marked for it first and unmarked after.
	 */
	async #onKit<T>(
		spec: TernSelector,
		frame: FramePath,
		run: (spec: TernSelector, frame: FramePath) => Promise<T>,
	): Promise<T> {
		if (!this.#native || (spec.engine !== "ref" && spec.engine !== "id")) return await run(spec, frame);
		const marked = await this.#markRef(spec.engine === "ref" ? spec.ref : this.#observedRef(spec.id), frame);
		try {
			return await run({ engine: "handle", token: marked.token }, marked.frame);
		} finally {
			await this.#kit("unmark", [marked.token], marked.frame).catch(() => undefined);
		}
	}

	/** The layout viewport's size in CSS px. */
	async #viewportSize(): Promise<{ width: number; height: number }> {
		if (this.#native) {
			const { viewport } = await this.#dom({ read: "snapshot", limit: 1 });
			return { width: viewport.width, height: viewport.height };
		}
		const geometry = await this.#kit<TernGeometry>("geometry", []);
		return { width: geometry.innerWidth, height: geometry.innerHeight };
	}

	/** Observe through a native snapshot; its ids replace the tab's id registry. */
	async #observeNative(opts?: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		selector?: string;
		compact?: boolean;
	}): Promise<DomObservation> {
		let root: DomRef | undefined;
		if (opts?.selector) {
			const spec = this.#spec(opts.selector);
			root = (await this.#locate(spec, null))?.ref;
			if (root === undefined) {
				throw new ToolError(`tab.observe: selector ${JSON.stringify(spec)} matched no element`);
			}
		}
		const snapshot = await this.#dom({
			read: "snapshot",
			...(root === undefined ? {} : { root }),
			...(opts?.includeAll ? { includeAll: true } : {}),
			...(opts?.viewportOnly ? { viewportOnly: true } : {}),
		});
		if (snapshot.truncated) logger.debug("Tern cut a DOM snapshot at its node limit", { url: snapshot.url });
		const mapped = observationFrom(snapshot, { compact: opts?.compact === true });
		this.#observed = mapped.refs;
		this.#url = mapped.observation.url;
		this.#title = snapshot.title;
		return mapped;
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

	/** Click the element's centre with a trusted mouse click, optionally with another button or click count. */
	async click(selector: string, options?: { button?: MouseButtonName; count?: number }): Promise<void> {
		await this.clickIn(selector, null, options);
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

	/**
	 * Focus the element. On native reads an editable control is focused by a
	 * trusted click; any other element still takes the kit's `focus()`.
	 */
	async focus(selector: string | TernSelector, frame: FramePath = null): Promise<void> {
		const label = `tab.focus(${describe(selector)})`;
		const spec = this.#spec(selector);
		if (this.#native) {
			const target = await this.#resolveTarget(label, spec, "focus", frame);
			const states = target.node.states ?? [];
			if (states.includes("editable") && !states.includes("disabled")) {
				const editable = await this.#resolveTarget(label, { engine: "ref", ref: target.ref }, "type", frame);
				await this.#clickAt(editable, "left", 1);
				return;
			}
		} else {
			await this.#target(label, spec, "focus", frame);
		}
		await this.#onKit(spec, frame, (kitSpec, kitFrame) => this.#kit("focus", [kitSpec], kitFrame));
	}

	/** Checked state of the checkable element `spec` names, by a native read. */
	async #checkedState(spec: TernSelector, frame: FramePath): Promise<boolean> {
		const node = await this.#first(spec, frame, ["checked"]);
		if (!node) throw new ToolError(`No element matches ${JSON.stringify(spec)}`);
		if (node.checked === undefined) throw new ToolError("tab.check() requires a checkbox, radio, or ARIA switch");
		return node.checked === true;
	}

	async #setChecked(selector: string | TernSelector, desired: boolean, frame: FramePath): Promise<void> {
		const label = `tab.${desired ? "check" : "uncheck"}(${describe(selector)})`;
		const spec = this.#spec(selector);
		const box = await this.#target(label, spec, "check", frame);
		const checked = async (): Promise<boolean> =>
			this.#native
				? await this.#checkedState(spec, frame)
				: (await this.#kit<{ checked: boolean }>("checkState", [spec], frame)).checked;
		if ((await checked()) === desired) return;
		await this.#clickAt(box, "left", 1);
		if ((await checked()) !== desired) {
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

	/**
	 * Type `text` into the element with trusted key events: at the end of its
	 * content, or on native reads at the caret a trusted click on it places.
	 */
	async type(selector: string | TernSelector, text: string, frame: FramePath = null): Promise<void> {
		const spec = this.#spec(selector);
		const box = await this.#target(`tab.type(${describe(selector)})`, spec, "type", frame);
		if (this.#native) await this.#clickAt(box, "left", 1);
		else await this.#kit("caretToEnd", [spec], frame);
		await this.#input(typeSteps(String(text), this.#mods));
	}

	/**
	 * Replace the element's value (trusted text input for text controls). On
	 * native reads a text control is focused by a trusted click and its content
	 * selected through the `edit` op; selects and date/time/color/range inputs
	 * are still set by the kit.
	 */
	async fill(selector: string | TernSelector, value: string, frame: FramePath = null): Promise<void> {
		const spec = this.#spec(selector);
		const text = String(value);
		const label = `tab.fill(${describe(selector)})`;
		if (this.#native) {
			const first = await this.#first(spec, frame, ["attributes"]);
			if (first && isPickedControl(first)) {
				const picked = await this.#resolveTarget(label, spec, "point", frame, undefined, true);
				await this.#onKit({ engine: "ref", ref: picked.ref }, frame, (kitSpec, kitFrame) =>
					this.#kit("prepareFill", [kitSpec, text], kitFrame),
				);
				return;
			}
			await this.#clickAt(await this.#resolveTarget(label, spec, "fill", frame), "left", 1);
			await this.#op("edit", { action: "selectAll" });
		} else {
			await this.#target(label, spec, "fill", frame);
			const prepared = await this.#kit<{ mode: "insert" | "done" }>("prepareFill", [spec, text], frame);
			if (prepared.mode === "done") return;
		}
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
			throw this.#unsupported(
				"mouseDown",
				`the ${button} mouse button cannot be synthesised (left, right, middle only)`,
			);
		}
		return button;
	}

	async #viewportCentre(): Promise<{ x: number; y: number }> {
		const viewport = await this.#viewportSize();
		return { x: viewport.width / 2, y: viewport.height / 2 };
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

	/**
	 * Scroll the page (trusted wheel at the viewport centre) or an element
	 * (`scrollBy`; on native reads a trusted wheel over the element).
	 */
	async scroll(dx: number, dy: number, opts?: { selector?: string }): Promise<void> {
		if (opts?.selector) {
			const spec = this.#spec(opts.selector);
			const box = await this.#target(`tab.scroll(${describe(opts.selector)})`, spec, "point", null);
			if (this.#native) {
				await this.#input([{ type: "wheel", x: box.x, y: box.y, dx, dy, mods: [...this.#mods] }]);
				return;
			}
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
		const overlayFrame = await this.#onKit(spec, null, async (kitSpec, kitFrame) => {
			await this.#kit("highlight", [kitSpec, id], kitFrame);
			return kitFrame;
		});
		try {
			await untilAborted(this.#signal, () => Bun.sleep(duration));
		} finally {
			await this.#kit("removeOverlay", [id], overlayFrame).catch(() => undefined);
		}
	}

	/** Scroll the element into view (on native reads with trusted wheels, and only when no part of it shows). */
	async scrollIntoView(selector: string | TernSelector): Promise<void> {
		const spec = this.#spec(selector);
		await this.#target(`tab.scrollIntoView(${describe(selector)})`, spec, "point", null);
		if (!this.#native) await this.#kit("scrollIntoView", [spec]);
	}

	/** Select `<select>` options by value (then label). */
	async select(selector: string | TernSelector, ...values: string[]): Promise<string[]> {
		const spec = this.#spec(selector);
		await this.#target(`tab.select(${describe(selector)})`, spec, "point", null);
		return await this.#onKit(spec, null, (kitSpec, kitFrame) =>
			this.#kit<string[]>("select", [kitSpec, values.map(String)], kitFrame),
		);
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
		await this.#onKit(spec, null, async (kitSpec, kitFrame) => {
			if (await this.#kit<boolean>("isFileInput", [kitSpec], kitFrame)) {
				await this.#pull();
				const since = this.#cursor;
				await this.#op("files", { paths: absolute });
				if ((await this.#kit<string>("openChooser", [kitSpec], kitFrame)) === "input") {
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
			await this.#kit("setFiles", [kitSpec, await readFilePayloads(absolute)], kitFrame);
		});
	}

	// ─── Queries ──────────────────────────────────────────────────────────

	async #read<T>(
		selector: string | TernSelector,
		prop: string,
		arg?: unknown,
		frame: FramePath = null,
	): Promise<T | null> {
		return await this.#onKit(this.#spec(selector), frame, (kitSpec, kitFrame) =>
			this.#kit<T | null>("read", [kitSpec, prop, arg], kitFrame),
		);
	}

	/** The element's rendered text (the page `<body>` without a selector), or null. */
	async text(selector: string | TernSelector = "body", frame: FramePath = null): Promise<string | null> {
		if (this.#native) {
			const node = await this.#first(this.#spec(selector), frame, ["text"]);
			return node ? (node.text ?? "").trim() : null;
		}
		return await this.#read<string>(selector, "text", undefined, frame);
	}

	/** The element's inner HTML (the page `<body>` without a selector), or null. */
	async html(selector: string | TernSelector = "body", frame: FramePath = null): Promise<string | null> {
		if (this.#native) {
			const node = await this.#first(this.#spec(selector), frame, ["html"]);
			return node ? innerHtmlOf(node.html ?? "", node.tag ?? "") : null;
		}
		return await this.#read<string>(selector, "html", undefined, frame);
	}

	/** The form element's value, or null. */
	async value(selector: string | TernSelector, frame: FramePath = null): Promise<string | null> {
		if (this.#native) {
			const node = await this.#first(this.#spec(selector), frame, ["value"]);
			if (!node) return null;
			return node.value ?? (FORM_VALUE_TAGS[node.tag ?? ""] ? "" : null);
		}
		return await this.#read<string | null>(selector, "value", undefined, frame);
	}

	/** One attribute, or null. */
	async attr(selector: string | TernSelector, name: string, frame: FramePath = null): Promise<string | null> {
		if (this.#native) {
			const node = await this.#first(this.#spec(selector), frame, ["attributes"]);
			return node?.attributes?.[name] ?? null;
		}
		return await this.#read<string | null>(selector, "attr", name, frame);
	}

	/** How many elements match. */
	async count(selector: string | TernSelector, frame: FramePath = null): Promise<number> {
		if (this.#native) return (await this.#query(this.#spec(selector), frame, { limit: 1 })).total;
		return await this.#kit<number>("count", [this.#spec(selector)], frame);
	}

	/** The element's box in main-frame viewport px, or null. */
	async box(selector: string | TernSelector, frame: FramePath = null): Promise<BoundingBox | null> {
		if (this.#native) {
			const rect = (await this.#first(this.#spec(selector), frame))?.rect;
			return rect && rect[2] > 0 && rect[3] > 0 ? { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } : null;
		}
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
		if (this.#native) {
			const found = await this.#locate(this.#spec(selector), frame);
			if (!found) return false;
			const { state } = await this.#dom({ read: "resolve", ref: found.ref, action: "none", stable: 0 });
			return state !== "detached" && state !== "hidden";
		}
		return (await this.#read<boolean>(selector, "visible", undefined, frame)) === true;
	}

	/** Whether the element is enabled. */
	async isEnabled(selector: string | TernSelector): Promise<boolean> {
		if (this.#native) {
			const node = await this.#first(this.#spec(selector), null);
			return node !== undefined && !node.states?.includes("disabled");
		}
		return (await this.#read<boolean>(selector, "enabled")) === true;
	}

	/** Whether the element is checked. */
	async isChecked(selector: string | TernSelector): Promise<boolean> {
		if (this.#native) return (await this.#first(this.#spec(selector), null, ["checked"]))?.checked === true;
		return (await this.#read<boolean>(selector, "checked")) === true;
	}

	/**
	 * Wait until `text` appears in the body (or a matching element). On native
	 * reads: until an element's rendered text contains it (ignoring case), or
	 * with `exact` equals it.
	 */
	async waitForText(text: string, opts: { timeout?: number; selector?: string; exact?: boolean } = {}): Promise<void> {
		const label = `tab.waitForText(${JSON.stringify(text)})`;
		const timeoutMs = resolveWaitTimeout(this.#cellMs, opts.timeout);
		const root = opts.selector ? this.#spec(opts.selector) : null;
		if (this.#native) {
			let left = timeoutMs;
			let within: DomRef | undefined;
			if (root) {
				const started = Date.now();
				within = (await this.#waitNative(label, root, null, "attached", timeoutMs))[0]?.ref;
				left = Math.max(1, timeoutMs - (Date.now() - started));
			}
			const waited = await this.#dom(
				{
					read: "wait",
					for: {
						by: "text",
						value: text,
						...(opts.exact ? { exact: true } : {}),
						...(within === undefined ? {} : { root: within }),
					},
					state: "attached",
					timeout: left,
				},
				left + WAIT_REPLY_GRACE_MS,
			);
			if (!waited.matched) throw new ToolError(`${label} timed out after ${timeoutMs}ms`);
			return;
		}
		await this.#poll(label, timeoutMs, async () =>
			(await this.#kit<boolean>("hasText", [text, root, opts.exact === true])) ? true : undefined,
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
		const label = `tab.waitFor(${describe(selector)})`;
		const timeoutMs = resolveWaitTimeout(this.#cellMs, opts?.timeout);
		if (this.#native) {
			const nodes = await this.#waitNative(label, spec, frame, "visible", timeoutMs);
			return new TernElementHandle(this, await this.#waitedSpec(spec, frame, nodes, true), frame);
		}
		await this.#poll(label, timeoutMs, async () =>
			(await this.#read<boolean>(spec, "visible", undefined, frame)) === true ? true : undefined,
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
		if (this.#native) {
			const state = opts?.hidden ? "hidden" : opts?.visible ? "visible" : "attached";
			const nodes = await this.#waitNative(
				`tab.waitForSelector(${describe(selector)})`,
				spec,
				frame,
				state,
				timeoutMs,
			);
			if (state === "hidden") return null;
			return new TernElementHandle(this, await this.#waitedSpec(spec, frame, nodes, state === "visible"), frame);
		}
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

	/** A handle for the first current match of `selector`, or null. */
	async firstHandle(selector: string): Promise<TernElementHandle | null> {
		if (this.#native) {
			const ref = (await this.#first(this.#spec(selector), null))?.ref;
			return ref === undefined ? null : new TernElementHandle(this, { engine: "ref", ref }, null);
		}
		return (await this.count(selector)) > 0 ? await this.waitForSelector(selector, { timeout: 1 }) : null;
	}

	/** One handle per current match of `selector`, in document order. */
	async handlesFor(selector: string): Promise<TernElementHandle[]> {
		if (this.#native) {
			const { nodes } = await this.#query(this.#spec(selector), null, { limit: HANDLE_LIMIT });
			return nodes.flatMap(node =>
				node.ref === undefined ? [] : [new TernElementHandle(this, { engine: "ref", ref: node.ref }, null)],
			);
		}
		const tokens = await this.#kit<string[]>("markAll", [this.#spec(selector)]);
		return tokens.map(token => new TernElementHandle(this, { engine: "handle", token }, null));
	}

	/** Handle for observation id `id` (from the last `observe()`). */
	async id(id: number): Promise<TernElementHandle> {
		const spec: TernSelector = { engine: "id", id };
		if (this.#native) {
			// Throws for an id the last observe did not list, and for one whose element left the page.
			await this.#query(spec, null, { limit: 1 });
			return new TernElementHandle(this, { engine: "ref", ref: this.#observedRef(id) }, null);
		}
		await this.#kit("count", [spec]);
		return new TernElementHandle(this, spec, null);
	}

	/** Handle for ARIA snapshot ref `eN` (from the last `ariaSnapshot()`). */
	async ref(id: string): Promise<TernElementHandle> {
		const ref = parseAriaRefSelector(id) ?? id.trim();
		const spec: TernSelector = { engine: "ariaRef", ref };
		const held = this.#native ? await this.#refThroughKit(spec, null) : null;
		if (this.#native ? held === null : (await this.#kit<number>("count", [spec])) === 0) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		return new TernElementHandle(this, held === null ? spec : { engine: "ref", ref: held }, null);
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
		return await this.#onKit(spec, frame, (kitSpec, kitFrame) =>
			this.#evaluateOnKitElement(kitSpec, fn, args, kitFrame),
		);
	}

	async #evaluateOnKitElement(spec: TernSelector, fn: unknown, args: unknown[], frame: FramePath): Promise<unknown> {
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
		if (this.#native) return (await this.#observeNative(opts)).observation;
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

	/** Capture raw image bytes: viewport, full page, or an element (optionally in a frame), at `scale` image pixels per CSS pixel (default: the viewport's). */
	async captureBytes(
		opts: {
			selector?: string | TernSelector;
			fullPage?: boolean;
			format: "png" | "jpeg";
			quality?: number;
			scale?: number;
		},
		frame: FramePath = null,
	): Promise<Buffer> {
		const scale = opts.scale ?? this.#viewport.deviceScaleFactor ?? 1;
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
			throw new ToolError(`${this.product} capture answered without image data`);
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
			let observation: Observation;
			let targets: Array<number | TernAnnotation["boxes"][number]>;
			if (this.#native) {
				// The kit draws the overlay; the boxes are the snapshot's, since its registry knows no native id.
				const observed = await this.#observeNative();
				observation = observed.observation;
				targets = Array.from(observed.rects, ([id, rect]) => ({
					id,
					x: rect[0],
					y: rect[1],
					width: rect[2],
					height: rect[3],
				}));
			} else {
				observation = await this.observe();
				targets = observation.elements.map(element => element.id);
			}
			annotation = await this.#kit<TernAnnotation>("annotate", [targets]);
			for (const box of annotation.boxes) {
				const element = observation.elements.find(candidate => candidate.id === box.id);
				legend.push({ ...box, role: element?.role ?? "generic", name: element?.name });
			}
		}
		let comparison: Buffer;
		let buffer: Buffer;
		const scale = this.#viewport.deviceScaleFactor ?? 1;
		try {
			const capture = { selector: opts.selector, fullPage: opts.fullPage, scale };
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
				capture: { area: screenshotArea(opts), scale },
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
			throw this.#unsupported(
				"pdf",
				`options ${ignored.join(", ")} are unavailable (the web view prints the whole document with its own pagination); only path is supported`,
			);
		}
		const context = this.#requireRunContext("tab.pdf()");
		const answer = await this.#op("pdf", {}, resolveOpTimeouts(this.#cellMs).budgetBound);
		if (!isRecord(answer) || typeof answer.data !== "string") {
			throw new ToolError(`${this.product} pdf answered without data`);
		}
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
			throw this.#unsupported(
				"emulate",
				"timezone cannot be overridden in the web view (Date keeps the system time zone)",
			);
		}
		if (options.headers !== undefined && options.headers !== null && Object.keys(options.headers).length > 0) {
			throw this.#unsupported(
				"emulate",
				"extra HTTP headers cannot be added to the web view's navigations and subresources",
			);
		}
		if (options.reducedMotion !== undefined) {
			throw this.#unsupported(
				"emulate",
				"prefers-reduced-motion cannot be overridden in the web view (CSS media queries follow the system)",
			);
		}
		if (options.cpuThrottling !== undefined && options.cpuThrottling !== null && options.cpuThrottling !== 1) {
			throw this.#unsupported("emulate", "CPU throttling needs the Chromium DevTools protocol");
		}
		if (options.network !== undefined && options.network !== null) {
			throw this.#unsupported(
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

	/** Captured console messages (page world, from document start; the engine's own on a server that lists `console`). */
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

	/**
	 * Web Vitals of the current document (observers run from document start).
	 * Where pages are observed natively the observers are no default script:
	 * the first call makes them one, and `collectVitals` then installs them in
	 * the current document and reloads it once so they see it from the start.
	 */
	async vitals(options: VitalsOptions = {}): Promise<VitalsResult> {
		if (!this.#vitalsScript) {
			this.#vitalsScript = true;
			await this.#syncScripts();
		}
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

	/** Page-provided WebMCP tools: Chromium only. */
	async webmcpList(_options: WebMcpListOptions = {}): Promise<WebMcpListResult> {
		throw this.#unsupported("webmcpList", noWebMcp(this.product));
	}

	/** Invoke one page-provided WebMCP tool: Chromium only. */
	async webmcpInvoke(
		_name: string,
		_params: Record<string, unknown>,
		_options: WebMcpInvokeOptions = {},
	): Promise<WebMcpInvokeResult> {
		throw this.#unsupported("webmcpInvoke", noWebMcp(this.product));
	}

	/** WebMCP catalog changes: Chromium only. */
	async webmcpEvents(_options: WebMcpEventsOptions = {}): Promise<WebMcpEventsResult> {
		throw this.#unsupported("webmcpEvents", noWebMcp(this.product));
	}

	// ─── Recording ────────────────────────────────────────────────────────

	#recordingSource(): RecordingFrameSource {
		let active = false;
		let loop: Promise<void> | undefined;
		const tab = this;
		const capture = async (quality: number): Promise<Uint8Array> =>
			await tab.captureBytes({ format: "jpeg", quality: Math.max(1, Math.min(100, Math.round(quality))) });
		return {
			viewport: async () => await tab.#viewportSize(),
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
		throw this.#unsupported("traceStart", "the web view exposes no performance-trace protocol");
	}

	/** Unsupported: WKWebView has no tracing protocol. */
	async traceStop(_options: { path?: string } = {}): Promise<never> {
		throw this.#unsupported("traceStop", "the web view exposes no performance-trace protocol");
	}

	/** Unsupported: WKWebView has no CPU profiler protocol. */
	async profileStart(): Promise<never> {
		throw this.#unsupported("profileStart", "the web view exposes no CPU-profiler protocol");
	}

	/** Unsupported: WKWebView has no CPU profiler protocol. */
	async profileStop(_options: { path?: string } = {}): Promise<never> {
		throw this.#unsupported("profileStop", "the web view exposes no CPU-profiler protocol");
	}

	#requireRunContext(operation: string): InProcessRunContext {
		if (!this.#runContext) throw new ToolError(`${operation} requires an active ${this.product} browser run`);
		return this.#runContext;
	}

	/** A ToolError for helper `name`, which this backend cannot provide. */
	#unsupported(name: string, reason: string): ToolError {
		return new ToolError(`${helper(name)} is not supported on the ${this.product} browser backend: ${reason}`);
	}
}

/** Selector text for helper labels. */
function describe(selector: string | TernSelector): string {
	return JSON.stringify(selector);
}

/** A response seen by the Tern tab: fetch/XHR (body from the page), a navigation or a natively observed load (no body). */
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
				this.#tab.nativeNetwork
					? `The body of ${this.#record.url} is not available on the ${this.#tab.product} backend (it observes requests in the engine and keeps no response bodies; read it in the page with tab.evaluate and fetch)`
					: `The body of ${this.#record.url} is not available on the ${this.#tab.product} backend (only fetch/XHR bodies of the current document are captured)`,
			);
		}
		return typeof body.value === "string" ? body.value : Buffer.from(body.value.base64, "base64").toString("utf8");
	}

	/** The body parsed as JSON. */
	async json(): Promise<unknown> {
		return JSON.parse(await this.text());
	}
}

/**
 * Element handle of the Tern tab (`tab.id(n)`, `tab.ref(eN)`, `waitFor`). It
 * holds a selector the tab resolves on every call: on native reads the
 * engine ref of its element, so it keeps naming that element across
 * re-observes and reports it missing once it leaves the page.
 */
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
	async click(selector: string, options?: { button?: MouseButtonName; count?: number }): Promise<void> {
		await this.#tab.clickIn(selector, this.#path, options);
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

	/** Element text; the frame's `<body>` without a selector. */
	async text(selector = "body"): Promise<string> {
		return (await this.#tab.text(selector, this.#path)) ?? "";
	}

	/** Element inner HTML; the frame's `<body>` without a selector. */
	async html(selector = "body"): Promise<string> {
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
		return await this.#tab.firstHandle(selector);
	}

	async $$(selector: string): Promise<TernElementHandle[]> {
		return await this.#tab.handlesFor(selector);
	}

	async click(selector: string, options?: { button?: MouseButtonName; count?: number }): Promise<void> {
		await this.#tab.click(selector, options);
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
		return `${this.#tab.product} web view`;
	}

	wsEndpoint(): string {
		return `${this.#tab.product.toLowerCase()}://block/${this.#tab.block}`;
	}

	disconnect(): void {
		this.connected = false;
	}

	async close(): Promise<void> {
		this.connected = false;
	}
}
