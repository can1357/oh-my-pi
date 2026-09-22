import * as path from "node:path";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ElementHandle, KeyInput, MouseButton, Page } from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";

/** Options accepted by coordinate-based mouse clicks. */
export interface ClickAtOptions {
	/** Mouse button to press. */
	button?: MouseButton;
	/** Number of clicks to dispatch. */
	clickCount?: number;
}

/** Options accepted by pointer movement. */
export interface MouseMoveOptions {
	/** Number of intermediate movement events. */
	steps?: number;
}

/** Options accepted by mouse button transitions. */
export interface MouseButtonOptions {
	/** Mouse button to press or release. */
	button?: MouseButton;
}

/** Options accepted by element highlighting. */
export interface HighlightOptions {
	/** Time to keep the highlight visible in milliseconds. */
	duration?: number;
}

/** Options accepted by element or page scrolling. */
export interface ScrollOptions {
	/** Scroll one matching element instead of the page. */
	selector?: string;
}

/** A browser element handle with omp's additional interaction methods. */
export type InteractionHandle = ElementHandle & {
	dblclick(): Promise<void>;
	check(): Promise<void>;
	uncheck(): Promise<void>;
	highlight(options?: HighlightOptions): Promise<void>;
};

interface ClickPoint {
	x: number;
	y: number;
}

type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string; coveredBy?: string };

interface FilePayload {
	name: string;
	type: string;
	data: string;
}

interface PageRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}

interface PageRoot {
	host?: PageElement;
}

interface PageShadowRoot {
	elementFromPoint(x: number, y: number): PageElement | null;
}

interface PageElement {
	readonly tagName: string;
	id: string;
	type: string;
	checked: boolean;
	files: unknown;
	inert: boolean;
	readonly classList: ArrayLike<string>;
	readonly dataset: Record<string, string>;
	readonly style: Record<string, string>;
	parentElement: PageElement | null;
	shadowRoot: PageShadowRoot | null;
	getBoundingClientRect(): PageRect;
	getRootNode(): PageRoot;
	contains(other: PageElement): boolean;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	dispatchEvent(event: unknown): boolean;
	scrollIntoView(options: { behavior: string; block: string; inline: string }): void;
	remove(): void;
}

interface PageDocument {
	elementFromPoint(x: number, y: number): PageElement | null;
	createElement(tag: string): PageElement;
	getElementById(id: string): PageElement | null;
	documentElement: { append(element: PageElement): void };
}

interface PageGlobals {
	document: PageDocument;
	innerWidth: number;
	innerHeight: number;
	getComputedStyle(element: PageElement): {
		display: string;
		visibility: string;
		pointerEvents: string;
		opacity: string;
	};
	Event: new (type: string, options: { bubbles: boolean }) => unknown;
	File: new (parts: Uint8Array[], name: string, options: { type: string }) => unknown;
	DataTransfer: new () => { items: { add(file: unknown): void }; files: unknown };
	DragEvent: new (type: string, options: { bubbles: boolean; cancelable: boolean; dataTransfer: unknown }) => unknown;
}

function requireFiniteNumber(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new ToolError(`${label} must be a finite number`);
}

/** Return the visible center point of an element or explain why it cannot receive a click. */
export async function isClickActionable(handle: ElementHandle, signal?: AbortSignal): Promise<ActionabilityResult> {
	return (await untilAborted(signal, () =>
		handle.evaluate(el => {
			const element = el as unknown as PageElement;
			const page = globalThis as unknown as PageGlobals;
			const style = page.getComputedStyle(element);
			if (style.display === "none") return { ok: false as const, reason: "display:none" };
			if (style.visibility === "hidden" || style.visibility === "collapse") {
				return { ok: false as const, reason: `visibility:${style.visibility}` };
			}
			if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
			if (Number(style.opacity) === 0) return { ok: false as const, reason: "opacity:0" };
			const rect = element.getBoundingClientRect();
			if (rect.width < 1 || rect.height < 1) return { ok: false as const, reason: "zero-size" };
			const left = Math.max(0, Math.min(page.innerWidth, rect.left));
			const right = Math.max(0, Math.min(page.innerWidth, rect.right));
			const top = Math.max(0, Math.min(page.innerHeight, rect.top));
			const bottom = Math.max(0, Math.min(page.innerHeight, rect.bottom));
			if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };
			const x = Math.floor((left + right) / 2);
			const y = Math.floor((top + bottom) / 2);
			let topElement = page.document.elementFromPoint(x, y);
			for (let depth = 0; topElement?.shadowRoot && depth < 16; depth++) {
				const nested = topElement.shadowRoot.elementFromPoint(x, y);
				if (!nested || nested === topElement) break;
				topElement = nested;
			}
			if (!topElement) return { ok: false as const, reason: "elementFromPoint-null" };
			const composedContains = (ancestor: PageElement, descendant: PageElement): boolean => {
				for (let current: PageElement | null = descendant, depth = 0; current && depth < 64; depth++) {
					if (current === ancestor) return true;
					const root: PageRoot = current.getRootNode();
					current = current.parentElement ?? root.host ?? null;
				}
				return false;
			};
			if (!composedContains(element, topElement) && !composedContains(topElement, element)) {
				const tag = topElement.tagName.toLowerCase();
				const id = topElement.id ? `#${topElement.id}` : "";
				const classes = Array.from(topElement.classList)
					.slice(0, 2)
					.map(name => `.${name}`)
					.join("");
				return { ok: false as const, reason: "covered", coveredBy: `<${tag}${id}${classes}>` };
			}
			return { ok: true as const, x, y };
		}),
	)) as ActionabilityResult;
}

async function actionableClickPoint(handle: ElementHandle, label: string, signal?: AbortSignal): Promise<ClickPoint> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const element = el as unknown as PageElement;
			element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
		}),
	);
	let previous = await untilAborted(signal, () => handle.boundingBox());
	while (true) {
		throwIfAborted(signal);
		await untilAborted(signal, () => Bun.sleep(16));
		const current = await untilAborted(signal, () => handle.boundingBox());
		const stable =
			previous !== null &&
			current !== null &&
			Math.abs(previous.x - current.x) < 0.5 &&
			Math.abs(previous.y - current.y) < 0.5 &&
			Math.abs(previous.width - current.width) < 0.5 &&
			Math.abs(previous.height - current.height) < 0.5;
		const result = await isClickActionable(handle, signal);
		if (stable && result.ok) return { x: result.x, y: result.y };
		if (stable && !result.ok && result.coveredBy) {
			throw new ToolError(`${label} blocked: covered by ${result.coveredBy}`);
		}
		previous = current;
		await untilAborted(signal, () => Bun.sleep(34));
	}
}

/** Click an element only after verifying the dispatched point is not occluded. */
export async function clickElement(
	handle: ElementHandle,
	label: string,
	signal?: AbortSignal,
	options: ClickAtOptions = {},
): Promise<void> {
	const point = await actionableClickPoint(handle, label, signal);
	await untilAborted(signal, () =>
		handle.frame.page().mouse.click(point.x, point.y, {
			button: options.button,
			count: options.clickCount,
		}),
	);
}

/** Resolve text-query matches to the first visible clickable candidate in document order. */
export async function resolveActionableQueryHandlerClickTarget(
	handles: ElementHandle[],
): Promise<ElementHandle | null> {
	const candidates: Array<{ handle: ElementHandle; x: number; y: number; owned: boolean }> = [];
	for (const handle of handles) {
		let candidate = handle;
		let owned = false;
		try {
			const proxy = await handle.evaluateHandle(el =>
				(el as Element).closest('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'),
			);
			const element = proxy.asElement();
			if (element) {
				candidate = element;
				owned = candidate !== handle;
			} else await proxy.dispose();
			const rect = (await candidate.evaluate(el => {
				const box = (el as Element).getBoundingClientRect();
				return { x: box.left, y: box.top, width: box.width, height: box.height };
			})) as { x: number; y: number; width: number; height: number };
			if (rect.width >= 1 && rect.height >= 1 && (await candidate.isIntersectingViewport())) {
				candidates.push({ handle: candidate, x: rect.x, y: rect.y, owned });
			} else if (owned) await candidate.dispose().catch(() => undefined);
		} catch {
			if (owned) await candidate.dispose().catch(() => undefined);
		}
	}
	candidates.sort((a, b) => a.y - b.y || a.x - b.x);
	const winner = candidates.shift();
	for (const candidate of candidates) {
		if (candidate.owned) await candidate.handle.dispose().catch(() => undefined);
	}
	return winner?.handle ?? null;
}

/** Click the actionable match chosen for a Puppeteer text query handler. */
export async function clickQueryHandlerText(
	page: Page,
	selector: string,
	label: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const clickSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	while (true) {
		throwIfAborted(clickSignal);
		const handles = (await untilAborted(clickSignal, () => page.$$(selector))) as ElementHandle[];
		let target: ElementHandle | null = null;
		try {
			target = await resolveActionableQueryHandlerClickTarget(handles);
			if (!target) {
				await untilAborted(clickSignal, () => Bun.sleep(50));
				continue;
			}
			await clickElement(target, label, clickSignal);
			return;
		} finally {
			if (target && !handles.includes(target)) await target.dispose().catch(() => undefined);
			await Promise.all(handles.map(async handle => handle.dispose().catch(() => undefined)));
		}
	}
}

/** Set a native checkable control or ARIA switch to the requested state idempotently. */
export async function setElementChecked(
	handle: ElementHandle,
	checked: boolean,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	const state = (await untilAborted(signal, () =>
		handle.evaluate(el => {
			const element = el as unknown as PageElement;
			const tag = element.tagName.toLowerCase();
			const type = tag === "input" ? element.type.toLowerCase() : "";
			const role = element.getAttribute("role")?.toLowerCase() ?? "";
			if (tag === "input" && (type === "checkbox" || type === "radio")) {
				return { kind: type, checked: element.checked };
			}
			if (role === "switch" || role === "checkbox" || role === "radio") {
				return { kind: `aria-${role}`, checked: element.getAttribute("aria-checked") === "true" };
			}
			return { kind: "", checked: false };
		}),
	)) as { kind: string; checked: boolean };
	if (!state.kind) throw new ToolError(`${label} requires a checkbox, radio, or ARIA switch`);
	if (state.checked === checked) return;
	if (state.kind === "radio" && !checked) {
		await untilAborted(signal, () =>
			handle.evaluate(el => {
				const input = el as unknown as PageElement;
				const page = globalThis as unknown as PageGlobals;
				input.checked = false;
				input.dispatchEvent(new page.Event("input", { bubbles: true }));
				input.dispatchEvent(new page.Event("change", { bubbles: true }));
			}),
		);
		return;
	}
	await clickElement(handle, label, signal);
	await untilAborted(signal, () =>
		handle.evaluate((el, desired) => {
			const element = el as unknown as PageElement;
			const page = globalThis as unknown as PageGlobals;
			const role = element.getAttribute("role")?.toLowerCase();
			const current = role ? element.getAttribute("aria-checked") === "true" : element.checked;
			if (current === desired) return;
			if (role) element.setAttribute("aria-checked", String(desired));
			else element.checked = desired;
			element.dispatchEvent(new page.Event("input", { bubbles: true }));
			element.dispatchEvent(new page.Event("change", { bubbles: true }));
		}, checked),
	);
}

/** Draw a temporary inert outline around an element and remove it after the requested duration. */
export async function highlightElement(
	handle: ElementHandle,
	options: HighlightOptions = {},
	signal?: AbortSignal,
): Promise<void> {
	const duration = options.duration ?? 2_000;
	if (!Number.isFinite(duration) || duration < 0)
		throw new ToolError("highlight duration must be a non-negative number");
	const id = `omp-highlight-${crypto.randomUUID()}`;
	await untilAborted(signal, () =>
		handle.evaluate((el, overlayId) => {
			const element = el as unknown as PageElement;
			const page = globalThis as unknown as PageGlobals;
			const rect = element.getBoundingClientRect();
			const overlay = page.document.createElement("div");
			overlay.id = overlayId;
			overlay.dataset.ompHighlightOverlay = "";
			overlay.setAttribute("aria-hidden", "true");
			overlay.setAttribute("role", "presentation");
			overlay.inert = true;
			Object.assign(overlay.style, {
				position: "fixed",
				left: `${rect.left - 3}px`,
				top: `${rect.top - 3}px`,
				width: `${rect.width + 6}px`,
				height: `${rect.height + 6}px`,
				border: "3px solid #ff3366",
				borderRadius: "4px",
				boxSizing: "border-box",
				pointerEvents: "none",
				zIndex: "2147483647",
			});
			page.document.documentElement.append(overlay);
		}, id),
	);
	try {
		await untilAborted(signal, () => Bun.sleep(duration));
	} finally {
		await handle.frame
			.page()
			.evaluate(overlayId => {
				const page = globalThis as unknown as PageGlobals;
				page.document.getElementById(overlayId)?.remove();
			}, id)
			.catch(() => undefined);
	}
}

/** Upload files through an input, native chooser trigger, or synthetic drop-zone event sequence. */
export async function uploadFilesToElement(
	page: Page,
	handle: ElementHandle,
	absolutePaths: string[],
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	const inputType = (await untilAborted(signal, () =>
		handle.evaluate(el => {
			const element = el as unknown as PageElement;
			return { tag: element.tagName, type: element.type ?? "" };
		}),
	)) as { tag: string; type: string };
	if (inputType.tag === "INPUT" && inputType.type.toLowerCase() === "file") {
		await untilAborted(signal, () =>
			(handle as unknown as { uploadFile: (...paths: string[]) => Promise<void> }).uploadFile(...absolutePaths),
		);
		return;
	}

	const chooserPromise = page.waitForFileChooser({ timeout: 400 }).catch(() => null);
	await clickElement(handle, label, signal);
	const chooser = await untilAborted(signal, () => chooserPromise);
	if (chooser) {
		await untilAborted(signal, () => chooser.accept(absolutePaths));
		return;
	}

	const files: FilePayload[] = [];
	for (const absolute of absolutePaths) {
		throwIfAborted(signal);
		const file = Bun.file(absolute);
		const data = Buffer.from(await file.arrayBuffer()).toString("base64");
		files.push({ name: path.basename(absolute), type: file.type || "application/octet-stream", data });
	}
	await untilAborted(signal, () =>
		handle.evaluate((el, payloads) => {
			const element = el as unknown as PageElement;
			const page = globalThis as unknown as PageGlobals;
			const transfer = new page.DataTransfer();
			for (const payload of payloads) {
				const bytes = Uint8Array.from(atob(payload.data), character => character.charCodeAt(0));
				transfer.items.add(new page.File([bytes], payload.name, { type: payload.type }));
			}
			for (const type of ["dragenter", "dragover", "drop"]) {
				element.dispatchEvent(
					new page.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
				);
			}
		}, files),
	);
}

/** Press a keyboard key without releasing it. */
export async function keyDown(page: Page, key: KeyInput, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => page.keyboard.down(key));
}

/** Release a keyboard key previously pressed with keyDown. */
export async function keyUp(page: Page, key: KeyInput, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => page.keyboard.up(key));
}

/** Move the page pointer to viewport coordinates. */
export async function mouseMove(
	page: Page,
	x: number,
	y: number,
	options: MouseMoveOptions = {},
	signal?: AbortSignal,
): Promise<void> {
	requireFiniteNumber(x, "mouseMove x");
	requireFiniteNumber(y, "mouseMove y");
	await untilAborted(signal, () => page.mouse.move(x, y, options));
}

/** Press a mouse button at the current pointer position. */
export async function mouseDown(page: Page, options: MouseButtonOptions = {}, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => page.mouse.down(options));
}

/** Release a mouse button at the current pointer position. */
export async function mouseUp(page: Page, options: MouseButtonOptions = {}, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => page.mouse.up(options));
}

/** Click the page at viewport coordinates. */
export async function clickAt(
	page: Page,
	x: number,
	y: number,
	options: ClickAtOptions = {},
	signal?: AbortSignal,
): Promise<void> {
	requireFiniteNumber(x, "clickAt x");
	requireFiniteNumber(y, "clickAt y");
	await untilAborted(signal, () =>
		page.mouse.click(x, y, {
			button: options.button,
			count: options.clickCount,
		}),
	);
}

/** Queue one raw mouse-wheel event without waiting for scroll settlement. */
export async function wheel(page: Page, deltaX: number, deltaY: number, signal?: AbortSignal): Promise<void> {
	requireFiniteNumber(deltaX, "wheel deltaX");
	requireFiniteNumber(deltaY, "wheel deltaY");
	await untilAborted(signal, () => page.mouse.wheel({ deltaX, deltaY }));
}
