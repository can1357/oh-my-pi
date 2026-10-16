import type { Protocol } from "devtools-protocol";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	ElementHandle,
	Frame,
	JSHandle,
	KeyInput,
	KeyPressOptions,
	MouseButton,
	Page,
	Realm,
} from "puppeteer-core";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { splitKeyCombo, ternKey } from "./tern/keys";
import { devtoolsFrameId } from "./frames";
import {
	createFilePicker,
	openUploadSources,
	pickedFiles,
	refuseFolders,
	setFileInputPaths,
	type UploadFileInfo,
	type UploadRoute,
	type UploadSource,
	type UploadStaging,
} from "./upload-files";

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
	readonly isConnected: boolean;
	type: string;
	checked: boolean;
	files: unknown;
	inert: boolean;
	readonly labels?: ArrayLike<PageElement> | null;
	matches(selector: string): boolean;
	readonly classList: ArrayLike<string>;
	readonly dataset: Record<string, string>;
	readonly style: Record<string, string>;
	parentElement: PageElement | null;
	shadowRoot: PageShadowRoot | null;
	getBoundingClientRect(): PageRect;
	getClientRects(): ArrayLike<PageRect>;
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
	Event: new (type: string, options: { bubbles: boolean; composed?: boolean }) => unknown;
	File: new (parts: Uint8Array[], name: string, options: { type: string; lastModified?: number }) => unknown;
	DataTransfer: new () => { items: { add(file: unknown): void }; files: unknown };
	DragEvent: new (type: string, options: { bubbles: boolean; cancelable: boolean; dataTransfer: unknown }) => unknown;
	MessageChannel: new () => {
		port1: { onmessage: (() => void) | null; close(): void };
		port2: { postMessage(message: null): void; close(): void };
	};
}

/** A click aborted while its element was still refused; `refusal` names the last failed check. */
export class ClickRefusedError extends ToolAbortError {
	constructor(
		readonly refusal: string,
		options?: ErrorOptions,
	) {
		super(undefined, options);
	}
}

function requireFiniteNumber(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new ToolError(`${label} must be a finite number`);
}

/**
 * Page function (self-contained; serialisable via `.toString()`): whether `descendant` is `ancestor` or
 * sits inside it, crossing the shadow-root boundaries `Node.contains` stops at.
 */
export function composedContains(ancestor: unknown, descendant: unknown): boolean {
	for (let current = descendant as PageElement | null; current;) {
		if (current === ancestor) return true;
		const root: PageRoot = current.getRootNode();
		current = current.parentElement ?? root.host ?? null;
	}
	return false;
}

interface ClickFlags {
	viaLabel: boolean;
}

/** Page half of {@link isClickActionable}; `contains` is {@link composedContains}, bound in by `clickActionableInPage`. */
function checkClickActionable(
	el: unknown,
	{ viaLabel }: ClickFlags,
	contains: typeof composedContains,
): ActionabilityResult {
	const element = el as unknown as PageElement;
	const page = globalThis as unknown as PageGlobals;
	// A node the page replaced (e.g. a re-render) has no computed style; say so rather than misread it.
	if (!element.isConnected) {
		return { ok: false as const, reason: "detached (the page replaced this element; look it up again)" };
	}
	const style = page.getComputedStyle(element);
	if (style.display === "none") return { ok: false as const, reason: "display:none" };
	if (style.visibility === "hidden" || style.visibility === "collapse") {
		return { ok: false as const, reason: `visibility:${style.visibility}` };
	}
	if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
	// A custom checkbox or radio keeps its real control at opacity:0 under the box it draws; the hit test below decides.
	if (
		Number(style.opacity) === 0 &&
		!element.matches(
			'input[type="checkbox"], input[type="radio"], [role="checkbox" i], [role="radio" i], [role="switch" i]',
		)
	) {
		return { ok: false as const, reason: "opacity:0" };
	}
	const rect = element.getBoundingClientRect();
	if (rect.width < 1 || rect.height < 1) return { ok: false as const, reason: "zero-size" };
	// A wrapped link's box centre can fall between its lines, on the parent; aim at its first visible line.
	const fragments = Array.from(element.getClientRects());
	const box =
		fragments.length === 0
			? rect
			: fragments.find(
					r =>
						Math.min(page.innerWidth, r.right) - Math.max(0, r.left) >= 1 &&
						Math.min(page.innerHeight, r.bottom) - Math.max(0, r.top) >= 1,
				);
	if (!box) return { ok: false as const, reason: "off-viewport" };
	const left = Math.max(0, Math.min(page.innerWidth, box.left));
	const right = Math.max(0, Math.min(page.innerWidth, box.right));
	const top = Math.max(0, Math.min(page.innerHeight, box.top));
	const bottom = Math.max(0, Math.min(page.innerHeight, box.bottom));
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
	// A label forwards a click to its control unless the hit is other interactive content inside it.
	const interactiveContent =
		'a[href], area[href], button, details, embed, iframe, input:not([type="hidden"]), label, select, textarea, summary, audio[controls], video[controls], [contenteditable=""], [contenteditable="true"]';
	const hit: PageElement = topElement;
	const forwardedBy = (owner: PageElement): boolean => {
		let current: PageElement | null = hit;
		while (current && current !== owner) {
			if (current.matches(interactiveContent)) return false;
			current = current.parentElement ?? current.getRootNode().host ?? null;
		}
		return current === owner;
	};
	const onTarget =
		contains(element, topElement) ||
		contains(topElement, element) ||
		(viaLabel && Array.from(element.labels ?? []).some(forwardedBy));
	if (!onTarget) {
		const tag = topElement.tagName.toLowerCase();
		const id = topElement.id ? `#${topElement.id}` : "";
		const classes = Array.from(topElement.classList)
			.slice(0, 2)
			.map(name => `.${name}`)
			.join("");
		return { ok: false as const, reason: "covered", coveredBy: `<${tag}${id}${classes}>` };
	}
	return { ok: true as const, x: x - rect.left, y: y - rect.top };
}

/** {@link checkClickActionable} with {@link composedContains} bound in, as one self-contained page function. */
const clickActionableInPage = new Function(
	"el",
	"flags",
	`return (${checkClickActionable.toString()})(el, flags, ${composedContains.toString()});`,
) as (el: unknown, flags: ClickFlags) => ActionabilityResult;

/**
 * Return a visible point relative to the element's box, or explain why it cannot receive a click.
 * A left click on one of the control's own `<label>`s counts as on-target, since the label forwards it.
 */
export async function isClickActionable(
	handle: ElementHandle,
	signal?: AbortSignal,
	options: Pick<ClickAtOptions, "button"> = {},
): Promise<ActionabilityResult> {
	const flags: ClickFlags = { viaLabel: (options.button ?? "left") === "left" };
	return await untilAborted(signal, () => handle.evaluate(clickActionableInPage, flags));
}

async function actionableClickPoint(
	handle: ElementHandle,
	label: string,
	signal: AbortSignal | undefined,
	options: ClickAtOptions,
): Promise<ClickPoint> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const element = el as unknown as PageElement;
			element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
		}),
	);
	let previous = await untilAborted(signal, () => handle.boundingBox());
	let refusal: string | undefined;
	try {
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
			const result = await isClickActionable(handle, signal, options);
			// ElementHandle.boundingBox() is relative to the main frame; elementFromPoint() above is frame-local.
			if (stable && result.ok && current) return { x: current.x + result.x, y: current.y + result.y };
			if (stable && !result.ok && result.coveredBy) {
				throw new ToolError(`${label} blocked: covered by ${result.coveredBy}`);
			}
			refusal = result.ok ? "still moving" : result.coveredBy ? `covered by ${result.coveredBy}` : result.reason;
			previous = current;
			await untilAborted(signal, () => Bun.sleep(34));
		}
	} catch (error) {
		if (signal?.aborted && refusal !== undefined) throw new ClickRefusedError(refusal, { cause: signal.reason });
		throw error;
	}
}

/**
 * Click an element only after verifying the dispatched point is not occluded, then confirm the browser
 * delivered the click to it: the target got the `mousedown` or `click` (a label's forwarded `click` counts
 * for its control), or the page consumed its `pointerdown` with `preventDefault()`, which suppresses the
 * mouse events after it. A disabled control gets only an unconsumed `pointerdown` and an inert subtree
 * nothing, so a click the page never saw fails instead of reporting success.
 */
export async function clickElement(
	handle: ElementHandle,
	label: string,
	signal?: AbortSignal,
	options: ClickAtOptions = {},
): Promise<void> {
	const point = await actionableClickPoint(handle, label, signal, options);
	const watch = await untilAborted(signal, () =>
		handle.evaluateHandle(el => {
			interface InputEvent {
				type: string;
				defaultPrevented: boolean;
				composedPath(): unknown[];
			}
			type Listen = (type: string, listener: (event: InputEvent) => void, capture: boolean) => void;
			const target = el as unknown as { addEventListener: Listen; removeEventListener: Listen };
			const page = globalThis as unknown as { addEventListener: Listen; removeEventListener: Listen };
			const pointerDowns: InputEvent[] = [];
			const state = {
				reached: false,
				// Read after the click: the page's handlers have run by then.
				delivered: () => state.reached || pointerDowns.some(event => event.defaultPrevented),
				stop: () => {},
			};
			const record = (event: InputEvent) => {
				if (event.type === "pointerdown") pointerDowns.push(event);
				else state.reached = true;
			};
			// The target's own listener sees events inside a closed shadow root, which the window's path hides;
			// the window's sees an event a page handler stops before it reaches the target.
			const onPage = (event: InputEvent) => {
				if (event.composedPath().includes(el)) record(event);
			};
			const types = ["pointerdown", "mousedown", "click"];
			for (const type of types) {
				target.addEventListener(type, record, true);
				page.addEventListener(type, onPage, true);
			}
			state.stop = () => {
				for (const type of types) {
					target.removeEventListener(type, record, true);
					page.removeEventListener(type, onPage, true);
				}
			};
			return state;
		}),
	);
	try {
		await untilAborted(signal, () =>
			handle.frame.page().mouse.click(point.x, point.y, {
				button: options.button,
				count: options.clickCount,
			}),
		);
	} catch (error) {
		// The page may be stuck; tidy up without waiting on it.
		void watch
			.evaluate(state => state.stop())
			.catch(() => undefined)
			.finally(() => watch.dispose().catch(() => undefined));
		throw error;
	}
	// A click that navigated away took the page's record with it; it reached the page. A cancelled call
	// still fails as cancelled.
	const delivered = await untilAborted(signal, () =>
		watch.evaluate(state => {
			state.stop();
			return state.delivered();
		}),
	).catch((error: unknown) => {
		if (signal?.aborted) throw error;
		return true;
	});
	await watch.dispose().catch(() => undefined);
	if (!delivered) {
		throw new ToolError(`${label}: the browser did not deliver the click to the element (disabled or inert)`);
	}
}

/**
 * Focus a text-entry target, refusing one that cannot take keystrokes. A
 * disabled control ignores `focus()`, so they would land in whichever element
 * had focus; a read-only one drops them. The check runs after `focus()` so a
 * focus handler that locks the field is seen.
 */
export async function focusTextEntryTarget(
	handle: ElementHandle,
	action: "fill" | "type into",
	signal?: AbortSignal,
): Promise<void> {
	const refusal = await untilAborted(signal, () =>
		handle.evaluate(el => {
			const node = el as unknown as {
				readOnly?: boolean;
				focus?: () => void;
				matches(selector: string): boolean;
			};
			node.focus?.();
			if (node.matches(":disabled")) return "disabled";
			if (node.readOnly) return "read-only";
			return null;
		}),
	);
	if (refusal) throw new ToolError(`Cannot ${action} a ${refusal} element`);
}

/**
 * Input types set through a picker or slider, with an example of the value each takes. Typing into
 * one fills its segments by keystroke rules (`2026-10-12` became `61012-02-02`) or nothing at all
 * (a colour stayed `#000000`, a range at its midpoint), so fill sets their value instead.
 */
const PICKER_VALUE_EXAMPLES: Record<string, string> = {
	color: '"#ff8800"',
	date: '"2026-10-12"',
	"datetime-local": '"2026-10-12T14:30"',
	month: '"2026-10"',
	time: '"14:30"',
	week: '"2026-W41"',
	range: "a number within its min, max and step",
};
const PICKER_INPUT_TYPES = Object.keys(PICKER_VALUE_EXAMPLES);

/**
 * Focus a field that can take text, clear any existing value, then retype. A colour, date, time or
 * range input gets its value set the way its picker would, and refuses one it rejects.
 *
 * Every step is a DOM evaluation or an input dispatch, so this works on tabs
 * that produce no animation frames — unlike Puppeteer's `Locator.fill`, whose
 * viewport/stability/enabled preconditions wait on `requestAnimationFrame`
 * and `IntersectionObserver` callbacks that a backgrounded headless tab never
 * delivers (#12892).
 *
 * `type` overrides how the value is entered, for callers that need their own
 * abort-aware keyboard loop.
 */
export async function fillViaHandle(
	handle: ElementHandle,
	value: string,
	signal?: AbortSignal,
	type: (text: string) => Promise<unknown> = text => handle.type(text, { delay: 0 }),
): Promise<void> {
	await focusTextEntryTarget(handle, "fill", signal);
	const picker = await untilAborted(signal, () =>
		handle.evaluate(
			(el, wanted, pickerTypes) => {
				const node = el as unknown as {
					localName?: string;
					type?: string;
					value?: string;
					focus?: () => void;
					isContentEditable?: boolean;
					innerText?: string;
					getAttribute(name: string): string | null;
					namespaceURI: string | null;
					ownerDocument: {
						createElementNS(
							namespace: string | null,
							tag: "input",
						): { value: string; setAttribute(name: string, value: string): void };
					};
					dispatchEvent(event: unknown): boolean;
				};
				node.focus?.();
				// The native setter bypasses value trackers that frameworks (React) install on the element, so
				// they see the new value as a change instead of their own write. It is looked up past the
				// prototypes of a customized built-in (`<input is=…>`), which do not own `value`. A page class
				// that defines its own `value` accessor is not on the chain this function sees, so that accessor
				// never runs here.
				let proto = Object.getPrototypeOf(node);
				let descriptor: PropertyDescriptor | undefined;
				while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, "value"))) {
					proto = Object.getPrototypeOf(proto);
				}
				const setValue = descriptor?.set;
				const write = (next: string) => (setValue ? setValue.call(node, next) : (node.value = next));
				// Like the browser's own, input leaves a shadow root and change stays inside it.
				const report = () => {
					const { Event } = globalThis as unknown as PageGlobals;
					node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
					node.dispatchEvent(new Event("change", { bubbles: true }));
				};
				const kind = node.type?.toLowerCase() ?? "";
				// localName, not tagName: an XHTML page keeps the tag's lower case.
				if (node.localName === "input" && pickerTypes.includes(kind)) {
					const before = node.value ?? "";
					// Tried on a plain input with the same type, min, max and step: a value written to the live
					// control and then put back would still cut it off from its value attribute, and a copy of a
					// customized built-in would run the page's constructor. It takes the target's namespace, which
					// an XML document's createElement would drop for a generic element that keeps any value.
					const probe = node.ownerDocument.createElementNS(node.namespaceURI, "input");
					for (const name of ["type", "min", "max", "step"]) {
						const attribute = node.getAttribute(name);
						if (attribute !== null) probe.setAttribute(name, attribute);
					}
					probe.value = wanted;
					// The browser normalises what it accepts (a colour to #rrggbb, a time's seconds), turns what
					// it rejects into "" (a colour into #000000, a range into its midpoint) and clamps a range. A
					// colour stored as #000000 is accepted only if it draws black, so the browser resolves it rather
					// than a parser saying it is well-formed (`var(--missing)` is, and is still refused). A
					// rejected range number can land on the midpoint it coerces to (`0x5`), so its spelling is
					// checked against the decimal form the browser parses. Only the date and time types can be
					// cleared.
					const actual = probe.value;
					let refused: boolean;
					if (kind === "color") {
						const { OffscreenCanvas } = globalThis as unknown as {
							OffscreenCanvas: new (
								width: number,
								height: number,
							) => {
								getContext(type: "2d"): {
									fillStyle: string;
									fillRect(x: number, y: number, width: number, height: number): void;
									getImageData(
										x: number,
										y: number,
										width: number,
										height: number,
									): { data: ArrayLike<number> };
								} | null;
							};
						};
						// A colour the canvas cannot parse keeps the white set first, so it draws white.
						const paint = new OffscreenCanvas(1, 1).getContext("2d");
						let drawsBlack = false;
						if (paint) {
							paint.fillStyle = "#ffffff";
							paint.fillStyle = wanted;
							paint.fillRect(0, 0, 1, 1);
							const [red, green, blue] = Array.from(paint.getImageData(0, 0, 1, 1).data);
							drawsBlack = red === 0 && green === 0 && blue === 0;
						}
						refused = actual === "#000000" && !drawsBlack;
					} else if (kind === "range") {
						refused =
							!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(wanted) || Number(actual) !== Number(wanted);
					} else {
						refused = wanted !== "" && actual === "";
					}
					// A picker reports a pick that changes the value, not one that keeps it.
					if (!refused && actual !== before) {
						write(wanted);
						report();
					}
					return { kind, refused };
				}
				const before = node.isContentEditable ? node.innerText : node.value;
				if (node.isContentEditable) node.innerText = "";
				else if ("value" in node) write("");
				// Typing a value fires its own input events; an empty value types nothing,
				// so report the clear itself when there was something to clear.
				if (wanted === "" && before) report();
				return null;
			},
			value,
			PICKER_INPUT_TYPES,
		),
	);
	if (picker?.refused) {
		throw new ToolError(
			`<input type=${picker.kind}> does not accept ${JSON.stringify(value)}; give its value format, e.g. ${PICKER_VALUE_EXAMPLES[picker.kind]}`,
		);
	}
	if (picker) return;
	await untilAborted(signal, () => type(value));
}

interface QueryCandidate {
	handle: ElementHandle;
	/** Document coordinates, so candidates measured at different scroll offsets still compare. */
	x: number;
	y: number;
	onScreen: boolean;
	/** Shown only as a strip at an edge; see {@link MeasuredBox.edgeOnly}. */
	edgeOnly: boolean;
	owned: boolean;
}

async function disposeOwned(candidates: Iterable<QueryCandidate>): Promise<void> {
	for (const candidate of candidates) {
		if (candidate.owned) await candidate.handle.dispose().catch(() => undefined);
	}
}

interface MeasuredBox {
	x: number;
	y: number;
	sized: boolean;
	onScreen: boolean;
	/** Missed by every interior probe but hit half a pixel inside an edge, as a strip a scroll container leaves in view is. */
	edgeOnly: boolean;
}

/**
 * Runs in the page: the element's document position, whether it has a box, and whether the browser shows
 * it anywhere in the viewport. Visibility is the renderer's own hit test at a few points of each on-screen
 * fragment, landing on the element or inside it, so every clip, transform, top layer and containment rule
 * is the browser's. An element hit testing cannot see (`pointer-events: none`, `visibility: hidden`, inert)
 * is not shown.
 * Self-contained, since Puppeteer serializes it.
 */
function measureBoxInPage(el: unknown): MeasuredBox {
	const element = el as unknown as PageElement;
	const page = globalThis as unknown as PageGlobals & { scrollX: number; scrollY: number };
	const rect = element.getBoundingClientRect();
	const inViewport = (r: PageRect) => ({
		left: Math.max(0, r.left),
		top: Math.max(0, r.top),
		right: Math.min(page.innerWidth, r.right),
		bottom: Math.min(page.innerHeight, r.bottom),
	});
	const shown = Array.from(element.getClientRects())
		.map(inViewport)
		.filter(r => r.right - r.left >= 1 && r.bottom - r.top >= 1);
	const style = page.getComputedStyle(element);
	const hitTestable =
		style.pointerEvents !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
	const hitsElement = (x: number, y: number): boolean => {
		let hit = page.document.elementFromPoint(x, y);
		for (let depth = 0; hit?.shadowRoot && depth < 16; depth++) {
			const nested = hit.shadowRoot.elementFromPoint(x, y);
			if (!nested || nested === hit) break;
			hit = nested;
		}
		for (let node = hit; node; node = node.parentElement ?? node.getRootNode().host ?? null) {
			if (node === element) return true;
		}
		return false;
	};
	// The resolver still falls back to a match that is not shown, so the click's actionability check says why.
	const hitAny = (points: (r: { left: number; right: number; top: number; bottom: number }) => number[][]) =>
		hitTestable && shown.some(r => points(r).some(([x, y]) => hitsElement(x, y)));
	const grid = (xs: number[], ys: number[]) => xs.flatMap(x => ys.map(y => [x, y]));
	const interior = (start: number, end: number) => [0.5, 0.15, 0.85].map(f => start + (end - start) * f);
	const onScreen = hitAny(r => grid(interior(r.left, r.right), interior(r.top, r.bottom)));
	// Every shown rect is at least 1px on each axis, so half a pixel in stays inside it.
	const edgeOnly =
		!onScreen &&
		hitAny(r => {
			const xs = interior(r.left, r.right);
			const ys = interior(r.top, r.bottom);
			const edgeXs = [r.left + 0.5, r.right - 0.5];
			const edgeYs = [r.top + 0.5, r.bottom - 0.5];
			return [...grid(edgeXs, [...ys, ...edgeYs]), ...grid(xs, edgeYs)];
		});
	return {
		x: rect.left + page.scrollX,
		y: rect.top + page.scrollY,
		sized: rect.width >= 1 && rect.height >= 1,
		onScreen,
		edgeOnly,
	};
}

/**
 * Lift a text match to its clickable ancestor and measure it, or return null for a match with no box.
 * `isIntersectingViewport` waits on an `IntersectionObserver` callback that background tabs never
 * deliver, so visibility comes from {@link measureBoxInPage}'s synchronous hit test instead.
 */
async function measureQueryCandidate(handle: ElementHandle, signal?: AbortSignal): Promise<QueryCandidate | null> {
	let candidate = handle;
	let owned = false;
	try {
		const proxy = await untilAborted(signal, () =>
			handle.evaluateHandle(el =>
				(el as Element).closest('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'),
			),
		);
		const element = proxy.asElement();
		if (element) {
			candidate = element;
			owned = candidate !== handle;
		} else await proxy.dispose();
		const box = await untilAborted(signal, () => candidate.evaluate(measureBoxInPage));
		if (box.sized) {
			return { handle: candidate, x: box.x, y: box.y, onScreen: box.onScreen, edgeOnly: box.edgeOnly, owned };
		}
	} catch (error) {
		if (owned) await candidate.dispose().catch(() => undefined);
		if (signal?.aborted) throw error;
		return null;
	}
	if (owned) await candidate.dispose().catch(() => undefined);
	return null;
}

/**
 * Scroll an off-screen match into view: `shown` when the browser's hit test finds it there, `reachable`
 * when the actionability check would let a click go at it (it also accepts a hit on an ancestor, which is
 * what a clipped or inert match yields) or names what covers it.
 */
async function probeOffScreen(
	handle: ElementHandle,
	signal?: AbortSignal,
): Promise<{ shown: boolean; reachable: boolean }> {
	try {
		await untilAborted(signal, () =>
			handle.evaluate(el => {
				const element = el as unknown as PageElement;
				element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
			}),
		);
		const actionable = await isClickActionable(handle, signal);
		const reachable = actionable.ok || actionable.coveredBy !== undefined;
		if (!actionable.ok) return { shown: false, reachable };
		const box = await untilAborted(signal, () => handle.evaluate(measureBoxInPage));
		return { shown: box.onScreen, reachable };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { shown: false, reachable: false };
	}
}

/**
 * Resolve text-query matches to the first match the browser shows on screen, in document order. A match
 * shown only as a strip at an edge counts once scrolling it into view lets the browser hit its interior,
 * as with a strip a scroll container leaves; one an overlay covers stays covered there. When none is on
 * screen, off-screen matches are scrolled into view in document order and the first one shown wins;
 * failing that, the first one a click could be aimed at, then the first match, so the click itself reports
 * what stops it.
 */
export async function resolveActionableQueryHandlerClickTarget(
	handles: ElementHandle[],
	signal?: AbortSignal,
): Promise<ElementHandle | null> {
	const candidates: QueryCandidate[] = [];
	let winner: QueryCandidate | undefined;
	try {
		for (const handle of handles) {
			const candidate = await measureQueryCandidate(handle, signal);
			if (candidate) candidates.push(candidate);
		}
		candidates.sort((a, b) => a.y - b.y || a.x - b.x);
		for (const candidate of candidates) {
			if (candidate.onScreen || (candidate.edgeOnly && (await probeOffScreen(candidate.handle, signal)).shown)) {
				winner = candidate;
				break;
			}
		}
		if (!winner) {
			let reachable: QueryCandidate | undefined;
			for (const candidate of candidates) {
				const probe = await probeOffScreen(candidate.handle, signal);
				if (probe.shown) {
					winner = candidate;
					break;
				}
				if (probe.reachable) reachable ??= candidate;
			}
			winner ??= reachable ?? candidates[0];
		}
	} catch (error) {
		await disposeOwned(candidates);
		throw error;
	}
	await disposeOwned(candidates.filter(candidate => candidate !== winner));
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
			target = await resolveActionableQueryHandlerClickTarget(handles, clickSignal);
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

/**
 * Select `<select>` options by value, then by visible label, and return the values this call
 * selected. An exact value match always wins over a label, so value-based calls keep their
 * meaning. A single `<select>` takes the first matching value. A value that matches no option
 * throws before the select is touched, so a typo never commits the browser's default option.
 */
export async function selectElementOptions(
	handle: ElementHandle,
	values: string[],
	label: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const outcome = (await untilAborted(signal, () =>
		handle.evaluate((el, vals) => {
			interface SelectOption {
				value: string;
				label: string;
				text: string;
				index: number;
				selected: boolean;
			}
			interface SelectLike {
				tagName: string;
				multiple: boolean;
				selectedIndex: number;
				options: ArrayLike<SelectOption>;
				dispatchEvent: (event: unknown) => boolean;
			}
			const select = el as unknown as SelectLike;
			if (select?.tagName !== "SELECT") return null;
			const page = globalThis as unknown as PageGlobals;
			const options = Array.from(select.options);
			const wanted: SelectOption[] = [];
			const missing: string[] = [];
			for (const value of vals as string[]) {
				const option =
					options.find(candidate => candidate.value === value) ??
					options.find(
						candidate => candidate.label === value || candidate.text.replace(/\s+/g, " ").trim() === value,
					);
				if (option) wanted.push(option);
				else missing.push(value);
			}
			if (missing.length > 0) return { missing };
			let selected: string[];
			if (wanted.length === 0) {
				for (const option of options) option.selected = false;
				selected = [];
			} else if (select.multiple) {
				for (const option of options) option.selected = wanted.includes(option);
				selected = options.filter(option => option.selected).map(option => option.value);
			} else {
				select.selectedIndex = wanted[0]!.index;
				selected = [wanted[0]!.value];
			}
			select.dispatchEvent(new page.Event("input", { bubbles: true }));
			select.dispatchEvent(new page.Event("change", { bubbles: true }));
			return { selected };
		}, values),
	)) as { missing: string[] } | { selected: string[] } | null;
	if (!outcome) throw new ToolError(`${label} requires a <select> element`);
	if ("missing" in outcome)
		throw new ToolError(
			`No <select> option matches ${outcome.missing.map(value => JSON.stringify(value)).join(", ")}`,
		);
	return outcome.selected;
}

/** How long a click has to open a file chooser before the target counts as a drop zone. */
const FILE_CHOOSER_WAIT_MS = 400;

/**
 * Raw bytes per call into the page. Each call is one CDP message carrying its chunk base64-encoded, so an upload of any
 * size stays far below the websocket message caps on the way (the relay's is 256 MiB).
 */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Chunk calls in flight at once, so the CDP round trips overlap. */
const UPLOAD_CHUNKS_IN_FLIGHT = 4;

/** Store chunk `seq` of file `index` of a page-side upload. Runs in the isolated world. */
function storeUploadChunk(parts: Uint8Array[][], index: number, seq: number, data: string): void {
	parts[index] ??= [];
	// Chrome before 140 has no `fromBase64`.
	parts[index][seq] =
		typeof Uint8Array.fromBase64 === "function"
			? Uint8Array.fromBase64(data)
			: Uint8Array.from(atob(data), character => character.charCodeAt(0));
}

/** Build an upload's files from their stored chunks. Runs in the isolated world. */
function buildUploadFiles(parts: Uint8Array[][], files: UploadFileInfo[]): unknown[] {
	const page = globalThis as unknown as PageGlobals;
	return files.map(
		(file, index) =>
			new page.File(parts[index] ?? [], file.name, { type: file.type, lastModified: file.lastModified }),
	);
}

/** Why a file input cannot take `count` files, or null. Runs in the page. */
function fileInputRefusal(el: unknown, count: number): string | null {
	const element = el as PageElement & { multiple: boolean };
	if (count > 1 && !element.multiple) return "Multiple file uploads only work with <input type=file multiple>";
	if (element.tagName !== "INPUT" || element.type?.toLowerCase() !== "file") return "Node is not a file input element";
	return null;
}

/** Give a file input `files` and fire the events a user's pick would; returns why it refused. Runs in the isolated world. */
function assignInputFiles(el: unknown, files: unknown[]): string | null {
	const element = el as PageElement & { multiple: boolean };
	const page = globalThis as unknown as PageGlobals;
	if (files.length > 1 && !element.multiple) return "Multiple file uploads only work with <input type=file multiple>";
	if (element.tagName !== "INPUT" || element.type?.toLowerCase() !== "file") return "Node is not a file input element";
	const transfer = new page.DataTransfer();
	for (const file of files) transfer.items.add(file);
	element.files = transfer.files;
	element.dispatchEvent(new page.Event("input", { bubbles: true, composed: true }));
	element.dispatchEvent(new page.Event("change", { bubbles: true }));
	return null;
}

/** Tell a page its chooser closed without a pick, as the browser does. Runs in the isolated world. */
function cancelChooser(el: unknown): void {
	const page = globalThis as unknown as PageGlobals;
	(el as PageElement).dispatchEvent(new page.Event("cancel", { bubbles: true }));
}

/**
 * Drop `files` on an element through the drag events a user's drop fires. Runs in the isolated world.
 *
 * A user's drop runs the page's microtasks after each listener, so a drop handler may read the files after an `await`.
 * A script's `dispatchEvent` runs them only once the script yields, so each event is followed by a yield to a task
 * (a message, which background tabs do not throttle as they do timers) that lets everything the event queued settle.
 * A user's drag events go to whatever is under the pointer, so when a settled event replaced the element (a framework
 * rerendering the zone on `dragenter`), the next one goes to its replacement at the same point.
 */
async function dropUploadFiles(el: unknown, files: unknown[], watch: string): Promise<void> {
	const element = el as PageElement;
	const page = globalThis as unknown as PageGlobals;
	const transfer = new page.DataTransfer();
	for (const file of files) transfer.items.add(file);
	const rect = element.getBoundingClientRect();
	const x = rect.left + rect.width / 2;
	const y = rect.top + rect.height / 2;
	// The element's document or shadow root, both of which resolve a point; taken now, before a rerender detaches it.
	const root = element.getRootNode() as unknown as PageShadowRoot;
	const target = (): PageElement => (element.isConnected ? element : (root.elementFromPoint(x, y) ?? element));
	const settle = async (): Promise<void> => {
		const channel = new page.MessageChannel();
		const { promise, resolve } = Promise.withResolvers<void>();
		channel.port1.onmessage = () => resolve();
		channel.port2.postMessage(null);
		try {
			await promise;
		} finally {
			channel.port1.close();
			channel.port2.close();
		}
	};
	const fire = (on: PageElement, type: string) =>
		on.dispatchEvent(new page.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
	fire(target(), "dragenter");
	await settle();
	fire(target(), "dragover");
	await settle();
	// `watch`, private to this drop, opens the count of reads for {@link watchDropRead} right before `drop` and closes it
	// once what `drop` queued has settled, so reads made in `drop` or in the microtasks it queued count, and reads
	// deferred from dragenter or dragover do not. Its listener sits on the original element, so the watch events go
	// there even after a rerender: they only wrap and unwrap the shared `DataTransfer`.
	fire(element, watch);
	fire(target(), "drop");
	await settle();
	fire(element, watch);
}

/** A watch for a page reading a drop's files; see {@link watchDropRead}. */
interface DropReadWatch {
	counting: boolean;
	read: boolean;
	end(): void;
}

/**
 * Watch for the page reading the files of the drop on an element: getting the drop's `files` or `items` while `drop` is
 * dispatched or in what it queued before the next task. {@link dropUploadFiles} fires the private `type` event right
 * before `drop`, which wraps the getters and opens the count, and again once `drop` has settled, which closes it. No
 * page listener can run before the first, as one registered for `drop` itself could; reads during dragenter and
 * dragover, or deferred from them, stay uncounted. Runs in the main world, where the page's listeners get the wrapper
 * whose reads it watches.
 */
function watchDropRead(el: unknown, type: string): DropReadWatch {
	interface DropEvent {
		dataTransfer: object | null;
	}
	interface WatchTarget {
		addEventListener(type: string, listener: (event: DropEvent) => void): void;
		removeEventListener(type: string, listener: (event: DropEvent) => void): void;
	}
	const element = el as unknown as WatchTarget;
	const instrument = (event: DropEvent): void => {
		const transfer = event.dataTransfer;
		if (!transfer) return;
		if (watch.counting) {
			watch.counting = false;
			return;
		}
		for (const key of ["files", "items"]) {
			// The wrapper's own prototype, not the `DataTransfer` global a page may replace.
			const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(transfer), key)?.get;
			Object.defineProperty(transfer, key, {
				configurable: true,
				get() {
					if (watch.counting) watch.read = true;
					return get?.call(transfer);
				},
			});
		}
		watch.counting = true;
	};
	const watch = { counting: false, read: false, end: () => element.removeEventListener(type, instrument) };
	element.addEventListener(type, instrument);
	return watch;
}

/** Stop a drop watch; whether the page read the files. Runs in the main world. */
function endDropReadWatch(watch: DropReadWatch): boolean {
	watch.end();
	return watch.read;
}

/** End a drop watch and release its handle. */
async function releaseDropReadWatch(watch: JSHandle<DropReadWatch>): Promise<void> {
	try {
		await watch.evaluate(endDropReadWatch);
	} finally {
		await watch.dispose();
	}
}

/**
 * Wait for `pending` under `signal`. An abort does not stop the call behind it, so a result that arrives after the
 * abort is handed to `release`.
 */
async function untilAbortedOrReleased<T>(
	signal: AbortSignal | undefined,
	pending: Promise<T>,
	release: (late: T) => Promise<unknown>,
): Promise<T> {
	return await untilAborted(signal, () => pending).catch(error => {
		void pending.then(release).catch(() => undefined);
		throw error;
	});
}

/**
 * Run `drop` on `zone` with a fresh private watch event type and report whether the page read the dropped files.
 * Canceling proves nothing: pages cancel dragover and drop document-wide only to stop the browser navigating to a
 * dropped file. A read is the strongest signal there is, not proof of acceptance: a document guard that checks
 * `files.length` counts too, and counting element-level reads only would fail delegated drop zones, which read at the
 * document (React 16 and older, jQuery `.on("drop", selector)`). A drop that navigates the zone's frame destroys the
 * worlds holding the drop and its watch before either answers; the page took the drop, so that counts as taken.
 */
async function dropRead(
	zone: ElementHandle,
	drop: (watch: string) => Promise<void>,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const type = `omp-upload-drop-${crypto.randomUUID()}`;
	const frame = zone.frame;
	const realm = frame.mainRealm();
	const target = await untilAbortedOrReleased(signal, realm.adoptHandle(zone), late => late.dispose());
	let navigated = false;
	const onNavigated = (navigatedFrame: Frame) => {
		if (navigatedFrame === frame) navigated = true;
	};
	const page = frame.page();
	page.on("framenavigated", onNavigated);
	try {
		const watch = await untilAbortedOrReleased(
			signal,
			realm.evaluateHandle(watchDropRead, target, type),
			releaseDropReadWatch,
		);
		try {
			try {
				await drop(type);
			} catch (error) {
				const read = await watch.evaluate(endDropReadWatch).catch(() => false);
				if (navigated && !signal?.aborted) return true;
				if (read && !signal?.aborted) return true;
				throw error;
			}
			return await untilAborted(signal, () => watch.evaluate(endDropReadWatch)).catch(error => {
				if (navigated && !signal?.aborted) return true;
				throw error;
			});
		} finally {
			await watch.dispose().catch(() => undefined);
		}
	} finally {
		page.off("framenavigated", onNavigated);
		await target.dispose().catch(() => undefined);
	}
}

/**
 * Stream files into `realm` in chunks, several calls in flight, and return a handle to the built `File` array. The
 * isolated world builds them, so the `File` and base64 decoding a page may replace are never the ones used.
 */
async function streamUploadFiles(
	realm: Realm,
	sources: UploadSource[],
	signal: AbortSignal | undefined,
): Promise<JSHandle<unknown[]>> {
	const parts = await untilAborted(signal, () => realm.evaluateHandle(() => [] as Uint8Array[][]));
	try {
		const chunks = sources.flatMap(({ file, size }, index) =>
			Array.from({ length: Math.ceil(size / UPLOAD_CHUNK_BYTES) }, (_, seq) => ({ file, index, seq })),
		);
		// The first failed chunk stops the others.
		const stop = new AbortController();
		const chunkSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
		let next = 0;
		const send = async (): Promise<void> => {
			while (next < chunks.length) {
				const { file, index, seq } = chunks[next++]!;
				const start = seq * UPLOAD_CHUNK_BYTES;
				const bytes = await untilAborted(chunkSignal, () =>
					file.slice(start, start + UPLOAD_CHUNK_BYTES).arrayBuffer(),
				);
				const data = Buffer.from(bytes).toString("base64");
				await untilAborted(chunkSignal, () => parts.evaluate(storeUploadChunk, index, seq, data));
			}
		};
		const senders = Math.min(UPLOAD_CHUNKS_IN_FLIGHT, chunks.length);
		await Promise.all(
			Array.from({ length: senders }, () =>
				send().catch(error => {
					stop.abort(error);
					throw error;
				}),
			),
		);
		const files = sources.map(source => source.info);
		return await untilAborted(signal, () => realm.evaluateHandle(buildUploadFiles, parts, files));
	} finally {
		await parts.dispose().catch(() => undefined);
	}
}

/** Fill a detached picker with `paths` and return its files, which the browser built from the paths itself. */
async function pickFiles(realm: Realm, paths: string[], signal: AbortSignal | undefined): Promise<JSHandle<unknown[]>> {
	const picker = await untilAborted(signal, () => realm.evaluateHandle(createFilePicker));
	try {
		const input = picker.asElement();
		if (!input) throw new ToolError("Could not create a file picker to drop files from");
		await untilAborted(signal, () => setFileInputPaths(input, paths));
		return await untilAborted(signal, () => realm.evaluateHandle(pickedFiles, picker));
	} finally {
		await picker.dispose().catch(() => undefined);
	}
}

/**
 * Hand a file input the files: staged copies' paths, or contents streamed into the isolated world. `filling` runs once
 * the files are being set, after staging or streaming has succeeded.
 */
async function deliverToInput(
	input: ElementHandle,
	sources: UploadSource[],
	route: UploadRoute,
	staging: UploadStaging,
	signal: AbortSignal | undefined,
	filling?: () => void,
): Promise<void> {
	if (route === "paths") {
		const staged = await staging.stage(sources, signal);
		await untilAborted(signal, () => {
			filling?.();
			return setFileInputPaths(input, staged);
		});
		return;
	}
	const realm = input.frame.isolatedRealm();
	const target = await untilAborted(signal, () => realm.adoptHandle(input));
	try {
		const files = await streamUploadFiles(realm, sources, signal);
		try {
			const refusal = await untilAborted(signal, () => {
				filling?.();
				return realm.evaluate(assignInputFiles, target, files);
			});
			if (refusal) throw new ToolError(refusal);
		} finally {
			await files.dispose().catch(() => undefined);
		}
	} finally {
		await target.dispose().catch(() => undefined);
	}
}

/**
 * Drop the files on an element, built from staged copies by a detached picker or from streamed contents; fails when
 * nothing on the page read them.
 */
async function deliverToDropZone(
	zone: ElementHandle,
	sources: UploadSource[],
	route: UploadRoute,
	staging: UploadStaging,
	label: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const realm = zone.frame.isolatedRealm();
	const target = await untilAborted(signal, () => realm.adoptHandle(zone));
	try {
		const files =
			route === "paths"
				? await pickFiles(realm, await staging.stage(sources, signal), signal)
				: await streamUploadFiles(realm, sources, signal);
		try {
			const read = await dropRead(
				zone,
				watch => untilAborted(signal, () => realm.evaluate(dropUploadFiles, target, files, watch)),
				signal,
			);
			if (!read) {
				throw new ToolError(
					`${label} opened no file chooser and nothing on the page took the dropped files; target the page's <input type=file>, the control that opens the chooser, or its drop zone`,
				);
			}
		} finally {
			await files.dispose().catch(() => undefined);
		}
	} finally {
		await target.dispose().catch(() => undefined);
	}
}

/**
 * An upload whose target is found. Finding it runs under the action deadline; `deliver` hands over the files, which for
 * streamed contents takes time in proportion to their size, so it runs under its own, longer one.
 */
export interface PreparedUpload {
	/** Bytes `deliver` hands over. */
	readonly bytes: number;
	deliver(signal: AbortSignal): Promise<void>;
	/** Release what finding the target held: a caught chooser's input, cancelled when it was never filled. */
	dispose(): Promise<void>;
}

function preparedUpload(
	sources: UploadSource[],
	deliver: (signal: AbortSignal) => Promise<void>,
	dispose: () => Promise<void> = async () => {},
): PreparedUpload {
	return { bytes: sources.reduce((sum, source) => sum + source.size, 0), deliver, dispose };
}

/** Prepare an upload into a file input: open the files and check the input takes that many. */
export async function prepareInputUpload(
	input: ElementHandle,
	absolutePaths: string[],
	route: UploadRoute,
	staging: UploadStaging,
	signal?: AbortSignal,
): Promise<PreparedUpload> {
	const sources = await openUploadSources(absolutePaths, signal);
	if (route === "contents") refuseFolders(sources);
	const refusal = await untilAborted(signal, () => input.evaluate(fileInputRefusal, sources.length));
	if (refusal) throw new ToolError(refusal);
	return preparedUpload(sources, sig => deliverToInput(input, sources, route, staging, sig));
}

/** Pages with a chooser-trigger upload in flight: a second one would catch the first one's chooser. */
const pagesAwaitingChooser = new WeakSet<Page>();

/**
 * Click `handle` and return the file input of the chooser it opens, adopted into the isolated world; null when no
 * chooser opened. The chooser is caught on a CDP session of our own, which lets go of the interception as soon as the
 * input is adopted: Puppeteer's `waitForFileChooser` leaves it on, which swallows every later chooser on the page, and
 * its listener throws on a File System Access picker's event.
 */
async function catchChooserInput(
	page: Page,
	handle: ElementHandle,
	label: string,
	signal: AbortSignal | undefined,
): Promise<ElementHandle | null> {
	let timer: NodeJS.Timeout | undefined;
	const creating = page.createCDPSession();
	const session = await untilAborted(signal, () => creating).catch(error => {
		// An abort does not stop the attach; detach the session once it arrives.
		void creating.then(late => late.detach()).catch(() => undefined);
		throw error;
	});
	try {
		const { promise: opened, resolve } = Promise.withResolvers<Protocol.Page.FileChooserOpenedEvent | null>();
		session.once("Page.fileChooserOpened", resolve);
		await untilAborted(signal, () => session.send("Page.enable"));
		await untilAborted(signal, () => session.send("Page.setInterceptFileChooserDialog", { enabled: true }));
		// The wait covers the click, so a target that only becomes clickable later counts as a drop zone.
		timer = setTimeout(() => resolve(null), FILE_CHOOSER_WAIT_MS);
		await clickElement(handle, label, signal);
		const chooser = await untilAborted(signal, () => opened);
		if (!chooser) return null;
		if (chooser.backendNodeId === undefined) {
			throw new ToolError(
				`${label} opened a File System Access picker (showOpenFilePicker), which automation cannot fill; upload through the page's <input type=file> or drop zone instead`,
			);
		}
		const { backendNodeId } = chooser;
		const frame = page.frames().find(candidate => devtoolsFrameId(candidate) === chooser.frameId);
		if (!frame) throw new ToolError(`${label} opened a file chooser in a frame that has since gone away`);
		const node = await untilAborted(signal, () => frame.isolatedRealm().adoptBackendNode(backendNodeId));
		const input = node.asElement();
		if (!input) {
			await node.dispose().catch(() => undefined);
			throw new ToolError("Node is not a file input element");
		}
		return input;
	} finally {
		clearTimeout(timer);
		// The relay serves every session of a tab from one debugger attachment, so detaching alone leaves it on.
		await session.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
		await session.detach().catch(() => undefined);
	}
}

/**
 * Find what takes an upload through `handle`: the file input itself, the chooser its click opens, or else the element
 * as a drop zone. `route` is how the browser gets the files; see {@link UploadStaging.route}.
 */
export async function prepareElementUpload(
	page: Page,
	handle: ElementHandle,
	absolutePaths: string[],
	label: string,
	route: UploadRoute,
	staging: UploadStaging,
	signal?: AbortSignal,
): Promise<PreparedUpload> {
	const inputType = (await untilAborted(signal, () =>
		handle.evaluate(el => {
			const element = el as unknown as PageElement;
			return { tag: element.tagName, type: element.type ?? "" };
		}),
	)) as { tag: string; type: string };
	if (inputType.tag === "INPUT" && inputType.type.toLowerCase() === "file") {
		return await prepareInputUpload(handle, absolutePaths, route, staging, signal);
	}
	const sources = await openUploadSources(absolutePaths, signal);
	if (route === "contents") refuseFolders(sources);

	if (pagesAwaitingChooser.has(page)) {
		throw new ToolError(`${label} cannot run while another uploadFile on this tab waits for its file chooser`);
	}
	pagesAwaitingChooser.add(page);
	try {
		const input = await catchChooserInput(page, handle, label, signal);
		if (input) {
			// A page learns a chooser closed from `change` or `cancel`; one that got neither would wait on a pick
			// forever, so a refused or failed upload cancels the chooser as the browser would.
			let filled = false;
			const release = async (): Promise<void> => {
				if (!filled) await input.evaluate(cancelChooser).catch(() => undefined);
				await input.dispose().catch(() => undefined);
			};
			try {
				const refusal = await untilAborted(signal, () => input.evaluate(fileInputRefusal, sources.length));
				if (refusal) throw new ToolError(refusal);
			} catch (error) {
				await release();
				throw error;
			}
			return preparedUpload(
				sources,
				sig =>
					deliverToInput(input, sources, route, staging, sig, () => {
						filled = true;
					}),
				release,
			);
		}
	} finally {
		pagesAwaitingChooser.delete(page);
	}
	return preparedUpload(sources, sig => deliverToDropZone(handle, sources, route, staging, label, sig));
}

/** Press a keyboard key without releasing it. */
export async function keyDown(page: Page, key: KeyInput, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => page.keyboard.down(key));
}

/** Release a keyboard key previously pressed with keyDown. */
export async function keyUp(page: Page, key: KeyInput, signal?: AbortSignal): Promise<void> {
	await untilAborted(signal, () => page.keyboard.up(key));
}

/**
 * macOS runs editing shortcuts as app-menu commands a CDP key event never reaches, so the key-down
 * names Chrome's editor command instead; elsewhere the plain key event already edits.
 * Keyed by the sorted Tern modifiers and the lower-cased letter.
 */
const EDITING_COMMANDS: Readonly<Record<string, string>> =
	process.platform === "darwin"
		? {
				"meta+a": "selectAll",
				"meta+c": "copy",
				"meta+v": "paste",
				"meta+x": "cut",
				"meta+z": "undo",
				"meta+shift+z": "redo",
			}
		: {};

/** The editor command a combo names on macOS, whatever its spelling (`Meta+c`, `MetaLeft+KeyC`, `Shift+Meta+Z`). */
function editingCommand(keys: readonly string[]): string | undefined {
	const key = keys[keys.length - 1]!;
	if (keys.length < 2 || !/^(?:Key[A-Z]|[A-Za-z])$/.test(key)) return undefined;
	const modifiers = new Set<string>();
	for (const name of keys.slice(0, -1)) {
		// ternKey throws on names Tern cannot type; only modifiers can select a command.
		const modifier = /^(?:Shift|Control|Alt|Meta)(?:Left|Right)?$/.test(name) ? ternKey(name).modifier : undefined;
		if (!modifier) return undefined;
		modifiers.add(modifier);
	}
	return EDITING_COMMANDS[`${[...modifiers].sort().join("+")}+${ternKey(key).key.toLowerCase()}`];
}

/**
 * Press a key or a `+`-joined combo (`Enter`, `Shift+Tab`, `Meta+a`): the leading
 * keys go down in order, the last key is pressed with `options`, then the leading
 * keys are released in reverse.
 */
export async function pressKey(page: Page, combo: string, options?: KeyPressOptions): Promise<void> {
	// Unchecked on purpose: puppeteer validates each name and throws `Unknown key: "…"`.
	const keys = splitKeyCombo(combo) as KeyInput[];
	const key = keys[keys.length - 1]!;
	const held = keys.slice(0, -1);
	const command = editingCommand(keys);
	const pressed: KeyInput[] = [];
	try {
		for (const modifier of held) {
			await page.keyboard.down(modifier);
			pressed.push(modifier);
		}
		// `commands` is @deprecated in puppeteer but still forwarded to Input.dispatchKeyEvent,
		// and puppeteer never adds the macOS editing commands itself.
		await page.keyboard.press(key, command ? { ...options, commands: [command] } : options);
	} finally {
		for (const modifier of pressed.reverse()) await page.keyboard.up(modifier);
	}
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
