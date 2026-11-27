/**
 * A surface: the whole UI of a program, as the regions a backend draws.
 *
 * - `main`: the flowing document (the transcript). A terminal backend moves
 *   settled main nodes into terminal history; a Tern terminal scrolls it.
 * - `dock`: live chrome under it (composer, status line, HUDs).
 * - `layer`: floating content (overlays, toasts, pickers, sheets).
 *
 * The program owns keyboard focus (`focus`) and finality (`settle`). Both
 * backends read the same surface; neither paints anything the program did not
 * describe.
 */
import { resolveChildren } from "./children";
import type { UiNode } from "./node";
import { type Accessor, createRoot, type Signal, signal } from "./reactive";
import type { JSXNode } from "./types";

/** What a program declares for each region. */
export interface SurfaceTemplate {
	readonly main?: JSXNode;
	readonly dock?: JSXNode;
	readonly layer?: JSXNode;
}

const kSettled = Symbol("pi-tui.settled");

interface SettleMark {
	[kSettled]?: Signal<boolean>;
}

function settledSignal(node: UiNode): Signal<boolean> {
	const holder = node as SettleMark;
	return (holder[kSettled] ??= signal(false));
}

/**
 * Mark a main-region node final: it will not change again. A terminal
 * backend may then write it into terminal history and stop painting it; a
 * native backend sends `settle` and drops its retained description.
 */
export function settle(node: UiNode): void {
	settledSignal(node).set(true);
}

/** Whether `node` was settled (reactive). */
export function isSettled(node: UiNode): boolean {
	return settledSignal(node)();
}

/** A mounted program UI. */
export interface Surface {
	readonly main: Accessor<readonly UiNode[]>;
	readonly dock: Accessor<readonly UiNode[]>;
	readonly layer: Accessor<readonly UiNode[]>;
	/** The node holding keyboard focus (an `editor`, `input`, `list`, `picker`, …), or null. */
	readonly focused: Accessor<UiNode | null>;
	/** Move keyboard focus (both backends draw the caret/focus ring there and route keys to it). */
	focus(node: UiNode | null): void;
	/** Tear the UI down (disposes every node the template built). */
	dispose(): void;
}

/** Build a surface from a template; the template runs once, inside the surface's reactive root. */
export function createSurface(template: () => SurfaceTemplate): Surface {
	return createRoot(dispose => {
		const regions = template();
		const focused = signal<UiNode | null>(null);
		return {
			main: resolveChildren(regions.main),
			dock: resolveChildren(regions.dock),
			layer: resolveChildren(regions.layer),
			focused,
			focus: node => focused.set(node),
			dispose,
		};
	});
}
