import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger, postmortem, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "../../../eval/js/shared/runtime";
import { callSessionTool } from "../../../eval/js/tool-bridge";
import { resizeImage } from "../../../utils/image-resize";
import type { ToolSession } from "../../index";
import { resolveToCwd } from "../../path-utils";
import { formatScreenshot } from "../../render-utils";
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
import { ToolAbortError, ToolError, throwIfAborted } from "../../tool-errors";
import { type AriaSnapshotOptions, assertSelectorString, buildAriaSnapshotScript } from "../aria/aria-snapshot";
import { DEFAULT_VIEWPORT } from "../launch";
import { extractReadableFromHtml, type ReadableFormat } from "../readable";
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

interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	silent?: boolean;
	encoding?: "base64" | "binary";
}

interface ObserveOptions {
	includeAll?: boolean;
	viewportOnly?: boolean;
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
type SelectorKind = "css" | "ref" | "aria-ref" | "text" | "aria" | "xpath" | "pierce" | "ax";

interface SelectorSpec {
	kind: SelectorKind;
	value: string;
	raw: string;
	ref?: string;
	name?: string;
	role?: string;
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

interface CmuxResponseRecord {
	id: number;
	url: string;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
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
const accessibleName = element =>
	(
		element.getAttribute("aria-label") ||
		element.getAttribute("alt") ||
		element.getAttribute("title") ||
		textOf(element)
	).trim();
const findElement = spec => {
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
	const remember = async response => {
		try {
			const clone = response.clone();
			const body = await clone.text().catch(() => "");
			state.records.push({
				id: state.nextId++,
				url: response.url,
				status: response.status,
				statusText: response.statusText,
				headers: headersObject(response.headers),
				body,
			});
			if (state.records.length > 200) state.records.splice(0, state.records.length - 200);
		} catch {
		}
	};
	const originalFetch = globalThis.fetch;
	if (typeof originalFetch === "function") {
		globalThis.fetch = async (...args) => {
			const response = await originalFetch(...args);
			void remember(response);
			return response;
		};
	}
	const OriginalXHR = globalThis.XMLHttpRequest;
	if (typeof OriginalXHR === "function") {
		globalThis.XMLHttpRequest = function XMLHttpRequestProxy() {
			const xhr = new OriginalXHR();
			xhr.addEventListener("loadend", () => {
				const rawHeaders = xhr.getAllResponseHeaders();
				const headers = {};
				for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
					const index = line.indexOf(":");
					if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
				}
				state.records.push({
					id: state.nextId++,
					url: xhr.responseURL || "",
					status: xhr.status,
					statusText: xhr.statusText,
					headers,
					body: typeof xhr.responseText === "string" ? xhr.responseText : "",
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
	#lastTitle: string | undefined;
	#lastViewport: ReadyInfo["viewport"] = DEFAULT_VIEWPORT;
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
	}

	async observe(opts?: ObserveOptions): Promise<Observation> {
		void opts?.viewportOnly;
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
		this.#lastUrl = observation.url;
		this.#lastTitle = observation.title;
		this.#rememberObservedElements(observation);
		return observation;
	}

	async ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string> {
		const timeoutMs = Math.min(this.#runContext?.timeoutMs ?? 30_000, 30_000);
		const result = (await this.#request(
			"browser.eval",
			{ script: buildAriaSnapshotScript(selector, opts) },
			timeoutMs,
		)) as CmuxEvalResult;
		return result.value as string;
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

	async scroll(dx: number, dy: number): Promise<void> {
		await this.#request("browser.scroll", { dx, dy });
	}

	async waitFor(selector: string, opts?: { timeout?: number }): Promise<CmuxElementHandle> {
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

	async extract(format: ReadableFormat = "markdown"): Promise<string> {
		const result = (await this.#request("browser.snapshot", { interactive: false })) as CmuxSnapshotResult;
		const html = typeof result.page?.html === "string" ? result.page.html : "";
		const url =
			(typeof result.url === "string" && result.url.length > 0 ? result.url : undefined) ??
			(typeof result.page?.url === "string" && result.page.url.length > 0 ? result.page.url : undefined) ??
			this.#lastUrl;
		const readable = await extractReadableFromHtml(html, url, format);
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

	async pageContent(): Promise<string> {
		return await this.#evalScript<string>("document.documentElement.outerHTML");
	}

	async pageScreenshot(opts: ScreenshotOptions = {}): Promise<Buffer | string> {
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
					element.checked = true;
					inputEvent(element);
					return true;
				case "uncheck":
					element.checked = false;
					inputEvent(element);
					return true;
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
					if (element.tagName !== "INPUT" || element.type !== "file") {
						throw new Error("tab.uploadFile() requires an <input type=file> element");
					}
					const transfer = new DataTransfer();
					for (const file of args.files || []) {
						const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
						transfer.items.add(new File([bytes], file.name, { type: file.type || "application/octet-stream" }));
					}
					element.files = transfer.files;
					inputEvent(element);
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
			records.push({
				id: numberFrom(object.id, 0),
				url: typeof object.url === "string" ? object.url : "",
				status: numberFrom(object.status, 0),
				statusText: typeof object.statusText === "string" ? object.statusText : "",
				headers: Object.fromEntries(
					Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
				),
				body: typeof object.body === "string" ? object.body : "",
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
			if (prefix === "text" || prefix === "aria" || prefix === "xpath" || prefix === "pierce") {
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
		return await this.#tab.waitFor(this.#selector, { timeout: this.#timeoutMs });
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
		return await this.#tab.waitFor(selector, opts);
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

	async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer | string> {
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

function numberFrom(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
