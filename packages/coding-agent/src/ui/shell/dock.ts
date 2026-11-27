/**
 * The dock: live chrome under the transcript, as named slots.
 *
 * Both renderers show the same slots in different orders. In a plain
 * terminal everything stacks above the composer, most transient last, so it
 * reads next to the prompt. Tern leads with the HUD pills, keeps queued
 * messages next to the composer, and flows the deferred shell runs and a
 * waiting ask at the transcript's end instead (see {@link NATIVE_TAIL}).
 */
import { type JSXNode, jsx } from "@oh-my-pi/pi-tui";
import { Slot } from "./views";

/** Every dock position. */
export type DockSlot =
	/** `!`/`$` runs started while the agent streams, until they move into the transcript. */
	| "pendingShell"
	| "pendingMessages"
	| "todo"
	| "subagents"
	| "btw"
	/** A docked command report (`/changelog`, …); Esc clears it. */
	| "report"
	| "omfg"
	| "cleanse"
	| "errorBanner"
	| "modelCycle"
	| "deferredCommand"
	/** Judge batches and downloads, right above the working row. */
	| "progress"
	/** The ask waiting for answers, over the working row and the composer. */
	| "ask"
	/** Working loader / transient status row. */
	| "status"
	| "attachments"
	| "editorGap"
	| "widgetsAbove"
	/** The tool-approval prompt: no dock position of its own, the composer's column leads with it. */
	| "approval"
	/** The composer: editor, its chrome and the status line. */
	| "composer"
	| "widgetsBelow"
	/** Native only: the HUD pills row. */
	| "pills"
	/** Native only: the tray. */
	| "tray";

/** Terminal order, top to bottom. */
export const TERMINAL_DOCK: readonly DockSlot[] = [
	"pendingShell",
	"pendingMessages",
	"todo",
	"subagents",
	"btw",
	"report",
	"omfg",
	"cleanse",
	"errorBanner",
	"modelCycle",
	"deferredCommand",
	"progress",
	"ask",
	"status",
	"attachments",
	"editorGap",
	"widgetsAbove",
	"composer",
	"widgetsBelow",
];

/** Tern order, top to bottom. */
export const NATIVE_DOCK: readonly DockSlot[] = [
	"pills",
	"btw",
	"omfg",
	"cleanse",
	"errorBanner",
	"modelCycle",
	"deferredCommand",
	"progress",
	"widgetsAbove",
	"status",
	"tray",
	"pendingMessages",
	"composer",
	"widgetsBelow",
];

/** Slots Tern shows at the transcript's end rather than in the dock. */
export const NATIVE_TAIL: readonly DockSlot[] = ["pendingShell", "ask"];

/**
 * Slots drawn over the live transcript in a plain terminal. The live rows they
 * push off the top are neither on screen nor in history until the slot
 * empties, so only blocks the user opens and dismisses belong here, not an ask
 * answered by reading the transcript above it.
 */
export const COVERING: readonly DockSlot[] = ["report"];

/** The dock's slots. */
export class Dock {
	readonly #slots = new Map<DockSlot, Slot>();

	/** The slot at `name`. */
	slot(name: DockSlot): Slot {
		let slot = this.#slots.get(name);
		if (!slot) {
			slot = new Slot();
			this.#slots.set(name, slot);
		}
		return slot;
	}

	/** The views of `order`'s slots, as a region template. */
	views(order: readonly DockSlot[]): JSXNode {
		return order.map(name => this.slot(name).view);
	}

	/** The terminal dock as a region template: {@link TERMINAL_DOCK}, the {@link COVERING} slots drawn over the transcript. */
	terminalViews(): JSXNode {
		return TERMINAL_DOCK.map(name =>
			COVERING.includes(name)
				? jsx("col", { role: "omp.dock.covering", children: this.slot(name).view }, name)
				: this.slot(name).view,
		);
	}
}
