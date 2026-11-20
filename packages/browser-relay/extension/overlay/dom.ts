/**
 * DOM helpers for the overlay. Everything is built with `createElement`, never markup strings, so a page's Trusted
 * Types policy can't refuse it.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** The omp π glyph, as drawn by collab-web's `OmpMark`, in a 64×64 box. */
export const OMP_MARK_PATH = "M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z";

/** Create an HTML element with a class and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	node.append(...children);
	return node;
}

/** Create an SVG element with attributes and children. */
export function svg<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attributes: Record<string, string>,
	...children: SVGElement[]
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const name in attributes) node.setAttribute(name, attributes[name]);
	node.append(...children);
	return node;
}

/** A 16×16 line icon in the current text color. */
export function icon(...shapes: SVGElement[]): SVGSVGElement {
	return svg(
		"svg",
		{
			class: "icon",
			viewBox: "0 0 16 16",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "1.5",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"aria-hidden": "true",
		},
		...shapes,
	);
}

let markCount = 0;

/**
 * The omp mark with its pink → violet → cyan gradient, cropped to the glyph so it fills its box at 14px. Gradient
 * ids are unique within the shadow root.
 */
export function ompMark(): SVGSVGElement {
	const id = `omp-mark-${++markCount}`;
	const stop = (offset: string, color: string) => svg("stop", { offset, "stop-color": color });
	return svg(
		"svg",
		{ class: "mark", viewBox: "9 12 46 46", "aria-hidden": "true" },
		svg(
			"defs",
			{},
			svg(
				"linearGradient",
				{ id, x1: "0", y1: "0", x2: "1", y2: "1" },
				stop("0", "oklch(0.7 0.24 340)"),
				stop(".5", "oklch(0.62 0.21 295)"),
				stop("1", "oklch(0.81 0.14 200)"),
			),
		),
		svg("path", { fill: `url(#${id})`, d: OMP_MARK_PATH }),
	);
}

/** Longest a wait for painted frames may take; rAF never fires in a tab that stops rendering mid-wait. */
const FRAME_WAIT_LIMIT_MS = 250;

/**
 * Resolve once `count` animation frames have been produced, so style changes made before the call are on screen.
 * A hidden tab paints nothing, so there it resolves on the next task.
 */
export function afterFrames(count: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (document.visibilityState === "hidden") {
		setTimeout(resolve, 0);
		return promise;
	}
	const step = (left: number): void => {
		if (left === 0) resolve();
		else requestAnimationFrame(() => step(left - 1));
	};
	step(count);
	setTimeout(resolve, FRAME_WAIT_LIMIT_MS);
	return promise;
}

/** Whether to place things directly instead of animating: reduced motion is on, or the tab isn't being painted. */
export function skipMotion(): boolean {
	return document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches;
}
