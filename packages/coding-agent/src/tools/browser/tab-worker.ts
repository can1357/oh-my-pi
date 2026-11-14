import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { formatBytes, isRecord, postmortem, Snowflake, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "@oh-my-pi/pi-utils/dom";
import type {
	Accessibility,
	Browser,
	CDPSession,
	ElementHandle,
	Frame,
	FrameWaitForFunctionOptions,
	HTTPRequest,
	HTTPResponse,
	JSHandle,
	KeyInput,
	KeyPressOptions,
	MouseButton,
	Page,
	Protocol,
	Realm,
	SerializedAXNode,
	Target,
} from "puppeteer-core";
import { stringifyFunction } from "puppeteer-core/internal/util/Function.js";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { formatScreenshot, resizeImage } from "../../utils/image-resize";
import { resolveToCwd } from "../path-utils";
import {
	bindRunFacade,
	installBrowserWorkerRejectionGuard,
	isBrowserRunOwnedRejection,
	markBrowserRunRejection,
	markHandled,
	observeBrowserRunPromise,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../run-scope";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	type AriaSnapshotOptions,
	assertSelectorString,
	captureAriaSnapshot,
	PLAYWRIGHT_ONLY_SELECTOR_RE,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria/aria-snapshot";
import { resolveOpTimeouts, resolveWaitTimeout, ZERO_MATCH_FAIL_FAST_MS, ZERO_MATCH_POLL_MS } from "./op-timeouts";
import { type BrowserA11yOptions, type BrowserA11yResult, formatA11ySummary, runA11yAudit } from "./a11y/audit";
import {
	applyUserAgentOverride,
	BrowserEmulationController,
	type BrowserEmulateOptions,
	type ClipboardActionResult,
	type ClipboardReadResult,
} from "./emulation";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PAGE_PROTOCOL_TIMEOUT_MS,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	browserConnection,
	connectPuppeteer,
	DEFAULT_VIEWPORT,
	isPuppeteerHandle,
	isPuppeteerTargetClose,
	isPuppeteerTimeout,
	loadPuppeteerInWorker,
	loadedKnownDevices,
	loadedNetworkConditions,
	privateTargetId,
	puppeteerTimeoutError,
	readPageViewport,
} from "./launch";
import { extractReadableFromHtml, type ReadableExtractOptions, type ReadableFormat } from "./readable";
import { assertTabPressArgs } from "./tab-arguments";
import { selectorWaitOptions, type SelectorWaitOptions, waitForDetached, waitForSelectorHandle } from "./selector-wait";
import {
	type BrowserCookie,
	type ClearCookiesOptions,
	clearPageCookies,
	type CookieQueryOptions,
	loadStorageState,
	type LoadStateResult,
	readCookies,
	readStorage,
	saveStorageState,
	setPageCookies,
	setPageStorage,
	clearPageStorage,
	type StorageKind,
} from "./storage-state";
import { enableReact, puppeteerReactHost, type ReactEnableResult } from "./react/devtools-hook";
import { collectReactRenders, type ReactRendersAction, type ReactRendersResult } from "./react/renders";
import { readReactSuspense, type ReactSuspenseBoundary, type ReactSuspenseOptions } from "./react/suspense";
import {
	inspectReactFiber,
	type ReactInspectResult,
	type ReactTreeNode,
	type ReactTreeOptions,
	readReactTree,
} from "./react/tree";
import { collectVitals, installVitalsObservers, type VitalsOptions, type VitalsResult } from "./react/vitals";
import { parseRoleSelector, registerSemanticQueryHandlers } from "./query-handlers";
import {
	type ElementQueryHelpers,
	enrichElementQueries,
	queryAttribute,
	queryBox,
	queryChecked,
	queryCount,
	queryEnabled,
	queryHtml,
	type QueryBox,
	queryStyles,
	queryText,
	queryValue,
	queryVisible,
	waitForPageText,
} from "./queries";
import { DownloadManager, type BrowserDownload } from "./downloads";
import { InitScriptManager, type InitScriptInfo } from "./init-scripts";
import { applyInsecure } from "./open-options";
import { FOREIGN_FRAME_REFUSAL } from "./relay/protocol";
import {
	BrowserNetworkManager,
	type HarContentPolicy,
	type NetworkPattern,
	type NetworkRequestDetail,
	type NetworkRequestRecord,
	type NetworkRequestsOptions,
	type NetworkRouteDescription,
	type NetworkRouteOptions,
} from "./network";
import {
	type BrowserCaptureResult,
	type BrowserConsoleEntry,
	type BrowserConsoleOptions,
	type BrowserErrorEntry,
	type BrowserErrorOptions,
	PageConsoleCapture,
} from "./console-capture";
import {
	type BrowserMetrics,
	type BrowserProfileStopOptions,
	type BrowserTraceStartOptions,
	type BrowserTraceStopOptions,
	BrowserTracingController,
} from "./tracing";
import {
	WebMcpController,
	type WebMcpEventsOptions,
	type WebMcpEventsResult,
	type WebMcpInvokeOptions,
	type WebMcpInvokeResult,
	type WebMcpListOptions,
	type WebMcpListResult,
} from "./webmcp";
import {
	createCdpRecordingSource,
	RecordingController,
	type RecordingOptions,
	type RecordingStartResult,
	type RecordingStatus,
	type RecordingStopResult,
} from "./recording";
import {
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	ariaSnapshotBaselineKey,
	diffAriaSnapshot,
} from "./snapshot-plus";
import {
	ClickRefusedError,
	clickAt,
	clickElement,
	composedContains,
	clickQueryHandlerText,
	dragBetween,
	fillViaHandle,
	highlightElement,
	hoverElement,
	type HighlightOptions,
	type InteractionHandle,
	installCancelledReleaseGuard,
	keyDown,
	keyUp,
	mouseDown,
	mouseMove,
	mouseUp,
	pressKey,
	releaseButtonOffPage,
	selectElementOptions,
	setElementChecked,
	type PreparedUpload,
	prepareElementUpload,
	type ScrollOptions,
	TypingInterruptedError,
	typeIntoElement,
	wheel,
	withLiveElement,
} from "./interactions";
import {
	captureScreenshotBuffer,
	createPngDiff,
	type DiffScreenshotOptions,
	type DiffScreenshotResult,
	formatScreenshotLegend,
	installScreenshotAnnotations,
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
	whileDrawing,
} from "./screenshot";
import { type DialogPolicy, type DialogState, dialogBlocksPageError, RuntimeDialogController } from "./dialogs";
import {
	type BrowserFrameApi,
	type BrowserFrameInfo,
	captureFrameScreenshot,
	createFrameApi,
	devtoolsFrameId,
	listFrames,
	resolveFrame,
} from "./frames";
import {
	assertUrlPattern,
	isNavigatedContextError,
	type NavigationWaitUntil,
	navigateMainFrame,
	pushState,
	reloadPage,
	traverseHistory,
	waitForMainFrameDocument,
} from "./navigation";

import { cloneSafe, RunOutput } from "./run-output";
import { type UploadRoute, UploadStaging } from "./upload-files";
import {
	type Observation,
	type ObservationEntry,
	isMissingPageGlobal,
	ownsPage,
	type ReadyInfo,
	type RunErrorPayload,
	type ScreenshotResult,
	type SessionSnapshot,
	type ToolReply,
	type Transport,
	type WorkerInbound,
	type WorkerInitPayload,
} from "./tab-protocol";

declare module "puppeteer-core" {
	interface Frame {
		/** Puppeteer's main JavaScript realm, retained by our pinned runtime patch. */
		mainRealm(): Realm;
		/** This frame's accessibility tree (`@internal` upstream, stripped from published types). */
		readonly accessibility: Accessibility;
		/**
		 * Loader of the document the frame shows (`@internal` upstream). Changes on every navigation that
		 * loads a document; a back/forward cache restore keeps the previous document's value.
		 */
		readonly _loaderId: string;
		/** CDP session that drives this frame (`@internal` upstream, stripped from published types). */
		readonly client: CDPSession;
	}
	interface Realm {
		/** Re-home a DOM handle into this realm (`@internal` upstream, stripped from published types). */
		adoptHandle<T extends JSHandle>(handle: T): Promise<T>;
		/** Resolve a CDP backend node id in this realm (`@internal` upstream, stripped from published types). */
		adoptBackendNode(backendNodeId: number): Promise<JSHandle>;
	}
	interface JSHandle {
		/** Realm that created this handle (`@internal` upstream, stripped from published types). */
		readonly realm: Realm;
	}
	interface SerializedAXNode {
		/** DOM node behind this AX node (`@internal` upstream, stripped from published types). */
		readonly backendNodeId?: number;
		/** Loader of the frame's document when the snapshot was taken (`@internal` upstream, stripped from published types). */
		readonly loaderId: string;
	}
}

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
		readonly visibilityState: "visible" | "hidden";
	};
}

const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

const SELECTOR_HANDLER_PREFIXES = [
	"aria/",
	"text/",
	"xpath/",
	"pierce/",
	"label/",
	"placeholder/",
	"testid/",
	"alt/",
	"title/",
	"role/",
	"aria-ref=",
	"aria-ref/",
	"ariaref/",
	"p-",
] as const;

type DragTarget = string | { readonly x: number; readonly y: number };

/** Maximum wait for a renderer acknowledgement after a wheel event is queued. */
const SCROLL_ACK_TIMEOUT_MS = 2_000;
/** Cleanup must settle inside the supervisor's 750ms post-run grace window. */
const REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 500;
/** Bound cleanup window after a timed-out raw handle action. */
const HANDLE_ACTION_INVALIDATION_TIMEOUT_MS = 500;
/** Bound on reading every iframe in one observation; a frame whose renderer is stuck in script never answers. */
const FRAME_SNAPSHOT_TIMEOUT_MS = 5_000;
/** Bound on Puppeteer exposing a page Chromium still has; the supervisor's init budget caps the whole attach anyway. */
const ATTACHED_TARGET_EXPOSE_TIMEOUT_MS = 5_000;
/** Bound on counting a timed-out selector's matches for its error message. */
const MATCH_COUNT_PROBE_TIMEOUT_MS = 1_000;
/** Bound on the page command that lets a relay detach report overtake a run's failure; inside the supervisor's grace. */
const DETACH_REPORT_TIMEOUT_MS = 500;
/** Longest a page call waits for a main-frame navigation the page requested to replace the document. */
const REQUESTED_NAVIGATION_WAIT_MS = 5_000;

/** Options for one tab helper run through `WorkerCore.#runOp`. */
interface OpOptions {
	selector?: string;
	zeroMatchAfterMs?: number;
	awaitNavigation?: boolean;
	/**
	 * How the call meets a confirm or prompt, which stops the page's script until it is answered. Either way a call
	 * made while one is open fails at once. One that opens during the call: `"blocks"` fails the call (it can only end
	 * once the dialog is answered); `"answers"` ends it as done (an input the page answered with the dialog).
	 */
	dialog?: "blocks" | "answers";
}

/** Queue a wheel event without treating a delayed renderer acknowledgement as dispatch failure. */
export async function dispatchScroll(
	dispatch: () => Promise<void>,
	ackTimeoutMs = SCROLL_ACK_TIMEOUT_MS,
): Promise<void> {
	const deadline = Promise.withResolvers<void>();
	const timer = setTimeout(() => deadline.resolve(), ackTimeoutMs);
	timer.unref();
	try {
		await Promise.race([dispatch(), deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
	): Promise<void>;
	observe(opts?: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		selector?: string;
		compact?: boolean;
	}): Promise<Observation>;
	ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string | AriaSnapshotDiffResult>;
	screenshot(opts?: ScreenshotOptions): Promise<string | ScreenshotChangeResult>;
	diffScreenshot(baselinePath: string, opts?: DiffScreenshotOptions): Promise<DiffScreenshotResult>;
	pdf(opts?: PdfOptions): Promise<string>;
	extract(format?: ReadableFormat, opts?: ReadableExtractOptions): Promise<string>;
	click(
		selector: string,
		opts?: { button?: "left" | "right" | "middle" | "back" | "forward"; count?: number },
	): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: string, opts?: { selector?: string }): Promise<void>;
	scroll(deltaX: number, deltaY: number, opts?: ScrollOptions): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string, opts?: { timeout?: number }): Promise<ActionableHandle>;
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: string[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<HTTPResponse>;
	waitForSelector(selector: string, opts?: SelectorWaitOptions): Promise<ActionableHandle | null>;
	waitForNavigation(opts?: {
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		timeout?: number;
	}): Promise<HTTPResponse | null>;
	id(n: number): Promise<ActionableHandle>;
	ref(id: string): Promise<ActionableHandle>;
	cookies(opts?: CookieQueryOptions): Promise<BrowserCookie[]>;
	setCookies(...cookies: unknown[]): Promise<void>;
	clearCookies(opts?: ClearCookiesOptions): Promise<void>;
	storage(kind: StorageKind, opts?: { key?: string }): Promise<Record<string, string> | string | null>;
	setStorage(kind: StorageKind, keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void>;
	clearStorage(kind: StorageKind): Promise<void>;
	saveState(filePath?: string): Promise<string>;
	loadState(filePath: string): Promise<LoadStateResult>;
	recordStart(path: string, opts?: RecordingOptions): Promise<RecordingStartResult>;
	recordStop(): Promise<RecordingStopResult>;
	recordRestart(path: string, opts?: RecordingOptions): Promise<RecordingStartResult>;
	recording(): Promise<RecordingStatus>;
	webmcpList(opts?: WebMcpListOptions): Promise<WebMcpListResult>;
	webmcpInvoke(name: string, params: Record<string, unknown>, opts?: WebMcpInvokeOptions): Promise<WebMcpInvokeResult>;
	webmcpEvents(opts?: WebMcpEventsOptions): Promise<WebMcpEventsResult>;
	a11y(opts?: BrowserA11yOptions): Promise<BrowserA11yResult>;
	vitals(opts?: VitalsOptions): Promise<VitalsResult>;
	reactEnable(): Promise<ReactEnableResult>;
	reactTree(opts?: ReactTreeOptions): Promise<ReactTreeNode[]>;
	reactInspect(id: number): Promise<ReactInspectResult>;
	reactRenders(opts: { action: ReactRendersAction }): Promise<ReactRendersResult>;
	reactSuspense(opts?: ReactSuspenseOptions): Promise<ReactSuspenseBoundary[]>;
	back(opts?: { waitUntil?: NavigationWaitUntil }): Promise<string>;
	forward(opts?: { waitUntil?: NavigationWaitUntil }): Promise<string>;
	reload(opts?: { waitUntil?: NavigationWaitUntil }): Promise<string>;
	pushState(url: string): Promise<string>;
	frames(): Promise<BrowserFrameInfo[]>;
	frame(selectorOrNameOrUrl: string): Promise<BrowserFrameApi>;
	dialog(): Promise<DialogState>;
	handleDialog(opts: { accept: boolean; text?: string }): Promise<void>;
	setDialogs(policy: DialogPolicy | null): Promise<void>;
	/** Without a selector, reads the page `<body>`. */
	text(selector?: string): Promise<string | null>;
	/** Without a selector, reads the page `<body>`. */
	html(selector?: string): Promise<string | null>;
	value(selector: string): Promise<string | null>;
	attr(selector: string, name: string): Promise<string | null>;
	count(selector: string): Promise<number>;
	box(selector: string): Promise<QueryBox | null>;
	styles(selector: string, props?: string[]): Promise<Record<string, string> | null>;
	isVisible(selector: string): Promise<boolean>;
	isEnabled(selector: string): Promise<boolean>;
	isChecked(selector: string): Promise<boolean>;
	waitForText(text: string, opts?: { timeout?: number; selector?: string; exact?: boolean }): Promise<void>;
	addInitScript(source: string): Promise<{ id: string }>;
	removeInitScript(id: string): Promise<void>;
	initScripts(): Promise<InitScriptInfo[]>;
	waitForDownload(opts?: { timeout?: number }): Promise<BrowserDownload>;
	downloads(): Promise<BrowserDownload[]>;
	console(opts?: BrowserConsoleOptions): Promise<BrowserCaptureResult<BrowserConsoleEntry>>;
	errors(opts?: BrowserErrorOptions): Promise<BrowserCaptureResult<BrowserErrorEntry>>;
	clearConsole(): Promise<void>;
	traceStart(opts?: BrowserTraceStartOptions): Promise<void>;
	traceStop(opts?: BrowserTraceStopOptions): Promise<string>;
	profileStart(): Promise<void>;
	profileStop(opts?: BrowserProfileStopOptions): Promise<string>;
	metrics(): Promise<BrowserMetrics>;
	dblclick(selector: string): Promise<void>;
	hover(selector: string): Promise<void>;
	focus(selector: string): Promise<void>;
	check(selector: string): Promise<void>;
	uncheck(selector: string): Promise<void>;
	keyDown(key: KeyInput): Promise<void>;
	keyUp(key: KeyInput): Promise<void>;
	mouseMove(x: number, y: number, opts?: { steps?: number }): Promise<void>;
	mouseDown(opts?: { button?: "left" | "right" | "middle" | "back" | "forward" }): Promise<void>;
	mouseUp(opts?: { button?: "left" | "right" | "middle" | "back" | "forward" }): Promise<void>;
	clickAt(
		x: number,
		y: number,
		opts?: {
			button?: "left" | "right" | "middle" | "back" | "forward";
			clickCount?: number;
		},
	): Promise<void>;
	wheel(deltaX: number, deltaY: number): Promise<void>;
	highlight(selector: string, opts?: HighlightOptions): Promise<void>;
	emulate(opts?: BrowserEmulateOptions): Promise<BrowserEmulateOptions>;
	devices(): Promise<string[]>;
	clipboardRead(): Promise<ClipboardReadResult>;
	clipboardWrite(text: string): Promise<ClipboardActionResult>;
	clipboardCopy(): Promise<ClipboardActionResult>;
	clipboardPaste(): Promise<ClipboardActionResult>;
	route(pattern: NetworkPattern, opts?: NetworkRouteOptions): Promise<void>;
	unroute(pattern?: NetworkPattern): Promise<void>;
	routes(): Promise<NetworkRouteDescription[]>;
	requests(opts?: NetworkRequestsOptions): Promise<NetworkRequestRecord[]>;
	request(id: string | number): Promise<NetworkRequestDetail>;
	clearRequests(): Promise<void>;
	harStart(opts?: { content?: HarContentPolicy }): Promise<void>;
	harStop(opts?: { path?: string }): Promise<string>;
	allowedDomains(): Promise<string[]>;
}

export function normalizeSelector(selector: string): string {
	assertSelectorString(selector);
	if (!selector) return selector;
	if (
		!SELECTOR_HANDLER_PREFIXES.some(prefix => selector.startsWith(prefix)) &&
		PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)
	) {
		throw new ToolError(
			`Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. ` +
				`Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`,
		);
	}
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	if (selector.startsWith("role/")) {
		// The role/ handler refuses a selector it cannot fully read. Parsing it here surfaces that as a tool error before
		// the op, so a wait fails at once instead of at its timeout.
		try {
			parseRoleSelector(selector.slice(5));
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	}
	return selector;
}

function isInteractiveNode(node: SerializedAXNode): boolean {
	if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
	return (
		node.checked !== undefined ||
		node.pressed !== undefined ||
		node.selected !== undefined ||
		node.expanded !== undefined ||
		node.focused === true
	);
}

function asElementHandle(handle: unknown): ElementHandle | null {
	return handle ? (handle as ElementHandle) : null;
}

/** ElementHandle enriched with omp's additional direct interaction and query methods. */
export type ActionableHandle = InteractionHandle & ElementQueryHelpers & { fill(value: string): Promise<void> };

/**
 * A named per-op guard: runs `fn` inside the active run's fail-fast deadline and
 * in-flight tracking (the same wrapper `tab.click(selector)` uses), so a stalled
 * handle action rejects with a named error before the cell budget instead of
 * hanging on puppeteer's protocol timeout. `dialog` says how the action meets a
 * confirm or prompt (`OpOptions.dialog`): a click or key press that opens one is
 * done (`"answers"`); any other action fails (`"blocks"`, the default).
 */
export type HandleOpGuard = <T>(
	label: string,
	fn: (signal: AbortSignal) => Promise<T>,
	dialog?: "blocks" | "answers",
) => Promise<T>;

/**
 * Every `ElementHandle` method that dispatches input, pointer/touch, drag, or navigation
 * work and can therefore stall on a busy page. When {@link toActionableHandle} is given a
 * guard, each is routed through the per-op fail-fast wrapper; without it the inherited
 * puppeteer method runs outside the op map and a stall consumes the whole cell (issue #9535).
 * Pure reads (`boundingBox`, `screenshot`, `evaluate`, queries) are omitted — they are not
 * user-driven actions and keep their native puppeteer behavior.
 */
const GUARDED_HANDLE_METHODS = [
	"click",
	"type",
	"hover",
	"tap",
	"focus",
	"press",
	"select",
	"uploadFile",
	"scrollIntoView",
	"drag",
	"dragEnter",
	"dragOver",
	"drop",
	"dragAndDrop",
	"touchStart",
	"touchMove",
	"touchEnd",
	"autofill",
] as const satisfies readonly (keyof ElementHandle)[];

type GuardedHandleMethod = (typeof GUARDED_HANDLE_METHODS)[number];
type RawHandleMethod = (...args: unknown[]) => Promise<unknown>;

interface RawHandleMethods {
	interactive: Partial<Record<GuardedHandleMethod, RawHandleMethod>>;
	invalidatedBy?: string;
}

/** Symbol-keyed original methods travel with each cached handle without enumerating or colliding. */
const RAW_HANDLE_METHODS = Symbol("browser.rawHandleMethods");

type HandleWithRawMethods = ActionableHandle & { [RAW_HANDLE_METHODS]?: RawHandleMethods };

async function runGuardedHandleAction<T>(
	handle: ElementHandle,
	state: RawHandleMethods,
	label: string,
	signal: AbortSignal,
	action: () => Promise<T>,
	invalidate?: () => Promise<void>,
): Promise<T> {
	if (state.invalidatedBy) {
		throw new ToolError(
			`${label} cannot run: this handle was invalidated after ${state.invalidatedBy} timed out; ` +
				"run tab.observe() or tab.ariaSnapshot() to resolve a fresh handle",
		);
	}
	throwIfAborted(signal);
	const pending = action();
	try {
		return await untilAborted(signal, () => pending);
	} catch (error) {
		if (!signal.aborted) throw error;
		state.invalidatedBy = label;
		let actionError: unknown;
		await withTimeout(
			Promise.all([
				pending.then(
					() => undefined,
					(err: unknown) => {
						actionError = err;
					},
				),
				handle.dispose().catch(() => undefined),
				invalidate?.().catch(() => undefined),
			]),
			HANDLE_ACTION_INVALIDATION_TIMEOUT_MS,
			`Timed out invalidating ${label}`,
		).catch(() => undefined);
		// A click still refused, or typing cut short, when the deadline hit carries that on its own abort error.
		throw actionError instanceof ClickRefusedError || actionError instanceof TypingInterruptedError
			? actionError
			: error;
	}
}

/**
 * How an actionable handle uploads files: the route check and `prepare` each run under their own action deadline,
 * delivery under `deliverGuard`.
 */
export interface HandleUploads {
	/** How the browser takes files; see {@link UploadStaging.route}. */
	route(signal: AbortSignal): Promise<UploadRoute>;
	/** Find what takes the files through the handle: its file input, the chooser its click opens, or a drop zone. */
	prepare(filePaths: string[], label: string, route: UploadRoute, signal: AbortSignal): Promise<PreparedUpload>;
	/** A guard with a deadline long enough to stream a large file. */
	deliverGuard: HandleOpGuard;
}

async function uploadThroughHandle(
	handle: ElementHandle,
	state: RawHandleMethods,
	filePaths: string[],
	guard: HandleOpGuard,
	uploads: HandleUploads,
	invalidate?: () => Promise<void>,
): Promise<void> {
	const label = "handle.uploadFile()";
	// Its own deadline, as for `tab.uploadFile`: the first upload's check must not eat into the action's.
	const route = await guard(`${label} checking how the browser takes files`, signal => uploads.route(signal));
	const prepared = await guard(label, signal =>
		runGuardedHandleAction(
			handle,
			state,
			label,
			signal,
			() => uploads.prepare(filePaths, label, route, signal),
			invalidate,
		),
	);
	try {
		await uploads.deliverGuard(`${label} sending ${formatBytes(prepared.bytes)}`, signal => prepared.deliver(signal));
	} finally {
		await prepared.dispose();
	}
}

/**
 * Re-home element handles in `args` into `realm` so they can be passed to an
 * evaluation there. The stealth patch resolves selectors (`tab.waitForSelector`,
 * `tab.$`, …) in Puppeteer's isolated world while `tab.evaluate` runs in the main
 * world; CDP rejects a handle used outside the context that created it. Puppeteer's
 * supported realm adoption is DOM-only, so non-element JSHandles pass through and
 * retain Puppeteer's native same-realm requirement. Nested handles likewise remain
 * unsupported by Puppeteer's positional argument serializer.
 *
 * Adopted copies are disposed on partial adoption failure and after evaluation.
 * Caller-owned handles — including handles already in `realm` — are never disposed.
 */
async function adoptElementArgs(
	realm: Realm,
	args: unknown[],
): Promise<{ args: unknown[]; dispose: () => Promise<void> }> {
	let adopted: JSHandle[] | undefined;
	let out: unknown[] | undefined;
	let copies: Map<JSHandle, JSHandle> | undefined;
	const dispose = async (): Promise<void> => {
		if (adopted) await Promise.all(adopted.map(handle => handle.dispose().catch(() => undefined)));
	};

	try {
		for (let i = 0; i < args.length; i++) {
			const handle = args[i];
			if (!isPuppeteerHandle(handle)) continue;
			const element = handle.asElement();
			if (!element || handle.realm === realm) continue;

			copies ??= new Map();
			let copy = copies.get(handle);
			if (!copy) {
				copy = await realm.adoptHandle(element);
				copies.set(handle, copy);
				(adopted ??= []).push(copy);
			}
			out ??= args.slice();
			out[i] = copy;
		}
	} catch (error) {
		await dispose();
		throw error;
	}

	return { args: out ?? args, dispose };
}

type PageFunction = string | ((...args: unknown[]) => unknown);

/**
 * Evaluate `fn` in `realm` with its element-handle `args` adopted there (see {@link adoptElementArgs}), returning
 * the value or, with `handle`, a handle to it. Puppeteer evaluates a string as an expression and ignores extra
 * args; that holds here, without inspecting or adopting otherwise-unused handles.
 */
async function evaluateInRealm(
	realm: Realm,
	fn: PageFunction,
	args: unknown[],
	handle: boolean,
	signal?: AbortSignal,
): Promise<unknown> {
	if (typeof fn === "string") return handle ? realm.evaluateHandle(fn) : realm.evaluate(fn);
	const { args: adopted, dispose } = await adoptElementArgs(realm, args);
	try {
		if (signal) throwIfAborted(signal);
		return handle ? await realm.evaluateHandle(fn, ...adopted) : await realm.evaluate(fn, ...adopted);
	} finally {
		await dispose();
	}
}
type PagePoller = { promise: Promise<unknown>; stop(): void };

/**
 * Page-side half of the run page's `waitForFunction`: its promise resolves with the first truthy value of
 * `predicate(...args)`, checked at once and then on every animation frame, DOM mutation, or numeric interval,
 * or with `undefined` after `ms` (never when `null`). `stop` releases the poller on host cancellation.
 */
function waitInPage(
	predicate: (...args: unknown[]) => unknown,
	mode: string | number,
	ms: number | null,
	...args: unknown[]
): PagePoller {
	type Observer = { observe(node: unknown, options: object): void; disconnect(): void };
	const pageGlobal = globalThis as unknown as {
		document: unknown;
		requestAnimationFrame(callback: () => void): number;
		cancelAnimationFrame(id: number): void;
		setTimeout(callback: () => void, ms: number): number;
		clearTimeout(id: number): void;
		setInterval(callback: () => void, ms: number): number;
		clearInterval(id: number): void;
		MutationObserver: new (callback: () => void) => Observer;
	};
	// Async functions use the realm's intrinsic Promise even when the page replaces the global constructor.
	const IntrinsicPromise = (async () => {})().constructor as PromiseConstructor;
	const { promise, resolve, reject } = IntrinsicPromise.withResolvers<unknown>();
	// The host attaches to this promise in its next protocol call, after the page's rejection checkpoint.
	void promise.catch(() => {});
	let settled = false;
	let observer: Observer | undefined;
	let frame: number | undefined;
	let interval: number | undefined;
	let timer: number | undefined;
	const finish = (failed: boolean, value: unknown) => {
		if (settled) return;
		settled = true;
		observer?.disconnect();
		if (frame !== undefined) pageGlobal.cancelAnimationFrame(frame);
		if (interval !== undefined) pageGlobal.clearInterval(interval);
		if (timer !== undefined) pageGlobal.clearTimeout(timer);
		if (failed) reject(value);
		else resolve(value);
	};
	const check = async () => {
		if (settled) return;
		try {
			const value = await predicate(...args);
			if (value) finish(false, value);
		} catch (error) {
			finish(true, error);
		}
		if (!settled && mode === "raf") frame = pageGlobal.requestAnimationFrame(() => void check());
		if (!settled && typeof mode === "number" && interval === undefined) {
			interval = pageGlobal.setInterval(() => void check(), mode);
		}
	};
	if (ms !== null) timer = pageGlobal.setTimeout(() => finish(false, undefined), ms);
	if (mode === "mutation") {
		observer = new pageGlobal.MutationObserver(() => void check());
		observer.observe(pageGlobal.document, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
	}
	void check();
	return { promise, stop: () => finish(false, undefined) };
}

/**
 * The `page` that `tab.run` code receives. The stealth patch runs Puppeteer's page evaluations in its isolated
 * world, where page globals and custom-element members do not exist; this page runs the code handed to
 * `evaluate`, `evaluateHandle`, `$eval`, `$$eval` and `waitForFunction` in the main world, as `tab.evaluate` does.
 * Their selectors still resolve in the isolated world, and the matches are adopted for the call. Every other
 * member is the tab's own page, bound to it so Puppeteer's private fields stay reachable; one that returns the
 * page (`page.on(…)`) returns this page, so a chained call keeps the main world. `signal` ends the run.
 */
function createRunPage(page: Page, signal: AbortSignal): Page {
	const realm = (): Realm => page.mainFrame().mainRealm();
	const mainWorld = new Map<PropertyKey, unknown>([
		["evaluate", (fn: PageFunction, ...args: unknown[]) => evaluateInRealm(realm(), fn, args, false)],
		["evaluateHandle", (fn: PageFunction, ...args: unknown[]) => evaluateInRealm(realm(), fn, args, true)],
		[
			"$eval",
			async (selector: string, fn: PageFunction, ...args: unknown[]) => {
				const element = await page.$(selector);
				// Puppeteer's own message for a `$eval` that matches nothing.
				if (!element) throw new Error(`Error: failed to find element matching selector "${selector}"`);
				try {
					return await evaluateInRealm(realm(), fn, [element, ...args], false);
				} finally {
					await element.dispose();
				}
			},
		],
		[
			"$$eval",
			async (selector: string, fn: PageFunction, ...args: unknown[]) => {
				const elements = await page.$$(selector);
				const target = realm();
				// Adopt every match at once: one CDP round trip each, run together rather than in turn.
				const adopted = await Promise.allSettled(elements.map(element => target.adoptHandle(element)));
				try {
					const failed = adopted.find(result => result.status === "rejected");
					if (failed) throw failed.reason;
					const nodes = adopted.map(result => (result as PromiseFulfilledResult<ElementHandle>).value);
					const list = await target.evaluateHandle((...found: unknown[]) => found, ...nodes);
					try {
						return await evaluateInRealm(target, fn, [list, ...args], false);
					} finally {
						await list.dispose();
					}
				} finally {
					await Promise.all([
						...adopted.map(result => (result.status === "fulfilled" ? result.value.dispose() : undefined)),
						...elements.map(element => element.dispose()),
					]);
				}
			},
		],
		[
			"waitForFunction",
			// Puppeteer's own wait installs its query bindings as globals of the world it polls, which every page
			// script can see in the main world. This evaluates instead, retrying across navigations as its wait does:
			// All polling stays in the page so protocol latency does not stretch numeric intervals.
			async (fn: PageFunction, options: FrameWaitForFunctionOptions = {}, ...args: unknown[]) => {
				const timeout = options.timeout ?? page.getDefaultTimeout();
				const polling = options.polling ?? 100;
				if (typeof polling !== "number" && polling !== "raf" && polling !== "mutation") {
					throw new Error(`Unknown polling option: ${polling}`);
				}
				if (typeof polling === "number" && polling < 0) {
					throw new Error("Cannot poll with non-positive interval");
				}
				const deadline = timeout > 0 ? Date.now() + timeout : Number.POSITIVE_INFINITY;
				const waitSignal = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
				const timedOut = () => puppeteerTimeoutError(`Waiting failed: ${timeout}ms exceeded`);
				const attempt = async (target: Realm, left: number, evalSignal: AbortSignal): Promise<JSHandle> => {
					if (waitSignal.aborted) throw waitSignal.reason;
					const predicate = await target.evaluateHandle(
						typeof fn === "string" ? `() => (${fn})` : `(${stringifyFunction(fn)})`,
					);
					let poller: JSHandle<PagePoller> | undefined;
					const stop = () => {
						if (poller) void target.evaluate(held => held.stop(), poller).catch(() => {});
					};
					try {
						throwIfAborted(evalSignal);
						const ms = Number.isFinite(left) ? left : null;
						const waitArgs = [predicate, polling, ms, ...args];
						poller = (await evaluateInRealm(
							target,
							waitInPage as PageFunction,
							waitArgs,
							true,
							evalSignal,
						)) as JSHandle<PagePoller>;
						evalSignal.addEventListener("abort", stop, { once: true });
						throwIfAborted(evalSignal);
						return await target.evaluateHandle(held => held.promise, poller);
					} finally {
						evalSignal.removeEventListener("abort", stop);
						if (poller) {
							await target.evaluate(held => held.stop(), poller).catch(() => {});
							await poller.dispose();
						}
						await predicate.dispose();
					}
				};
				for (;;) {
					if (waitSignal.aborted) throw waitSignal.reason;
					const left = Math.max(0, deadline - Date.now());
					// The deadline also bounds a predicate that never settles, not only the polls between attempts.
					const evalSignal = Number.isFinite(left)
						? AbortSignal.any([waitSignal, AbortSignal.timeout(left)])
						: waitSignal;
					try {
						const target = realm();
						const pending = attempt(target, left, evalSignal);
						// The protocol evaluation can finish after the host-side deadline or cancellation won.
						void pending
							.then(value => {
								if (evalSignal.aborted) return value.dispose();
							})
							.catch(() => {});
						const value = await untilAborted(evalSignal, () => pending);
						let returned = false;
						try {
							if (await untilAborted(evalSignal, () => target.evaluate(held => !!held, value))) {
								throwIfAborted(evalSignal);
								returned = true;
								return value;
							}
						} finally {
							if (!returned) {
								const cleanup = value.dispose();
								void cleanup.catch(() => {});
								await untilAborted(evalSignal, () => cleanup);
							}
						}
					} catch (error) {
						if (waitSignal.aborted) throw waitSignal.reason;
						if (evalSignal.aborted) throw timedOut();
						if (!isNavigatedContextError(error)) throw error;
						if (Date.now() >= deadline) throw timedOut();
						continue;
					}
					if (Date.now() >= deadline) throw timedOut();
				}
			},
		],
	]);
	const runPage: Page = new Proxy(page, {
		get(target, prop) {
			if (mainWorld.has(prop)) return mainWorld.get(prop);
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const result = Reflect.apply(value, target, args);
				return result === target ? runPage : result;
			};
		},
	});
	return runPage;
}

/**
 * Attach `fill()` to a puppeteer ElementHandle before handing it to user code and,
 * when a `guard` is supplied, route every interactive method ({@link GUARDED_HANDLE_METHODS})
 * through the same fail-fast per-op wrapper as the selector-based helpers — so
 * `(await tab.id(n)).click()` fails fast with `handle.click() timed out after …ms`
 * instead of stalling until the whole browser cell expires. Repeated enrichment is
 * idempotent: cached handles are always rewrapped from their original bound methods,
 * never from wrappers retaining an earlier run's guard. A timed-out action invalidates
 * and disposes its handle before surfacing the named error, so catching it cannot
 * dispatch a duplicate retry through the stale handle. Puppeteer handles expose
 * `type()` but no `fill()`; the `fill()` semantics mirror the selector-based
 * `tab.fill()`: focus, clear any existing value, then type, or set the value of a
 * colour, date, time or range input directly.
 */
export function toActionableHandle(
	handle: ElementHandle,
	guard?: HandleOpGuard,
	invalidate?: () => Promise<void>,
	uploads?: HandleUploads,
): ActionableHandle {
	const enriched = handle as HandleWithRawMethods;
	const methods = enriched as unknown as Partial<Record<GuardedHandleMethod, RawHandleMethod>>;
	const preserved = enriched[RAW_HANDLE_METHODS];
	if (!guard) {
		if (preserved) {
			for (const method of GUARDED_HANDLE_METHODS) {
				const original = preserved.interactive[method];
				if (original) methods[method] = original;
			}
		}
		enriched.fill = value => fillViaHandle(enriched, value);
		enriched.click = options =>
			clickElement(enriched, "handle.click()", undefined, {
				button: options?.button,
				clickCount: options?.count,
			});
		enriched.dblclick = () => clickElement(enriched, "handle.dblclick()", undefined, { clickCount: 2 });
		enriched.check = () => setElementChecked(enriched, true, "handle.check()");
		enriched.uncheck = () => setElementChecked(enriched, false, "handle.uncheck()");
		enriched.select = (...values) => selectElementOptions(enriched, values, "handle.select()");
		enriched.highlight = options => highlightElement(enriched, options);
		const controller = new AbortController();
		return enrichElementQueries(enriched, (_label, fn) => fn(controller.signal));
	}

	let originals = preserved;
	if (!originals) {
		const interactive: Partial<Record<GuardedHandleMethod, RawHandleMethod>> = {};
		for (const method of GUARDED_HANDLE_METHODS) {
			const original = methods[method];
			if (typeof original === "function") interactive[method] = original.bind(enriched);
		}
		// Puppeteer's `ElementHandle.press` takes a single key name; focus and press
		// through `pressKey` so combos and the macOS editing commands work on handles too.
		// The guard below passes its signal, so a cut-off press releases what it held.
		const focus = interactive.focus;
		if (focus) {
			const press = async (key: KeyInput, options?: KeyPressOptions, signal?: AbortSignal): Promise<void> => {
				await untilAborted(signal, () => focus());
				await pressKey(enriched.frame.page(), key, options, signal);
			};
			interactive.press = press as RawHandleMethod;
		}
		originals = { interactive };
		enriched[RAW_HANDLE_METHODS] = originals;
	}

	for (const method of GUARDED_HANDLE_METHODS) {
		if (method === "type") continue;
		const original = originals.interactive[method];
		if (!original) continue;
		methods[method] = (...args) =>
			guard(
				`handle.${method}()`,
				signal =>
					runGuardedHandleAction(
						enriched,
						originals,
						`handle.${method}()`,
						signal,
						() => (method === "press" ? original(args[0], args[1], signal) : original(...args)),
						invalidate,
					),
				method === "press" || method === "tap" ? "answers" : "blocks",
			);
	}
	enriched.type = (text, options) =>
		guard<void>("handle.type()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.type()",
				signal,
				() => typeIntoElement(enriched, text, signal, options),
				invalidate,
			),
		);
	enriched.fill = value =>
		guard<void>("handle.fill()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.fill()",
				signal,
				() => fillViaHandle(enriched, value, signal),
				invalidate,
			),
		);
	enriched.click = options =>
		guard<void>(
			"handle.click()",
			signal =>
				runGuardedHandleAction(
					enriched,
					originals,
					"handle.click()",
					signal,
					() =>
						clickElement(enriched, "handle.click()", signal, {
							button: options?.button,
							clickCount: options?.count,
						}),
					invalidate,
				),
			"answers",
		);
	enriched.dblclick = () =>
		guard<void>(
			"handle.dblclick()",
			signal =>
				runGuardedHandleAction(
					enriched,
					originals,
					"handle.dblclick()",
					signal,
					() => clickElement(enriched, "handle.dblclick()", signal, { clickCount: 2 }),
					invalidate,
				),
			"answers",
		);
	enriched.hover = () =>
		guard<void>("handle.hover()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.hover()",
				signal,
				() => hoverElement(enriched, signal),
				invalidate,
			),
		);
	enriched.check = () =>
		guard<void>("handle.check()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.check()",
				signal,
				() => setElementChecked(enriched, true, "handle.check()", signal),
				invalidate,
			),
		);
	enriched.uncheck = () =>
		guard<void>("handle.uncheck()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.uncheck()",
				signal,
				() => setElementChecked(enriched, false, "handle.uncheck()", signal),
				invalidate,
			),
		);
	enriched.select = (...values) =>
		guard<string[]>("handle.select()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.select()",
				signal,
				() => selectElementOptions(enriched, values, "handle.select()", signal),
				invalidate,
			),
		);
	enriched.highlight = (options?: HighlightOptions) =>
		guard<void>("handle.highlight()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.highlight()",
				signal,
				() => highlightElement(enriched, options, signal),
				invalidate,
			),
		);
	const clearFiles = methods.uploadFile;
	if (uploads) {
		enriched.uploadFile = async (...filePaths: string[]) => {
			// With no paths Puppeteer's own method clears the input; there is nothing to route.
			if (!filePaths.length && clearFiles) {
				await clearFiles();
				return;
			}
			await uploadThroughHandle(enriched, originals, filePaths, guard, uploads, invalidate);
		};
	}
	return enrichElementQueries(enriched, guard);
}

/**
 * Strip `user:pass@` from a URL before surfacing it in tool outputs / details
 * so Basic Auth credentials don't leak into transcripts. Returns the original
 * string verbatim when it doesn't parse as a URL or when there are no
 * credentials to redact.
 */
function redactUrlCredentials(url: string): string {
	if (!url || (!url.includes("@") && !url.includes("//"))) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

class RequestInterceptionCleanupError extends ToolError {}

/** `tab.goto` outlasted its budget; the page stays on what loaded. */
class NavigationTimeoutError extends ToolError {}

/** The page's renderer crashed; every later call on the page stalls until its timeout. */
class RendererCrashedError extends ToolError {}

/** Chrome ended the debugger attachment the page is driven through (omp browser relay); the page itself lives on. */
class DebuggerDetachedError extends ToolError {
	constructor(
		readonly reason: string,
		/** `during`: the run's code had started, so its input may already have landed. */
		readonly when: "during" | "before",
	) {
		super(
			`Chrome detached omp from this tab (${reason}) ${when === "during" ? "during this call" : "before this call, so its code did not run"}`,
		);
	}
}

interface RunPageScope {
	page: Page;
	/** Restore the page's own listener methods and remove every handler this run registered. */
	detach(): void;
	/** Return request interception to the tab's persistent route/allowlist state. */
	restoreInterception(): Promise<void>;
}

/**
 * Expose the tab page while retaining every event handler created by this run.
 * The facade removes only run-owned listeners, preserving worker-level routing,
 * request logging, dialogs, and console capture. Raw interception is restored
 * to the tab's persistent route/allowlist state after a run that changed it.
 *
 * A listener added to the page while the run is attached is run-owned, whichever
 * reference reached the page, except one added while the page is delivering an
 * event to a handler the run did not add. Puppeteer's in-flight request tracking
 * subscribes to request completion from inside its own `request` handler; removing
 * those subscriptions with the run left `waitForNetworkIdle` waiting on a request
 * an earlier run started.
 */
function createRunPageScope(page: Page, restoreInterception: () => Promise<void>): RunPageScope {
	const handlers = new Map<unknown, Function[]>();
	/**
	 * The listener the page holds for each run-owned handler. It runs the handler with
	 * `delivering` cleared, so what the handler registers stays run-owned. One per handler,
	 * so duplicate registrations and removals keep puppeteer's own ordering.
	 */
	const listeners = new Map<Function, (...args: unknown[]) => unknown>();
	const on = page.on;
	const off = page.off;
	const once = page.once;
	const emit = page.emit;
	const setRequestInterception = page.setRequestInterception;
	const onDescriptor = Object.getOwnPropertyDescriptor(page, "on");
	const offDescriptor = Object.getOwnPropertyDescriptor(page, "off");
	const onceDescriptor = Object.getOwnPropertyDescriptor(page, "once");
	const emitDescriptor = Object.getOwnPropertyDescriptor(page, "emit");
	const removeAllDescriptor = Object.getOwnPropertyDescriptor(page, "removeAllListeners");
	const interceptionDescriptor = Object.getOwnPropertyDescriptor(page, "setRequestInterception");
	let interceptionChanged = false;
	/** Set while the page delivers an event; a listener the run added clears it while it runs. */
	let delivering = false;
	const withDelivering = <T>(value: boolean, fn: () => T): T => {
		const outer = delivering;
		delivering = value;
		try {
			return fn();
		} finally {
			delivering = outer;
		}
	};
	const listenerFor = (handler: Function): ((...args: unknown[]) => unknown) => {
		let listener = listeners.get(handler);
		if (!listener) {
			listener = (...args: unknown[]): unknown =>
				withDelivering(false, () => Reflect.apply(handler, undefined, args));
			listeners.set(handler, listener);
		}
		return listener;
	};
	const remember = (type: unknown, handler: Function): void => {
		const owned = handlers.get(type);
		if (owned) owned.push(handler);
		else handlers.set(type, [handler]);
		Reflect.apply(on, page, [type, listenerFor(handler)]);
	};
	/** Remove run-owned registrations; reports whether any matched. */
	const forget = (type: unknown, handler?: unknown): boolean => {
		const owned = handlers.get(type);
		if (!owned) return false;
		if (handler === undefined) {
			for (const registered of owned) Reflect.apply(off, page, [type, listenerFor(registered)]);
			handlers.delete(type);
			return true;
		}
		const index = owned.findLastIndex(registered => registered === handler);
		if (index < 0) return false;
		Reflect.apply(off, page, [type, listenerFor(owned[index])]);
		owned.splice(index, 1);
		if (owned.length === 0) handlers.delete(type);
		return true;
	};

	Object.defineProperties(page, {
		on: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				if (delivering || typeof handler !== "function") Reflect.apply(on, page, [type, handler]);
				else remember(type, handler);
				return page;
			},
		},
		once: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				if (delivering || typeof handler !== "function") {
					Reflect.apply(once, page, [type, handler]);
					return page;
				}
				const wrapper = (event: unknown): void => {
					forget(type, wrapper);
					Reflect.apply(handler, page, [event]);
				};
				remember(type, wrapper);
				return page;
			},
		},
		off: {
			configurable: true,
			value: (type: unknown, handler?: unknown): Page => {
				// Puppeteer's own subscriptions unsubscribe through here too.
				if (!forget(type, handler) && handler !== undefined) Reflect.apply(off, page, [type, handler]);
				return page;
			},
		},
		emit: {
			configurable: true,
			value: (type: unknown, event?: unknown): boolean => {
				// Puppeteer defers every `request` listener to an interception action that runs after
				// `emit` returns, so each action queued during `emit` keeps the delivery it came from.
				const request = type === "request" && typeof event === "object" ? (event as HTTPRequest | null) : null;
				const enqueue = request?.enqueueInterceptAction;
				if (!request || typeof enqueue !== "function") {
					return withDelivering(true, () => Reflect.apply(emit, page, [type, event]));
				}
				const enqueueDescriptor = Object.getOwnPropertyDescriptor(request, "enqueueInterceptAction");
				Object.defineProperty(request, "enqueueInterceptAction", {
					configurable: true,
					value: (action: () => unknown): void => {
						const queued = delivering;
						Reflect.apply(enqueue, request, [() => withDelivering(queued, action)]);
					},
				});
				try {
					return withDelivering(true, () => Reflect.apply(emit, page, [type, event]));
				} finally {
					// The tab's request log keeps requests well after the run; do not let them hold this scope.
					if (enqueueDescriptor) Object.defineProperty(request, "enqueueInterceptAction", enqueueDescriptor);
					else Reflect.deleteProperty(request, "enqueueInterceptAction");
				}
			},
		},
		removeAllListeners: {
			configurable: true,
			value: (type?: unknown): Page => {
				if (type !== undefined) forget(type);
				else {
					// Map iteration tolerates deletion of the current key by forget().
					for (const ownedType of handlers.keys()) forget(ownedType);
				}
				return page;
			},
		},
		setRequestInterception: {
			configurable: true,
			value: (value: boolean): Promise<void> => {
				interceptionChanged = true;
				return Reflect.apply(setRequestInterception, page, [value]);
			},
		},
	});

	return {
		page,
		detach() {
			if (onDescriptor) Object.defineProperty(page, "on", onDescriptor);
			else Reflect.deleteProperty(page, "on");
			if (offDescriptor) Object.defineProperty(page, "off", offDescriptor);
			else Reflect.deleteProperty(page, "off");
			if (onceDescriptor) Object.defineProperty(page, "once", onceDescriptor);
			else Reflect.deleteProperty(page, "once");
			if (emitDescriptor) Object.defineProperty(page, "emit", emitDescriptor);
			else Reflect.deleteProperty(page, "emit");
			if (removeAllDescriptor) Object.defineProperty(page, "removeAllListeners", removeAllDescriptor);
			else Reflect.deleteProperty(page, "removeAllListeners");
			if (interceptionDescriptor) Object.defineProperty(page, "setRequestInterception", interceptionDescriptor);
			else Reflect.deleteProperty(page, "setRequestInterception");
			for (const [type, owned] of handlers) {
				for (const handler of owned) Reflect.apply(off, page, [type, listenerFor(handler)]);
			}
			handlers.clear();
		},
		async restoreInterception() {
			if (!interceptionChanged) return;
			try {
				await withTimeout(
					restoreInterception(),
					REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
					"Timed out restoring browser request interception",
				);
			} catch (error) {
				throw new RequestInterceptionCleanupError(
					"Failed to restore browser request interception after browser.run",
					{
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		},
	};
}

function errorPayload(error: unknown): RunErrorPayload {
	const recoverTab = error instanceof RequestInterceptionCleanupError || undefined;
	const navigationTimeout = error instanceof NavigationTimeoutError || undefined;
	const rendererCrashed = error instanceof RendererCrashedError || undefined;
	const debuggerDetached =
		error instanceof DebuggerDetachedError ? { when: error.when, reason: error.reason } : undefined;
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isToolError: true,
			isAbort: false,
			recoverTab,
			navigationTimeout,
			rendererCrashed,
			debuggerDetached,
		};
	}
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isToolError: false,
			isAbort: false,
			missingPageGlobal: isMissingPageGlobal(error) || undefined,
		};
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const Ctor = payload.isToolError ? ToolError : Error;
	const err = new Ctor(payload.message);
	if (payload.name) err.name = payload.name;
	if (payload.stack) err.stack = payload.stack;
	return err;
}

async function targetIdForTarget(target: Target): Promise<string> {
	const fastTargetId = privateTargetId(target);
	if (fastTargetId) return fastTargetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

async function createTrackedPage(
	browser: Browser,
	attach: { nearTargetId?: string } | undefined,
	reportTarget: (targetId: string) => void,
): Promise<Page> {
	let targetId: string;
	if (attach) {
		// Attached browsers may have no page or browser target yet. Create through
		// the root CDP connection; the relay also uses nearTargetId to choose Chrome.
		const params: Protocol.Target.CreateTargetRequest & { nearTargetId?: string } = {
			url: "about:blank",
			background: true,
			nearTargetId: attach.nearTargetId,
		};
		({ targetId } = await browserConnection(browser).send("Target.createTarget", params));
		reportTarget(targetId);
	} else {
		const session = await browser.target().createCDPSession();
		try {
			({ targetId } = await session.send("Target.createTarget", { url: "about:blank" }));
			reportTarget(targetId);
		} finally {
			await session.detach().catch(() => undefined);
		}
	}
	const existing = browser.targets().find(target => privateTargetId(target) === targetId);
	const target =
		existing ??
		(await browser.waitForTarget(candidate => privateTargetId(candidate) === targetId, {
			timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		}));
	const page = await target.page();
	if (!page) throw new ToolError(`Created target ${targetId} did not expose a page`);
	return page;
}

/**
 * Frames that missed an observation deadline, mapped to the document they showed then. Observe skips
 * them until they navigate, so a frame stuck in script costs only the first observation its wait.
 */
const unresponsiveFrames = new WeakMap<Frame, string>();

function frameDocumentKey(frame: Frame): string {
	return `${frame._loaderId} ${frame.url()}`;
}

/** One frame's accessibility tree; ids observed in it resolve in that frame. */
interface FrameSnapshot {
	frame: Frame;
	snapshot: SerializedAXNode;
}

/**
 * Accessibility snapshots of `frames` and their descendants, each with its frame, in frame-tree
 * order. A frame that does not answer by `deadline` is left out with its descendants, and skipped
 * by later observations until it navigates, so one dead iframe never costs the page its
 * observation. With `root`, only frames inside it are read.
 */
async function snapshotFrames(
	frames: Frame[],
	options: { interestingOnly: boolean; root: ElementHandle | null; deadline: number; signal?: AbortSignal },
): Promise<FrameSnapshot[]> {
	const snapshots = await Promise.all(
		frames.map(async (frame): Promise<FrameSnapshot[]> => {
			if (unresponsiveFrames.get(frame) === frameDocumentKey(frame)) return [];
			const timeout = new Error(`Frame ${frame.url()} did not answer`);
			let snapshot: SerializedAXNode | null;
			try {
				snapshot = await withTimeout(
					snapshotFrame(frame, options),
					Math.max(0, options.deadline - Date.now()),
					timeout,
					options.signal,
				);
			} catch (error) {
				if (options.signal?.aborted) throw error;
				if (error === timeout) unresponsiveFrames.set(frame, frameDocumentKey(frame));
				return [];
			}
			if (!snapshot) return [];
			return [{ frame, snapshot }, ...(await snapshotFrames(frame.childFrames(), { ...options, root: null }))];
		}),
	);
	return snapshots.flat();
}

async function snapshotFrame(
	frame: Frame,
	options: { interestingOnly: boolean; root: ElementHandle | null },
): Promise<SerializedAXNode | null> {
	if (options.root) {
		const owner = await frame.frameElement();
		if (!owner) return null;
		const scoped = await options.root.realm.adoptHandle(owner).finally(() => owner.dispose().catch(() => undefined));
		try {
			// The owner may sit in a web component's shadow root under `root`, where `Node.contains` stops.
			if (!(await options.root.evaluate(composedContains, scoped))) return null;
		} finally {
			await scoped.dispose().catch(() => undefined);
		}
	}
	return await frame.accessibility.snapshot({ interestingOnly: options.interestingOnly });
}

function collectInteractiveObservationAncestors(node: SerializedAXNode, ancestors: Set<SerializedAXNode>): boolean {
	let found = false;
	for (const child of node.children ?? []) {
		const descendantInteractive = collectInteractiveObservationAncestors(child, ancestors);
		if (isInteractiveNode(child) || descendantInteractive) found = true;
	}
	if (found) ancestors.add(node);
	return found;
}

/** Where an observed element lives; `tab.id(n)` resolves it to a handle on first use. */
interface ObservedElement {
	frame: Frame;
	backendNodeId: number;
	/**
	 * Loader of the document `frame` showed when observed. Backend node ids are unique only within
	 * one renderer process, so once the frame shows another document the id may name an unrelated node.
	 */
	loaderId: string;
}

/** Whether the frame has loaded another document since `element` was observed. */
function isObservedDocumentGone(element: ObservedElement): boolean {
	return element.frame._loaderId !== element.loaderId;
}

/**
 * Resolve an observed element to a handle in its frame's main world, or null when the node is
 * gone, has left the document, or the frame no longer shows the document it was observed in (any
 * resolution failure counts as gone). Text nodes resolve to their parent.
 */
async function resolveObservedElement(observed: ObservedElement): Promise<ElementHandle | null> {
	if (isObservedDocumentGone(observed)) return null;
	let node: JSHandle;
	try {
		node = await observed.frame.mainRealm().adoptBackendNode(observed.backendNodeId);
	} catch {
		return null;
	}
	try {
		const resolved = await node.evaluateHandle(value => {
			const candidate = value as unknown as { nodeType: number; parentElement: Element | null };
			const element = (candidate.nodeType === 3 ? candidate.parentElement : value) as unknown as Element | null;
			if (!element?.isConnected) return null;
			// The document itself (the root `includeAll` lists) has no owner document.
			const owner: unknown = candidate.nodeType === 9 ? value : element.ownerDocument;
			return owner === document ? element : null;
		});
		const element = resolved.asElement();
		// The frame may have committed another document while the node resolved.
		if (element && !isObservedDocumentGone(observed)) return element as ElementHandle;
		await resolved.dispose().catch(() => undefined);
		return null;
	} catch {
		return null;
	} finally {
		await node.dispose().catch(() => undefined);
	}
}

async function collectObservationEntries(
	core: WorkerCore,
	frame: Frame,
	node: SerializedAXNode,
	entries: ObservationEntry[],
	options: {
		viewportOnly: boolean;
		includeAll: boolean;
		compact: boolean;
		interactiveAncestors: Set<SerializedAXNode>;
	},
): Promise<void> {
	const emptyStructural =
		(node.role === "generic" || node.role === "none" || node.role === "group") &&
		!node.name &&
		!options.interactiveAncestors.has(node);
	if (
		node.backendNodeId !== undefined &&
		(options.includeAll || isInteractiveNode(node)) &&
		!(options.compact && emptyStructural)
	) {
		const observed: ObservedElement = { frame, backendNodeId: node.backendNodeId, loaderId: node.loaderId };
		let handle: ElementHandle | null = null;
		let inViewport = true;
		if (options.viewportOnly) {
			handle = await resolveObservedElement(observed);
			inViewport = (await handle?.isIntersectingViewport().catch(() => false)) ?? false;
		}
		if (inViewport) {
			const id = core.observeElement(observed, handle ?? undefined);
			const states: string[] = [];
			if (node.disabled) states.push("disabled");
			if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
			if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
			if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
			if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
			if (node.required) states.push("required");
			if (node.readonly) states.push("readonly");
			if (node.multiselectable) states.push("multiselectable");
			if (node.multiline) states.push("multiline");
			if (node.modal) states.push("modal");
			if (node.focused) states.push("focused");
			entries.push({
				id,
				role: node.role,
				name: node.name,
				value: node.value,
				description: node.description,
				keyshortcuts: node.keyshortcuts,
				states,
			});
		} else {
			await handle?.dispose().catch(() => undefined);
		}
	}
	for (const child of node.children ?? []) {
		await collectObservationEntries(core, frame, child, entries, options);
	}
}

/**
 * Hint appended to a selector op's fail-fast timeout, given the selector's current
 * match count: a missing element (consent wall, wrong page) reads differently from
 * a present-but-unactionable one.
 */
export function formatSelectorMatchHint(count: number): string {
	return count === 0
		? "; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page"
		: `; selector currently matches ${count} element(s) but the action never became possible — the element may be hidden or covered (try tab.scrollIntoView() or a more specific selector)`;
}

export interface InflightOp {
	label: string;
	startedAt: number;
}

interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	output: RunOutput;
	screenshots: ScreenshotResult[];
	pendingTools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
	rejectionOwner: object;
	floatingRejections: unknown[];
	floatingFailure: { promise: Promise<never>; reject(reason?: unknown): void };
	/** Helper invocations currently awaiting the page/network, keyed by op id. */
	inflight: Map<number, InflightOp>;
	opCounter: number;
	/** The run's code started, so input it sent may have reached the page. */
	codeStarted: boolean;
}

/** Human-readable label for a screenshot op, used in op tracking + timeout errors. */
export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}

/** Summarize still-running helpers (oldest first) so a cell timeout names what stalled. */
export function describeInflight(inflight: Map<number, InflightOp>): string {
	const now = Date.now();
	return [...inflight.values()]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(op => `${op.label} (${((now - op.startedAt) / 1000).toFixed(1)}s)`)
		.join(", ");
}

export class WorkerCore {
	#transport: Transport;
	#browser?: Browser;
	#page?: Page;
	#targetId?: string;
	/** Last viewport read from the page; reported while a dialog or failure blocks a fresh read. */
	#lastViewport?: ReadyInfo["viewport"];
	#elementCache = new Map<number, ElementHandle>();
	#observedElements = new Map<number, ObservedElement>();
	#elementCounter = 0;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#isolated: boolean;
	#uninstallRejectionGuard: () => void;
	#mode?: WorkerInitPayload["mode"];
	#ownsPage = false;
	/** The upload route this worker's browser connection takes, and the tab's staging folder. */
	#uploads?: UploadStaging;
	#dialogs?: RuntimeDialogController;
	#network?: BrowserNetworkManager;
	#initScripts?: InitScriptManager;
	#downloads?: DownloadManager;
	readonly #consoleCapture = new PageConsoleCapture();
	#tracing?: BrowserTracingController;
	#ariaSnapshotBaselines = new Map<string, AriaSnapshotBaseline>();
	#emulation?: BrowserEmulationController;
	#screenshotHistory = new Map<string, ScreenshotHistory>();
	#webmcp?: WebMcpController;
	/** Session holding `insecure`; Chromium drops the override once it detaches. */
	#certificateOverride?: CDPSession;
	readonly #recording = new RecordingController();
	/** Set once the core stops for good: by {@link terminate}, or by a close. */
	#stopped = false;
	/**
	 * The page asked to navigate its main frame (a link, a submit button, a script setting `location`) and the new
	 * document has neither committed nor been abandoned. Chromium reports the request before the click that caused it
	 * returns, while the network request and commit come later.
	 */
	#mainFrameNavigationRequested = false;
	/**
	 * A back/forward cache restore brings a document back without loading it, so the frame keeps the
	 * loader id of the document it replaced and the ids observed there would still pass as current.
	 */
	readonly #onFrameNavigated = (event: Protocol.Page.FrameNavigatedEvent): void => {
		if (event.type === "BackForwardCacheRestore") this.#clearElementCache();
		if (event.frame.parentId === undefined) this.#mainFrameNavigationRequested = false;
	};
	readonly #onFrameRequestedNavigation = (event: Protocol.Page.FrameRequestedNavigationEvent): void => {
		if (event.disposition === "currentTab" && this.#isMainFrame(event.frameId))
			this.#mainFrameNavigationRequested = true;
	};
	/** A same-document navigation, or a load that stopped without a new document (a download, a 204, a cancel). */
	readonly #onMainFrameNavigationSettled = (event: { frameId: string }): void => {
		if (this.#isMainFrame(event.frameId)) this.#mainFrameNavigationRequested = false;
	};
	/** A `beforeunload` prompt is open; dismissing it cancels the navigation that raised it. */
	#beforeUnloadOpen = false;
	readonly #onDialogOpening = (event: Protocol.Page.JavascriptDialogOpeningEvent): void => {
		this.#beforeUnloadOpen = event.type === "beforeunload";
	};
	readonly #onDialogClosed = (event: Protocol.Page.JavascriptDialogClosedEvent): void => {
		if (this.#beforeUnloadOpen && !event.result) this.#mainFrameNavigationRequested = false;
		this.#beforeUnloadOpen = false;
	};
	#isMainFrame(frameId: string): boolean {
		return this.#page !== undefined && devtoolsFrameId(this.#page.mainFrame()) === frameId;
	}

	/** The renderer crashed; the supervisor recycles this worker, so it runs nothing more. */
	#crashed = false;
	/** The user drives this browser (connected, relay); only there can Chrome detach omp under a run. */
	#userDriven = false;
	/** Buttons and keys `tab.mouseDown` / `tab.keyDown` pressed and nothing released yet; a run that is cut off releases them. */
	readonly #heldButtons = new Set<MouseButton>();
	readonly #heldKeys = new Set<KeyInput>();
	/** `ready` was sent; a crash before it fails the start instead. */
	#started = false;
	/** The run whose result is not sent yet; it outlives `#active` while the result is being put together. */
	#unanswered: ActiveRun | null = null;
	/**
	 * Puppeteer's page `error` event is Chromium's `Inspector.targetCrashed`: the renderer is gone and every
	 * later page call stalls. The unanswered run is answered now rather than after steps that wait on the
	 * dead page, and cancelled so its code does not go on after its caller was told it failed.
	 */
	readonly #onPageCrashed = (): void => {
		if (this.#crashed) return;
		this.#crashed = true;
		if (!this.#started) {
			const error = new RendererCrashedError("Browser tab's renderer crashed while the tab was starting");
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
			return;
		}
		const run = this.#unanswered;
		if (!run) return;
		this.#unanswered = null;
		run.ac.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser tab's renderer crashed")));
		const error = new RendererCrashedError("Browser tab's renderer crashed during this run");
		this.#transport.send({ type: "result", id: run.id, ok: false, error: errorPayload(error) });
	};

	/**
	 * The reason Chrome gave for ending the relay's debugger attachment on this tab (another extension's frame
	 * loaded in it, or the user cancelled the debugging bar); `undefined` while attached. Every later page call
	 * fails or stalls, so this worker runs nothing more and the supervisor re-adopts the tab on a new one.
	 */
	#debuggerDetached: string | undefined;
	/** The omp browser relay's `OMP.debuggerDetached` event, sent to the page's sessions ahead of their detach. */
	readonly #onDebuggerDetached = (params: unknown): void => {
		if (this.#debuggerDetached !== undefined) return;
		const reason = isRecord(params) && typeof params.reason === "string" ? params.reason : "no reason given";
		this.#debuggerDetached = reason;
		const run = this.#started ? this.#unanswered : null;
		if (!run) return;
		this.#unanswered = null;
		run.ac.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Chrome detached omp from this tab")));
		const error = new DebuggerDetachedError(reason, run.codeStarted ? "during" : "before");
		this.#transport.send({ type: "result", id: run.id, ok: false, error: errorPayload(error) });
	};

	constructor(transport: Transport, isolated: boolean) {
		this.#transport = transport;
		this.#isolated = isolated;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as WorkerInbound);
		});
		this.#uninstallRejectionGuard = this.#installRejectionGuard();
	}

	#installRejectionGuard(): () => void {
		if (!this.#isolated) {
			return postmortem.interceptUnhandledRejections(reason => this.#consumeUnhandledRejection(reason));
		}
		return installBrowserWorkerRejectionGuard(reason => this.#consumeUnhandledRejection(reason));
	}

	#consumeUnhandledRejection(reason: unknown): boolean {
		const active = this.#active;
		if (!active) return false;
		if (!isBrowserRunOwnedRejection(reason, active.rejectionOwner, `browser-run-${active.id}.js`)) return false;
		this.#recordFloatingRejection(active, reason);
		return true;
	}

	#recordFloatingRejection(active: ActiveRun, reason: unknown): void {
		if (postmortem.isExpectedCleanupError(reason)) return;
		if (this.#active !== active) {
			this.#log("warn", "Unhandled rejection after browser run ended", {
				runId: active.id,
				error: reason instanceof Error ? reason.message : String(reason),
			});
			return;
		}
		const isFirst = active.floatingRejections.length === 0;
		active.floatingRejections.push(reason);
		if (isFirst) active.floatingFailure.reject(this.#floatingRejectionError(reason));
	}

	#floatingRejectionError(reason: unknown): Error {
		const message = reason instanceof Error ? reason.message : String(reason);
		const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
		if (reason instanceof Error) error.name = reason.name;
		return error;
	}

	#foldFloatingRejections(active: ActiveRun, failure: { error: unknown } | undefined): { error: unknown } | undefined {
		const rejections = active.floatingRejections;
		if (rejections.length === 0) return failure;
		let reported = rejections;
		if (!failure) {
			failure = { error: this.#floatingRejectionError(rejections[0]) };
			reported = rejections.slice(1);
		} else if (failure.error instanceof Error && failure.error.cause === rejections[0]) {
			reported = rejections.slice(1);
		}
		for (const reason of reported) {
			this.#log("warn", "Additional unhandled browser-run rejection", {
				error: reason instanceof Error ? reason.message : String(reason),
			});
		}
		return failure;
	}

	/** Number an observed element; keeps `handle` when the observation already resolved it. */
	observeElement(element: ObservedElement, handle?: ElementHandle): number {
		this.#elementCounter += 1;
		this.#observedElements.set(this.#elementCounter, element);
		if (handle) this.#elementCache.set(this.#elementCounter, handle);
		return this.#elementCounter;
	}

	async #handleMessage(msg: WorkerInbound): Promise<void> {
		switch (msg.type) {
			case "init":
				await this.#init(msg.payload);
				return;
			case "run":
				await this.#run(msg);
				return;
			case "abort":
				if (this.#active?.id === msg.id) {
					const reason = msg.expectedCleanup
						? postmortem.markExpectedCleanupError(new ToolAbortError())
						: new ToolAbortError();
					this.#active.ac.abort(reason);
				}
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				await this.#close(msg.keepPage ?? false);
				return;
		}
	}

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			this.#ownsPage = ownsPage(payload);
			this.#uploads = new UploadStaging(payload.uploadDir);
			const puppeteer = await loadPuppeteerInWorker(payload.safeDir);
			registerSemanticQueryHandlers(puppeteer);
			this.#browser = await connectPuppeteer(puppeteer, {
				browserWSEndpoint: payload.browserWSEndpoint,
				defaultViewport: null,
				protocolTimeout: BROWSER_PAGE_PROTOCOL_TIMEOUT_MS,
			});
			// Terminated while it connected: nothing will drop this connection later.
			if (this.#stopped) {
				void this.#browser.disconnect();
				return;
			}

			// Realm setup is done: puppeteer loaded and browser connected. Sent before
			// page acquisition so the supervisor's cold-start budget bounds only the
			// realm setup; page creation runs under the ready wait.
			this.#transport.send({ type: "setup" });
			if (payload.mode === "headless" || payload.page.kind === "create") {
				// Create the target directly so its id is reportable before
				// Puppeteer waits for target/page initialization. If that wait
				// wedges, the supervisor can still close the created target.
				const attach =
					payload.mode === "attach" && payload.page.kind === "create"
						? { nearTargetId: payload.page.nearTargetId }
						: undefined;
				try {
					this.#page = await createTrackedPage(this.#browser, attach, targetId => {
						this.#transport.send({ type: "page-created", targetId });
					});
				} catch (error) {
					if (!attach) throw error;
					throw new ToolError(
						`Could not create a managed tab in the attached browser profile: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				this.#observeDialogs();
				if (payload.mode === "headless") {
					await applyStealthPatches(this.#browser, this.#page, { browserSession: null, override: null });
					if (payload.emulateViewport !== false) await applyViewport(this.#page, payload.viewport);
				}
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			} else {
				const target = await this.#findAttachedTarget(payload.page.targetId);
				// Post-timeout recycle: unblock the target BEFORE adopting the page — an open
				// modal dialog or hung navigation can stall `target.page()` / ready info, and a
				// stalled init used to time out and force-kill the tab.
				if (payload.recover) await this.#recoverAttachedTarget(target);
				const page = await target.page();
				if (!page)
					throw new ToolError(`Target ${payload.page.targetId} is no longer available on the attached browser`);
				this.#page = page;
				await this.#claimRelayTarget(page);
				this.#observeDialogs();
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			const client = this.#page.mainFrame().client;
			client.on("Page.frameNavigated", this.#onFrameNavigated);
			client.on("Page.frameRequestedNavigation", this.#onFrameRequestedNavigation);
			client.on("Page.navigatedWithinDocument", this.#onMainFrameNavigationSettled);
			client.on("Page.frameStoppedLoading", this.#onMainFrameNavigationSettled);
			client.on("Page.javascriptDialogOpening", this.#onDialogOpening);
			client.on("Page.javascriptDialogClosed", this.#onDialogClosed);
			client.on("OMP.debuggerDetached", this.#onDebuggerDetached);
			this.#page.on("error", this.#onPageCrashed);
			if (this.#ownsPage || (payload.mode === "attach" && payload.userDriven)) {
				// Background Chromium tabs stop producing frames, stalling rAF,
				// IntersectionObserver, and input acknowledgements; in a visible browser a tab
				// that was never selected drops trusted input outright. Keep the page
				// interactive without selecting its tab or raising a window, including a user's
				// page in a background tab; explicit settle-freeze still applies. It ends with
				// this connection's session (on the relay, with the bridge's last session).
				await this.#page.emulateFocusedPage(true);
			}
			this.#webmcp = new WebMcpController(this.#page);
			await installVitalsObservers(this.#page);
			await installCancelledReleaseGuard(this.#page);
			if (payload.userAgent !== undefined) await applyUserAgentOverride(this.#page, payload.userAgent);
			if (payload.insecure) this.#certificateOverride = await applyInsecure(this.#page);
			this.#targetId = await targetIdForPage(this.#page);
			this.#initScripts = new InitScriptManager(this.#page);
			for (const source of payload.initScripts ?? []) await this.#initScripts.add(source);
			this.#userDriven = payload.mode !== "headless" && payload.userDriven === true;
			this.#downloads = new DownloadManager(this.#browser, this.#page, this.#targetId, {
				perTab: !this.#userDriven,
				pageEvents: payload.mode === "attach" && payload.relay === true,
			});
			await this.#downloads.start(payload.downloadsPath);
			const baseUserAgent = await this.#page.evaluate(() => navigator.userAgent);
			this.#emulation = new BrowserEmulationController(
				this.#page,
				loadedKnownDevices(),
				loadedNetworkConditions(),
				baseUserAgent,
			);
			await this.#consoleCapture.install(this.#page);
			this.#tracing = new BrowserTracingController(this.#page);
			this.#network = new BrowserNetworkManager(this.#page, payload.allowedDomains);
			await this.#network.start();
			// A window omp does not size (visible, attached, relay) takes a viewport only when the open asks for one,
			// after the steps that can fail, so a failed open leaves a borrowed tab at its own size. Without `scale` it
			// keeps the window's own device scale (0).
			if (payload.viewport && (payload.mode === "attach" || payload.emulateViewport === false)) {
				await this.#page.setViewport({
					...payload.viewport,
					deviceScaleFactor: payload.viewport.deviceScaleFactor ?? 0,
				});
			}
			const info = await this.#currentReadyInfo();
			this.#started = true;
			this.#transport.send({ type: "ready", info });
		} catch (error) {
			// A page this attempt created would be orphaned (the supervisor retries
			// with a fresh worker), so close it before reporting. An adopted target —
			// a borrowed page, or an owned one a recycle retries — is never closed here.
			const page = this.#page;
			await this.#webmcp?.dispose().catch(() => undefined);
			this.#webmcp = undefined;
			if (payload.mode === "headless" && page && !page.isClosed()) {
				await page.close().catch(() => undefined);
			}
			// Attached browsers also own tabs created by omp, including spawned Chrome.
			if (payload.mode === "attach" && payload.page.kind === "create" && page && !page.isClosed()) {
				await page.close().catch(() => undefined);
			}
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedTarget(targetId: string): Promise<Target> {
		if (!this.#browser) throw new ToolError("Browser is not connected");
		for (const target of this.#browser.targets()) {
			if ((await targetIdForTarget(target).catch(() => "")) !== targetId) continue;
			return target;
		}
		// The omp relay withholds a tab Chrome refused to attach, and says why beside `Target.getTargetInfo`. A refusal over
		// another extension's frame fails at once, so the supervisor can keep the tab for a later call.
		const targetInfo = await this.#browserHasTarget(this.#browser, targetId);
		const refusal = isRecord(targetInfo) && typeof targetInfo.refusal === "string" ? targetInfo.refusal : undefined;
		if (refusal && FOREIGN_FRAME_REFUSAL.test(refusal)) {
			throw new ToolError(`Chrome refused to attach to target ${targetId}: ${refusal}`);
		}
		// Puppeteer lists a page only once its URL is non-empty, and a crashed page revived by this attach reloads
		// with an empty URL for a moment. Wait for it while Chromium still has the target; fail at once when not.
		if (targetInfo) {
			const target = await this.#browser
				.waitForTarget(async candidate => (await targetIdForTarget(candidate).catch(() => "")) === targetId, {
					timeout: ATTACHED_TARGET_EXPOSE_TIMEOUT_MS,
				})
				.catch(() => undefined);
			if (target) return target;
		}
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

	async #browserHasTarget(browser: Browser, targetId: string): Promise<unknown> {
		try {
			return await browserConnection(browser).send("Target.getTargetInfo", { targetId });
		} catch {
			return undefined;
		}
	}

	/**
	 * Tell the omp browser relay this worker drives the adopted page, so the relay adds it to the per-window "omp"
	 * tab group. The supervisor's connect URL claims it already (`?claim=`); an older relay still serving this
	 * machine ignores that and learns of the claim only here. Best-effort: plain CDP backends (real Chrome, cmux)
	 * reject the relay-private method.
	 */
	async #claimRelayTarget(page: Page): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await page.createCDPSession();
			// Puppeteer's protocol map cannot express the relay-private method; the
			// send signature is otherwise identical.
			const raw = session as unknown as { send(method: string): Promise<unknown> };
			await raw.send("OMP.claimTarget");
		} catch {
			// Not the omp relay; nothing to claim.
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	/**
	 * Best-effort unblocking of a wedged target during post-timeout recovery: dismiss any
	 * open JS dialog and stop a pending navigation over a raw CDP session (created on the
	 * target, not the page, so it works while the page itself is unresponsive). Every step
	 * tolerates "nothing to do".
	 */
	async #recoverAttachedTarget(target: Target): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await target.createCDPSession();
			// A crashed page answers none of the steps below. `Inspector.enable` reports a renderer
			// still dead (a relay attach leaves it so), the listener one that dies again as it reloads.
			session.on("Inspector.targetCrashed", this.#onPageCrashed);
			await session.send("Inspector.enable").catch(() => undefined);
			await session.send("Page.enable").catch(() => undefined);
			await session.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
			await session.send("Page.stopLoading").catch(() => undefined);
			await session.send("Fetch.disable").catch(() => undefined);
		} catch (error) {
			this.#log("debug", "Recovery CDP session failed; proceeding with attach", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	/** Install runtime dialog observation and default handling. */
	#observeDialogs(): void {
		const page = this.#requirePage();
		this.#dialogs?.dispose();
		this.#dialogs = new RuntimeDialogController(page, (message, details) => this.#log("debug", message, details));
		this.#dialogs.observe();
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(page));
		this.#targetId = targetId;
		const dialogPending = this.#dialogs?.state().open ?? false;
		return {
			url: redactUrlCredentials(page.url()),
			title: dialogPending ? undefined : await page.title().catch(() => undefined),
			viewport: dialogPending
				? (page.viewport() ?? this.#lastViewport ?? DEFAULT_VIEWPORT)
				: await this.#viewport().catch(() => this.#lastViewport ?? DEFAULT_VIEWPORT),
			targetId,
		};
	}

	async #viewport(signal?: AbortSignal): Promise<ReadyInfo["viewport"]> {
		this.#lastViewport = await readPageViewport(this.#requirePage(), signal);
		return this.#lastViewport;
	}

	/** Apply an automatic dialog policy selected while opening the tab. */
	#applyDialogPolicy(policy: DialogPolicy): void {
		void this.#requireDialogs()
			.setPolicy(policy)
			.catch(error =>
				this.#log("debug", "Dialog auto-handler failed", {
					policy,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	}

	async #postReadyInfo(): Promise<void> {
		try {
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#log("debug", "Failed to refresh tab info", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #run(msg: Extract<WorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#crashed) {
			const error = new RendererCrashedError(
				"Browser tab's renderer had crashed before this run, so its code did not run",
			);
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(error) });
			return;
		}
		if (this.#debuggerDetached !== undefined) {
			const error = new DebuggerDetachedError(this.#debuggerDetached, "before");
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(error) });
			return;
		}
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(new ToolError("Tab worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(msg.timeoutMs);
		const ac = new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const output = new RunOutput();
		const screenshots: ScreenshotResult[] = [];
		const runErrorStartSeq = this.#consoleCapture.nextSequence;
		const floatingFailure = Promise.withResolvers<never>();
		const active: ActiveRun = {
			id: msg.id,
			ac,
			signal,
			output,
			screenshots,
			pendingTools: new Map(),
			rejectionOwner: {},
			floatingRejections: [],
			floatingFailure,
			inflight: new Map(),
			opCounter: 0,
			codeStarted: false,
		};
		this.#active = active;
		this.#unanswered = active;
		let completed = false;
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let recoverTab = false;
		let runPage: RunPageScope | undefined;
		try {
			throwIfAborted(signal);
			await untilAborted(signal, () => this.#emulation?.reapply() ?? Promise.resolve());
			runPage = createRunPageScope(this.#requirePage(), () => this.#requireNetwork().restoreInterception());
			const browser = this.#requireBrowser();
			const tabApi = this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, output, screenshots, active);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			const onFloatingRejection = (reason: unknown): void => this.#recordFloatingRejection(active, reason);
			runtime.setRunScope({
				page: bindRunFacade(
					createRunPage(runPage.page, signal),
					signal,
					active.rejectionOwner,
					onFloatingRejection,
				),
				browser: bindRunFacade(browser, signal, active.rejectionOwner, onFloatingRejection),
				tab: bindRunFacade(tabApi, signal, active.rejectionOwner, onFloatingRejection),
				assert: (cond: unknown, text?: string): void => {
					if (!cond) throw new ToolError(text ?? "Assertion failed");
				},
				// Both wait forms register in the in-flight map so a cell that dies while
				// sleeping/polling names the culprit instead of a bare whole-cell timeout.
				wait: (msOrPredicate: number | (() => unknown), opts?: WaitPredicateOptions): Promise<unknown> => {
					const label = typeof msOrPredicate === "number" ? `wait(${msOrPredicate}ms)` : "wait(predicate)";
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: { timeout: resolvePredicateTimeout(msg.timeoutMs, opts?.timeout), interval: opts?.interval };
					return observeBrowserRunPromise(
						this.#runOp(active, label, signal, Number.POSITIVE_INFINITY, sig =>
							waitForRun(msOrPredicate, sig, resolved),
						),
						active.rejectionOwner,
						onFloatingRejection,
					);
				},
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				if (timeoutSignal.aborted) {
					const stalled = describeInflight(active.inflight);
					const dialog = this.#dialogs?.state();
					const dialogNote = dialog?.open
						? `; a ${dialog.type}(${JSON.stringify(dialog.message?.slice(0, 80) ?? "")}) dialog opened during this run and may still block the page — use tab.handleDialog() or tab.setDialogs("accept"|"dismiss")`
						: "";
					const pageErrorCount = this.#consoleCapture.errorCountSince(runErrorStartSeq);
					const pageErrorNote =
						pageErrorCount > 0 ? `; ${pageErrorCount} page error(s) since run start — see tab.errors()` : "";
					rejectCancel(
						new ToolError(
							`Browser code execution timed out after ${msg.timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}${pageErrorNote}`,
						),
					);
				} else {
					rejectCancel(abortError);
				}
				// Cancel in-flight tool calls so user code's awaited proxies reject promptly.
				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) {
					pending.reject(toolAbort);
				}
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				const hooks = this.#hooksForActiveRun();
				if (!hooks) throw new ToolError("Browser runtime started without an active run");
				returnValue = await withBrowserPromiseCombinatorTracking(
					active.rejectionOwner,
					onFloatingRejection,
					async () =>
						await Promise.race([
							runtime.run(msg.code, `browser-run-${msg.id}.js`, hooks, {
								runId: msg.id,
								cwd: msg.session.cwd,
							}),
							cancelRejection,
							floatingFailure.promise,
						]),
				);
				completed = true;
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended")));
			await Bun.sleep(0);
			// Detach first: the stop below fails the cancelled requests, and run handlers that see
			// those events would touch the aborted run's facade.
			runPage?.detach();
			// A cancelled or timed-out run leaves no button or key pressed for the user's next move.
			if (ac.signal.aborted || timeoutSignal.aborted) this.#releaseHeldInput();
			// A cancelled run abandons its main-frame navigation: left loading, it still replaces the
			// page later and holds up any interception restore below. Stopping is gated on
			// that navigation because Page.stopLoading also cancels every fetch and subresource
			// load in flight. A run that merely ended keeps an unawaited goto going.
			if (ac.signal.aborted && this.#network?.hasPendingMainFrameNavigation()) await this.#stopLoading();
			try {
				await runPage?.restoreInterception();
			} catch (error) {
				// A finished run keeps its result; the supervisor still recycles the tab.
				if (completed && active.floatingRejections.length === 0) {
					recoverTab = true;
					this.#log("warn", "Browser tab state could not be restored after a completed run", {
						error: error instanceof Error ? error.message : String(error),
					});
				} else {
					failure = { error };
				}
			}
			failure = this.#foldFloatingRejections(active, failure);
			if (this.#active?.id === msg.id) this.#active = null;
		}
		// A renderer crash or a debugger detach answers the run itself.
		if (this.#unanswered !== active) return;
		if (failure) {
			// Chrome ends a cross-site frame's session the moment it detaches omp from a relay tab, ahead of the
			// relay's `OMP.debuggerDetached`. Chrome reports that detach to the relay extension before it answers a
			// later command, so one more page command lets the report answer a run the closed frame session failed.
			if (this.#userDriven && isPuppeteerTargetClose(failure.error)) {
				const page = this.#page;
				if (page && !page.isClosed()) {
					await withTimeout(
						page.mainFrame().client.send("Target.getTargetInfo"),
						DETACH_REPORT_TIMEOUT_MS,
						"Timed out waiting for the relay's detach report",
					).catch(() => undefined);
				}
				if (this.#unanswered !== active) return;
			}
			this.#unanswered = null;
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(failure.error) });
			return;
		}
		if (completed) {
			await this.#postReadyInfo();
			if (this.#unanswered !== active) return;
			this.#unanswered = null;
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: true,
				payload: {
					displays: output.finish(),
					returnValue: cloneSafe(returnValue),
					screenshots,
					recoverTab: recoverTab || undefined,
				},
			});
		}
	}

	/**
	 * Release what `tab.mouseDown` / `tab.keyDown` still hold, buttons off the page (`releaseButtonOffPage`). Sent at
	 * once and not awaited: the page the run gave up on may not answer before this worker is replaced.
	 */
	#releaseHeldInput(): void {
		const page = this.#page;
		if (page) {
			for (const button of this.#heldButtons) releaseButtonOffPage(page, { button });
			for (const key of this.#heldKeys) void page.keyboard.up(key).catch(() => {});
		}
		this.#heldButtons.clear();
		this.#heldKeys.clear();
	}

	#ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({
			initialCwd: session.cwd,
			sessionId: `browser-tab-${this.#targetId ?? "unknown"}`,
		});
		return this.#runtime;
	}

	#hooksForActiveRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				active.output.pushText(chunk);
				this.#log("debug", chunk.replace(/\n$/, ""));
			},
			onDisplay: output => {
				throwIfAborted(active.signal);
				active.output.pushDisplay(output);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
			// Compiling the cell can wait (the first run loads Babel); a detach (or any abort) then still ran nothing,
			// and the cell must not run late either.
			onEvaluate: () => {
				throwIfAborted(active.signal);
				active.codeStarted = true;
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tab-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	/**
	 * Wrap a tab helper so it (a) registers in the active run's in-flight map for
	 * timeout diagnostics and (b) honors an optional per-op deadline that fails fast
	 * with a named error instead of silently consuming the whole cell budget. Pass
	 * `Number.POSITIVE_INFINITY` for `perOpTimeoutMs` to bound the op only by the cell
	 * budget (used for `evaluate` running user code and for locator helpers that already
	 * carry puppeteer's own `.setTimeout(timeoutMs)`). When the op targets a `selector`,
	 * the fail-fast timeout carries a best-effort match-count hint, and — when
	 * `zeroMatchAfterMs` is set — a watchdog aborts the op early once the selector has
	 * matched nothing for that long. With `awaitNavigation`, the op first waits for a
	 * main-frame navigation the page requested to replace the document, so it works on
	 * the page that navigation brings rather than the one it leaves.
	 */
	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
		opts?: OpOptions,
	): Promise<T> {
		const opId = active.opCounter++;
		active.inflight.set(opId, { label, startedAt: Date.now() });
		const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
		const opTimeout = capped ? AbortSignal.timeout(perOpTimeoutMs) : undefined;
		const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout]) : cellSignal;
		const selector = opts?.selector;
		const watchdog =
			selector !== undefined && opts?.zeroMatchAfterMs !== undefined && parseAriaRefSelector(selector) === null
				? { selector, afterMs: opts.zeroMatchAfterMs }
				: undefined;
		// Fired when the watchdog or a dialog wins the race (tears down the in-flight action) and in
		// the finally (stops the watchdog's polling once the op settles either way).
		const earlyAc = new AbortController();
		const dialogs = opts?.dialog ? this.#dialogs : undefined;
		try {
			const openDialog = dialogs?.state();
			if (openDialog?.open) throw dialogBlocksPageError(label, openDialog, "is open");
			// A download this op starts before a pending `waitForDownload()` has enabled
			// tracking would bypass it, so hold the op until tracking applies — within
			// the op's own deadline, so a stalled enable surfaces as this op's timeout.
			const arming = this.#downloads?.arming;
			if (arming)
				await untilAborted(
					opSignal,
					arming.catch(() => undefined),
				);
			if (opts?.awaitNavigation) await this.#awaitRequestedNavigation(opSignal, perOpTimeoutMs);
			if (!watchdog && !dialogs) return await fn(opSignal);
			const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
			const racers = [fn(racedSignal)];
			if (watchdog) racers.push(this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal));
			if (dialogs) {
				racers.push(
					// The finally tears the call down once this settles the race.
					dialogs.whenPending(racedSignal).then(state => {
						if (opts?.dialog === "blocks") throw dialogBlocksPageError(label, state, "opened");
						// An "answers" op is an input that resolves to nothing; the dialog is what it did.
						return undefined as T;
					}),
				);
			}
			return await Promise.race(racers);
		} catch (err) {
			// Fail fast with a named, attributable error instead of the opaque whole-cell timeout:
			// our per-op deadline fired, or puppeteer's own (equal) timeout fired first — having
			// already torn down the CDP action via the op signal, so no work is left dangling.
			// Cell-budget aborts and uncapped helpers (goto/evaluate) keep their native errors.
			if (capped && !cellSignal.aborted && (opTimeout?.aborted || isPuppeteerTimeout(err))) {
				const refusal = err instanceof ClickRefusedError ? err.refusal : undefined;
				// Typing that had started proves the element was actionable; the match count would only mislead.
				const interrupted = err instanceof TypingInterruptedError ? err : undefined;
				const probe = selector && !interrupted ? await this.#selectorMatchCount(selector) : undefined;
				const countNote =
					probe === undefined
						? undefined
						: "count" in probe
							? `selector matches ${probe.count} element(s)`
							: `could not count matches: ${probe.failure}`;
				let hint = "";
				if (interrupted) hint = `; ${interrupted.progress}`;
				else if (refusal)
					hint = `; the element never became clickable (last check: ${refusal}${countNote ? `; ${countNote}` : ""})`;
				else if (probe && "count" in probe) hint = formatSelectorMatchHint(probe.count);
				else if (countNote) hint = `; ${countNote}`;
				throw markBrowserRunRejection(
					new ToolError(`${label} timed out after ${perOpTimeoutMs}ms${hint}`),
					active.rejectionOwner,
				);
			}
			throw markBrowserRunRejection(err, active.rejectionOwner);
		} finally {
			earlyAc.abort();
			active.inflight.delete(opId);
		}
	}

	/**
	 * Fail-fast arm raced against a selector op: rejects once the selector has matched
	 * nothing for the whole `afterMs` window, so a wrong selector or wrong page (consent
	 * wall, pre-navigation document) costs ~2s instead of the full action deadline.
	 * Disarms — hangs until the settled race drops it — the moment at least one element
	 * matches; an inconclusive probe (mid-navigation, detached frame) never counts
	 * toward the zero-match window.
	 */
	async #zeroMatchWatchdog(selector: string, label: string, afterMs: number, signal: AbortSignal): Promise<never> {
		const page = this.#requirePage();
		const resolved = normalizeSelector(selector);
		const deadline = Date.now() + afterMs;
		while (!signal.aborted) {
			let count: number | null = null;
			try {
				const handles = await page.$$(resolved);
				count = handles.length;
				for (const handle of handles) void handle.dispose().catch(() => undefined);
			} catch {
				// Inconclusive probe — keep polling without advancing toward failure.
			}
			if (count !== null && count > 0) break;
			if (count === 0 && Date.now() >= deadline) {
				throw new ToolError(`${label} failed fast after ${afterMs}ms${formatSelectorMatchHint(0)}`);
			}
			try {
				await untilAborted(signal, () => Bun.sleep(ZERO_MATCH_POLL_MS));
			} catch {
				break;
			}
		}
		return await new Promise<never>(() => {});
	}

	/**
	 * Best-effort match count for a timed-out selector op. Never throws: a probe
	 * that fails or stalls reports why, since that same probe failing is what keeps
	 * the zero-match watchdog from failing fast. Undefined for an aria-ref.
	 */
	async #selectorMatchCount(selector: string): Promise<{ count: number } | { failure: string } | undefined> {
		if (parseAriaRefSelector(selector) !== null) return undefined;
		try {
			const handles = await Promise.race([
				this.#requirePage().$$(normalizeSelector(selector)),
				Bun.sleep(MATCH_COUNT_PROBE_TIMEOUT_MS).then(() => null),
			]);
			if (!handles) return { failure: `no answer within ${MATCH_COUNT_PROBE_TIMEOUT_MS}ms` };
			for (const handle of handles) void handle.dispose().catch(() => undefined);
			return { count: handles.length };
		} catch (err) {
			const message = (err instanceof Error ? err.message : String(err)).split("\n", 1)[0];
			return { failure: message || (err instanceof Error ? err.name : "unknown error") };
		}
	}

	/**
	 * Wait for a main-frame navigation the page requested (a link or submit button just clicked, a script setting
	 * `location`) to replace the document and for the new one to finish parsing. Chromium reports the request before
	 * the click that caused it returns, while the response and commit come later, so a call made right after the
	 * click would otherwise reach the page being left. Bounded by half the op's deadline, at most
	 * {@link REQUESTED_NAVIGATION_WAIT_MS}: past that, Chromium itself holds evaluations on the old document until a
	 * navigation that started loading commits, and a request that never started loading holds no later call.
	 * `contextLost` waits even with no request seen.
	 */
	async #awaitRequestedNavigation(signal: AbortSignal, perOpMs: number, contextLost = false): Promise<void> {
		const settled = await waitForMainFrameDocument(
			this.#requirePage(),
			() => this.#mainFrameNavigationRequested,
			Math.min(REQUESTED_NAVIGATION_WAIT_MS, perOpMs / 2),
			signal,
			contextLost,
		);
		if (!settled) this.#mainFrameNavigationRequested = false;
	}

	/** Run one of our own page reads once more on the new document when a navigation took its execution context. */
	async #rereadAfterNavigation<T>(signal: AbortSignal, perOpMs: number, read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (error) {
			if (signal.aborted || !isNavigatedContextError(error)) throw error;
			await this.#awaitRequestedNavigation(signal, perOpMs, true);
			return await read();
		}
	}

	#createTabApi(
		name: string,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		active: ActiveRun,
	): TabApi {
		const page = this.#requirePage();
		const webmcp = this.#webmcp;
		if (!webmcp) throw new ToolError("Tab worker WebMCP handling is not initialized");
		const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(timeoutMs);
		const waitMs = (explicit?: number): number => resolveWaitTimeout(timeoutMs, explicit);
		const INF = Number.POSITIVE_INFINITY;
		const op = <T>(
			label: string,
			perOpMs: number,
			fn: (sig: AbortSignal) => Promise<T>,
			selectorOpts?: OpOptions,
		): Promise<T> => markHandled(this.#runOp(active, label, signal, perOpMs, fn, selectorOpts));
		// Calls on the document (reads, actions, waits for its content) reach the page a navigation the page requested
		// brings, not the one it leaves; `read` also reruns once when a navigation takes its context mid-call. Waits for
		// events (navigation, response, download), dialogs and network setup run at once: they may be what the
		// navigation waits on, or must catch its first request.
		// Both run the page's script, which a confirm or prompt stops until it is answered (`OpOptions.dialog`).
		const read = <T>(label: string, perOpMs: number, fn: (sig: AbortSignal) => Promise<T>): Promise<T> =>
			op(label, perOpMs, sig => this.#rereadAfterNavigation(sig, perOpMs, () => fn(sig)), {
				awaitNavigation: true,
				dialog: "blocks",
			});
		const act = <T>(
			label: string,
			perOpMs: number,
			fn: (sig: AbortSignal) => Promise<T>,
			selectorOpts?: OpOptions,
		): Promise<T> => op(label, perOpMs, fn, { dialog: "blocks", ...selectorOpts, awaitNavigation: true });
		// Hand user-facing handles the fail-fast per-op guard so their interactive
		// methods (`.click()`, `.type()`, …) can't outrun the cell budget (issue #9535).
		const enrich = (handle: ElementHandle): ActionableHandle =>
			toActionableHandle(
				handle,
				(label, fn, dialog = "blocks") => op(label, actionOpMs, fn, { dialog }),
				async () => {
					// Raw Puppeteer actions have no AbortSignal. Poison + dispose every
					// cached handle and stop navigation before reporting a recoverable timeout.
					this.#clearElementCache();
					await this.#stopLoading();
				},
				{
					route: sig => this.#requireUploads().route(page, sig),
					prepare: (filePaths, label, route, sig) =>
						prepareElementUpload(
							page,
							handle,
							filePaths.map(filePath => resolveToCwd(filePath, session.cwd)),
							label,
							route,
							this.#requireUploads(),
							sig,
						),
					deliverGuard: (label, fn) => op(label, budgetBound, fn),
				},
			);
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => read("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
			goto: (url, opts) =>
				op(`tab.goto(${JSON.stringify(url)})`, INF, async sig => {
					this.#clearElementCache();
					try {
						// Default to "load" because dev servers with HMR/WS never reach networkidle.
						// budgetBound (not the full cell) so a hung navigation fails named and
						// catchable inside the run instead of dying with the whole cell.
						await navigateMainFrame(page, opts?.waitUntil ?? "load", budgetBound, sig, options =>
							page.goto(url, options),
						);
					} catch (err) {
						if (isPuppeteerTimeout(err)) {
							// Abandon the hung navigation NOW — a still-pending load stalls every
							// later op on this page and cascades into more opaque timeouts.
							await this.#stopLoading();
							throw new NavigationTimeoutError(
								`tab.goto(${JSON.stringify(url)}) timed out after ${budgetBound}ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:"domcontentloaded"`,
							);
						}
						throw err;
					}
				}),
			observe: opts => read("tab.observe()", quickOpMs, sig => this.#collectObservation({ ...opts, signal: sig })),
			ariaSnapshot: (selector, opts) =>
				read(
					selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()",
					quickOpMs,
					async sig => {
						let root: ElementHandle | null = null;
						if (selector) {
							root = (await untilAborted(sig, () =>
								page.$(normalizeSelector(selector)),
							)) as ElementHandle | null;
							if (!root)
								throw new ToolError(
									`tab.ariaSnapshot: selector ${JSON.stringify(selector)} matched no element`,
								);
						}
						try {
							const snapshot = await untilAborted(sig, () => captureAriaSnapshot(page, root, opts));
							if (!opts?.diff) return snapshot;
							const key = ariaSnapshotBaselineKey(selector, opts);
							return diffAriaSnapshot(this.#ariaSnapshotBaselines, key, page.url(), snapshot);
						} finally {
							await root?.dispose().catch(() => undefined);
						}
					},
				),
			screenshot: opts =>
				read(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, output, screenshots, sig, opts),
				),
			extract: (format = "markdown", opts) =>
				read(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
					const html = (await untilAborted(sig, () => page.content())) as string;
					const result = await extractReadableFromHtml(html, page.url(), format, opts);
					if (!result) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`,
						);
					}
					const content = format === "markdown" ? result.markdown : result.text;
					if (!content) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`,
						);
					}
					return content;
				}),
			click: (selector, opts) =>
				act(
					`tab.click(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const label = `tab.click(${JSON.stringify(selector)})`;
						const click = { button: opts?.button, clickCount: opts?.count };
						const resolved = normalizeSelector(selector);
						if (resolved.startsWith("text/") && parseAriaRefSelector(selector) === null) {
							await clickQueryHandlerText(page, resolved, label, actionOpMs, sig, click);
							return;
						}
						await this.#clickSelector(selector, actionOpMs, sig, handle =>
							clickElement(handle, label, sig, click),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS, dialog: "answers" },
				),
			type: (selector, text) =>
				act(
					`tab.type(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await typeIntoElement(handle, text, sig);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			fill: (selector, value) =>
				act(
					`tab.fill(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await fillViaHandle(handle, value, sig);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			press: (key, opts) =>
				act(
					`tab.press(${JSON.stringify(key)})`,
					actionOpMs,
					async sig => {
						assertTabPressArgs(key, opts);
						const selector = opts?.selector;
						if (selector) {
							if (parseAriaRefSelector(selector) !== null) {
								const handle = await this.#resolveAriaRef(selector);
								try {
									await untilAborted(sig, () => handle.focus());
								} finally {
									await handle.dispose().catch(() => undefined);
								}
							} else await untilAborted(sig, () => page.focus(normalizeSelector(selector)));
						}
						await pressKey(page, key, undefined, sig);
					},
					{ dialog: "answers" },
				),
			scroll: (deltaX, deltaY, opts) =>
				act("tab.scroll()", actionOpMs, async sig => {
					if (!opts?.selector) {
						await untilAborted(sig, () => dispatchScroll(() => page.mouse.wheel({ deltaX, deltaY })));
						return;
					}
					const handle = await this.#resolveActionHandle(opts.selector, actionOpMs, sig);
					try {
						await untilAborted(sig, () =>
							handle.evaluate(
								(el, dx, dy) => {
									const target = el as unknown as {
										scrollBy(opts: { left: number; top: number; behavior: string }): void;
									};
									target.scrollBy({ left: dx, top: dy, behavior: "instant" });
								},
								deltaX,
								deltaY,
							),
						);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				}),
			drag: (from, to) => act("tab.drag()", actionOpMs, sig => this.#drag(from, to, sig)),
			waitFor: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return act(
					`tab.waitFor(${JSON.stringify(selector)})`,
					w,
					async sig => enrich(await this.#resolveActionHandle(selector, w, sig)),
					{ selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			waitForSelector: async (selector, opts) => {
				opts = selectorWaitOptions(opts);
				const w = waitMs(opts?.timeout);
				return act(
					`tab.waitForSelector(${JSON.stringify(selector)})`,
					w,
					async sig => {
						const ref = parseAriaRefSelector(selector);
						if (ref !== null) {
							const handle = await waitForSelectorHandle(() => resolveAriaRefHandle(page, ref), opts, sig);
							return handle ? enrich(handle) : null;
						}
						if (opts.state === "detached") {
							const normalized = normalizeSelector(selector);
							return await waitForDetached(() => page.$(normalized), sig);
						}
						const handle = (await untilAborted(sig, () =>
							page.waitForSelector(normalizeSelector(selector), {
								timeout: w,
								visible: opts?.visible,
								hidden: opts?.hidden,
								signal: sig,
							}),
						)) as ElementHandle | null;
						return handle ? enrich(handle) : null;
					},
					{
						selector,
						// `hidden: true` waits for zero matches — that is success, never a fast-fail.
						zeroMatchAfterMs:
							opts?.timeout === undefined && !opts?.hidden && opts?.state !== "detached"
								? ZERO_MATCH_FAIL_FAST_MS
								: undefined,
					},
				);
			},
			waitForNavigation: opts => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForNavigation()", w, sig =>
					untilAborted(sig, () =>
						page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "load", timeout: w, signal: sig }),
					),
				);
			},
			evaluate: (fn, ...args) =>
				// User code may have side effects and may throw any message, so it waits for a requested navigation but
				// never runs again.
				act("tab.evaluate()", INF, sig =>
					untilAborted(sig, () =>
						evaluateInRealm(page.mainFrame().mainRealm(), fn as PageFunction, args, false, sig),
					),
				) as never,
			scrollIntoView: selector =>
				act(
					`tab.scrollIntoView(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () =>
								handle.evaluate(el => {
									const target = el as unknown as {
										scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
									};
									target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
								}),
							);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			select: (selector, ...values) =>
				act(
					`tab.select(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#select(selector, values, actionOpMs, sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uploadFile: (selector, ...filePaths) => {
				const label = `tab.uploadFile(${JSON.stringify(selector)})`;
				return markHandled(
					(async () => {
						if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
						// Its own deadline: the first upload's check must not eat into the wait for the selector.
						const route = await op(`${label} checking how the browser takes files`, actionOpMs, sig =>
							this.#requireUploads().route(page, sig),
						);
						const prepared = await act(
							label,
							actionOpMs,
							sig => this.#prepareTabUpload(selector, filePaths, label, route, actionOpMs, sig, session),
							{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
						);
						try {
							await op(`${label} sending ${formatBytes(prepared.bytes)}`, budgetBound, sig =>
								prepared.deliver(sig),
							);
						} finally {
							await prepared.dispose();
						}
					})(),
				);
			},
			waitForUrl: (pattern, opts) => {
				assertUrlPattern(pattern);
				const w = waitMs(opts?.timeout);
				return act("tab.waitForUrl()", w, sig => this.#waitForUrl(pattern, w, sig));
			},
			waitForResponse: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForResponse()", w, sig => this.#waitForResponse(pattern, w, sig));
			},
			id: async id => enrich(await this.#resolveCachedHandle(id)),
			ref: async id => enrich(await this.#resolveAriaRef(id)),
			// The browser keeps cookies, so a dialog stopping the page's script does not stop this read.
			cookies: opts =>
				op("tab.cookies()", quickOpMs, sig => readCookies(page, opts, sig), { awaitNavigation: true }),
			setCookies: (...cookies) => op("tab.setCookies()", actionOpMs, sig => setPageCookies(page, cookies, sig)),
			clearCookies: opts => op("tab.clearCookies()", actionOpMs, sig => clearPageCookies(page, opts, sig)),
			storage: (kind, opts) => act("tab.storage()", quickOpMs, sig => readStorage(page, kind, opts, sig)),
			setStorage: (kind, keyOrEntries, value) =>
				op("tab.setStorage()", actionOpMs, sig => setPageStorage(page, kind, keyOrEntries, value, sig)),
			clearStorage: kind => op("tab.clearStorage()", actionOpMs, sig => clearPageStorage(page, kind, sig)),
			saveState: filePath =>
				op("tab.saveState()", actionOpMs, sig => saveStorageState(page, name, filePath, session.cwd, sig)),
			loadState: filePath =>
				op("tab.loadState()", actionOpMs, sig =>
					loadStorageState(page, filePath, session.cwd, {
						allowOtherOrigins: this.#mode === "headless",
						navigationTimeoutMs: actionOpMs,
						signal: sig,
					}),
				),
			recordStart: (destination, opts) =>
				op(`tab.recordStart(${JSON.stringify(destination)})`, quickOpMs, sig =>
					this.#recording.start(createCdpRecordingSource(page), destination, session.cwd, opts, sig),
				),
			recordStop: () =>
				op("tab.recordStop()", budgetBound, sig =>
					this.#recording.stop({ signal: sig, output, excludeWebP: session.excludeWebP }),
				),
			recordRestart: (destination, opts) =>
				op(`tab.recordRestart(${JSON.stringify(destination)})`, budgetBound, sig =>
					this.#recording.restart(createCdpRecordingSource(page), destination, session.cwd, opts, {
						signal: sig,
						output,
						excludeWebP: session.excludeWebP,
					}),
				),
			recording: () => op("tab.recording()", quickOpMs, () => Promise.resolve(this.#recording.status())),
			webmcpList: opts => op("tab.webmcpList()", quickOpMs, sig => untilAborted(sig, () => webmcp.list(opts, sig))),
			webmcpInvoke: (toolName, params, opts) => {
				const w = waitMs(opts?.timeout);
				return op(`tab.webmcpInvoke(${JSON.stringify(toolName)})`, w, sig =>
					untilAborted(sig, () => webmcp.invoke(toolName, params, opts, sig)),
				);
			},
			webmcpEvents: opts =>
				op("tab.webmcpEvents()", quickOpMs, sig => untilAborted(sig, () => webmcp.events(opts, sig))),
			a11y: opts =>
				read("tab.a11y()", budgetBound, async sig => {
					const result = await untilAborted(sig, () => runA11yAudit(page, opts));
					output.push({ type: "text", text: formatA11ySummary(result) });
					return result;
				}),
			vitals: opts => op("tab.vitals()", INF, sig => collectVitals(puppeteerReactHost(page), opts, sig)),
			reactEnable: () => op("tab.reactEnable()", INF, sig => enableReact(puppeteerReactHost(page), sig)),
			reactTree: opts => op("tab.reactTree()", quickOpMs, sig => readReactTree(page, opts, sig)),
			reactInspect: id => op(`tab.reactInspect(${id})`, quickOpMs, sig => inspectReactFiber(page, id, sig)),
			reactRenders: opts => op("tab.reactRenders()", quickOpMs, sig => collectReactRenders(page, opts, sig)),
			reactSuspense: opts => op("tab.reactSuspense()", quickOpMs, sig => readReactSuspense(page, opts, sig)),
			back: opts =>
				op("tab.back()", INF, async sig => {
					this.#clearElementCache();
					return await traverseHistory(page, "back", opts?.waitUntil ?? "load", budgetBound, sig);
				}),
			forward: opts =>
				op("tab.forward()", INF, async sig => {
					this.#clearElementCache();
					return await traverseHistory(page, "forward", opts?.waitUntil ?? "load", budgetBound, sig);
				}),
			reload: opts =>
				op("tab.reload()", INF, async sig => {
					this.#clearElementCache();
					return await reloadPage(page, opts?.waitUntil ?? "load", budgetBound, sig);
				}),
			pushState: url =>
				op(`tab.pushState(${JSON.stringify(url)})`, actionOpMs, async sig => {
					this.#clearElementCache();
					return await pushState(page, url, sig);
				}),
			frames: () => act("tab.frames()", quickOpMs, sig => listFrames(page, sig)),
			frame: selectorOrNameOrUrl =>
				act(`tab.frame(${JSON.stringify(selectorOrNameOrUrl)})`, quickOpMs, async sig => {
					const frame = await resolveFrame(page, selectorOrNameOrUrl, normalizeSelector, sig);
					return createFrameApi(frame, {
						quickOpMs,
						actionOpMs,
						zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS,
						normalizeSelector,
						waitMs,
						op,
						captureScreenshot: (target, selector, screenshotSignal) =>
							captureFrameScreenshot(
								target,
								selector,
								screenshotSignal,
								normalizeSelector,
								session,
								output,
								screenshots,
							),
					});
				}),
			dialog: () =>
				op("tab.dialog()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireDialogs().state();
				}),
			handleDialog: opts =>
				op("tab.handleDialog()", actionOpMs, sig => untilAborted(sig, () => this.#requireDialogs().handle(opts))),
			setDialogs: policy =>
				op("tab.setDialogs()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireDialogs().setPolicy(policy)),
				),
			route: (pattern, opts) =>
				op("tab.route()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireNetwork().route(pattern, opts, sig)),
				),
			unroute: pattern =>
				op("tab.unroute()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireNetwork().unroute(pattern, sig)),
				),
			routes: () =>
				op("tab.routes()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireNetwork().routes();
				}),
			requests: opts =>
				op("tab.requests()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireNetwork().requests(opts);
				}),
			request: id =>
				op("tab.request()", quickOpMs, sig => untilAborted(sig, () => this.#requireNetwork().request(id, sig))),
			clearRequests: () =>
				op("tab.clearRequests()", quickOpMs, async sig => {
					throwIfAborted(sig);
					this.#requireNetwork().clearRequests();
				}),
			harStart: opts =>
				op("tab.harStart()", quickOpMs, async sig => {
					throwIfAborted(sig);
					this.#requireNetwork().harStart(opts?.content);
				}),
			harStop: opts =>
				op("tab.harStop()", INF, sig => {
					const destination = opts?.path
						? resolveToCwd(opts.path, session.cwd)
						: path.join(session.cwd, `browser-${name.replace(/[^a-z0-9_-]+/gi, "-")}-${Snowflake.next()}.har`);
					return untilAborted(sig, () => this.#requireNetwork().harStop(destination, sig));
				}),
			allowedDomains: () =>
				op("tab.allowedDomains()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireNetwork().allowedDomains();
				}),
			diffScreenshot: (baselinePath, opts) =>
				read("tab.diffScreenshot()", quickOpMs, sig =>
					this.#diffScreenshot(session, output, screenshots, sig, baselinePath, opts),
				),
			pdf: opts => read("tab.pdf()", quickOpMs, sig => this.#pdf(session, sig, opts)),
			addInitScript: source =>
				op("tab.addInitScript()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireInitScripts().add(source)),
				),
			removeInitScript: id =>
				op("tab.removeInitScript()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireInitScripts().remove(id)),
				),
			initScripts: () =>
				op("tab.initScripts()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireInitScripts().list();
				}),
			waitForDownload: opts => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForDownload()", w, sig => this.#requireDownloads().wait(sig));
			},
			downloads: () =>
				op("tab.downloads()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireDownloads().list();
				}),
			text: (selector = "body") =>
				read(`tab.text(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryText(page, normalizeSelector(selector), sig),
				),
			html: (selector = "body") =>
				read(`tab.html(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryHtml(page, normalizeSelector(selector), sig),
				),
			value: selector =>
				read(`tab.value(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryValue(page, normalizeSelector(selector), sig),
				),
			attr: (selector, attribute) =>
				read(`tab.attr(${JSON.stringify(selector)}, ${JSON.stringify(attribute)})`, quickOpMs, sig =>
					queryAttribute(page, normalizeSelector(selector), attribute, sig),
				),
			count: selector =>
				read(`tab.count(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryCount(page, normalizeSelector(selector), sig),
				),
			box: selector =>
				read(`tab.box(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryBox(page, normalizeSelector(selector), sig),
				),
			styles: (selector, props) =>
				read(`tab.styles(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryStyles(page, normalizeSelector(selector), props, sig),
				),
			isVisible: selector =>
				read(`tab.isVisible(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryVisible(page, normalizeSelector(selector), sig),
				),
			isEnabled: selector =>
				read(`tab.isEnabled(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryEnabled(page, normalizeSelector(selector), sig),
				),
			isChecked: selector =>
				read(`tab.isChecked(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryChecked(page, normalizeSelector(selector), sig),
				),
			waitForText: (text, opts) => {
				const w = waitMs(opts?.timeout);
				return act(`tab.waitForText(${JSON.stringify(text)})`, w, sig =>
					waitForPageText(page, text, {
						timeout: w,
						selector: opts?.selector ? normalizeSelector(opts.selector) : undefined,
						exact: opts?.exact,
						signal: sig,
					}),
				);
			},
			console: opts =>
				op("tab.console()", quickOpMs, sig => untilAborted(sig, () => this.#consoleCapture.console(opts))),
			errors: opts =>
				op("tab.errors()", quickOpMs, sig => untilAborted(sig, () => this.#consoleCapture.errors(opts))),
			clearConsole: () =>
				op("tab.clearConsole()", quickOpMs, async sig => {
					throwIfAborted(sig);
					this.#consoleCapture.clear();
				}),
			traceStart: opts =>
				op("tab.traceStart()", actionOpMs, sig => untilAborted(sig, () => this.#requireTracing().traceStart(opts))),
			traceStop: opts =>
				op("tab.traceStop()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireTracing().traceStop(session.cwd, opts)),
				),
			profileStart: () =>
				op("tab.profileStart()", actionOpMs, sig => untilAborted(sig, () => this.#requireTracing().profileStart())),
			profileStop: opts =>
				op("tab.profileStop()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireTracing().profileStop(session.cwd, opts)),
				),
			metrics: () =>
				op("tab.metrics()", quickOpMs, sig => untilAborted(sig, () => this.#requireTracing().metrics())),
			dblclick: selector =>
				act(
					`tab.dblclick(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						await this.#clickSelector(selector, actionOpMs, sig, handle =>
							clickElement(handle, `tab.dblclick(${JSON.stringify(selector)})`, sig, { clickCount: 2 }),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS, dialog: "answers" },
				),
			hover: selector =>
				act(
					`tab.hover(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await hoverElement(handle, sig);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			focus: selector =>
				act(
					`tab.focus(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () => handle.focus());
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			check: selector =>
				act(
					`tab.check(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						await this.#clickSelector(selector, actionOpMs, sig, handle =>
							setElementChecked(handle, true, `tab.check(${JSON.stringify(selector)})`, sig),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uncheck: selector =>
				act(
					`tab.uncheck(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						await this.#clickSelector(selector, actionOpMs, sig, handle =>
							setElementChecked(handle, false, `tab.uncheck(${JSON.stringify(selector)})`, sig),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			// A press is held from when it lands; one cut off on its way is released by the helper itself.
			keyDown: key =>
				op(`tab.keyDown(${JSON.stringify(key)})`, actionOpMs, async sig => {
					await keyDown(page, key, sig);
					this.#heldKeys.add(key);
				}),
			keyUp: key =>
				op(`tab.keyUp(${JSON.stringify(key)})`, actionOpMs, sig => {
					this.#heldKeys.delete(key);
					return keyUp(page, key, sig);
				}),
			mouseMove: (x, y, opts) => op("tab.mouseMove()", actionOpMs, sig => mouseMove(page, x, y, opts, sig)),
			mouseDown: opts =>
				op("tab.mouseDown()", actionOpMs, async sig => {
					await mouseDown(page, opts, sig);
					this.#heldButtons.add(opts?.button ?? "left");
				}),
			mouseUp: opts =>
				op("tab.mouseUp()", actionOpMs, sig => {
					this.#heldButtons.delete(opts?.button ?? "left");
					return mouseUp(page, opts, sig);
				}),
			// Raw pointer input runs at once, as on main: sent the moment a new document had parsed, a click did not
			// reach it.
			clickAt: (x, y, opts) => op("tab.clickAt()", actionOpMs, sig => clickAt(page, x, y, opts, sig)),
			wheel: (deltaX, deltaY) => op("tab.wheel()", actionOpMs, sig => wheel(page, deltaX, deltaY, sig)),
			highlight: (selector, opts) =>
				act(
					`tab.highlight(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await highlightElement(handle, opts, sig);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			emulate: opts =>
				op("tab.emulate()", actionOpMs, sig => untilAborted(sig, () => this.#requireEmulation().emulate(opts))),
			devices: () =>
				op("tab.devices()", quickOpMs, async sig => {
					throwIfAborted(sig);
					return this.#requireEmulation().devices();
				}),
			clipboardRead: () =>
				op("tab.clipboardRead()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireEmulation().clipboardRead()),
				),
			clipboardWrite: text =>
				op("tab.clipboardWrite()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireEmulation().clipboardWrite(text)),
				),
			clipboardCopy: () => op("tab.clipboardCopy()", actionOpMs, sig => this.#requireEmulation().clipboardCopy(sig)),
			clipboardPaste: () =>
				op("tab.clipboardPaste()", actionOpMs, sig => this.#requireEmulation().clipboardPaste(sig)),
		};
	}

	async #collectObservation(options: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		selector?: string;
		compact?: boolean;
		signal?: AbortSignal;
	}): Promise<Observation> {
		const page = this.#requirePage();
		this.#clearElementCache();
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		let root: ElementHandle | null = null;
		if (options.selector) {
			root =
				parseAriaRefSelector(options.selector) !== null
					? await this.#resolveAriaRef(options.selector)
					: ((await untilAborted(options.signal, () =>
							page.$(normalizeSelector(options.selector!)),
						)) as ElementHandle | null);
			if (!root) {
				throw new ToolError(`tab.observe: selector ${JSON.stringify(options.selector)} matched no element`);
			}
		}
		let snapshot: SerializedAXNode | null;
		let frameSnapshots: FrameSnapshot[];
		try {
			snapshot = (await untilAborted(options.signal, () =>
				page.accessibility.snapshot({ interestingOnly: !includeAll, root: root ?? undefined }),
			)) as SerializedAXNode | null;
			frameSnapshots = await snapshotFrames(page.mainFrame().childFrames(), {
				interestingOnly: !includeAll,
				root,
				deadline: Date.now() + FRAME_SNAPSHOT_TIMEOUT_MS,
				signal: options.signal,
			});
		} finally {
			await root?.dispose().catch(() => undefined);
		}
		if (!snapshot) throw new ToolError("Accessibility snapshot unavailable");
		const entries: ObservationEntry[] = [];
		const interactiveAncestors = new Set<SerializedAXNode>();
		const trees: FrameSnapshot[] = [{ frame: page.mainFrame(), snapshot }, ...frameSnapshots];
		for (const tree of trees) {
			if (options.compact) collectInteractiveObservationAncestors(tree.snapshot, interactiveAncestors);
			await collectObservationEntries(this, tree.frame, tree.snapshot, entries, {
				includeAll,
				viewportOnly,
				compact: options.compact ?? false,
				interactiveAncestors,
			});
		}
		const scroll = (await untilAborted(options.signal, () =>
			page.evaluate(() => {
				const win = globalThis as unknown as {
					scrollX: number;
					scrollY: number;
					innerWidth: number;
					innerHeight: number;
					document: { documentElement: { scrollWidth: number; scrollHeight: number } };
				};
				const doc = win.document.documentElement;
				return {
					x: win.scrollX,
					y: win.scrollY,
					width: win.innerWidth,
					height: win.innerHeight,
					scrollWidth: doc.scrollWidth,
					scrollHeight: doc.scrollHeight,
				};
			}),
		)) as Observation["scroll"];
		return {
			url: page.url(),
			title: (await untilAborted(options.signal, () => page.title())) as string,
			viewport: await this.#viewport(options.signal),
			scroll,
			elements: entries,
		};
	}

	async #captureScreenshot(
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		opts: ScreenshotOptions = {},
	): Promise<string | ScreenshotChangeResult> {
		const page = this.#requirePage();
		screenshotQuality(opts);
		const threshold = screenshotThreshold(opts.threshold);
		const changeDetection = opts.ifChanged === true || opts.threshold !== undefined;
		const captureFormat = opts.format ?? "png";
		const captureMime = captureFormat === "jpeg" ? ("image/jpeg" as const) : ("image/png" as const);
		const annotationTargets: ScreenshotAnnotationTarget[] = [];
		if (opts.annotate) {
			const observation = await this.#collectObservation({ signal });
			for (const entry of observation.elements) {
				const handle = await this.#resolveCachedHandle(entry.id);
				const box = await untilAborted(signal, () => handle.boundingBox()).catch(() => null);
				if (!box || box.width <= 0 || box.height <= 0) continue;
				annotationTargets.push({
					id: entry.id,
					role: entry.role,
					name: entry.name,
					x: box.x,
					y: box.y,
					width: box.width,
					height: box.height,
				});
			}
		}
		const captureScale = opts.silent ? undefined : ((await this.#viewport(signal)).deviceScaleFactor ?? 1);
		const cleanupAnnotations = opts.annotate
			? await installScreenshotAnnotations(page, annotationTargets, signal)
			: async (): Promise<void> => {};
		const resolveSelector = async (selector: string): Promise<ElementHandle | null> =>
			parseAriaRefSelector(selector) !== null
				? await this.#resolveAriaRef(selector)
				: asElementHandle(await untilAborted(signal, () => page.$(normalizeSelector(selector))));
		let captured: { comparison: Uint8Array; image: Uint8Array };
		try {
			captured = await whileDrawing(page, signal, async () => {
				const comparison = await captureScreenshotBuffer(page, opts, signal, resolveSelector, "png");
				const image =
					captureFormat === "png"
						? comparison
						: await captureScreenshotBuffer(page, opts, signal, resolveSelector, captureFormat);
				return { comparison, image };
			});
		} finally {
			await cleanupAnnotations();
		}
		const { comparison: comparisonBuffer, image: buffer } = captured;
		let changeResult: ScreenshotChangeResult | undefined;
		if (changeDetection) {
			const scope = screenshotScope(opts);
			const previous = this.#screenshotHistory.get(scope);
			const pixelChangeRatio = previous ? pngPixelChangeRatio(previous.png, comparisonBuffer) : 1;
			const changed = !previous || pixelChangeRatio > threshold;
			const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;
			this.#screenshotHistory.set(scope, { png: comparisonBuffer, revision });
			changeResult = { changed, revision, pixelChangeRatio };
			if (!changed) return changeResult;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const preserveFormat = opts.format !== undefined;
		const saveFullRes = !!session.browserScreenshotDir || preserveFormat;
		const savedBuffer = saveFullRes ? buffer : resized.buffer;
		const savedMimeType = saveFullRes ? captureMime : resized.mimeType;
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest = session.browserScreenshotDir
			? path.join(
					session.browserScreenshotDir,
					`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
				)
			: path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.${ext}`);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await Bun.write(dest, savedBuffer);
		screenshots.push({
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		});
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				dest,
				resized,
				capture: { area: screenshotArea(opts), scale: captureScale },
			});
			if (opts.annotate) lines.push(formatScreenshotLegend(annotationTargets));
			output.push({ type: "text", text: lines.join("\n") });
			output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		if (changeResult) return { ...changeResult, path: dest };
		return dest;
	}

	async #diffScreenshot(
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		baselinePath: string,
		opts: DiffScreenshotOptions = {},
	): Promise<DiffScreenshotResult> {
		const page = this.#requirePage();
		const absoluteBaseline = resolveToCwd(baselinePath, session.cwd);
		const baseline = await untilAborted(signal, () => fs.promises.readFile(absoluteBaseline));
		const current = await whileDrawing(page, signal, () =>
			captureScreenshotBuffer(page, {}, signal, async () => null, "png"),
		);
		const diff = createPngDiff(baseline, current);
		const threshold = screenshotThreshold(opts.threshold);
		const changed = diff.pixelChangeRatio > threshold;
		const diffPath = opts.output
			? resolveToCwd(opts.output, session.cwd)
			: path.join(os.tmpdir(), `omp-screenshot-diff-${Snowflake.next()}.png`);
		await fs.promises.mkdir(path.dirname(diffPath), { recursive: true });
		await Bun.write(diffPath, diff.png);
		const resized = await resizeImage(
			{ type: "image", data: diff.png.toBase64(), mimeType: "image/png" },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		screenshots.push({
			dest: diffPath,
			mimeType: "image/png",
			bytes: diff.png.length,
			width: resized.width,
			height: resized.height,
		});
		output.push({
			type: "text",
			text: `Screenshot diff: ${diff.pixelChangeRatio.toFixed(6)} changed-pixel ratio (${changed ? "changed" : "unchanged"}); saved to ${diffPath}`,
		});
		output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		return { pixelChangeRatio: diff.pixelChangeRatio, changed, diffPath };
	}

	async #pdf(session: SessionSnapshot, signal: AbortSignal | undefined, opts: PdfOptions = {}): Promise<string> {
		const dest = opts.path
			? resolveToCwd(opts.path, session.cwd)
			: path.join(os.tmpdir(), `omp-browser-${Snowflake.next()}.pdf`);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await untilAborted(signal, () =>
			this.#requirePage().pdf({
				path: dest,
				format: opts.format,
				landscape: opts.landscape,
				scale: opts.scale,
				printBackground: opts.printBackground,
				margin: opts.margin,
				pageRanges: opts.pageRanges,
			}),
		);
		return dest;
	}

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (
			target: DragTarget,
			role: "from" | "to",
		): Promise<{ x: number; y: number; handle?: ElementHandle }> => {
			if (typeof target === "string") {
				const handle =
					parseAriaRefSelector(target) !== null
						? await this.#resolveAriaRef(target)
						: asElementHandle(await untilAborted(signal, () => page.$(normalizeSelector(target))));
				if (!handle) throw new ToolError(`Drag ${role} selector did not resolve: ${target}`);
				const box = (await untilAborted(signal, () => handle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				if (!box) {
					await handle.dispose().catch(() => undefined);
					throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
				}
				return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
			}
			if (
				target !== null &&
				typeof target === "object" &&
				typeof (target as { x: unknown }).x === "number" &&
				typeof (target as { y: unknown }).y === "number"
			) {
				return { x: (target as { x: number }).x, y: (target as { y: number }).y };
			}
			throw new ToolError(
				`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`,
			);
		};
		const start = await resolveDragPoint(from, "from");
		let end: { x: number; y: number; handle?: ElementHandle } | undefined;
		try {
			end = await resolveDragPoint(to, "to");
			await dragBetween(page, start, end, signal);
		} finally {
			if (start.handle) await start.handle.dispose().catch(() => undefined);
			if (end?.handle) await end.handle.dispose().catch(() => undefined);
		}
	}

	async #select(selector: string, values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			return await selectElementOptions(handle, values, "tab.select()", signal);
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	/**
	 * Find what takes a `tab.uploadFile` under the action deadline, looking the selector up again when the page
	 * replaced a chooser trigger before its click ({@link withLiveElement}); the result owns the resolved handle.
	 */
	#prepareTabUpload(
		selector: string,
		filePaths: string[],
		label: string,
		route: UploadRoute,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<PreparedUpload> {
		const page = this.#requirePage();
		const absolute = filePaths.map(filePath => resolveToCwd(filePath, session.cwd));
		return withLiveElement(
			() => this.#resolveActionHandle(selector, timeoutMs, signal),
			async handle => {
				try {
					const prepared = await prepareElementUpload(
						page,
						handle,
						absolute,
						label,
						route,
						this.#requireUploads(),
						signal,
					);
					return {
						...prepared,
						dispose: async () => {
							await prepared.dispose();
							await handle.dispose().catch(() => undefined);
						},
					};
				} catch (error) {
					await handle.dispose().catch(() => undefined);
					throw error;
				}
			},
			signal,
			{ retry: parseAriaRefSelector(selector) === null },
		);
	}

	async #waitForUrl(pattern: string | RegExp, timeout: number, signal: AbortSignal): Promise<string> {
		const page = this.#requirePage();
		const isRegex = pattern instanceof RegExp;
		const matcher = isRegex ? pattern.source : pattern;
		const flags = isRegex ? pattern.flags : "";
		await untilAborted(signal, () =>
			page.waitForFunction(
				(m: string, isRe: boolean, fl: string) => {
					const url = (globalThis as unknown as { location: { href: string } }).location.href;
					return isRe ? new RegExp(m, fl).test(url) : url.includes(m);
				},
				{ timeout, polling: 200, signal },
				matcher,
				isRegex,
				flags,
			),
		);
		return page.url();
	}

	async #waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		timeout: number,
		signal: AbortSignal,
	): Promise<HTTPResponse> {
		const page = this.#requirePage();
		const predicate: (response: HTTPResponse) => boolean | Promise<boolean> =
			typeof pattern === "function"
				? pattern
				: pattern instanceof RegExp
					? response => pattern.test(response.url())
					: response => response.url().includes(pattern);
		return (await untilAborted(signal, () => page.waitForResponse(predicate, { timeout, signal }))) as HTTPResponse;
	}

	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const element = this.#observedElements.get(id);
		if (!element) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		if (isObservedDocumentGone(element)) {
			this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		const handle = this.#elementCache.get(id);
		if (!handle) {
			const resolved = await resolveObservedElement(element);
			// An observe() during the await renumbers ids, so the id may now name another element.
			if (!resolved || this.#observedElements.get(id) !== element) {
				await resolved?.dispose().catch(() => undefined);
				if (this.#observedElements.get(id) === element) this.#clearElementCache();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
			const cached = this.#elementCache.get(id);
			if (cached) {
				await resolved.dispose().catch(() => undefined);
				return cached;
			}
			this.#elementCache.set(id, resolved);
			return resolved;
		}
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				this.#clearElementCache();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
		} catch (err) {
			if (err instanceof ToolError) throw err;
			this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		return handle;
	}

	async #resolveAriaRef(id: string): Promise<ElementHandle> {
		const ref = parseAriaRefSelector(id) ?? id.trim();
		const handle = await resolveAriaRefHandle(this.#requirePage(), ref);
		if (!handle) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		return handle;
	}

	/**
	 * Resolve a selector to an ElementHandle for handle-based actions. An
	 * `aria-ref=eN` selector resolves against the latest ariaSnapshot's refs
	 * (main world); anything else goes through the normal locator wait.
	 */
	async #resolveActionHandle(selector: string, timeoutMs: number, sig: AbortSignal): Promise<ElementHandle> {
		if (parseAriaRefSelector(selector) !== null) return this.#resolveAriaRef(selector);
		return (await untilAborted(sig, () =>
			this.#requirePage().locator(normalizeSelector(selector)).setTimeout(timeoutMs).waitHandle({ signal: sig }),
		)) as ElementHandle;
	}

	/**
	 * Runs `click` on the element `selector` resolves to, resolving it again whenever the page replaced it before the
	 * click reached it ({@link withLiveElement}). An `aria-ref` resolves to the replaced node again, so its replacement
	 * fails at once.
	 */
	#clickSelector(
		selector: string,
		timeoutMs: number,
		sig: AbortSignal,
		click: (handle: ElementHandle) => Promise<void>,
	): Promise<void> {
		return withLiveElement(
			() => this.#resolveActionHandle(selector, timeoutMs, sig),
			async handle => {
				try {
					await click(handle);
				} finally {
					void handle.dispose().catch(() => undefined);
				}
			},
			sig,
			{ retry: parseAriaRefSelector(selector) === null },
		);
	}

	#clearElementCache(): void {
		this.#observedElements.clear();
		if (this.#elementCache.size === 0) {
			this.#elementCounter = 0;
			return;
		}
		const handles = [...this.#elementCache.values()];
		this.#elementCache.clear();
		this.#elementCounter = 0;
		for (const handle of handles) void handle.dispose().catch(() => undefined);
	}

	/** Best-effort `Page.stopLoading` so an abandoned navigation cannot stall later ops. */
	async #stopLoading(): Promise<void> {
		try {
			const session = await this.#requirePage().createCDPSession();
			try {
				await session.send("Page.stopLoading");
			} finally {
				await session.detach().catch(() => undefined);
			}
		} catch (error) {
			this.#log("debug", "Page.stopLoading failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Inline counterpart of `Worker.terminate()`: stop taking messages, abort the active run, and drop the browser
	 * connection (a connected core keeps Chrome's debugger attached to the tab), even under a close in progress.
	 */
	terminate(): void {
		this.#stop();
		this.#active?.ac.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Tab worker terminated")));
		if (this.#browser?.connected) void this.#browser.disconnect();
	}

	/** Stop taking messages; false when the core had already stopped. */
	#stop(): boolean {
		if (this.#stopped) return false;
		this.#stopped = true;
		this.#unsub();
		this.#uninstallRejectionGuard();
		return true;
	}

	async #close(keepPage: boolean): Promise<void> {
		if (!this.#stop()) return;
		this.#clearElementCache();
		const page = this.#page;
		await this.#recording.close().catch(error => {
			this.#log("warn", "Failed to finalize active browser recording during tab close", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		await this.#webmcp?.dispose().catch(() => undefined);
		this.#webmcp = undefined;
		this.#dialogs?.dispose();
		await this.#network?.close();
		await this.#downloads?.close();
		await this.#tracing?.dispose();
		await this.#consoleCapture.detach();
		// A borrowed page outlives this tab; detaching restores its certificate checks.
		await this.#certificateOverride?.detach().catch(() => undefined);
		this.#certificateOverride = undefined;
		this.#emulation?.dispose();
		if (this.#ownsPage && !keepPage && page && !page.isClosed()) await page.close().catch(() => undefined);
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireUploads(): UploadStaging {
		if (!this.#uploads) throw new ToolError("Tab worker is not initialized");
		return this.#uploads;
	}

	#requireDialogs(): RuntimeDialogController {
		if (!this.#dialogs) throw new ToolError("Tab worker dialog handling is not initialized");
		return this.#dialogs;
	}

	#requireNetwork(): BrowserNetworkManager {
		if (!this.#network) throw new ToolError("Tab worker network manager is not initialized");
		return this.#network;
	}

	#requireTracing(): BrowserTracingController {
		if (!this.#tracing) throw new ToolError("Tab worker tracing is not initialized");
		return this.#tracing;
	}

	#requireInitScripts(): InitScriptManager {
		if (!this.#initScripts) throw new ToolError("Tab worker init scripts are not initialized");
		return this.#initScripts;
	}

	#requireDownloads(): DownloadManager {
		if (!this.#downloads) throw new ToolError("Tab worker downloads are not initialized");
		return this.#downloads;
	}

	#requireEmulation(): BrowserEmulationController {
		if (!this.#emulation) throw new ToolError("Tab worker emulation is not initialized");
		return this.#emulation;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
