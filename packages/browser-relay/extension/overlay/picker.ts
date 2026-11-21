/**
 * The element and region pickers: a scrim over the page that turns the next click or drag into a
 * {@link PickResult}. A pick resolves only after its visuals are off screen, so the capture that follows is clean.
 */
import type { PickResult, Rect, Size } from "../messages";
import { afterFrames, el } from "./dom";
import type { Point } from "./motion";

/** A drag smaller than this in either axis is a click: capture the whole viewport. */
const REGION_MIN_PX = 10;

/** The hint steps aside when the pointer comes this close to the bottom edge. */
const HINT_ZONE_PX = 96;

/** The hint's gap from the viewport edge, or from the overlay chrome at that edge. */
const HINT_GAP_PX = 20;

function viewport(): Size {
	return { width: window.innerWidth, height: window.innerHeight };
}

/** `<tag#id>`, `<tag.firstClass>` or `<tag>` for an element. */
export function describeElement(element: Element): string {
	const tag = element.localName;
	if (element.id) return `<${tag}#${element.id}>`;
	const firstClass = element.classList[0];
	return firstClass ? `<${tag}.${firstClass}>` : `<${tag}>`;
}

/** The part of `rect` inside a viewport of `size`, in whole CSS pixels. */
export function clipToViewport(rect: Rect, size: Size): Rect {
	const left = Math.max(0, Math.floor(rect.x));
	const top = Math.max(0, Math.floor(rect.y));
	const right = Math.min(size.width, Math.ceil(rect.x + rect.width));
	const bottom = Math.min(size.height, Math.ceil(rect.y + rect.height));
	return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function place(node: HTMLElement, x: number, y: number): void {
	node.style.setProperty("transform", `translate(${x}px, ${y}px)`);
}

/** The instruction pill: `parts` and the way out, separated by dots. */
function hint(...parts: string[]): HTMLElement {
	const node = el("div", "hint glass");
	for (const part of parts) node.append(part, el("span", "sep", "·"));
	node.append(el("kbd", "", "Esc"), " to cancel");
	return node;
}

/** Runs one pick at a time in the overlay's picker layer. */
export class Picker {
	readonly #root: HTMLElement;
	readonly #host: Element;
	readonly #occupied: () => { top: number; bottom: number };
	/** Ends the pick in flight with a cancellation. */
	#cancel: (() => void) | null = null;

	/**
	 * `root` is the picker layer; `host` is the overlay's host element, skipped when hit-testing the page;
	 * `occupied` says how far the overlay's own chrome reaches in from the top and bottom edges.
	 */
	constructor(root: HTMLElement, host: Element, occupied: () => { top: number; bottom: number }) {
		this.#root = root;
		this.#host = host;
		this.#occupied = occupied;
	}

	/** Cancel the pick in flight, if any; it resolves null. */
	cancel(): void {
		this.#cancel?.();
	}

	/** Let the user pick an element or a region; null when they cancel. A new pick cancels the one in flight. */
	pick(mode: "element" | "region"): Promise<PickResult | null> {
		this.cancel();
		const { promise, resolve } = Promise.withResolvers<PickResult | null>();
		const scrim = el("div", "scrim");
		const listeners = new AbortController();
		const finish = (result: PickResult | null): void => {
			if (listeners.signal.aborted) return;
			listeners.abort();
			this.#cancel = null;
			this.#root.classList.remove("on");
			this.#root.replaceChildren();
			// Two frames: one to commit the removal, one for the compositor to present it.
			void afterFrames(2).then(() => resolve(result));
		};
		this.#cancel = () => finish(null);

		const { signal } = listeners;
		window.addEventListener(
			"keydown",
			event => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopImmediatePropagation();
				finish(null);
			},
			{ capture: true, signal },
		);
		// Pressing on the scrim must not take focus from whatever the page had focused.
		scrim.addEventListener("mousedown", event => event.preventDefault(), { signal });
		// The page keeps keyboard focus, so a right-click is the way out for a hand that is on the mouse.
		scrim.addEventListener(
			"contextmenu",
			event => {
				event.preventDefault();
				finish(null);
			},
			{ signal },
		);

		if (mode === "element") this.#pickElement(scrim, signal, finish);
		else this.#pickRegion(scrim, signal, finish);
		this.#root.replaceChildren(scrim);
		this.#root.classList.add("on");
		return promise;
	}

	/** The page element under a viewport point, looking through the scrim and into open shadow roots. */
	#elementAt(point: Point): Element | null {
		let found = document.elementsFromPoint(point.x, point.y).find(element => element !== this.#host) ?? null;
		while (found?.shadowRoot) {
			const inner = found.shadowRoot.elementFromPoint(point.x, point.y);
			if (!inner || inner === found) break;
			found = inner;
		}
		return found;
	}

	#pickElement(scrim: HTMLElement, signal: AbortSignal, finish: (result: PickResult | null) => void): void {
		const outline = el("div", "outline");
		const chip = el("div", "pick-chip glass");
		const tip = hint("Click an element");
		outline.hidden = true;
		chip.hidden = true;
		scrim.append(outline, chip, tip);

		let pointer: Point | null = null;
		let target: Element | null = null;
		// The hint sits clear of the working tag or pill, at the bottom unless the pointer is working down there.
		const placeHint = (): void => {
			const reach = this.#occupied();
			const top = pointer !== null && pointer.y > window.innerHeight - reach.bottom - HINT_ZONE_PX;
			tip.style.setProperty("top", top ? `${reach.top + HINT_GAP_PX}px` : "auto");
			tip.style.setProperty("bottom", top ? "auto" : `${reach.bottom + HINT_GAP_PX}px`);
		};
		placeHint();
		const refresh = (): void => {
			if (!pointer) return;
			target = this.#elementAt(pointer);
			outline.hidden = chip.hidden = target === null;
			placeHint();
			if (!target) return;
			const box = target.getBoundingClientRect();
			place(outline, box.left - 2, box.top - 2);
			outline.style.setProperty("width", `${box.width + 4}px`);
			outline.style.setProperty("height", `${box.height + 4}px`);
			chip.textContent = describeElement(target);
			const maxLeft = window.innerWidth - chip.offsetWidth - 4;
			place(chip, Math.max(4, Math.min(box.left, maxLeft)), Math.max(4, box.top - 26));
		};
		scrim.addEventListener(
			"pointermove",
			event => {
				pointer = { x: event.clientX, y: event.clientY };
				refresh();
			},
			{ signal },
		);
		// The page can still scroll under the scrim; keep the outline on what is under the pointer.
		window.addEventListener("scroll", refresh, { capture: true, passive: true, signal });
		scrim.addEventListener(
			"click",
			event => {
				pointer = { x: event.clientX, y: event.clientY };
				refresh();
				if (!target) return;
				const size = viewport();
				const box = target.getBoundingClientRect();
				const rect = clipToViewport({ x: box.left, y: box.top, width: box.width, height: box.height }, size);
				finish({ kind: "element", rect, viewport: size, descriptor: describeElement(target) });
			},
			{ signal },
		);
	}

	#pickRegion(scrim: HTMLElement, signal: AbortSignal, finish: (result: PickResult | null) => void): void {
		// Four blocks dim everything outside the selection; before a drag the first covers the viewport.
		const shades = [el("div", "shade"), el("div", "shade"), el("div", "shade"), el("div", "shade")];
		const selection = el("div", "sel");
		const size = el("div", "size glass");
		const tip = hint("Drag to capture an area", "click for the whole tab");
		tip.classList.add("mid");
		scrim.append(...shades, selection, size, tip);

		let anchor: Point | null = null;
		let drawn: Rect | null = null;
		const draw = (rect: Rect | null): void => {
			drawn = rect;
			selection.hidden = size.hidden = rect === null;
			const { width, height } = viewport();
			const area = rect ?? { x: 0, y: height, width, height: 0 };
			const bottom = area.y + area.height;
			const blocks: Rect[] = [
				{ x: 0, y: 0, width, height: area.y },
				{ x: 0, y: bottom, width, height: height - bottom },
				{ x: 0, y: area.y, width: area.x, height: area.height },
				{ x: area.x + area.width, y: area.y, width: width - area.x - area.width, height: area.height },
			];
			blocks.forEach((block, index) => {
				const shade = shades[index];
				place(shade, block.x, block.y);
				shade.style.setProperty("width", `${Math.max(0, block.width)}px`);
				shade.style.setProperty("height", `${Math.max(0, block.height)}px`);
			});
			if (!rect) return;
			place(selection, rect.x, rect.y);
			selection.style.setProperty("width", `${rect.width}px`);
			selection.style.setProperty("height", `${rect.height}px`);
			size.textContent = `${rect.width} × ${rect.height}`;
			// Under the selection; inside its bottom edge when there is no room below.
			const below = bottom + 6 + size.offsetHeight <= height - 4;
			const left = Math.max(4, Math.min(rect.x, width - size.offsetWidth - 4));
			place(size, left, below ? bottom + 6 : bottom - size.offsetHeight - 6);
		};
		const dragged = (event: PointerEvent, from: Point): Rect => {
			const drag = {
				x: Math.min(from.x, event.clientX),
				y: Math.min(from.y, event.clientY),
				width: Math.abs(event.clientX - from.x),
				height: Math.abs(event.clientY - from.y),
			};
			return clipToViewport(drag, viewport());
		};
		draw(null);

		scrim.addEventListener(
			"pointerdown",
			event => {
				if (event.button !== 0) return;
				event.preventDefault();
				anchor = { x: event.clientX, y: event.clientY };
				scrim.setPointerCapture(event.pointerId);
				tip.classList.add("gone");
			},
			{ signal },
		);
		scrim.addEventListener(
			"pointermove",
			event => {
				if (anchor) draw(dragged(event, anchor));
			},
			{ signal },
		);
		scrim.addEventListener(
			"pointerup",
			event => {
				if (!anchor) return;
				const rect = dragged(event, anchor);
				const whole = rect.width < REGION_MIN_PX || rect.height < REGION_MIN_PX;
				finish(whole ? { kind: "viewport", viewport: viewport() } : { kind: "region", rect, viewport: viewport() });
			},
			{ signal },
		);
		scrim.addEventListener(
			"pointercancel",
			() => {
				anchor = null;
				tip.classList.remove("gone");
				draw(null);
			},
			{ signal },
		);
		window.addEventListener("resize", () => draw(drawn && clipToViewport(drawn, viewport())), { signal });
	}
}
