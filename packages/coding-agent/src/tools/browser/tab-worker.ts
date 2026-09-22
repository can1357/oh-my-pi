import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { postmortem, Snowflake, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "@oh-my-pi/pi-utils/dom";
import type {
	Browser,
	CDPSession,
	ElementHandle,
	HTTPResponse,
	JSHandle,
	KeyboardTypeOptions,
	KeyInput,
	Page,
	Realm,
	SerializedAXNode,
	Target,
} from "puppeteer-core";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { formatScreenshot, resizeImage } from "../../utils/image-resize";
import { resolveToCwd } from "../path-utils";
import {
	bindRunFacade,
	CELL_BUDGET_SLACK_MS,
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
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria/aria-snapshot";
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
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	isPuppeteerHandle,
	loadPuppeteerInWorker,
	loadedKnownDevices,
	loadedNetworkConditions,
} from "./launch";
import { extractReadableFromHtml, type ReadableExtractOptions, type ReadableFormat } from "./readable";
import { assertTabPressArgs } from "./tab-arguments";
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
import { enableReact, type ReactEnableResult } from "./react/devtools-hook";
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
import { registerSemanticQueryHandlers } from "./query-handlers";
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
import { applyIgnoreHttpsErrors } from "./open-options";
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
	installWebMcp,
	type WebMcpController,
	type WebMcpEventsOptions,
	type WebMcpEventsResult,
	type WebMcpInvokeOptions,
	type WebMcpInvokeResult,
	type WebMcpListOptions,
	type WebMcpListResult,
} from "./webmcp";
import {
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
	clickAt,
	clickElement,
	clickQueryHandlerText,
	highlightElement,
	type HighlightOptions,
	type InteractionHandle,
	keyDown,
	keyUp,
	mouseDown,
	mouseMove,
	mouseUp,
	setElementChecked,
	type ScrollOptions,
	uploadFilesToElement,
	wheel,
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
	screenshotQuality,
	screenshotScope,
	screenshotThreshold,
} from "./screenshot";
import { RuntimeDialogController, type DialogPolicy, type DialogState } from "./dialogs";
import {
	type BrowserFrameApi,
	type BrowserFrameInfo,
	captureFrameScreenshot,
	createFrameApi,
	listFrames,
	resolveFrame,
} from "./frames";
import { pushState, reloadPage, traverseHistory, type NavigationWaitUntil } from "./navigation";

import { cloneSafe, RunOutput } from "./run-output";
import type {
	Observation,
	ObservationEntry,
	ReadyInfo,
	RunErrorPayload,
	ScreenshotResult,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
} from "./tab-protocol";

declare module "puppeteer-core" {
	interface Frame {
		/** Puppeteer's main JavaScript realm, retained by our pinned runtime patch. */
		mainRealm(): Realm;
	}
	interface Realm {
		/** Re-home a DOM handle into this realm (`@internal` upstream, stripped from published types). */
		adoptHandle<T extends JSHandle>(handle: T): Promise<T>;
	}
	interface JSHandle {
		/** Realm that created this handle (`@internal` upstream, stripped from published types). */
		readonly realm: Realm;
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

/**
 * Playwright-only selector engines/pseudos puppeteer cannot parse. Without this guard a
 * `tab.click(":has-text(...)")` would wait the full action timeout and fail opaquely;
 * fail fast instead with a pointer to the puppeteer-native alternative. Skipped for
 * explicit query-handler prefixes (`text/`, `aria/`, …) whose payload is literal text.
 */
const PLAYWRIGHT_ONLY_SELECTOR_RE =
	/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b|:hidden\b|:nth-match\(|:near\(|:above\(|:below\(|:right-of\(|:left-of\(/;

type DragTarget = string | { readonly x: number; readonly y: number };

/**
 * Per-op fail-fast ceilings for `tab.*` helpers. All are kept strictly under the cell
 * budget (`timeoutMs - OP_DEADLINE_SLACK_MS`) so a stalled helper rejects with a named,
 * attributable error that leaves recovery budget — never the opaque whole-cell
 * "Browser code execution timed out" path that consumed the entire run.
 *
 * - `QUICK_OP_TIMEOUT_MS`: page-coupled reads that should resolve fast (`observe`,
 *   `screenshot`, `extract`, `ariaSnapshot`).
 * - `ACTION_OP_TIMEOUT_MS`: interactive point actions (`click`, `fill`, `type`, …) and
 *   the default for wait helpers when no explicit `{ timeout }` is given. Selector ops
 *   additionally fail fast after `ZERO_MATCH_FAIL_FAST_MS` of confirmed zero matches
 *   (see `#zeroMatchWatchdog`), so the full ceiling is only spent on elements that
 *   exist but are not yet actionable.
 *
 * `goto` and `evaluate` stay uncapped (`Number.POSITIVE_INFINITY`): navigation and user
 * code legitimately use the full cell budget.
 */
const QUICK_OP_TIMEOUT_MS = 20_000;
const ACTION_OP_TIMEOUT_MS = 8_000;
/** Maximum wait for a renderer acknowledgement after a wheel event is queued. */
const SCROLL_ACK_TIMEOUT_MS = 2_000;
/** Headroom subtracted from the cell budget so a per-op deadline fires before it. */
const OP_DEADLINE_SLACK_MS = CELL_BUDGET_SLACK_MS;
/**
 * A selector op whose selector has matched nothing for this long fails fast with the
 * zero-match hint instead of burning the rest of its deadline: a wrong selector or a
 * wrong page (consent wall, pre-navigation document) is the common agent failure and
 * should cost ~2s, not the full action ceiling. Explicit `{ timeout }` waits opt out.
 */
const ZERO_MATCH_FAIL_FAST_MS = 2_000;
/** Poll cadence for the zero-match watchdog. */
const ZERO_MATCH_POLL_MS = 250;
/** Cleanup must settle inside the supervisor's 750ms post-run grace window. */
const REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 500;
/** Bound cleanup window after a timed-out raw handle action. */
const HANDLE_ACTION_INVALIDATION_TIMEOUT_MS = 500;

export interface OpTimeouts {
	/** Largest per-op deadline allowed — strictly below the cell budget. */
	budgetBound: number;
	/** Ceiling for quick page reads. */
	quickOpMs: number;
	/** Ceiling for interactive actions + default for waits. */
	actionOpMs: number;
}

/** Resolve the per-op fail-fast ceilings for a given cell budget. */
export function resolveOpTimeouts(cellTimeoutMs: number): OpTimeouts {
	const budgetBound = Math.max(1, cellTimeoutMs - OP_DEADLINE_SLACK_MS);
	return {
		budgetBound,
		quickOpMs: Math.min(budgetBound, QUICK_OP_TIMEOUT_MS),
		actionOpMs: Math.min(budgetBound, ACTION_OP_TIMEOUT_MS),
	};
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

/**
 * Effective timeout for a wait helper (`waitFor*`). A positive explicit `{ timeout }` is
 * honored but clamped to the cell budget so it still fails fast + named; raising the tool
 * `timeout` raises that cap, so a longer budget stays meaningful. No `{ timeout }` → the
 * action ceiling. Puppeteer's `{ timeout: 0 }` / `Infinity` ("disable") maps to the largest
 * bounded wait (`budgetBound`) — the harness never permits an unbounded wait. Garbage input
 * (negative, `NaN`) falls back to the action ceiling rather than the longest wait.
 */
export function resolveWaitTimeout(cellTimeoutMs: number, explicit?: number): number {
	const { budgetBound, actionOpMs } = resolveOpTimeouts(cellTimeoutMs);
	if (explicit === undefined) return actionOpMs;
	// Puppeteer "disable" sentinels — still bounded by the budget here.
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
	// Positive finite → honored + clamped. Negative/NaN garbage → default, not the longest wait.
	if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return actionOpMs;
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
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: KeyInput, opts?: { selector?: string }): Promise<void>;
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
	waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<ActionableHandle | null>;
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
	text(selector: string): Promise<string | null>;
	html(selector: string): Promise<string | null>;
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
 * hanging on puppeteer's protocol timeout.
 */
export type HandleOpGuard = <T>(label: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;

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
	type: ElementHandle["type"];
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
		void pending.catch(() => undefined);
		await withTimeout(
			Promise.all([handle.dispose().catch(() => undefined), invalidate?.().catch(() => undefined)]),
			HANDLE_ACTION_INVALIDATION_TIMEOUT_MS,
			`Timed out invalidating ${label}`,
		).catch(() => undefined);
		throw error;
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
 * `tab.fill()`: focus, clear any existing value, then type.
 */
export function toActionableHandle(
	handle: ElementHandle,
	guard?: HandleOpGuard,
	invalidate?: () => Promise<void>,
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
		enriched.fill = value => fillViaHandle(enriched, value, undefined, preserved?.type);
		enriched.click = options =>
			clickElement(enriched, "handle.click()", undefined, {
				button: options?.button,
				clickCount: options?.count,
			});
		enriched.dblclick = () => clickElement(enriched, "handle.dblclick()", undefined, { clickCount: 2 });
		enriched.check = () => setElementChecked(enriched, true, "handle.check()");
		enriched.uncheck = () => setElementChecked(enriched, false, "handle.uncheck()");
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
		originals = { interactive, type: enriched.type.bind(enriched) };
		enriched[RAW_HANDLE_METHODS] = originals;
	}

	for (const method of GUARDED_HANDLE_METHODS) {
		if (method === "type") continue;
		const original = originals.interactive[method];
		if (!original) continue;
		methods[method] = (...args) =>
			guard(`handle.${method}()`, signal =>
				runGuardedHandleAction(
					enriched,
					originals,
					`handle.${method}()`,
					signal,
					() => original(...args),
					invalidate,
				),
			);
	}
	enriched.type = (text, options) =>
		guard<void>("handle.type()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.type()",
				signal,
				() => typeViaHandle(enriched, text, options, signal),
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
				() => fillViaHandle(enriched, value, signal, text => typeViaHandle(enriched, text, { delay: 0 }, signal)),
				invalidate,
			),
		);
	enriched.click = options =>
		guard<void>("handle.click()", signal =>
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
		);
	enriched.dblclick = () =>
		guard<void>("handle.dblclick()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.dblclick()",
				signal,
				() => clickElement(enriched, "handle.dblclick()", signal, { clickCount: 2 }),
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
	return enrichElementQueries(enriched, guard);
}

/** Focus once, then type one code point at a time so abort stops before the next key dispatch. */
async function typeViaHandle(
	handle: ElementHandle,
	text: string,
	options: Readonly<KeyboardTypeOptions> | undefined,
	signal: AbortSignal,
): Promise<void> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const node = el as unknown as { focus?: () => void };
			node.focus?.();
		}),
	);
	for (const character of text) {
		throwIfAborted(signal);
		await untilAborted(signal, () => handle.frame.page().keyboard.type(character, options));
	}
}

/** Focus, clear any existing value, then retype — shared by `tab.fill(aria-ref)` and enriched handles. */
async function fillViaHandle(
	handle: ElementHandle,
	value: string,
	signal?: AbortSignal,
	type: (text: string) => Promise<unknown> = text => handle.type(text, { delay: 0 }),
): Promise<void> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const node = el as unknown as { value?: string; focus?: () => void };
			node.focus?.();
			if ("value" in node) node.value = "";
		}),
	);
	await untilAborted(signal, () => type(value));
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

interface RunPageScope {
	page: Page;
	cleanup(): Promise<void>;
}

/**
 * Expose the tab page while retaining every event handler created by this run.
 * The facade removes only run-owned listeners, preserving worker-level routing,
 * request logging, dialogs, and console capture. Raw interception is restored
 * to the tab's persistent route/allowlist state after the run.
 */
function createRunPageScope(page: Page, restoreInterception: () => Promise<void>): RunPageScope {
	const handlers = new Map<unknown, unknown[]>();
	const on = page.on;
	const off = page.off;
	const once = page.once;
	const onDescriptor = Object.getOwnPropertyDescriptor(page, "on");
	const offDescriptor = Object.getOwnPropertyDescriptor(page, "off");
	const onceDescriptor = Object.getOwnPropertyDescriptor(page, "once");
	const removeAllDescriptor = Object.getOwnPropertyDescriptor(page, "removeAllListeners");

	const remember = (type: unknown, handler: unknown): void => {
		const owned = handlers.get(type);
		if (owned) owned.push(handler);
		else handlers.set(type, [handler]);
	};
	const forget = (type: unknown, handler?: unknown): void => {
		const owned = handlers.get(type);
		if (!owned) return;
		if (handler === undefined) {
			for (const registered of owned) Reflect.apply(off, page, [type, registered]);
			handlers.delete(type);
			return;
		}
		const index = owned.lastIndexOf(handler);
		if (index < 0) return;
		Reflect.apply(off, page, [type, handler]);
		owned.splice(index, 1);
		if (owned.length === 0) handlers.delete(type);
	};

	Object.defineProperties(page, {
		on: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				Reflect.apply(on, page, [type, handler]);
				remember(type, handler);
				return page;
			},
		},
		once: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				if (typeof handler !== "function") {
					Reflect.apply(once, page, [type, handler]);
					return page;
				}
				const wrapper = (event: unknown): void => {
					forget(type, wrapper);
					Reflect.apply(handler, page, [event]);
				};
				remember(type, wrapper);
				Reflect.apply(on, page, [type, wrapper]);
				return page;
			},
		},
		off: {
			configurable: true,
			value: (type: unknown, handler?: unknown): Page => {
				forget(type, handler);
				return page;
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
	});

	return {
		page,
		async cleanup() {
			if (onDescriptor) Object.defineProperty(page, "on", onDescriptor);
			else Reflect.deleteProperty(page, "on");
			if (offDescriptor) Object.defineProperty(page, "off", offDescriptor);
			else Reflect.deleteProperty(page, "off");
			if (onceDescriptor) Object.defineProperty(page, "once", onceDescriptor);
			else Reflect.deleteProperty(page, "once");
			if (removeAllDescriptor) Object.defineProperty(page, "removeAllListeners", removeAllDescriptor);
			else Reflect.deleteProperty(page, "removeAllListeners");
			for (const [type, owned] of handlers) {
				for (const handler of owned) Reflect.apply(off, page, [type, handler]);
			}
			handlers.clear();
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
		};
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
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

function privateTargetId(target: Target): string | undefined {
	const raw = target as unknown as { _targetId?: unknown };
	return typeof raw._targetId === "string" ? raw._targetId : undefined;
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

async function createTrackedHeadlessPage(browser: Browser, reportTarget: (targetId: string) => void): Promise<Page> {
	const session = await browser.target().createCDPSession();
	let targetId: string;
	try {
		({ targetId } = await session.send("Target.createTarget", { url: "about:blank" }));
		reportTarget(targetId);
	} finally {
		await session.detach().catch(() => undefined);
	}
	const existing = browser.targets().find(target => privateTargetId(target) === targetId);
	const target =
		existing ??
		(await browser.waitForTarget(candidate => privateTargetId(candidate) === targetId, {
			timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		}));
	const page = await target.page();
	if (!page) throw new ToolError(`Created headless target ${targetId} did not expose a page`);
	return page;
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

async function collectObservationEntries(
	core: WorkerCore,
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
	if ((options.includeAll || isInteractiveNode(node)) && !(options.compact && emptyStructural)) {
		const handle = await node.elementHandle();
		if (handle) {
			let inViewport = true;
			if (options.viewportOnly) {
				try {
					inViewport = await handle.isIntersectingViewport();
				} catch {
					inViewport = false;
				}
			}
			if (inViewport) {
				const id = core.nextElementId();
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
				core.cacheElement(id, handle as ElementHandle);
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
				await handle.dispose();
			}
		}
	}
	for (const child of node.children ?? []) {
		await collectObservationEntries(core, child, entries, options);
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
}

/** Human-readable label for a screenshot op, used in op tracking + timeout errors. */
export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}
export async function preparePageForScreenshot(
	page: Pick<Page, "bringToFront" | "evaluate">,
	signal: AbortSignal | undefined,
	activate: boolean,
): Promise<void> {
	if (activate) {
		await untilAborted(signal, () => page.bringToFront()).catch(() => undefined);
		return;
	}
	const visible = await untilAborted(signal, () => page.evaluate(() => document.visibilityState === "visible")).catch(
		() => false,
	);
	if (!visible) {
		throw new ToolError("The attached browser tab is not visible; switch to it before taking a screenshot");
	}
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
	#elementCache = new Map<number, ElementHandle>();
	#elementCounter = 0;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#isolated: boolean;
	#uninstallRejectionGuard: () => void;
	#mode?: WorkerInitPayload["mode"];
	#activateForScreenshot = true;
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
	readonly #recording = new RecordingController();

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

	nextElementId(): number {
		this.#elementCounter += 1;
		return this.#elementCounter;
	}

	cacheElement(id: number, handle: ElementHandle): void {
		this.#elementCache.set(id, handle);
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
				await this.#close();
				return;
		}
	}

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			this.#activateForScreenshot = payload.mode === "headless" || payload.activateForScreenshot !== false;
			const puppeteer = await loadPuppeteerInWorker(payload.safeDir);
			registerSemanticQueryHandlers(puppeteer);
			this.#browser = await puppeteer.connect({
				browserWSEndpoint: payload.browserWSEndpoint,
				defaultViewport: null,
				protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
			});

			// Realm setup is done: puppeteer loaded and browser connected. Sent before
			// page acquisition so the supervisor's cold-start budget bounds only the
			// realm setup; page creation and the first navigation run under the ready
			// wait.
			this.#transport.send({ type: "setup" });
			if (payload.mode === "headless") {
				// Create the target directly so its id is reportable before
				// Puppeteer waits for target/page initialization. If that wait
				// wedges, the supervisor can still close the created target.
				this.#page = await createTrackedHeadlessPage(this.#browser, targetId => {
					this.#transport.send({ type: "page-created", targetId });
				});
				this.#observeDialogs();
				await applyStealthPatches(this.#browser, this.#page, { browserSession: null, override: null });
				if (payload.emulateViewport !== false) await applyViewport(this.#page, payload.viewport);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			} else {
				const target = await this.#findAttachedTarget(payload.targetId);
				// Post-timeout recycle: unblock the target BEFORE adopting the page — an open
				// modal dialog or hung navigation can stall `target.page()` / ready info, and a
				// stalled init used to time out and force-kill the tab.
				if (payload.recover) await this.#recoverAttachedTarget(target);
				const page = await target.page();
				if (!page) throw new ToolError(`Target ${payload.targetId} is no longer available on the attached browser`);
				this.#page = page;
				await this.#claimRelayTarget(page);
				this.#observeDialogs();
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			if (payload.mode === "headless" || payload.emulateFocus) {
				// Background Chromium tabs stop producing frames, stalling rAF,
				// IntersectionObserver, and input acknowledgements. Keep owned tabs
				// interactive without raising a window; explicit settle-freeze still applies.
				await this.#page.emulateFocusedPage(true);
			}
			this.#webmcp = await installWebMcp(this.#page);
			await installVitalsObservers(this.#page);
			if (payload.userAgent !== undefined) await applyUserAgentOverride(this.#page, payload.userAgent);
			if (payload.ignoreHttpsErrors) await applyIgnoreHttpsErrors(this.#page);
			this.#targetId = await targetIdForPage(this.#page);
			this.#initScripts = new InitScriptManager(this.#page);
			for (const source of payload.initScripts ?? []) await this.#initScripts.add(source);
			this.#downloads = new DownloadManager(this.#browser, this.#page, this.#targetId);
			if (payload.downloadsPath) await this.#downloads.enable(payload.downloadsPath);
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
			if (payload.url) {
				await this.#page.goto(payload.url, {
					// Default to "load" because dev servers with HMR/WS never reach networkidle.
					waitUntil: payload.waitUntil ?? "load",
					timeout: payload.timeoutMs,
				});
			}
			this.#targetId = await targetIdForPage(this.#page);
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			// A failed headless init leaves the worker's page orphaned in the shared
			// browser (the supervisor retries with a fresh worker), so close it before
			// reporting. Attach mode adopts an existing target — never close it.
			const page = this.#page;
			await this.#webmcp?.dispose().catch(() => undefined);
			this.#webmcp = undefined;
			if (payload.mode === "headless" && page && !page.isClosed()) {
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
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

	/**
	 * Tell the omp browser relay this worker drives the adopted page, so the
	 * relay adds it to the per-window "omp" tab group. Best-effort: plain CDP
	 * backends (real Chrome, cmux) reject the relay-private method.
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
			viewport: page.viewport() ?? DEFAULT_VIEWPORT,
			targetId,
		};
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
		};
		this.#active = active;
		let completed = false;
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
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
				page: bindRunFacade(runPage.page, signal, active.rejectionOwner, onFloatingRejection),
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
			try {
				await runPage?.cleanup();
			} catch (error) {
				failure = { error };
			}
			failure = this.#foldFloatingRejections(active, failure);
			if (this.#active?.id === msg.id) this.#active = null;
		}
		if (failure) {
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(failure.error) });
			return;
		}
		if (completed) {
			await this.#postReadyInfo();
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: true,
				payload: { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots },
			});
		}
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
	 * matched nothing for that long.
	 */
	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
		opts?: { selector?: string; zeroMatchAfterMs?: number },
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
		// Fired when the watchdog wins the race (tears down the in-flight action) and in
		// the finally (stops the watchdog's polling once the op settles either way).
		const earlyAc = new AbortController();
		try {
			if (!watchdog) return await fn(opSignal);
			const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
			return await Promise.race([
				fn(racedSignal),
				this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal),
			]);
		} catch (err) {
			// Fail fast with a named, attributable error instead of the opaque whole-cell timeout:
			// our per-op deadline fired, or puppeteer's own (equal) timeout fired first — having
			// already torn down the CDP action via the op signal, so no work is left dangling.
			// Cell-budget aborts and uncapped helpers (goto/evaluate) keep their native errors.
			if (
				capped &&
				!cellSignal.aborted &&
				(opTimeout?.aborted || (err instanceof Error && err.name === "TimeoutError"))
			) {
				const hint = selector ? await this.#selectorTimeoutHint(selector) : "";
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
	 * Best-effort match-count probe for a timed-out selector op. Never throws;
	 * empty string when the probe fails, stalls, or the selector is an aria-ref.
	 */
	async #selectorTimeoutHint(selector: string): Promise<string> {
		if (parseAriaRefSelector(selector) !== null) return "";
		try {
			const handles = await Promise.race([
				this.#requirePage().$$(normalizeSelector(selector)),
				Bun.sleep(1_000).then(() => null),
			]);
			if (!handles) return "";
			const count = handles.length;
			for (const handle of handles) void handle.dispose().catch(() => undefined);
			return formatSelectorMatchHint(count);
		} catch {
			return "";
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
			selectorOpts?: { selector?: string; zeroMatchAfterMs?: number },
		): Promise<T> => markHandled(this.#runOp(active, label, signal, perOpMs, fn, selectorOpts));
		// Hand user-facing handles the fail-fast per-op guard so their interactive
		// methods (`.click()`, `.type()`, …) can't outrun the cell budget (issue #9535).
		const enrich = (handle: ElementHandle): ActionableHandle =>
			toActionableHandle(
				handle,
				(label, fn) => op(label, actionOpMs, fn),
				async () => {
					// Raw Puppeteer actions have no AbortSignal. Poison + dispose every
					// cached handle and stop navigation before reporting a recoverable timeout.
					this.#clearElementCache();
					await this.#stopLoading();
				},
			);
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => op("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
			goto: (url, opts) =>
				op(`tab.goto(${JSON.stringify(url)})`, INF, async sig => {
					this.#clearElementCache();
					try {
						// Default to "load" because dev servers with HMR/WS never reach networkidle.
						// budgetBound (not the full cell) so a hung navigation fails named and
						// catchable inside the run instead of dying with the whole cell.
						await untilAborted(sig, () =>
							page.goto(url, { waitUntil: opts?.waitUntil ?? "load", timeout: budgetBound }),
						);
					} catch (err) {
						if (err instanceof Error && err.name === "TimeoutError") {
							// Abandon the hung navigation NOW — a still-pending load stalls every
							// later op on this page and cascades into more opaque timeouts.
							await this.#stopLoading();
							throw new ToolError(
								`tab.goto(${JSON.stringify(url)}) timed out after ${budgetBound}ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:"domcontentloaded"`,
							);
						}
						throw err;
					}
				}),
			observe: opts => op("tab.observe()", quickOpMs, sig => this.#collectObservation({ ...opts, signal: sig })),
			ariaSnapshot: (selector, opts) =>
				op(
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
				op(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, output, screenshots, sig, opts),
				),
			extract: (format = "markdown", opts) =>
				op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
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
			click: selector =>
				op(`tab.click(${JSON.stringify(selector)})`, actionOpMs, async sig => {
					const label = `tab.click(${JSON.stringify(selector)})`;
					const resolved = normalizeSelector(selector);
					if (resolved.startsWith("text/") && parseAriaRefSelector(selector) === null) {
						await clickQueryHandlerText(page, resolved, label, actionOpMs, sig);
						return;
					}
					const handle =
						parseAriaRefSelector(selector) !== null
							? await this.#resolveAriaRef(selector)
							: ((await untilAborted(sig, () => page.$(resolved))) as ElementHandle | null);
					if (!handle) throw new ToolError(`${label} matched no visible element`);
					try {
						await clickElement(handle, label, sig);
					} finally {
						void handle.dispose().catch(() => undefined);
					}
				}),
			type: (selector, text) =>
				op(
					`tab.type(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () => handle.type(text, { delay: 0 }));
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			fill: (selector, value) =>
				op(
					`tab.fill(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						if (parseAriaRefSelector(selector) !== null) {
							const handle = await this.#resolveAriaRef(selector);
							try {
								await fillViaHandle(handle, value, sig);
							} finally {
								await handle.dispose().catch(() => undefined);
							}
							return;
						}
						await untilAborted(sig, () =>
							page.locator(normalizeSelector(selector)).setTimeout(actionOpMs).fill(value, { signal: sig }),
						);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			press: (key, opts) =>
				op(`tab.press(${JSON.stringify(key)})`, actionOpMs, async sig => {
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
					await untilAborted(sig, () => page.keyboard.press(key));
				}),
			scroll: (deltaX, deltaY, opts) =>
				op("tab.scroll()", actionOpMs, async sig => {
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
			drag: (from, to) => op("tab.drag()", actionOpMs, sig => this.#drag(from, to, sig)),
			waitFor: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitFor(${JSON.stringify(selector)})`,
					w,
					async sig => enrich(await this.#resolveActionHandle(selector, w, sig)),
					{ selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			waitForSelector: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitForSelector(${JSON.stringify(selector)})`,
					w,
					async sig => {
						if (parseAriaRefSelector(selector) !== null) return enrich(await this.#resolveAriaRef(selector));
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
						zeroMatchAfterMs: opts?.timeout === undefined && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : undefined,
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
				op("tab.evaluate()", INF, sig =>
					untilAborted(sig, async () => {
						const realm = page.mainFrame().mainRealm();
						// Puppeteer evaluates strings as expressions and ignores extra args; preserve
						// that behavior without inspecting or adopting otherwise-unused handles.
						if (typeof fn === "string") return realm.evaluate(fn);
						const { args: adopted, dispose } = await adoptElementArgs(realm, args);
						try {
							throwIfAborted(sig);
							return await realm.evaluate(fn as (...a: unknown[]) => unknown, ...adopted);
						} finally {
							await dispose();
						}
					}),
				) as never,
			scrollIntoView: selector =>
				op(
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
				op(
					`tab.select(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#select(selector, values, actionOpMs, sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uploadFile: (selector, ...filePaths) =>
				op(
					`tab.uploadFile(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#uploadFile(selector, filePaths, actionOpMs, sig, session),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			waitForUrl: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForUrl()", w, sig => this.#waitForUrl(pattern, w, sig));
			},
			waitForResponse: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForResponse()", w, sig => this.#waitForResponse(pattern, w, sig));
			},
			id: async id => enrich(await this.#resolveCachedHandle(id)),
			ref: async id => enrich(await this.#resolveAriaRef(id)),
			cookies: opts => op("tab.cookies()", quickOpMs, sig => readCookies(page, opts, sig)),
			setCookies: (...cookies) => op("tab.setCookies()", actionOpMs, sig => setPageCookies(page, cookies, sig)),
			clearCookies: opts => op("tab.clearCookies()", actionOpMs, sig => clearPageCookies(page, opts, sig)),
			storage: (kind, opts) => op("tab.storage()", quickOpMs, sig => readStorage(page, kind, opts, sig)),
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
					this.#recording.start(page, destination, session.cwd, opts, sig),
				),
			recordStop: () =>
				op("tab.recordStop()", budgetBound, sig =>
					this.#recording.stop({ signal: sig, output, excludeWebP: session.excludeWebP }),
				),
			recordRestart: (destination, opts) =>
				op(`tab.recordRestart(${JSON.stringify(destination)})`, budgetBound, sig =>
					this.#recording.restart(page, destination, session.cwd, opts, {
						signal: sig,
						output,
						excludeWebP: session.excludeWebP,
					}),
				),
			recording: () => op("tab.recording()", quickOpMs, () => Promise.resolve(this.#recording.status())),
			webmcpList: opts => op("tab.webmcpList()", quickOpMs, sig => untilAborted(sig, () => webmcp.list(opts))),
			webmcpInvoke: (toolName, params, opts) => {
				const w = waitMs(opts?.timeout);
				return op(`tab.webmcpInvoke(${JSON.stringify(toolName)})`, w, sig =>
					untilAborted(sig, () => webmcp.invoke(toolName, params, opts)),
				);
			},
			webmcpEvents: opts => op("tab.webmcpEvents()", quickOpMs, sig => untilAborted(sig, () => webmcp.events(opts))),
			a11y: opts =>
				op("tab.a11y()", budgetBound, async sig => {
					const result = await untilAborted(sig, () => runA11yAudit(page, opts));
					output.push({ type: "text", text: formatA11ySummary(result) });
					return result;
				}),
			vitals: opts => op("tab.vitals()", INF, sig => collectVitals(page, opts, sig)),
			reactEnable: () => op("tab.reactEnable()", INF, sig => enableReact(page, sig)),
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
			frames: () => op("tab.frames()", quickOpMs, sig => listFrames(page, sig)),
			frame: selectorOrNameOrUrl =>
				op(`tab.frame(${JSON.stringify(selectorOrNameOrUrl)})`, quickOpMs, async sig => {
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
				op("tab.diffScreenshot()", quickOpMs, sig =>
					this.#diffScreenshot(session, output, screenshots, sig, baselinePath, opts),
				),
			pdf: opts => op("tab.pdf()", quickOpMs, sig => this.#pdf(session, sig, opts)),
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
			text: selector =>
				op(`tab.text(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryText(page, normalizeSelector(selector), sig),
				),
			html: selector =>
				op(`tab.html(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryHtml(page, normalizeSelector(selector), sig),
				),
			value: selector =>
				op(`tab.value(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryValue(page, normalizeSelector(selector), sig),
				),
			attr: (selector, attribute) =>
				op(`tab.attr(${JSON.stringify(selector)}, ${JSON.stringify(attribute)})`, quickOpMs, sig =>
					queryAttribute(page, normalizeSelector(selector), attribute, sig),
				),
			count: selector =>
				op(`tab.count(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryCount(page, normalizeSelector(selector), sig),
				),
			box: selector =>
				op(`tab.box(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryBox(page, normalizeSelector(selector), sig),
				),
			styles: (selector, props) =>
				op(`tab.styles(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryStyles(page, normalizeSelector(selector), props, sig),
				),
			isVisible: selector =>
				op(`tab.isVisible(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryVisible(page, normalizeSelector(selector), sig),
				),
			isEnabled: selector =>
				op(`tab.isEnabled(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryEnabled(page, normalizeSelector(selector), sig),
				),
			isChecked: selector =>
				op(`tab.isChecked(${JSON.stringify(selector)})`, quickOpMs, sig =>
					queryChecked(page, normalizeSelector(selector), sig),
				),
			waitForText: (text, opts) => {
				const w = waitMs(opts?.timeout);
				return op(`tab.waitForText(${JSON.stringify(text)})`, w, sig =>
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
				op(
					`tab.dblclick(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await clickElement(handle, `tab.dblclick(${JSON.stringify(selector)})`, sig, { clickCount: 2 });
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			hover: selector =>
				op(
					`tab.hover(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () => handle.hover());
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			focus: selector =>
				op(
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
				op(
					`tab.check(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await setElementChecked(handle, true, `tab.check(${JSON.stringify(selector)})`, sig);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			uncheck: selector =>
				op(
					`tab.uncheck(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await setElementChecked(handle, false, `tab.uncheck(${JSON.stringify(selector)})`, sig);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			keyDown: key => op(`tab.keyDown(${JSON.stringify(key)})`, actionOpMs, sig => keyDown(page, key, sig)),
			keyUp: key => op(`tab.keyUp(${JSON.stringify(key)})`, actionOpMs, sig => keyUp(page, key, sig)),
			mouseMove: (x, y, opts) => op("tab.mouseMove()", actionOpMs, sig => mouseMove(page, x, y, opts, sig)),
			mouseDown: opts => op("tab.mouseDown()", actionOpMs, sig => mouseDown(page, opts, sig)),
			mouseUp: opts => op("tab.mouseUp()", actionOpMs, sig => mouseUp(page, opts, sig)),
			clickAt: (x, y, opts) => op("tab.clickAt()", actionOpMs, sig => clickAt(page, x, y, opts, sig)),
			wheel: (deltaX, deltaY) => op("tab.wheel()", actionOpMs, sig => wheel(page, deltaX, deltaY, sig)),
			highlight: (selector, opts) =>
				op(
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
			clipboardCopy: () =>
				op("tab.clipboardCopy()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireEmulation().clipboardCopy()),
				),
			clipboardPaste: () =>
				op("tab.clipboardPaste()", actionOpMs, sig =>
					untilAborted(sig, () => this.#requireEmulation().clipboardPaste()),
				),
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
		try {
			snapshot = (await untilAborted(options.signal, () =>
				page.accessibility.snapshot({ interestingOnly: !includeAll, root: root ?? undefined }),
			)) as SerializedAXNode | null;
		} finally {
			await root?.dispose().catch(() => undefined);
		}
		if (!snapshot) throw new ToolError("Accessibility snapshot unavailable");
		const entries: ObservationEntry[] = [];
		const interactiveAncestors = new Set<SerializedAXNode>();
		if (options.compact) collectInteractiveObservationAncestors(snapshot, interactiveAncestors);
		await collectObservationEntries(this, snapshot, entries, {
			includeAll,
			viewportOnly,
			compact: options.compact ?? false,
			interactiveAncestors,
		});
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
			viewport: page.viewport() ?? DEFAULT_VIEWPORT,
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
		await preparePageForScreenshot(page, signal, this.#activateForScreenshot);
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
		const cleanupAnnotations = opts.annotate
			? await installScreenshotAnnotations(page, annotationTargets, signal)
			: async (): Promise<void> => {};
		const resolveSelector = async (selector: string): Promise<ElementHandle | null> =>
			parseAriaRefSelector(selector) !== null
				? await this.#resolveAriaRef(selector)
				: asElementHandle(await untilAborted(signal, () => page.$(normalizeSelector(selector))));
		let comparisonBuffer: Uint8Array;
		let buffer: Uint8Array;
		try {
			comparisonBuffer = await captureScreenshotBuffer(page, opts, signal, resolveSelector, "png");
			buffer =
				captureFormat === "png"
					? comparisonBuffer
					: await captureScreenshotBuffer(page, opts, signal, resolveSelector, captureFormat);
		} finally {
			await cleanupAnnotations();
		}
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
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
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
		await preparePageForScreenshot(page, signal, this.#activateForScreenshot);
		const absoluteBaseline = resolveToCwd(baselinePath, session.cwd);
		const baseline = await untilAborted(signal, () => fs.promises.readFile(absoluteBaseline));
		const current = await captureScreenshotBuffer(page, {}, signal, async () => null, "png");
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
			await untilAborted(signal, () => page.mouse.move(start.x, start.y));
			await untilAborted(signal, () => page.mouse.down());
			await untilAborted(signal, () => page.mouse.move(end!.x, end!.y, { steps: 12 }));
			await untilAborted(signal, () => page.mouse.up());
		} finally {
			if (start.handle) await start.handle.dispose().catch(() => undefined);
			if (end?.handle) await end.handle.dispose().catch(() => undefined);
		}
	}

	async #select(selector: string, values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			return (await untilAborted(signal, () =>
				handle.evaluate((el, vals) => {
					interface SelectOption {
						value: string;
						selected: boolean;
					}
					interface SelectLike {
						tagName: string;
						options: ArrayLike<SelectOption>;
						dispatchEvent: (event: unknown) => boolean;
					}
					const select = el as unknown as SelectLike;
					if (select?.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
					const EventCtor = (
						globalThis as unknown as { Event: new (type: string, init?: { bubbles: boolean }) => unknown }
					).Event;
					const wanted = new Set(vals as string[]);
					// Assign the full selection first, then read back: on a single
					// <select>, un-selecting the current option mid-loop leaves the
					// browser reporting it selected until another option takes over,
					// which double-counted the old value in the returned list.
					for (let i = 0; i < select.options.length; i++) {
						const opt = select.options[i] as SelectOption;
						opt.selected = wanted.has(opt.value);
					}
					const selected: string[] = [];
					for (let i = 0; i < select.options.length; i++) {
						const opt = select.options[i] as SelectOption;
						if (opt.selected) selected.push(opt.value);
					}
					select.dispatchEvent(new EventCtor("input", { bubbles: true }));
					select.dispatchEvent(new EventCtor("change", { bubbles: true }));
					return selected;
				}, values),
			)) as string[];
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			const absolute = filePaths.map(filePath => resolveToCwd(filePath, session.cwd));
			await uploadFilesToElement(
				this.#requirePage(),
				handle,
				absolute,
				`tab.uploadFile(${JSON.stringify(selector)})`,
				signal,
			);
		} finally {
			await handle.dispose().catch(() => undefined);
		}
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
		const handle = this.#elementCache.get(id);
		if (!handle) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
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
	#clearElementCache(): void {
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

	async #close(): Promise<void> {
		this.#unsub();
		this.#uninstallRejectionGuard();
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
		this.#emulation?.dispose();
		if (this.#mode === "headless" && page && !page.isClosed()) await page.close().catch(() => undefined);
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
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
