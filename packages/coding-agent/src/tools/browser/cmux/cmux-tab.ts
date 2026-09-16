import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, postmortem, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "../../../eval/js/shared/runtime";
import { callSessionTool } from "../../../eval/js/tool-bridge";
import { formatScreenshot, resizeImage } from "../../../utils/image-resize";
import type { ToolSession } from "../../index";
import { resolveToCwd } from "../../path-utils";
import {
	bindRunFacade,
	isBrowserRunOwnedRejection,
	markBrowserRunRejection,
	observeBrowserRunPromise,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../../run-scope";
import { ToolAbortError, throwIfAborted } from "../../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	type BrowserCaptureResult,
	type BrowserConsoleEntry,
	type BrowserConsoleOptions,
	type BrowserErrorEntry,
	type BrowserErrorOptions,
	CMUX_CONSOLE_CAPTURE_SCRIPT,
} from "../console-capture";
import {
	type BrowserA11yOptions,
	type BrowserA11yResult,
	buildA11yPageScript,
	formatA11ySummary,
	normalizeA11yResult,
} from "../a11y/audit";
import type { BrowserEmulateOptions, ClipboardActionResult, ClipboardReadResult } from "../emulation";
import {
	type AriaSnapshotOptions,
	type AriaSnapshotPayload,
	assertSelectorString,
	buildAriaSnapshotPayloadScript,
} from "../aria/aria-snapshot";
import { DEFAULT_VIEWPORT } from "../launch";
import {
	historyBackInPage,
	historyForwardInPage,
	locationHrefInPage,
	pushStateInPage,
	reloadInPage,
} from "../navigation";
import { DEFAULT_STYLE_PROPERTIES } from "../queries";
import type {
	HarContentPolicy,
	NetworkPattern,
	NetworkRequestDetail,
	NetworkRequestRecord,
	NetworkRequestsOptions,
	NetworkRouteDescription,
	NetworkRouteOptions,
} from "../network";
import { extractReadableFromHtml, type ReadableExtractOptions, type ReadableFormat } from "../readable";
import type { VitalsOptions, VitalsResult } from "../react/vitals";
import type { RecordingOptions, RecordingStartResult, RecordingStatus, RecordingStopResult } from "../recording";
import type {
	WebMcpEventsOptions,
	WebMcpEventsResult,
	WebMcpInvokeOptions,
	WebMcpInvokeResult,
	WebMcpListOptions,
	WebMcpListResult,
} from "../webmcp";
import {
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	ariaSnapshotBaselineKey,
	diffAriaSnapshot,
	postProcessAriaSnapshot,
} from "../snapshot-plus";
import {
	createPngDiff,
	type DiffScreenshotOptions,
	type DiffScreenshotResult,
	type PdfOptions,
	type ScreenshotOptions,
	screenshotThreshold,
} from "../screenshot";
import { cloneSafe, RunOutput } from "../run-output";
import type { Observation, ReadyInfo, RunResultOk, ScreenshotResult, SessionSnapshot } from "../tab-protocol";
import {
	type CmuxEvalResult,
	type CmuxGeometry,
	type CmuxScreenshotResult,
	type CmuxSnapshotResult,
	type CmuxUrlGetResult,
	cmuxSnapshotToObservation,
	GEOMETRY_SCRIPT,
	mapWaitUntil,
	serializeEvalWithEnvelope,
	unwrapEvalEnvelope,
} from "./rpc";
import type { CmuxSocketClient } from "./socket-client";

interface PageScreenshotOptions extends ScreenshotOptions {
	encoding?: "base64" | "binary";
}

interface ObserveOptions {
	includeAll?: boolean;
	viewportOnly?: boolean;
	selector?: string;
	compact?: boolean;
}

interface RunContext {
	session: SessionSnapshot;
	output: RunOutput;
	screenshots: ScreenshotResult[];
	signal: AbortSignal;
	timeoutMs: number;
}

type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type DragTarget = string | { readonly x: number; readonly y: number };
type SelectorKind =
	| "css"
	| "ref"
	| "aria-ref"
	| "text"
	| "aria"
	| "xpath"
	| "pierce"
	| "ax"
	| "label"
	| "placeholder"
	| "testid"
	| "alt"
	| "title"
	| "role";

interface SelectorSpec {
	kind: SelectorKind;
	value: string;
	raw: string;
	ref?: string;
	name?: string;
	role?: string;
	exact?: boolean;
}

interface CachedElementRef {
	ref: string;
	name?: string;
	role?: string;
}

interface BoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface FilePayload {
	name: string;
	type: string;
	data: string;
}

type CmuxCaptureEntry = BrowserConsoleEntry | BrowserErrorEntry;

function parseCmuxCaptureResult(serialized: string): BrowserCaptureResult<CmuxCaptureEntry> {
	const value: unknown = JSON.parse(serialized);
	if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries)) {
		throw new ToolError("cmux console capture returned an invalid result");
	}
	const entries: CmuxCaptureEntry[] = [];
	for (const item of value.entries) {
		if (
			!item ||
			typeof item !== "object" ||
			!("seq" in item) ||
			typeof item.seq !== "number" ||
			!("ts" in item) ||
			typeof item.ts !== "number" ||
			!("type" in item) ||
			typeof item.type !== "string" ||
			!("level" in item) ||
			typeof item.level !== "string" ||
			!("text" in item) ||
			typeof item.text !== "string"
		) {
			continue;
		}
		const location = "location" in item && typeof item.location === "string" ? item.location : undefined;
		if (item.type === "console") {
			if (!["log", "info", "warn", "error", "debug"].includes(item.level)) continue;
			const level = item.level as BrowserConsoleEntry["level"];
			entries.push({
				seq: item.seq,
				ts: item.ts,
				type: "console",
				level,
				text: item.text,
				location,
				args: "args" in item && Array.isArray(item.args) ? item.args : [],
			});
			continue;
		}
		if (item.type !== "pageerror") continue;
		entries.push({
			seq: item.seq,
			ts: item.ts,
			type: "pageerror",
			level: "error",
			text: item.text,
			location,
			stack: "stack" in item && typeof item.stack === "string" ? item.stack : undefined,
		});
	}
	const nextSeq = "nextSeq" in value && typeof value.nextSeq === "number" ? value.nextSeq : 0;
	const dropped = "dropped" in value && typeof value.dropped === "number" ? value.dropped : 0;
	return { entries, nextSeq, dropped };
}

interface CmuxResponseRecord {
	id: number;
	ts: number;
	method: string;
	resourceType: "fetch" | "xhr";
	url: string;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	requestHeaders: Record<string, string>;
	body: string;
	durationMs: number;
}

interface ViewportOptions {
	width: number;
	height: number;
	deviceScaleFactor?: number;
}

const PAGE_SELECTOR_HELPERS = `
const isVisible = element => {
	const style = getComputedStyle(element);
	const rect = element.getBoundingClientRect();
	return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
};
const textOf = element => (element.innerText || element.textContent || "").trim();
const allElements = () => Array.from(document.querySelectorAll("body *"));
const pierceQuery = (root, selector) => {
	const direct = root.querySelector?.(selector);
	if (direct) return direct;
	const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
	for (const node of nodes) {
		if (node.shadowRoot) {
			const found = pierceQuery(node.shadowRoot, selector);
			if (found) return found;
		}
	}
	return null;
};
const implicitRole = element => {
	const tag = element.tagName.toLowerCase();
	if (tag === "a" && element.hasAttribute("href")) return "link";
	if (tag === "button") return "button";
	if (tag === "textarea") return "textbox";
	if (tag === "select") return element.multiple || element.size > 1 ? "listbox" : "combobox";
	if (tag === "option") return "option";
	if (tag === "img") return "img";
	if (tag === "ul" || tag === "ol") return "list";
	if (tag === "li") return "listitem";
	if (/^h[1-6]$/.test(tag)) return "heading";
	if (tag !== "input") return null;
	const type = (element.type || "text").toLowerCase();
	if (type === "checkbox") return "checkbox";
	if (type === "radio") return "radio";
	if (type === "range") return "slider";
	if (type === "number") return "spinbutton";
	if (type === "search") return "searchbox";
	if (["button", "submit", "reset", "image"].includes(type)) return "button";
	return ["hidden", "file", "color", "date", "datetime-local", "month", "time", "week"].includes(type)
		? null
		: "textbox";
};
const accessibleName = element => {
	const labelledBy = element.getAttribute("aria-labelledby");
	const referenced = labelledBy
		? labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent || "").join(" ").trim()
		: "";
	const labelled = element.labels ? Array.from(element.labels).map(label => textOf(label)).join(" ").trim() : "";
	return (
		element.getAttribute("aria-label") ||
		referenced ||
		labelled ||
		element.getAttribute("alt") ||
		element.getAttribute("title") ||
		(["button", "submit", "reset"].includes(element.type) ? element.value : "") ||
		textOf(element)
	).trim();
};
const semanticElements = spec => {
	if (!["label", "placeholder", "testid", "alt", "title", "role"].includes(spec.kind)) return null;
	const wanted = spec.value.trim().toLowerCase();
	return allElements().filter(element => {
		if (spec.kind === "label") return accessibleName(element).toLowerCase().includes(wanted);
		if (spec.kind === "placeholder") return (element.getAttribute("placeholder") || "").toLowerCase().includes(wanted);
		if (spec.kind === "testid") return element.getAttribute("data-testid") === spec.value.trim();
		if (spec.kind === "alt") return (element.getAttribute("alt") || "").toLowerCase().includes(wanted);
		if (spec.kind === "title") return (element.getAttribute("title") || "").toLowerCase().includes(wanted);
		const role = (element.getAttribute("role") || implicitRole(element) || "").toLowerCase();
		if (role !== (spec.role || "").toLowerCase()) return false;
		if (!spec.name) return true;
		const name = accessibleName(element).toLowerCase();
		return spec.exact ? name === spec.name.toLowerCase() : name.includes(spec.name.toLowerCase());
	});
};
const findElement = spec => {
	const semantic = semanticElements(spec);
	if (semantic) return semantic[0] || null;
	if (spec.kind === "css") return document.querySelector(spec.value);
	if (spec.kind === "pierce") return pierceQuery(document, spec.value);
	if (spec.kind === "aria-ref") {
		const wanted = spec.value;
		const scan = root => {
			for (const el of Array.from(root.querySelectorAll("*"))) {
				if (el._ariaRef && el._ariaRef.ref === wanted) return el;
				if (el.shadowRoot) {
					const found = scan(el.shadowRoot);
					if (found) return found;
				}
			}
			return null;
		};
		return scan(document);
	}
	if (spec.kind === "xpath") {
		const result = document.evaluate(spec.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
		return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
	}
	if (spec.kind === "text") {
		const wanted = spec.value.trim();
		return allElements().find(element => isVisible(element) && textOf(element).includes(wanted)) || null;
	}
	if (spec.kind === "aria" || spec.kind === "ax") {
		const wanted = (spec.name || spec.value).trim();
		const role = spec.role || "";
		return (
			allElements().find(element => {
				if (!isVisible(element)) return false;
				if (role && element.getAttribute("role") !== role) return false;
				const name = accessibleName(element);
				return name === wanted || name.includes(wanted);
			}) || null
		);
	}
	return null;
};
const findElements = spec => {
	const semantic = semanticElements(spec);
	if (semantic) return semantic;
	if (spec.kind === "css") return Array.from(document.querySelectorAll(spec.value));
	if (spec.kind === "xpath") {
		const result = document.evaluate(spec.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
		return Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index)).filter(Boolean);
	}
	const first = findElement(spec);
	return first ? [first] : [];
};
const event = (target, type, init = {}) =>
	target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
const mouseEvent = (target, type, init = {}) =>
	target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
const inputEvent = target => {
	event(target, "input");
	event(target, "change");
};
const setValue = (target, value, append = false) => {
	if ("value" in target) {
		target.value = append ? String(target.value || "") + value : value;
		inputEvent(target);
		return;
	}
	if (target.isContentEditable) {
		target.textContent = append ? String(target.textContent || "") + value : value;
		inputEvent(target);
	}
};
`;

const RESPONSE_OBSERVER_SCRIPT = String.raw`
(() => {
	const key = "__ompCmuxResponses";
	if (globalThis[key]) return true;
	const state = { nextId: 1, records: [] };
	Object.defineProperty(globalThis, key, { value: state, configurable: true });
	const headersObject = headers => {
		const out = {};
		if (headers && typeof headers.forEach === "function") headers.forEach((value, name) => (out[name] = value));
		return out;
	};
	const remember = async (response, meta) => {
		try {
			const clone = response.clone();
			const body = await clone.text().catch(() => "");
			state.records.push({
				id: state.nextId++,
				ts: meta.ts,
				method: meta.method,
				resourceType: "fetch",
				url: response.url,
				status: response.status,
				statusText: response.statusText,
				headers: headersObject(response.headers),
				requestHeaders: meta.requestHeaders,
				body,
				durationMs: Math.max(0, Date.now() - meta.ts),
			});
			if (state.records.length > 200) state.records.splice(0, state.records.length - 200);
		} catch {
		}
	};
	const originalFetch = globalThis.fetch;
	if (typeof originalFetch === "function") {
		globalThis.fetch = async (...args) => {
			const input = args[0];
			const init = args[1] || {};
			const ts = Date.now();
			const requestHeaders = headersObject(new Headers(init.headers || (input && input.headers)));
			const method = String(init.method || (input && input.method) || "GET").toUpperCase();
			const response = await originalFetch(...args);
			void remember(response, { ts, method, requestHeaders });
			return response;
		};
	}
	const OriginalXHR = globalThis.XMLHttpRequest;
	if (typeof OriginalXHR === "function") {
		globalThis.XMLHttpRequest = function XMLHttpRequestProxy() {
			const xhr = new OriginalXHR();
			let method = "GET";
			let ts = Date.now();
			const requestHeaders = {};
			const originalOpen = xhr.open.bind(xhr);
			xhr.open = (nextMethod, ...args) => {
				method = String(nextMethod || "GET").toUpperCase();
				return originalOpen(nextMethod, ...args);
			};
			const originalSend = xhr.send.bind(xhr);
			xhr.send = (...args) => {
				ts = Date.now();
				return originalSend(...args);
			};
			const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr);
			xhr.setRequestHeader = (name, value) => {
				requestHeaders[String(name).toLowerCase()] = String(value);
				return originalSetRequestHeader(name, value);
			};
			xhr.addEventListener("loadend", () => {
				const rawHeaders = xhr.getAllResponseHeaders();
				const headers = {};
				for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
					const index = line.indexOf(":");
					if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
				}
				state.records.push({
					id: state.nextId++,
					ts,
					method,
					resourceType: "xhr",
					url: xhr.responseURL || "",
					status: xhr.status,
					statusText: xhr.statusText,
					headers,
					requestHeaders,
					body: typeof xhr.responseText === "string" ? xhr.responseText : "",
					durationMs: Math.max(0, Date.now() - ts),
				});
				if (state.records.length > 200) state.records.splice(0, state.records.length - 200);
			});
			return xhr;
		};
	}
	return true;
})()
`;

export interface RunCmuxCodeOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
	snapshot: SessionSnapshot;
}

interface ActiveCmuxRun {
	filename: string;
	floatingRejections: unknown[];
}

const RECENT_CMUX_RUN_FILES_MAX = 256;
const activeCmuxRuns = new Map<string, ActiveCmuxRun>();
const recentCmuxRunFiles = new Set<string>();

function consumeCmuxRunRejection(reason: unknown): boolean {
	// cmux runs guest JS in the shared main-process realm (TTS/STT/MCP and other
	// subsystems live here too), so — like the eval inline fallback — only a
	// guest-file stack frame can safely attribute a rejection. A stackless or
	// non-run-stack reason is indistinguishable from a subsystem failure and
	// keeps the default fatal path; worker isolation is the long-term fix.
	const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : undefined;
	if (!stack) return false;

	let owner: ActiveCmuxRun | undefined;
	let ownerIndex = -1;
	for (const run of activeCmuxRuns.values()) {
		const index = stack.lastIndexOf(run.filename);
		if (index > ownerIndex) {
			ownerIndex = index;
			owner = run;
		}
	}
	if (owner) {
		owner.floatingRejections.push(reason);
		return true;
	}

	let recent: string | undefined;
	let recentIndex = -1;
	for (const filename of recentCmuxRunFiles) {
		const index = stack.lastIndexOf(filename);
		if (index > recentIndex) {
			recentIndex = index;
			recent = filename;
		}
	}
	if (!recent) return false;
	logger.warn("Unhandled rejection from a finished cmux browser run (missing await?)", {
		filename: recent,
		error: reason,
	});
	return true;
}

function rememberCmuxRunFile(filename: string): void {
	recentCmuxRunFiles.delete(filename);
	recentCmuxRunFiles.add(filename);
	if (recentCmuxRunFiles.size <= RECENT_CMUX_RUN_FILES_MAX) return;
	const oldest = recentCmuxRunFiles.values().next().value;
	if (oldest !== undefined) recentCmuxRunFiles.delete(oldest);
}

postmortem.interceptUnhandledRejections(consumeCmuxRunRejection);

export class CmuxTab {
	readonly #client: CmuxSocketClient;
	readonly #surfaceId: string;
	#lastUrl = "about:blank";
	#ariaSnapshotBaselines = new Map<string, AriaSnapshotBaseline>();
	#lastTitle: string | undefined;
	#lastViewport: ReadyInfo["viewport"] = DEFAULT_VIEWPORT;
	readonly #emulationState: BrowserEmulateOptions = {};
	#runContext: RunContext | undefined;
	#runtime: JsRuntime | undefined;
	readonly #elementRefs = new Map<number, CachedElementRef>();
	#pageFacade: CmuxPageFacade | undefined;
	#browserFacade: CmuxBrowserFacade | undefined;
	constructor(opts: { client: CmuxSocketClient; surfaceId: string; url?: string; title?: string }) {
		this.#client = opts.client;
		this.#surfaceId = opts.surfaceId;
		if (opts.url) this.#lastUrl = opts.url;
		this.#lastTitle = opts.title;
	}

	get surfaceId(): string {
		return this.#surfaceId;
	}

	get page(): CmuxPageFacade {
		this.#pageFacade ??= new CmuxPageFacade(this);
		return this.#pageFacade;
	}

	get browser(): CmuxBrowserFacade {
		this.#browserFacade ??= new CmuxBrowserFacade(this);
		return this.#browserFacade;
	}

	viewport(): ReadyInfo["viewport"] {
		return this.#lastViewport;
	}

	async setViewport(viewport: ViewportOptions): Promise<void> {
		this.#lastViewport = {
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: viewport.deviceScaleFactor,
		};
	}

	async emulate(options: BrowserEmulateOptions = {}): Promise<BrowserEmulateOptions> {
		for (const key in options) {
			if (key !== "viewport") {
				throw new ToolError(`tab.emulate() option ${JSON.stringify(key)} is not supported on the cmux backend`);
			}
		}
		if (options.viewport) {
			await this.setViewport({
				width: options.viewport.width,
				height: options.viewport.height,
				deviceScaleFactor: options.viewport.scale,
			});
			this.#emulationState.viewport = { ...options.viewport };
		}
		return structuredClone(this.#emulationState);
	}

	async devices(): Promise<string[]> {
		throw new ToolError("tab.devices() is not supported on the cmux backend");
	}

	async clipboardRead(): Promise<ClipboardReadResult> {
		throw new ToolError("tab.clipboardRead() is not supported on the cmux backend");
	}

	async clipboardWrite(_text: string): Promise<ClipboardActionResult> {
		throw new ToolError("tab.clipboardWrite() is not supported on the cmux backend");
	}

	async clipboardCopy(): Promise<ClipboardActionResult> {
		throw new ToolError("tab.clipboardCopy() is not supported on the cmux backend");
	}

	async clipboardPaste(): Promise<ClipboardActionResult> {
		throw new ToolError("tab.clipboardPaste() is not supported on the cmux backend");
	}

	url(): string {
		return this.#lastUrl;
	}

	async title(): Promise<string> {
		const result = (await this.#request("browser.eval", { script: "document.title" })) as CmuxEvalResult;
		this.#lastTitle = String(result.value ?? "");
		return this.#lastTitle;
	}

	async readyInfo(viewport: ReadyInfo["viewport"] = DEFAULT_VIEWPORT): Promise<ReadyInfo> {
		const urlResult = (await this.#request("browser.url.get", {})) as CmuxUrlGetResult;
		if (typeof urlResult.url === "string" && urlResult.url.length > 0) {
			this.#lastUrl = urlResult.url;
		}
		const geometry = await this.#readGeometry().catch(() => undefined);
		this.#lastViewport = geometry
			? { width: geometry.innerWidth, height: geometry.innerHeight, deviceScaleFactor: geometry.dpr }
			: viewport;
		await this.title().catch(() => "");
		await this.#installResponseObserver().catch(() => undefined);
		return {
			url: this.#lastUrl,
			title: this.#lastTitle,
			viewport: this.#lastViewport,
			targetId: this.#surfaceId,
		};
	}

	setRunContext(context: RunContext): void {
		this.#runContext = context;
	}

	clearRunContext(): void {
		this.#runContext = undefined;
	}

	async a11y(options: BrowserA11yOptions = {}): Promise<BrowserA11yResult> {
		const context = this.#requireRunContext("tab.a11y()");
		const stateKey = `__ompA11y${Snowflake.next()}`;
		const key = JSON.stringify(stateKey);
		const audit = buildA11yPageScript(options);
		await this.#evalScript(`(() => {
			const key = ${key};
			globalThis[key] = { done: false };
			Promise.resolve(${audit}).then(
				value => { globalThis[key] = { done: true, value }; },
				error => { globalThis[key] = { done: true, error: error instanceof Error ? error.message : String(error) }; },
			);
			return true;
		})()`);
		const deadline = Date.now() + context.timeoutMs;
		try {
			while (Date.now() <= deadline) {
				const state = await this.#evalScript<Record<string, unknown>>(`globalThis[${key}] || { done: false }`);
				if (state.done === true) {
					if (typeof state.error === "string") throw new ToolError(`tab.a11y() failed: ${state.error}`);
					const result = normalizeA11yResult(this.#lastUrl, state.value, options.includeIncomplete === true);
					context.output.push({ type: "text", text: formatA11ySummary(result) });
					return result;
				}
				await untilAborted(context.signal, () => Bun.sleep(50));
			}
			throw new ToolError(`tab.a11y() timed out after ${context.timeoutMs}ms`);
		} finally {
			await this.#evalScript(`delete globalThis[${key}]`).catch(() => undefined);
		}
	}

	async cookies(options: { urls?: string[] } = {}): Promise<
		Array<{
			name: string;
			value: string;
			domain: string;
			path: string;
			expires: number;
			httpOnly: boolean;
			secure: boolean;
			sameSite: "Lax";
		}>
	> {
		return await this.evaluate(urls => {
			const scope = globalThis as unknown as {
				document: { cookie: string };
				location: { href: string; hostname: string; origin: string; protocol: string };
			};
			if (
				urls?.some(url => {
					try {
						return new URL(url, scope.location.href).origin !== scope.location.origin;
					} catch {
						return true;
					}
				})
			) {
				throw new Error("tab.cookies() on the cmux backend can only read the current origin");
			}
			if (!scope.document.cookie) return [];
			return scope.document.cookie.split(/;\s*/).map((pair: string) => {
				const separator = pair.indexOf("=");
				const name = separator < 0 ? pair : pair.slice(0, separator);
				const value = separator < 0 ? "" : pair.slice(separator + 1);
				return {
					name,
					value,
					domain: scope.location.hostname,
					path: "/",
					expires: -1,
					httpOnly: false,
					secure: scope.location.protocol === "https:",
					sameSite: "Lax" as const,
				};
			});
		}, options.urls);
	}

	async setCookies(..._cookies: unknown[]): Promise<void> {
		throw new ToolError("tab.setCookies() is not supported on the cmux backend");
	}

	async clearCookies(_options?: { names?: string[] }): Promise<void> {
		throw new ToolError("tab.clearCookies() is not supported on the cmux backend");
	}

	async storage(
		kind: "local" | "session",
		options: { key?: string } = {},
	): Promise<Record<string, string> | string | null> {
		if (kind !== "local" && kind !== "session") {
			throw new ToolError('Storage kind must be "local" or "session"');
		}
		return await this.evaluate(
			(area, key) => {
				const store = area === "local" ? localStorage : sessionStorage;
				if (key !== undefined) return store.getItem(key);
				const result: Record<string, string> = {};
				for (let index = 0; index < store.length; index++) {
					const name = store.key(index);
					if (name !== null) result[name] = store.getItem(name) ?? "";
				}
				return result;
			},
			kind,
			options.key,
		);
	}

	async setStorage(
		kind: "local" | "session",
		keyOrEntries: string | Record<string, unknown>,
		value?: unknown,
	): Promise<void> {
		if (kind !== "local" && kind !== "session") {
			throw new ToolError('Storage kind must be "local" or "session"');
		}
		await this.evaluate(
			(area, input, singleValue) => {
				const store = area === "local" ? localStorage : sessionStorage;
				const stringify = (entry: unknown): string => {
					if (typeof entry === "string") return entry;
					const serialized = JSON.stringify(entry);
					if (serialized === undefined) throw new Error("tab.setStorage() could not serialize a supplied value");
					return serialized;
				};
				if (typeof input === "string") {
					store.setItem(input, stringify(singleValue));
					return;
				}
				if (!input || typeof input !== "object" || Array.isArray(input)) {
					throw new Error("tab.setStorage() expects a key/value object");
				}
				for (const key in input) {
					if (Object.hasOwn(input, key)) store.setItem(key, stringify(input[key]));
				}
			},
			kind,
			keyOrEntries,
			value,
		);
	}

	async clearStorage(kind: "local" | "session"): Promise<void> {
		if (kind !== "local" && kind !== "session") {
			throw new ToolError('Storage kind must be "local" or "session"');
		}
		await this.evaluate(area => (area === "local" ? localStorage : sessionStorage).clear(), kind);
	}

	async saveState(_path?: string): Promise<string> {
		throw new ToolError("tab.saveState() is not supported on the cmux backend");
	}

	async loadState(_path: string): Promise<{ loadedOrigins: string[]; skippedOrigins: string[] }> {
		throw new ToolError("tab.loadState() is not supported on the cmux backend");
	}

	async goto(url: string, opts?: { waitUntil?: WaitUntil; timeoutMs?: number }): Promise<void> {
		const timeoutMs = opts?.timeoutMs ?? this.#runContext?.timeoutMs ?? 30_000;
		const result = await this.#request("browser.navigate", { url }, timeoutMs);
		const navigatedUrl = result.url;
		this.#lastUrl = typeof navigatedUrl === "string" && navigatedUrl.length > 0 ? navigatedUrl : url;
		if (opts?.waitUntil) {
			await this.#request(
				"browser.wait",
				{ load_state: mapWaitUntil(opts.waitUntil), timeout_ms: timeoutMs },
				timeoutMs,
			);
		}
		await this.#installResponseObserver().catch(() => undefined);
	}

	async back(opts?: { waitUntil?: WaitUntil }): Promise<string> {
		await this.evaluate(historyBackInPage);
		await this.#waitAfterHistoryNavigation(opts?.waitUntil);
		return this.#lastUrl;
	}

	async forward(opts?: { waitUntil?: WaitUntil }): Promise<string> {
		await this.evaluate(historyForwardInPage);
		await this.#waitAfterHistoryNavigation(opts?.waitUntil);
		return this.#lastUrl;
	}

	async reload(opts?: { waitUntil?: WaitUntil }): Promise<string> {
		await this.evaluate(reloadInPage);
		await this.#waitAfterHistoryNavigation(opts?.waitUntil);
		return this.#lastUrl;
	}

	async pushState(url: string): Promise<string> {
		this.#lastUrl = await this.evaluate(pushStateInPage, url);
		return this.#lastUrl;
	}

	async frames(): Promise<never> {
		throw new ToolError("tab.frames() is not supported on the cmux backend");
	}

	async frame(_selectorOrNameOrUrl: string): Promise<never> {
		throw new ToolError("tab.frame() is not supported on the cmux backend");
	}

	async dialog(): Promise<never> {
		throw new ToolError("tab.dialog() is not supported on the cmux backend");
	}

	async handleDialog(_opts: { accept: boolean; text?: string }): Promise<never> {
		throw new ToolError("tab.handleDialog() is not supported on the cmux backend");
	}

	async setDialogs(_policy: "accept" | "dismiss" | null): Promise<never> {
		throw new ToolError("tab.setDialogs() is not supported on the cmux backend");
	}

	async #waitAfterHistoryNavigation(waitUntil: WaitUntil | undefined): Promise<void> {
		const timeoutMs = this.#runContext?.timeoutMs ?? 30_000;
		await this.#request(
			"browser.wait",
			{ load_state: mapWaitUntil(waitUntil ?? "load"), timeout_ms: timeoutMs },
			timeoutMs,
		);
		this.#lastUrl = await this.evaluate(locationHrefInPage);
	}

	async observe(opts?: ObserveOptions): Promise<Observation> {
		void opts?.viewportOnly;
		if (opts?.selector) {
			throw new ToolError("tab.observe({ selector }) is not supported on the cmux backend");
		}
		const timeoutMs = Math.min(this.#runContext?.timeoutMs ?? 30_000, 30_000);
		const [snapshot, geometry] = await Promise.all([
			this.#request("browser.snapshot", { interactive: !opts?.includeAll, max_depth: 12 }, timeoutMs),
			this.#readGeometry(timeoutMs),
		]);
		const viewport = {
			width: geometry.innerWidth,
			height: geometry.innerHeight,
			deviceScaleFactor: geometry.dpr,
		};
		this.#lastViewport = viewport;
		const observation = cmuxSnapshotToObservation(snapshot as CmuxSnapshotResult, viewport, geometry);
		if (opts?.compact) {
			observation.elements = observation.elements.filter(
				element =>
					!((element.role === "generic" || element.role === "none" || element.role === "group") && !element.name),
			);
		}
		this.#lastUrl = observation.url;
		this.#lastTitle = observation.title;
		this.#rememberObservedElements(observation);
		return observation;
	}

	async ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string | AriaSnapshotDiffResult> {
		const timeoutMs = Math.min(this.#runContext?.timeoutMs ?? 30_000, 30_000);
		const result = (await this.#request(
			"browser.eval",
			{ script: buildAriaSnapshotPayloadScript(selector, opts) },
			timeoutMs,
		)) as CmuxEvalResult;
		const payload = result.value as AriaSnapshotPayload;
		const snapshot = postProcessAriaSnapshot(payload.snapshot, opts, payload.hrefs);
		if (!opts?.diff) return snapshot;
		const urlResult = (await this.#request("browser.url.get", {}, timeoutMs)) as CmuxUrlGetResult;
		if (typeof urlResult.url === "string" && urlResult.url.length > 0) this.#lastUrl = urlResult.url;
		const key = ariaSnapshotBaselineKey(selector, opts);
		return diffAriaSnapshot(this.#ariaSnapshotBaselines, key, this.#lastUrl, snapshot);
	}

	async ref(id: string): Promise<CmuxElementHandle> {
		const refId = /^e\d+$/.test(id.trim()) ? id.trim() : id.trim().replace(/^(?:aria-ref=|aria-ref\/|ariaref\/)/, "");
		const selector = `aria-ref=${refId}`;
		const timeoutMs = this.#runContext?.timeoutMs ?? 30_000;
		await this.#waitForSelector(selector, timeoutMs);
		return new CmuxElementHandle(this, selector);
	}

	async click(selector: string): Promise<void> {
		await this.#selectorAction(selector, "click");
	}

	async dblclick(selector: string): Promise<void> {
		await this.#selectorAction(selector, "dblclick");
	}

	async hover(selector: string): Promise<void> {
		await this.#selectorAction(selector, "hover");
	}

	async focus(selector: string): Promise<void> {
		await this.#selectorAction(selector, "focus");
	}

	async check(selector: string): Promise<void> {
		await this.#selectorAction(selector, "check");
	}

	async uncheck(selector: string): Promise<void> {
		await this.#selectorAction(selector, "uncheck");
	}

	async keyDown(key: string): Promise<void> {
		await this.#evalScript(`(() => {
			const key = ${JSON.stringify(key)};
			(document.activeElement || document.body).dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
			);
			return true;
		})()`);
	}

	async keyUp(key: string): Promise<void> {
		await this.#evalScript(`(() => {
			const key = ${JSON.stringify(key)};
			(document.activeElement || document.body).dispatchEvent(
				new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true })
			);
			return true;
		})()`);
	}

	async mouseMove(x: number, y: number, opts?: { steps?: number }): Promise<void> {
		void opts?.steps;
		await this.#evalScript(`(() => {
			const point = ${JSON.stringify({ x, y })};
			globalThis.__ompMousePoint = point;
			const target = document.elementFromPoint(point.x, point.y) || document.body;
			target.dispatchEvent(new MouseEvent("mousemove", {
				clientX: point.x,
				clientY: point.y,
				bubbles: true,
				cancelable: true,
			}));
			return true;
		})()`);
	}

	async mouseDown(opts?: { button?: string }): Promise<void> {
		await this.#evalScript(this.#mouseTransitionScript("mousedown", opts?.button));
	}

	async mouseUp(opts?: { button?: string }): Promise<void> {
		await this.#evalScript(this.#mouseTransitionScript("mouseup", opts?.button));
	}

	async clickAt(x: number, y: number, opts?: { button?: string; clickCount?: number }): Promise<void> {
		const args = { x, y, button: opts?.button ?? "left", clickCount: opts?.clickCount ?? 1 };
		await this.#evalScript(`(() => {
			const args = ${JSON.stringify(args)};
			const target = document.elementFromPoint(args.x, args.y) || document.body;
			const button = ({ left: 0, middle: 1, right: 2, back: 3, forward: 4 })[args.button] ?? 0;
			for (let count = 1; count <= args.clickCount; count++) {
				const init = {
					clientX: args.x,
					clientY: args.y,
					button,
					detail: count,
					bubbles: true,
					cancelable: true,
					view: window,
				};
				target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 << button }));
				target.dispatchEvent(new MouseEvent("mouseup", init));
				target.dispatchEvent(new MouseEvent("click", init));
			}
			if (args.clickCount === 2) {
				target.dispatchEvent(new MouseEvent("dblclick", {
					clientX: args.x,
					clientY: args.y,
					button,
					detail: 2,
					bubbles: true,
					cancelable: true,
					view: window,
				}));
			}
			return true;
		})()`);
	}

	async wheel(deltaX: number, deltaY: number): Promise<void> {
		await this.#request("browser.scroll", { dx: deltaX, dy: deltaY });
	}

	async highlight(selector: string, opts?: { duration?: number }): Promise<void> {
		const duration = opts?.duration ?? 2_000;
		if (!Number.isFinite(duration) || duration < 0) {
			throw new ToolError("highlight duration must be a non-negative number");
		}
		const id = `omp-highlight-${crypto.randomUUID()}`;
		await this.#selectorAction(selector, "highlight", { id });
		await untilAborted(this.#runContext?.signal, () => Bun.sleep(duration));
		await this.#evalScript(`document.getElementById(${JSON.stringify(id)})?.remove()`);
	}

	async type(selector: string, text: string): Promise<void> {
		await this.#selectorAction(selector, "type", { text });
	}

	async fill(selector: string, value: string): Promise<void> {
		await this.#selectorAction(selector, "fill", { value });
	}

	async press(key: string, opts?: { selector?: string }): Promise<void> {
		if (opts?.selector) {
			await this.focus(opts.selector);
		}
		await this.#request("browser.press", { key });
	}

	async scroll(dx: number, dy: number, opts?: { selector?: string }): Promise<void> {
		if (opts?.selector) {
			await this.#selectorAction(opts.selector, "scroll", { dx, dy });
			return;
		}
		await this.#request("browser.scroll", { dx, dy });
	}

	async waitFor(selector: string | number, opts?: { timeout?: number }): Promise<CmuxElementHandle | undefined> {
		// Duration form: `tab.waitFor(ms)` is a plain bounded sleep — same contract
		// as the Chromium worker (#12137). 0 completes immediately (a plain sleep,
		// NOT Puppeteer's "disable timeout" sentinel); positive durations clamp to
		// the run timeout; garbage rejects instead of hitting assertSelectorString.
		if (typeof selector === "number") {
			if (!Number.isFinite(selector) || selector < 0) {
				throw new ToolError(`tab.waitFor(ms) takes a non-negative duration in ms, got ${JSON.stringify(selector)}`);
			}
			const ms = Math.min(selector, this.#runContext?.timeoutMs ?? 30_000);
			if (this.#runContext) {
				await waitForRun(ms, this.#runContext.signal);
			} else {
				await Bun.sleep(ms);
			}
			return undefined;
		}
		const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		await this.#waitForSelector(selector, timeoutMs);
		return new CmuxElementHandle(this, selector);
	}

	async waitForSelector(selector: string, opts?: { timeout?: number }): Promise<CmuxElementHandle> {
		const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		await this.#waitForSelector(selector, timeoutMs);
		return new CmuxElementHandle(this, selector);
	}

	async evaluate<R, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R> {
		// A script that throws inside the daemon comes back as a bare
		// `js_error: A JavaScript exception occurred` with no message or stack.
		// Catch page-side instead so the exception is diagnosable, and turn the
		// daemon's other blind spot — Promise return values it cannot
		// serialize — into an actionable error instead of "unsupported type".
		const script = serializeEvalWithEnvelope(fn as string | ((...args: unknown[]) => unknown), args);
		const result = (await this.#request("browser.eval", { script })) as CmuxEvalResult;
		return unwrapEvalEnvelope<R>(result.value, "tab.evaluate()");
	}

	async scrollIntoView(selector: string): Promise<void> {
		await this.#selectorAction(selector, "scrollIntoView");
	}

	async select(selector: string, ...values: string[]): Promise<string[]> {
		return await this.#selectorAction<string[]>(selector, "select", { values });
	}

	async extract(format: ReadableFormat = "markdown", opts?: ReadableExtractOptions): Promise<string> {
		const result = (await this.#request("browser.snapshot", { interactive: false })) as CmuxSnapshotResult;
		const html = typeof result.page?.html === "string" ? result.page.html : "";
		const url =
			(typeof result.url === "string" && result.url.length > 0 ? result.url : undefined) ??
			(typeof result.page?.url === "string" && result.page.url.length > 0 ? result.page.url : undefined) ??
			this.#lastUrl;
		const readable = await extractReadableFromHtml(html, url, format, opts);
		if (!readable) {
			throw new ToolError(`tab.extract(${JSON.stringify(format)}) found no readable content on ${url}`);
		}
		const content = format === "markdown" ? readable.markdown : readable.text;
		if (!content) {
			throw new ToolError(`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${url}`);
		}
		return content;
	}

	async screenshot(opts: ScreenshotOptions = {}): Promise<string> {
		const context = this.#requireRunContext("tab.screenshot()");
		if (opts.annotate) throw new ToolError("tab.screenshot({ annotate: true }) is not supported on the cmux backend");
		if (opts.ifChanged || opts.threshold !== undefined) {
			throw new ToolError("tab.screenshot() change detection is not supported on the cmux backend");
		}
		if (opts.format === "jpeg" || opts.quality !== undefined) {
			throw new ToolError("tab.screenshot() JPEG encoding is not supported on the cmux backend");
		}
		// The cmux daemon's `browser.screenshot` captures the surface viewport
		// only — it has no element-clip or full-page mode, and Bun.Image cannot
		// crop locally. Degrade transparently instead of silently mislabeling
		// the capture: scroll the element into view, then TELL the model the
		// image is the full viewport (reports showed selector captures being
		// consumed as element crops).
		const captureNotes: string[] = [];
		if (opts.selector) {
			await this.scrollIntoView(opts.selector);
			captureNotes.push(
				`selector ${JSON.stringify(opts.selector)} was scrolled into view, but this surface cannot clip to an element — the image is the full viewport`,
			);
		}
		if (opts.fullPage) {
			captureNotes.push("fullPage is unavailable on this surface — the image is the viewport only");
		}
		const result = await this.#captureScreenshotPng(context.timeoutMs);
		const buffer = Buffer.from(result.png_base64, "base64");
		const captureMime = "image/png";
		const resized = await resizeImage(
			{ type: "image", data: result.png_base64, mimeType: captureMime },
			{
				maxWidth: 1024,
				maxHeight: 1024,
				maxBytes: 150 * 1024,
				jpegQuality: 70,
				excludeWebP: context.session.excludeWebP,
			},
		);
		const saveFullRes = !!context.session.browserScreenshotDir;
		const savedBuffer = saveFullRes ? buffer : Buffer.from(resized.buffer);
		const savedMimeType = saveFullRes ? captureMime : resized.mimeType;
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest = context.session.browserScreenshotDir
			? path.join(
					context.session.browserScreenshotDir,
					`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
				)
			: path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.${ext}`);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await Bun.write(dest, savedBuffer);
		const info: ScreenshotResult = {
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		};
		context.screenshots.push(info);
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			if (captureNotes.length > 0) {
				lines.push(`[cmux surface: ${captureNotes.join("; ")}]`);
			}
			context.output.push({ type: "text", text: lines.join("\n") });
			context.output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return dest;
	}

	async diffScreenshot(baselinePath: string, opts: DiffScreenshotOptions = {}): Promise<DiffScreenshotResult> {
		const context = this.#requireRunContext("tab.diffScreenshot()");
		const absoluteBaseline = resolveToCwd(baselinePath, context.session.cwd);
		const baseline = await untilAborted(context.signal, () => fs.promises.readFile(absoluteBaseline));
		const capture = await this.#captureScreenshotPng(context.timeoutMs);
		const diff = createPngDiff(baseline, Buffer.from(capture.png_base64, "base64"));
		const threshold = screenshotThreshold(opts.threshold);
		const changed = diff.pixelChangeRatio > threshold;
		const diffPath = opts.output
			? resolveToCwd(opts.output, context.session.cwd)
			: path.join(os.tmpdir(), `omp-screenshot-diff-${Snowflake.next()}.png`);
		await fs.promises.mkdir(path.dirname(diffPath), { recursive: true });
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

	async pdf(_opts: PdfOptions = {}): Promise<string> {
		throw new ToolError("tab.pdf() is not supported on the cmux backend");
	}

	async waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string> {
		const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		if (typeof pattern === "string") {
			await this.#request("browser.wait", { url_contains: pattern, timeout_ms: timeoutMs }, timeoutMs, signal);
			const result = (await this.#request("browser.url.get", {}, timeoutMs, signal)) as CmuxUrlGetResult;
			if (typeof result.url === "string" && result.url.length > 0) {
				this.#lastUrl = result.url;
			}
			return this.#lastUrl;
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const result = (await this.#request(
				"browser.url.get",
				{},
				Math.min(timeoutMs, 5_000),
				signal,
			)) as CmuxUrlGetResult;
			if (typeof result.url === "string" && result.url.length > 0) {
				this.#lastUrl = result.url;
				if (pattern.test(result.url)) return result.url;
			}
			await untilAborted(signal, () => Bun.sleep(200));
		}
		throw new ToolError(`tab.waitForUrl() timed out after ${timeoutMs}ms`);
	}

	/** Init scripts require CDP document-start registration. */
	async addInitScript(_source: string): Promise<{ id: string }> {
		throw new ToolError("tab.addInitScript() is not supported on the cmux backend");
	}

	/** Init-script removal requires CDP document-start registration. */
	async removeInitScript(_id: string): Promise<void> {
		throw new ToolError("tab.removeInitScript() is not supported on the cmux backend");
	}

	/** Init-script enumeration requires CDP document-start registration. */
	async initScripts(): Promise<Array<{ id: string; source: string }>> {
		throw new ToolError("tab.initScripts() is not supported on the cmux backend");
	}

	/** Download completion events require the Chromium browser CDP domain. */
	async waitForDownload(_opts?: { timeout?: number }): Promise<{
		path: string;
		suggestedFilename: string;
		url: string;
		bytes: number;
	}> {
		throw new ToolError("tab.waitForDownload() is not supported on the cmux backend");
	}

	/** Download history requires the Chromium browser CDP domain. */
	async downloads(): Promise<Array<{ path: string; suggestedFilename: string; url: string; bytes: number }>> {
		throw new ToolError("tab.downloads() is not supported on the cmux backend");
	}

	async route(_pattern: NetworkPattern, _options: NetworkRouteOptions = {}): Promise<void> {
		throw new ToolError("tab.route() is not supported on the cmux backend");
	}

	async unroute(_pattern?: NetworkPattern): Promise<void> {
		throw new ToolError("tab.unroute() is not supported on the cmux backend");
	}

	async routes(): Promise<NetworkRouteDescription[]> {
		throw new ToolError("tab.routes() is not supported on the cmux backend");
	}

	async requests(options: NetworkRequestsOptions = {}): Promise<NetworkRequestRecord[]> {
		await this.#installResponseObserver();
		let records = (await this.#responseRecordsAfter(0)).filter(record => cmuxRequestMatches(record, options));
		if (options.limit !== undefined) {
			if (!Number.isInteger(options.limit) || options.limit < 0) {
				throw new ToolError("tab.requests() limit must be a non-negative integer");
			}
			records = records.slice(-options.limit);
		}
		const result = records.map(cmuxRequestRecord);
		if (options.clear) await this.clearRequests();
		return result;
	}

	async request(id: string | number): Promise<NetworkRequestDetail> {
		await this.#installResponseObserver();
		const numericId = typeof id === "number" ? id : Number(String(id).replace(/^request-/, ""));
		const record = (await this.#responseRecordsAfter(0)).find(candidate => candidate.id === numericId);
		if (!record) throw new ToolError(`Unknown browser request id ${JSON.stringify(id)}`);
		const contentType = cmuxHeader(record.headers, "content-type") ?? "text/plain";
		return {
			...cmuxRequestRecord(record),
			body: record.body,
			contentType,
		};
	}

	async clearRequests(): Promise<void> {
		await this.#installResponseObserver();
		await this.#evalScript("(() => { globalThis.__ompCmuxResponses.records = []; return true; })()");
	}

	async harStart(_options: { content?: HarContentPolicy } = {}): Promise<void> {
		throw new ToolError("tab.harStart() is not supported on the cmux backend");
	}

	async harStop(_options: { path?: string } = {}): Promise<string> {
		throw new ToolError("tab.harStop() is not supported on the cmux backend");
	}

	async allowedDomains(): Promise<string[]> {
		throw new ToolError("tab.allowedDomains() is not supported on the cmux backend");
	}

	async webmcpList(_options: WebMcpListOptions = {}): Promise<WebMcpListResult> {
		throw new ToolError("tab.webmcpList() is not supported on the cmux backend");
	}

	async webmcpInvoke(
		_name: string,
		_params: Record<string, unknown>,
		_options: WebMcpInvokeOptions = {},
	): Promise<WebMcpInvokeResult> {
		throw new ToolError("tab.webmcpInvoke() is not supported on the cmux backend");
	}

	async webmcpEvents(_options: WebMcpEventsOptions = {}): Promise<WebMcpEventsResult> {
		throw new ToolError("tab.webmcpEvents() is not supported on the cmux backend");
	}

	/** Collect available navigation and performance entries on the cmux surface. */
	async vitals(options: VitalsOptions = {}): Promise<VitalsResult> {
		if (options.reload !== false) await this.goto(this.#lastUrl, { waitUntil: "load" });
		return await this.#evalScript<VitalsResult>(`(() => {
			const round = value => Math.round((Number(value) || 0) * 100) / 100;
			const entries = type => performance.getEntriesByType(type);
			const nav = entries("navigation")[0];
			const paints = entries("paint");
			const lcpEntries = entries("largest-contentful-paint");
			const shifts = entries("layout-shift");
			const inputs = [...entries("event"), ...entries("first-input")];
			const longTasks = entries("longtask");
			const fcp = paints.find(entry => entry.name === "first-contentful-paint");
			const lcp = lcpEntries[lcpEntries.length - 1];
			let hydration;
			if (document.querySelector("[data-reactroot], #__next")) hydration = { framework: "React" };
			else if (globalThis.__VUE__ || document.querySelector("[data-v-app]")) hydration = { framework: "Vue" };
			else if (
				globalThis.__SVELTE_HMR ||
				document.querySelector("[data-svelte-h], [data-sveltekit-preload-data]")
			) hydration = { framework: "Svelte" };
			const result = {
				url: location.href,
				lcp: round(lcp && (lcp.renderTime || lcp.loadTime || lcp.startTime)),
				cls: round(shifts.reduce((sum, entry) => sum + (entry.hadRecentInput ? 0 : entry.value || 0), 0)),
				fcp: round(fcp && fcp.startTime),
				ttfb: round(nav && nav.responseStart - nav.requestStart),
				inp: round(inputs.reduce((worst, entry) => Math.max(worst, entry.duration || 0), 0)),
				domContentLoaded: round(nav && nav.domContentLoadedEventEnd),
				load: round(nav && nav.loadEventEnd),
				longTasks: round(longTasks.reduce((sum, entry) => sum + (entry.duration || 0), 0)),
			};
			if (hydration) result.hydration = hydration;
			return result;
		})()`);
	}

	/** Report that React hook installation is unavailable on cmux surfaces. */
	async reactEnable(): Promise<never> {
		throw new ToolError("tab.reactEnable() is not supported on the cmux backend");
	}

	/** Report that React tree inspection is unavailable on cmux surfaces. */
	async reactTree(_options?: unknown): Promise<never> {
		throw new ToolError("tab.reactTree() is not supported on the cmux backend");
	}

	/** Report that React fiber inspection is unavailable on cmux surfaces. */
	async reactInspect(_id: number): Promise<never> {
		throw new ToolError("tab.reactInspect() is not supported on the cmux backend");
	}

	/** Report that React render recording is unavailable on cmux surfaces. */
	async reactRenders(_options: unknown): Promise<never> {
		throw new ToolError("tab.reactRenders() is not supported on the cmux backend");
	}

	/** Report that Suspense inspection is unavailable on cmux surfaces. */
	async reactSuspense(_options?: unknown): Promise<never> {
		throw new ToolError("tab.reactSuspense() is not supported on the cmux backend");
	}

	async console(options: BrowserConsoleOptions = {}): Promise<BrowserCaptureResult<BrowserConsoleEntry>> {
		const result = await this.#readCmuxCapture("console", options);
		return {
			...result,
			entries: result.entries.filter((entry): entry is BrowserConsoleEntry => entry.type === "console"),
		};
	}

	async errors(options: BrowserErrorOptions = {}): Promise<BrowserCaptureResult<BrowserErrorEntry>> {
		const result = await this.#readCmuxCapture("errors", options);
		return {
			...result,
			entries: result.entries.filter((entry): entry is BrowserErrorEntry => entry.type !== "console"),
		};
	}

	async clearConsole(): Promise<void> {
		await this.#evalScript(
			`${CMUX_CONSOLE_CAPTURE_SCRIPT}; globalThis.__ompConsoleCapture.entries = []; globalThis.__ompConsoleCapture.dropped = 0; true`,
		);
	}

	async traceStart(options: { screenshots?: boolean; categories?: string[] } = {}): Promise<void> {
		void options;
		throw new ToolError("tab.traceStart() is not supported on the cmux backend");
	}

	async traceStop(options: { path?: string } = {}): Promise<string> {
		void options;
		throw new ToolError("tab.traceStop() is not supported on the cmux backend");
	}

	async profileStart(): Promise<void> {
		throw new ToolError("tab.profileStart() is not supported on the cmux backend");
	}

	async profileStop(options: { path?: string } = {}): Promise<string> {
		void options;
		throw new ToolError("tab.profileStop() is not supported on the cmux backend");
	}

	async metrics(): Promise<Record<string, number> & { domContentLoaded: number; load: number }> {
		return await this.#evalScript(`(() => {
			const timing = performance.timing;
			const navigationStart = timing.navigationStart;
			return {
				domContentLoaded: navigationStart > 0 && timing.domContentLoadedEventEnd > 0
					? timing.domContentLoadedEventEnd - navigationStart : 0,
				load: navigationStart > 0 && timing.loadEventEnd > 0 ? timing.loadEventEnd - navigationStart : 0,
			};
		})()`);
	}

	async recordStart(path: string, options?: RecordingOptions): Promise<RecordingStartResult> {
		void path;
		void options;
		throw new ToolError("tab.recordStart() is not supported on the cmux backend");
	}

	async recordStop(): Promise<RecordingStopResult> {
		throw new ToolError("tab.recordStop() is not supported on the cmux backend");
	}

	async recordRestart(path: string, options?: RecordingOptions): Promise<RecordingStartResult> {
		void path;
		void options;
		throw new ToolError("tab.recordRestart() is not supported on the cmux backend");
	}

	async recording(): Promise<RecordingStatus> {
		throw new ToolError("tab.recording() is not supported on the cmux backend");
	}

	async text(selector: string): Promise<string | null> {
		return await this.queryElement<string>(
			selector,
			`element => (element.innerText || element.textContent || "").trim()`,
		);
	}

	async html(selector: string): Promise<string | null> {
		return await this.queryElement<string>(selector, "element => element.innerHTML");
	}

	async value(selector: string): Promise<string | null> {
		return await this.queryElement<string | null>(
			selector,
			`element => "value" in element && element.value != null ? String(element.value) : null`,
		);
	}

	async attr(selector: string, name: string): Promise<string | null> {
		return await this.queryElement<string>(selector, "(element, name) => element.getAttribute(name)", [name]);
	}

	async count(selector: string): Promise<number> {
		return await this.elementCount(selector);
	}

	async box(selector: string): Promise<BoundingBox | null> {
		return await this.elementBox(selector);
	}

	async styles(
		selector: string,
		props: string[] = [...DEFAULT_STYLE_PROPERTIES],
	): Promise<Record<string, string> | null> {
		return await this.queryElement<Record<string, string>>(
			selector,
			"(element, properties) => { const computed = getComputedStyle(element); return Object.fromEntries(properties.map(property => [property, computed.getPropertyValue(property)])); }",
			[props],
		);
	}

	async isVisible(selector: string): Promise<boolean> {
		return (
			(await this.queryElement<boolean>(
				selector,
				"element => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; }",
			)) ?? false
		);
	}

	async isEnabled(selector: string): Promise<boolean> {
		return (
			(await this.queryElement<boolean>(
				selector,
				`element => !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true"`,
			)) ?? false
		);
	}

	async isChecked(selector: string): Promise<boolean> {
		return (
			(await this.queryElement<boolean>(
				selector,
				`element => typeof element.checked === "boolean" ? element.checked : element.getAttribute("aria-checked") === "true"`,
			)) ?? false
		);
	}

	async waitForText(text: string, opts: { timeout?: number; selector?: string; exact?: boolean } = {}): Promise<void> {
		const timeoutMs = opts.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const content = opts.selector
				? await this.text(opts.selector)
				: await this.#evalScript<string>("document.body?.innerText || ''");
			if (content !== null) {
				const candidate = content.trim();
				if (opts.exact ? candidate === text : candidate.includes(text)) return;
			}
			await untilAborted(signal, () => Bun.sleep(100));
		}
		throw new ToolError(`tab.waitForText(${JSON.stringify(text)}) timed out after ${timeoutMs}ms`);
	}

	async waitForNavigation(opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<null> {
		const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		// Cmux has no native "next navigation" wait — snapshot the current URL via a fresh
		// `browser.url.get` (never the possibly-stale `#lastUrl`), then poll for a change
		// from it (mirroring headless `page.waitForNavigation` intent) and optionally settle
		// on the requested load state. Start it BEFORE the click/submit that navigates; after
		// a completed nav it times out like puppeteer does.
		const baseline = (await this.#request(
			"browser.url.get",
			{},
			Math.min(timeoutMs, 5_000),
			signal,
		)) as CmuxUrlGetResult;
		const startUrl = typeof baseline.url === "string" && baseline.url.length > 0 ? baseline.url : this.#lastUrl;
		if (typeof baseline.url === "string" && baseline.url.length > 0) this.#lastUrl = baseline.url;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const result = (await this.#request(
				"browser.url.get",
				{},
				Math.min(timeoutMs, 5_000),
				signal,
			)) as CmuxUrlGetResult;
			if (typeof result.url === "string" && result.url.length > 0) {
				this.#lastUrl = result.url;
				if (result.url !== startUrl) {
					if (opts?.waitUntil) {
						await this.#request(
							"browser.wait",
							{ load_state: mapWaitUntil(opts.waitUntil), timeout_ms: timeoutMs },
							timeoutMs,
							signal,
						);
					}
					return null;
				}
			}
			await untilAborted(signal, () => Bun.sleep(200));
		}
		throw new ToolError(`tab.waitForNavigation() timed out after ${timeoutMs}ms`);
	}

	async drag(from: DragTarget, to: DragTarget): Promise<void> {
		const start = await this.#dragPoint(from);
		const end = await this.#dragPoint(to);
		await this.#evalScript(
			`(() => {
				const points = ${JSON.stringify({ start, end })};
				const target = document.elementFromPoint(points.start.x, points.start.y) || document.body;
				const dispatch = (type, point) => target.dispatchEvent(new MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					view: window,
					clientX: point.x,
					clientY: point.y,
					buttons: type === "mouseup" ? 0 : 1,
				}));
				dispatch("mousemove", points.start);
				dispatch("mousedown", points.start);
				dispatch("mousemove", points.end);
				dispatch("mouseup", points.end);
				return true;
			})()`,
		);
	}

	async uploadFile(selector: string, ...filePaths: string[]): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const files: FilePayload[] = [];
		for (const filePath of filePaths) {
			const absolute = resolveToCwd(filePath, this.#requireRunContext("tab.uploadFile()").session.cwd);
			const file = Bun.file(absolute);
			const data = Buffer.from(await file.arrayBuffer()).toString("base64");
			files.push({ name: path.basename(absolute), type: file.type || "application/octet-stream", data });
		}
		await this.#selectorAction(selector, "uploadFile", { files });
	}

	async waitForResponse(
		pattern: string | RegExp | ((response: CmuxResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<CmuxResponse> {
		const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		await this.#installResponseObserver();
		const startId = await this.#responseCursor();
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const records = await this.#responseRecordsAfter(startId);
			for (const record of records) {
				const response = new CmuxResponse(record);
				if (typeof pattern === "function") {
					if (await pattern(response)) return response;
				} else if (pattern instanceof RegExp ? pattern.test(record.url) : record.url.includes(pattern)) {
					return response;
				}
			}
			await untilAborted(signal, () => Bun.sleep(100));
		}
		throw new ToolError(`tab.waitForResponse() timed out after ${timeoutMs}ms`);
	}

	async id(id: number): Promise<CmuxElementHandle> {
		const ref = this.#elementRefs.get(id)?.ref ?? `@e${id}`;
		await this.#waitForSelector(ref, this.#runContext?.timeoutMs ?? 30_000);
		return new CmuxElementHandle(this, ref);
	}

	ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (!this.#runtime) {
			this.#runtime = new JsRuntime({
				initialCwd: session.cwd,
				sessionId: `cmux-tab-${this.#surfaceId}`,
			});
		}
		return this.#runtime;
	}

	async #readCmuxCapture(
		kind: "console" | "errors",
		options: BrowserConsoleOptions | BrowserErrorOptions,
	): Promise<BrowserCaptureResult<CmuxCaptureEntry>> {
		const serializedOptions = JSON.stringify(options);
		const serialized = await this.#evalScript<string>(`(() => {
			${CMUX_CONSOLE_CAPTURE_SCRIPT};
			const state = globalThis.__ompConsoleCapture;
			const options = ${serializedOptions};
			const since = Number.isFinite(options.since) ? Math.floor(options.since) : 0;
			const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 500;
			const entries = state.entries
				.filter(entry => entry.seq > since)
				.filter(entry => ${JSON.stringify(kind)} === "console"
					? entry.type === "console" && (!options.level || entry.level === options.level)
					: entry.type !== "console")
				.slice(0, limit);
			const result = {
				entries,
				nextSeq: entries.length ? entries[entries.length - 1].seq : state.nextSeq - 1,
				dropped: state.dropped,
			};
			if (options.clear) {
				state.entries = [];
				state.dropped = 0;
			}
			return JSON.stringify(result);
		})()`);
		return parseCmuxCaptureResult(serialized);
	}

	async #request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs?: number,
		signal: AbortSignal | undefined = this.#runContext?.signal,
	): Promise<Record<string, unknown>> {
		throwIfAborted(signal);
		const result = await untilAborted(signal, () =>
			this.#client.request(method, { surface_id: this.#surfaceId, ...params }, { timeoutMs }),
		);
		throwIfAborted(signal);
		return result;
	}

	async #readGeometry(timeoutMs?: number): Promise<CmuxGeometry> {
		const result = (await this.#request("browser.eval", { script: GEOMETRY_SCRIPT }, timeoutMs)) as CmuxEvalResult;
		return this.#normalizeGeometry(result.value);
	}

	elementHandle(selector: string): CmuxElementHandle {
		return new CmuxElementHandle(this, selector);
	}

	async elementExists(selector: string): Promise<boolean> {
		return await this.#selectorExists(this.#selectorSpec(selector));
	}

	async elementBox(selector: string): Promise<BoundingBox | null> {
		return await this.#selectorBox(this.#selectorSpec(selector));
	}

	async elementCount(selector: string): Promise<number> {
		const spec = this.#selectorSpec(selector);
		return await this.#evalScript<number>(`(() => {
			const spec = ${JSON.stringify(spec)};
			${PAGE_SELECTOR_HELPERS}
			return findElements(spec).length;
		})()`);
	}

	async evaluateOnSelector<R>(selector: string, source: string, args: unknown[]): Promise<R> {
		const spec = this.#selectorSpec(selector);
		const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			const source = ${JSON.stringify(source)};
			const args = ${JSON.stringify(args)};
			${PAGE_SELECTOR_HELPERS}
			const element = findElement(spec);
			if (!element) throw new Error("Element handle selector no longer resolves");
			const callable = (0, eval)("(" + source + ")");
			return callable(element, ...args);
		})()`;
		// Envelope so a stale selector or a throwing callback reports its actual
		// error instead of the daemon's generic js_error (see tab.evaluate()).
		const result = (await this.#request("browser.eval", {
			script: serializeEvalWithEnvelope(script, []),
		})) as CmuxEvalResult;
		return unwrapEvalEnvelope<R>(result.value, "elementHandle.evaluate()");
	}

	/** Evaluate a JSON-safe read against the first matching element, returning `null` when absent. */
	async queryElement<R>(selector: string, source: string, args: unknown[] = []): Promise<R | null> {
		const spec = this.#selectorSpec(selector);
		const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			const source = ${JSON.stringify(source)};
			const args = ${JSON.stringify(args)};
			${PAGE_SELECTOR_HELPERS}
			const element = findElement(spec);
			if (!element) return null;
			const callable = (0, eval)("(" + source + ")");
			return callable(element, ...args);
		})()`;
		return await this.#evalScript<R | null>(script);
	}

	async pageContent(): Promise<string> {
		return await this.#evalScript<string>("document.documentElement.outerHTML");
	}

	async pageScreenshot(opts: PageScreenshotOptions = {}): Promise<Buffer | string> {
		if (opts.selector) await this.scrollIntoView(opts.selector);
		const result = await this.#captureScreenshotPng(this.#runContext?.timeoutMs ?? 30_000);
		return opts.encoding === "base64" ? result.png_base64 : Buffer.from(result.png_base64, "base64");
	}

	async waitForFunction(
		fn: string | ((...args: unknown[]) => unknown | Promise<unknown>),
		opts: { timeout?: number; polling?: number } | undefined,
		...args: unknown[]
	): Promise<unknown> {
		const timeoutMs = opts?.timeout ?? this.#runContext?.timeoutMs ?? 30_000;
		const signal = this.#runContext?.signal;
		const pollingMs = typeof opts?.polling === "number" ? opts.polling : 200;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const value = typeof fn === "string" ? await this.#evalScript<unknown>(fn) : await this.evaluate(fn, ...args);
			if (value) return value;
			await untilAborted(signal, () => Bun.sleep(pollingMs));
		}
		throw new ToolError(`page.waitForFunction() timed out after ${timeoutMs}ms`);
	}

	async #evalScript<R>(script: string, timeoutMs?: number): Promise<R> {
		const result = (await this.#request("browser.eval", { script }, timeoutMs)) as CmuxEvalResult;
		return result.value as R;
	}

	#mouseTransitionScript(type: "mousedown" | "mouseup", button = "left"): string {
		return `(() => {
			const args = ${JSON.stringify({ type, button })};
			const point = globalThis.__ompMousePoint || { x: 0, y: 0 };
			const target = document.elementFromPoint(point.x, point.y) || document.body;
			const button = ({ left: 0, middle: 1, right: 2, back: 3, forward: 4 })[args.button] ?? 0;
			target.dispatchEvent(new MouseEvent(args.type, {
				clientX: point.x,
				clientY: point.y,
				button,
				buttons: args.type === "mouseup" ? 0 : 1 << button,
				bubbles: true,
				cancelable: true,
				view: window,
			}));
			return true;
		})()`;
	}

	async #captureScreenshotPng(timeoutMs: number): Promise<CmuxScreenshotResult & { png_base64: string }> {
		const result = (await this.#request("browser.screenshot", {}, timeoutMs)) as CmuxScreenshotResult;
		if (typeof result.png_base64 !== "string" || result.png_base64.length === 0) {
			throw new ToolError("cmux browser screenshot response did not include png_base64");
		}
		return result as CmuxScreenshotResult & { png_base64: string };
	}

	async #selectorAction<R = void>(selector: string, action: string, args: Record<string, unknown> = {}): Promise<R> {
		const spec = this.#selectorSpec(selector);
		const nativeSelector = this.#nativeSelector(spec);
		if (nativeSelector && action !== "select" && action !== "uploadFile") {
			switch (action) {
				case "click":
					await this.#request("browser.click", { selector: nativeSelector });
					return undefined as R;
				case "dblclick":
					await this.#request("browser.dblclick", { selector: nativeSelector });
					return undefined as R;
				case "hover":
					await this.#request("browser.hover", { selector: nativeSelector });
					return undefined as R;
				case "focus":
					await this.#request("browser.focus", { selector: nativeSelector });
					return undefined as R;
				case "check":
					await this.#request("browser.check", { selector: nativeSelector });
					return undefined as R;
				case "uncheck":
					await this.#request("browser.uncheck", { selector: nativeSelector });
					return undefined as R;
				case "type":
					await this.#request("browser.type", { selector: nativeSelector, text: String(args.text ?? "") });
					return undefined as R;
				case "fill":
					await this.#request("browser.fill", { selector: nativeSelector, text: String(args.value ?? "") });
					return undefined as R;
				case "scrollIntoView":
					await this.#request("browser.scroll_into_view", { selector: nativeSelector });
					return undefined as R;
			}
		}
		return await this.#evalSelectorAction<R>(spec, action, args);
	}

	async #evalSelectorAction<R>(spec: SelectorSpec, action: string, args: Record<string, unknown>): Promise<R> {
		const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			const action = ${JSON.stringify(action)};
			const args = ${JSON.stringify(args)};
			${PAGE_SELECTOR_HELPERS}
			const element = findElement(spec);
			if (!element) throw new Error("No element matched " + spec.raw);
			if (action !== "exists") element.scrollIntoView({ block: "center", inline: "center" });
			switch (action) {
				case "click":
					mouseEvent(element, "mousedown");
					mouseEvent(element, "mouseup");
					if (typeof element.click === "function") element.click();
					else mouseEvent(element, "click");
					return true;
				case "dblclick":
					mouseEvent(element, "dblclick");
					return true;
				case "hover":
					mouseEvent(element, "mouseover");
					mouseEvent(element, "mouseenter");
					mouseEvent(element, "mousemove");
					return true;
				case "focus":
					if (typeof element.focus === "function") element.focus();
					return true;
				case "check":
				case "uncheck": {
					const desired = action === "check";
					const type = String(element.type || "").toLowerCase();
					const role = String(element.getAttribute("role") || "").toLowerCase();
					const native = element.tagName === "INPUT" && (type === "checkbox" || type === "radio");
					const aria = role === "switch" || role === "checkbox" || role === "radio";
					if (!native && !aria) {
						throw new Error("tab." + action + "() requires a checkbox, radio, or ARIA switch");
					}
					const current = native ? !!element.checked : element.getAttribute("aria-checked") === "true";
					if (current === desired) return true;
					if (native) element.checked = desired;
					else element.setAttribute("aria-checked", String(desired));
					inputEvent(element);
					return true;
				}
				case "type":
					if (typeof element.focus === "function") element.focus();
					setValue(element, String(args.text || ""), true);
					return true;
				case "fill":
					if (typeof element.focus === "function") element.focus();
					setValue(element, String(args.value || ""), false);
					return true;
				case "scrollIntoView":
					return true;
				case "scroll":
					element.scrollBy({
						left: Number(args.dx) || 0,
						top: Number(args.dy) || 0,
						behavior: "instant",
					});
					return true;
				case "highlight": {
					const rect = element.getBoundingClientRect();
					const overlay = document.createElement("div");
					overlay.id = String(args.id);
					overlay.dataset.ompHighlightOverlay = "";
					overlay.setAttribute("aria-hidden", "true");
					overlay.setAttribute("role", "presentation");
					overlay.inert = true;
					Object.assign(overlay.style, {
						position: "fixed",
						left: (rect.left - 3) + "px",
						top: (rect.top - 3) + "px",
						width: (rect.width + 6) + "px",
						height: (rect.height + 6) + "px",
						border: "3px solid #ff3366",
						borderRadius: "4px",
						boxSizing: "border-box",
						pointerEvents: "none",
						zIndex: "2147483647",
					});
					document.documentElement.append(overlay);
					return true;
				}
				case "select": {
					const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value || "")];
					if (element.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
					const wanted = new Set(values);
					const selected = [];
					for (const option of Array.from(element.options)) {
						option.selected = wanted.has(option.value);
						if (option.selected) selected.push(option.value);
					}
					inputEvent(element);
					return selected;
				}
				case "uploadFile": {
					const transfer = new DataTransfer();
					for (const file of args.files || []) {
						const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
						transfer.items.add(new File([bytes], file.name, { type: file.type || "application/octet-stream" }));
					}
					if (element.tagName === "INPUT" && element.type === "file") {
						element.files = transfer.files;
						inputEvent(element);
						return true;
					}
					for (const type of ["dragenter", "dragover", "drop"]) {
						element.dispatchEvent(new DragEvent(type, {
							bubbles: true,
							cancelable: true,
							dataTransfer: transfer,
						}));
					}
					return true;
				}
			}
			throw new Error("Unsupported selector action " + action);
		})()`;
		const result = (await this.#request("browser.eval", { script }, this.#runContext?.timeoutMs)) as CmuxEvalResult;
		return result.value as R;
	}

	async #waitForSelector(selector: string, timeoutMs: number): Promise<void> {
		const signal = this.#runContext?.signal;
		const spec = this.#selectorSpec(selector);
		const nativeSelector = this.#nativeSelector(spec);
		if (nativeSelector) {
			await this.#request("browser.wait", { selector: nativeSelector, timeout_ms: timeoutMs }, timeoutMs, signal);
			return;
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			if (await this.#selectorExists(spec)) return;
			await untilAborted(signal, () => Bun.sleep(100));
		}
		throw new ToolError(`tab.waitFor(${JSON.stringify(selector)}) timed out after ${timeoutMs}ms`);
	}

	async #selectorExists(spec: SelectorSpec): Promise<boolean> {
		if (spec.kind === "ref") return this.#elementRefs.has(Number(spec.value));
		const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			${PAGE_SELECTOR_HELPERS}
			return !!findElement(spec);
		})()`;
		return !!(await this.#evalScript<unknown>(script));
	}

	async #selectorBox(spec: SelectorSpec): Promise<BoundingBox | null> {
		if (spec.kind === "ref") return null;
		const script = `(() => {
			const spec = ${JSON.stringify(spec)};
			${PAGE_SELECTOR_HELPERS}
			const element = findElement(spec);
			if (!element) return null;
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return null;
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		})()`;
		const value = await this.#evalScript<unknown>(script);
		if (!value || typeof value !== "object") return null;
		const object = value as Record<string, unknown>;
		return {
			x: numberFrom(object.x, 0),
			y: numberFrom(object.y, 0),
			width: numberFrom(object.width, 0),
			height: numberFrom(object.height, 0),
		};
	}

	async #dragPoint(target: DragTarget): Promise<{ x: number; y: number }> {
		if (typeof target === "string") {
			const box = await this.#selectorBox(this.#selectorSpec(target));
			if (!box) throw new ToolError(`Drag selector did not resolve to a visible element: ${target}`);
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		}
		if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
			return { x: target.x, y: target.y };
		}
		throw new ToolError("Drag target must be a selector string or { x: number, y: number } point");
	}

	async #installResponseObserver(): Promise<void> {
		await this.#evalScript<boolean>(RESPONSE_OBSERVER_SCRIPT);
	}

	async #responseCursor(): Promise<number> {
		const value = await this.#evalScript<unknown>(
			"(() => Math.max(0, ((globalThis.__ompCmuxResponses && globalThis.__ompCmuxResponses.nextId) || 1) - 1))()",
		);
		return numberFrom(value, 0);
	}

	async #responseRecordsAfter(id: number): Promise<CmuxResponseRecord[]> {
		const value = await this.#evalScript<unknown>(
			`(() => ((globalThis.__ompCmuxResponses && globalThis.__ompCmuxResponses.records) || []).filter(record => record.id > ${JSON.stringify(id)}))()`,
		);
		if (!Array.isArray(value)) return [];
		const records: CmuxResponseRecord[] = [];
		for (const item of value) {
			if (!item || typeof item !== "object") continue;
			const object = item as Record<string, unknown>;
			const headers = object.headers && typeof object.headers === "object" ? object.headers : {};
			const requestHeaders =
				object.requestHeaders && typeof object.requestHeaders === "object" ? object.requestHeaders : {};
			records.push({
				id: numberFrom(object.id, 0),
				ts: numberFrom(object.ts, 0),
				method: typeof object.method === "string" ? object.method : "GET",
				resourceType: object.resourceType === "xhr" ? "xhr" : "fetch",
				url: typeof object.url === "string" ? object.url : "",
				status: numberFrom(object.status, 0),
				statusText: typeof object.statusText === "string" ? object.statusText : "",
				headers: cmuxStringRecord(headers),
				requestHeaders: cmuxStringRecord(requestHeaders),
				body: typeof object.body === "string" ? object.body : "",
				durationMs: numberFrom(object.durationMs, 0),
			});
		}
		return records;
	}

	#selectorSpec(selector: string): SelectorSpec {
		assertSelectorString(selector);
		const raw = selector;
		let normalized = selector;
		if (normalized.startsWith("p-text/")) normalized = `text/${normalized.slice("p-text/".length)}`;
		else if (normalized.startsWith("p-aria/")) normalized = `aria/${normalized.slice("p-aria/".length)}`;
		else if (normalized.startsWith("p-xpath/")) normalized = `xpath/${normalized.slice("p-xpath/".length)}`;
		else if (normalized.startsWith("p-pierce/")) normalized = `pierce/${normalized.slice("p-pierce/".length)}`;
		const ariaRef = /^(?:aria-ref=|aria-ref\/|ariaref\/)(e\d+)$/.exec(normalized);
		if (ariaRef) return { kind: "aria-ref", value: ariaRef[1]!, raw };
		const ref = /^@?e(\d+)$/.exec(normalized);
		if (ref) return { kind: "ref", value: ref[1]!, raw, ref: `@e${ref[1]}` };
		const slash = normalized.indexOf("/");
		if (slash > 0) {
			const prefix = normalized.slice(0, slash);
			const value = normalized.slice(slash + 1);
			if (prefix === "role") {
				const roleMatch = /^\s*([^\s[]+)/.exec(value);
				const nameMatch = /\[\s*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(?:\s+(exact))?\s*\]/i.exec(value);
				return {
					kind: "role",
					value,
					raw,
					role: roleMatch?.[1] ?? "",
					name: nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3],
					exact: nameMatch?.[4]?.toLowerCase() === "exact",
				};
			}
			if (
				prefix === "text" ||
				prefix === "aria" ||
				prefix === "xpath" ||
				prefix === "pierce" ||
				prefix === "label" ||
				prefix === "placeholder" ||
				prefix === "testid" ||
				prefix === "alt" ||
				prefix === "title"
			) {
				return { kind: prefix, value, raw, name: prefix === "aria" ? value : undefined };
			}
		}
		return { kind: "css", value: normalized, raw };
	}

	#nativeSelector(spec: SelectorSpec): string | undefined {
		if (spec.kind === "css") return spec.value;
		if (spec.kind === "ref") return spec.ref;
		return undefined;
	}

	#rememberObservedElements(observation: Observation): void {
		this.#elementRefs.clear();
		for (const element of observation.elements) {
			this.#elementRefs.set(element.id, {
				ref: `@e${element.id}`,
				name: element.name,
				role: element.role,
			});
		}
	}

	#normalizeGeometry(value: unknown): CmuxGeometry {
		const object = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		return {
			innerWidth: numberFrom(object.innerWidth, DEFAULT_VIEWPORT.width),
			innerHeight: numberFrom(object.innerHeight, DEFAULT_VIEWPORT.height),
			dpr: numberFrom(object.dpr, DEFAULT_VIEWPORT.deviceScaleFactor ?? 1),
			scrollX: numberFrom(object.scrollX, 0),
			scrollY: numberFrom(object.scrollY, 0),
			scrollWidth: numberFrom(object.scrollWidth, DEFAULT_VIEWPORT.width),
			scrollHeight: numberFrom(object.scrollHeight, DEFAULT_VIEWPORT.height),
		};
	}

	#requireRunContext(operation: string): RunContext {
		if (!this.#runContext) {
			throw new ToolError(`${operation} requires an active cmux browser run`);
		}
		return this.#runContext;
	}
}

class CmuxResponse {
	readonly #record: CmuxResponseRecord;

	constructor(record: CmuxResponseRecord) {
		this.#record = record;
	}

	url(): string {
		return this.#record.url;
	}

	status(): number {
		return this.#record.status;
	}

	statusText(): string {
		return this.#record.statusText;
	}

	headers(): Record<string, string> {
		return { ...this.#record.headers };
	}

	async text(): Promise<string> {
		return this.#record.body;
	}

	async json(): Promise<unknown> {
		return JSON.parse(this.#record.body);
	}
}

class CmuxElementHandle {
	readonly #tab: CmuxTab;
	readonly #selector: string;

	constructor(tab: CmuxTab, selector: string) {
		this.#tab = tab;
		this.#selector = selector;
	}

	async click(): Promise<void> {
		await this.#tab.click(this.#selector);
	}

	async dblclick(): Promise<void> {
		await this.#tab.dblclick(this.#selector);
	}

	async check(): Promise<void> {
		await this.#tab.check(this.#selector);
	}

	async uncheck(): Promise<void> {
		await this.#tab.uncheck(this.#selector);
	}

	async highlight(opts?: { duration?: number }): Promise<void> {
		await this.#tab.highlight(this.#selector, opts);
	}

	async type(text: string): Promise<void> {
		await this.#tab.type(this.#selector, text);
	}

	async fill(value: string): Promise<void> {
		await this.#tab.fill(this.#selector, value);
	}

	async press(key: string): Promise<void> {
		await this.#tab.press(key, { selector: this.#selector });
	}

	async focus(): Promise<void> {
		await this.#tab.focus(this.#selector);
	}

	async hover(): Promise<void> {
		await this.#tab.hover(this.#selector);
	}

	async evaluate<R, TArgs extends unknown[]>(
		fn: (element: unknown, ...args: TArgs) => R | Promise<R>,
		...args: TArgs
	): Promise<R> {
		return await this.#tab.evaluateOnSelector<R>(this.#selector, fn.toString(), args);
	}

	async boundingBox(): Promise<BoundingBox | null> {
		return await this.#tab.elementBox(this.#selector);
	}

	async text(): Promise<string> {
		return (await this.#tab.text(this.#selector)) ?? "";
	}

	async html(): Promise<string> {
		return (await this.#tab.html(this.#selector)) ?? "";
	}

	async value(): Promise<string | null> {
		return await this.#tab.value(this.#selector);
	}

	async attr(name: string): Promise<string | null> {
		return await this.#tab.attr(this.#selector, name);
	}

	async styles(props?: string[]): Promise<Record<string, string>> {
		return (await this.#tab.styles(this.#selector, props)) ?? {};
	}

	async isEnabled(): Promise<boolean> {
		return await this.#tab.isEnabled(this.#selector);
	}

	async isChecked(): Promise<boolean> {
		return await this.#tab.isChecked(this.#selector);
	}

	async uploadFile(...paths: string[]): Promise<void> {
		await this.#tab.uploadFile(this.#selector, ...paths);
	}

	async dispose(): Promise<void> {}
}

class CmuxLocator {
	readonly #tab: CmuxTab;
	readonly #selector: string;
	#timeoutMs: number | undefined;

	constructor(tab: CmuxTab, selector: string) {
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

	async waitHandle(): Promise<CmuxElementHandle> {
		const handle = await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
		return handle as CmuxElementHandle;
	}
}

class CmuxPageFacade {
	readonly #tab: CmuxTab;
	readonly keyboard: { press: (key: string) => Promise<void> };
	readonly mouse: {
		wheel: (delta: { deltaX?: number; deltaY?: number }) => Promise<void>;
		move: (x: number, y: number) => Promise<void>;
		down: () => Promise<void>;
		up: () => Promise<void>;
	};

	constructor(tab: CmuxTab) {
		this.#tab = tab;
		this.keyboard = { press: key => this.#tab.press(key) };
		let lastPoint = { x: 0, y: 0 };
		let dragStart: { x: number; y: number } | undefined;
		this.mouse = {
			wheel: delta => this.#tab.scroll(delta.deltaX ?? 0, delta.deltaY ?? 0),
			move: (x, y) => {
				lastPoint = { x, y };
				return Promise.resolve();
			},
			down: () => {
				dragStart = lastPoint;
				return Promise.resolve();
			},
			up: async () => {
				if (dragStart) await this.#tab.drag(dragStart, lastPoint);
				dragStart = undefined;
			},
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

	async goto(url: string, opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<{ url: string }> {
		await this.#tab.goto(url, { waitUntil: opts?.waitUntil, timeoutMs: opts?.timeout });
		return { url: this.#tab.url() };
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

	locator(selector: string): CmuxLocator {
		return new CmuxLocator(this.#tab, selector);
	}

	async $(selector: string): Promise<CmuxElementHandle | null> {
		return (await this.#tab.elementExists(selector)) ? this.#tab.elementHandle(selector) : null;
	}

	async waitForSelector(selector: string, opts?: { timeout?: number }): Promise<CmuxElementHandle> {
		const handle = await this.#tab.waitFor(selector, opts);
		return handle as CmuxElementHandle;
	}

	async waitForFunction(
		fn: string | ((...args: unknown[]) => unknown | Promise<unknown>),
		opts?: { timeout?: number; polling?: number },
		...args: unknown[]
	): Promise<unknown> {
		return await this.#tab.waitForFunction(fn, opts, ...args);
	}

	async waitForResponse(
		pattern: string | RegExp | ((response: CmuxResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<CmuxResponse> {
		return await this.#tab.waitForResponse(pattern, opts);
	}

	async screenshot(opts: PageScreenshotOptions = {}): Promise<Buffer | string> {
		return await this.#tab.pageScreenshot(opts);
	}
}

class CmuxBrowserFacade {
	readonly #tab: CmuxTab;
	connected = true;

	constructor(tab: CmuxTab) {
		this.#tab = tab;
	}

	async pages(): Promise<CmuxPageFacade[]> {
		return [this.#tab.page];
	}

	async version(): Promise<string> {
		return "cmux";
	}

	wsEndpoint(): string {
		return `cmux://${this.#tab.surfaceId}`;
	}

	disconnect(): void {
		this.connected = false;
	}

	async close(): Promise<void> {
		this.connected = false;
	}
}

export async function runCmuxCode(tab: CmuxTab, opts: RunCmuxCodeOptions): Promise<RunResultOk> {
	const runAc = new AbortController();
	const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
	const signal = AbortSignal.any(
		opts.signal ? [timeoutSignal, opts.signal, runAc.signal] : [timeoutSignal, runAc.signal],
	);
	const runEndedError = postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended"));
	const output = new RunOutput();
	const screenshots: ScreenshotResult[] = [];
	const runId = crypto.randomUUID();
	const filename = `cmux-run-${runId}.js`;
	const activeRun: ActiveCmuxRun = { filename, floatingRejections: [] };
	activeCmuxRuns.set(filename, activeRun);
	tab.setRunContext({ session: opts.snapshot, output, screenshots, signal, timeoutMs: opts.timeoutMs });

	const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
	// If the synchronous setup below throws (same-realm ownership conflict)
	// while `signal` is already aborted, `Promise.race` never attaches a
	// handler to this promise; keep its armed rejection from surfacing as an
	// unhandled rejection — the postmortem-fatal path this run guards against.
	cancelRejection.catch(() => {});
	const rejectionOwner = {};
	const { promise: floatingFailure, reject: rejectFloatingFailure } = Promise.withResolvers<never>();
	floatingFailure.catch(() => {});
	let runActive = true;
	let hasFloatingFailure = false;
	const recordFloatingFailure = (reason: unknown): void => {
		if (hasFloatingFailure || postmortem.isExpectedCleanupError(reason)) return;
		const message = reason instanceof Error ? reason.message : String(reason);
		if (!runActive) {
			logger.warn("Unhandled rejection after browser run ended", { runId, error: message });
			return;
		}
		hasFloatingFailure = true;
		const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
		if (reason instanceof Error) error.name = reason.name;
		rejectFloatingFailure(error);
	};
	const uninstallRejectionInterceptor = postmortem.interceptUnhandledRejections(reason => {
		if (!isBrowserRunOwnedRejection(reason, rejectionOwner, `cmux-run-${runId}.js`)) return false;
		recordFloatingFailure(reason);
		return true;
	});
	const onAbort = (): void => {
		if (timeoutSignal.aborted) {
			reject(new ToolError(`Browser code execution timed out after ${opts.timeoutMs}ms`));
		} else {
			reject(
				signal.reason instanceof ToolAbortError
					? signal.reason
					: new ToolAbortError(undefined, { cause: signal.reason }),
			);
		}
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });

	try {
		const runtime = tab.ensureRuntime(opts.snapshot);
		// setCwd is non-exclusive; setRunScope/run still assert same-realm ownership.
		// Keep both inside try so a concurrent in-process eval/browser run surfaces as
		// a rejected promise the supervisor can report, never an unhandled rejection.
		runtime.setCwd(opts.snapshot.cwd);
		const runTab = bindRunFacade(tab, signal, rejectionOwner, recordFloatingFailure);
		runtime.setRunScope({
			page: bindRunFacade(tab.page, signal, rejectionOwner, recordFloatingFailure),
			browser: bindRunFacade(tab.browser, signal, rejectionOwner, recordFloatingFailure),
			tab: runTab,
			assert: (cond: unknown, text?: string): void => {
				if (!cond) throw new ToolError(text ?? "Assertion failed");
			},
			wait: (msOrPredicate: number | (() => unknown), waitOpts?: WaitPredicateOptions): Promise<unknown> =>
				observeBrowserRunPromise(
					waitForRun(
						msOrPredicate,
						signal,
						typeof msOrPredicate === "number"
							? waitOpts
							: {
									timeout: resolvePredicateTimeout(opts.timeoutMs, waitOpts?.timeout),
									interval: waitOpts?.interval,
								},
					).catch(error => {
						throw markBrowserRunRejection(error, rejectionOwner);
					}),
					rejectionOwner,
					recordFloatingFailure,
				),
		});

		const hooks: RuntimeHooks = {
			onText: chunk => {
				throwIfAborted(signal);
				output.pushText(chunk);
				logger.debug(chunk.replace(/\n$/, ""));
			},
			onDisplay: displayed => {
				throwIfAborted(signal);
				output.pushDisplay(displayed);
			},
			callTool: (name, args) => {
				throwIfAborted(signal);
				return callSessionTool(name, args, { session: opts.session, signal });
			},
		};
		// Like the inline worker fallback, cmux runs user JS in-process: awaited cmux/tool calls
		// observe this abort signal, but a synchronous infinite loop cannot be interrupted here.
		let returnValue: unknown;
		let runError: unknown;
		let runFailed = false;
		try {
			returnValue = await withBrowserPromiseCombinatorTracking(
				rejectionOwner,
				recordFloatingFailure,
				async () =>
					await Promise.race([
						runtime.run(opts.code, filename, hooks, { runId, cwd: opts.snapshot.cwd }),
						cancelRejection,
						floatingFailure,
					]),
			);
		} catch (error) {
			runFailed = true;
			runError = error;
		}
		runAc.abort(runEndedError);
		// Let rejection callbacks run while this run can still own guest-created promises.
		await Bun.sleep(0);
		if (hasFloatingFailure && !runFailed) await floatingFailure;
		if (runFailed) {
			for (const reason of activeRun.floatingRejections) {
				logger.warn("Unhandled rejection accompanied a failed cmux browser run", { filename, error: reason });
			}
			throw runError;
		}
		if (activeRun.floatingRejections.length > 0) {
			const messages = activeRun.floatingRejections.map(reason =>
				reason instanceof Error ? reason.message : String(reason),
			);
			throw new ToolError(`Unhandled rejection (missing await?): ${messages.join("\n[unhandled rejection] ")}`, {
				rejections: activeRun.floatingRejections,
			});
		}
		return { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots };
	} finally {
		runActive = false;
		uninstallRejectionInterceptor();
		signal.removeEventListener("abort", onAbort);
		runAc.abort(runEndedError);
		activeCmuxRuns.delete(filename);
		rememberCmuxRunFile(filename);
		tab.clearRunContext();
	}
}

function cmuxStringRecord(value: object): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in value) result[key] = String((value as Record<string, unknown>)[key]);
	return result;
}

function cmuxHeader(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const key in headers) {
		if (key.toLowerCase() === wanted) return headers[key];
	}
	return undefined;
}

function cmuxRequestMatches(record: CmuxResponseRecord, options: NetworkRequestsOptions): boolean {
	if (options.filter !== undefined) {
		if (typeof options.filter === "string") {
			if (!record.url.includes(options.filter)) return false;
		} else {
			options.filter.lastIndex = 0;
			if (!options.filter.test(record.url)) return false;
		}
	}
	const types = options.type === undefined ? undefined : Array.isArray(options.type) ? options.type : [options.type];
	if (types && !types.includes(record.resourceType)) return false;
	const methods =
		options.method === undefined ? undefined : Array.isArray(options.method) ? options.method : [options.method];
	if (methods && !methods.some(method => method.toUpperCase() === record.method)) return false;
	if (options.status !== undefined && !cmuxStatusMatches(record.status, options.status)) return false;
	if (options.since !== undefined && record.ts < options.since) return false;
	return true;
}

function cmuxStatusMatches(status: number, filter: number | string): boolean {
	if (typeof filter === "number") return status === filter;
	const statusClass = /^(\d)xx$/i.exec(filter);
	if (statusClass) return Math.floor(status / 100) === Number(statusClass[1]);
	const range = /^(\d{3})-(\d{3})$/.exec(filter);
	if (range) return status >= Number(range[1]) && status <= Number(range[2]);
	if (/^\d{3}$/.test(filter)) return status === Number(filter);
	throw new ToolError(`Invalid tab.requests() status filter ${JSON.stringify(filter)}`);
}

function cmuxRequestRecord(record: CmuxResponseRecord): NetworkRequestRecord {
	return {
		id: `request-${record.id}`,
		seq: record.id,
		ts: record.ts,
		method: record.method,
		url: record.url,
		resourceType: record.resourceType,
		status: record.status,
		ok: record.status >= 200 && record.status < 300,
		durationMs: record.durationMs,
		requestHeaders: { ...record.requestHeaders },
		responseHeaders: { ...record.headers },
		sizes: { requestBody: 0, responseBody: Buffer.byteLength(record.body) },
	};
}

function numberFrom(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
