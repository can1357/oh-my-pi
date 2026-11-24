/**
 * Tool looks: how the terminal backend paints one tool's `tool` node.
 *
 * The transcript's tool block (`omp.tool.*`, see `./block.ts`) handles what
 * every tool shares: transcript margins, hidden activity, compact presenter
 * lines and viewport allocations. Everything inside is the look's: the frame,
 * the head, the sections, the footer. A look is chosen by the node's
 * `term.look` (set by the presenter's view), else the tool name, else the
 * generic `default` card.
 *
 * Looks read the node's props and its children's props directly: the body's
 * nodes carry the data, the look decides the rows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import type { TspTone, TspToolProps } from "@oh-my-pi/pi-wire";

/** Terminal-only facts on a `tool` node's `term` prop (the tool block's plus the view's). */
export interface ToolTerm {
	/** The look that paints the node (`bash`, `default`); defaults to the tool name. */
	readonly look?: string;
	/** The tool's display label. */
	readonly label?: string;
	/** Application clock time the call started executing; running clocks count from it. */
	readonly startedAt?: number;
	/** An extension presenter's compact presentation: its own label and rows, or the bare summary row. */
	readonly compact?: "label" | "bare";
	/** The compact row's summary: bold label, muted detail. */
	readonly activity?: { readonly label: string; readonly detail?: string };
	/** Still executing (no settled result, not sealed): compact rows spin (animated looks) and count seconds. */
	readonly running?: boolean;
	/** Whether the view's compact row spins now (a body that streams in with the args); decides over `running`. */
	readonly spinning?: boolean;
	/** The view asked for no frame. */
	readonly inline?: boolean;
	/** Overrides the look's transcript margins for this view. */
	readonly margin?: boolean;
	/** The transcript's expand state (what a body-less node's `collapsed` cannot carry). */
	readonly expanded?: boolean;
	/** The call's args. */
	readonly args?: unknown;
	/** The result's image placeholders in order: where a look draws one, it links to its image. */
	readonly imageLinks?: readonly {
		readonly text: string;
		readonly blob: string;
		readonly source?: string;
	}[];
	readonly [fact: string]: unknown;
}

/** A `tool` node's props as looks read them. */
export type ToolProps = Readonly<
	TspToolProps & {
		role?: string;
		tone?: TspTone;
		hidden?: boolean;
		term?: ToolTerm;
	}
>;

/** Paints one tool's node, without the transcript's margins. */
export interface ToolLook {
	/** Paint the tool at `cx.width`. */
	paint(node: UiNode, cx: PaintContext): Block;
	/** The transcript sets the look off by a blank row above and below (framed looks). */
	readonly margin?: boolean;
	/**
	 * The look animates its pending or partial state: its spinner ticks in the
	 * transcript and its compact row spins. Otherwise the transcript paints it
	 * with reduced motion (the still glyph).
	 */
	readonly animated?: boolean;
	/**
	 * The look draws clock-driven effects of its own (the todo completion
	 * strike): the transcript paints it under the terminal's real motion
	 * setting, while its compact row stays still unless {@link animated}.
	 */
	readonly clocked?: boolean;
	/** The transcript wraps the look in the custom-tool box: one blank row and one cell of padding around it, tinted by status. */
	readonly boxed?: boolean;
}

const looks = new Map<string, ToolLook>();

/** Register the look `key` (a tool name, or a shared look a view names in `term.look`). */
export function defineToolLook(key: string, look: ToolLook): void {
	looks.set(key, look);
}

/** The look registered as `key`. */
export function toolLook(key: string): ToolLook | undefined {
	return looks.get(key);
}

/** The props of a `tool` node. */
export function toolProps(node: UiNode): ToolProps {
	return node.props() as ToolProps;
}

/** Whether the tool shows its expanded body: an explicit fold wins over the transcript's expand state. */
export function isExpanded(props: ToolProps): boolean {
	return props.collapsed === undefined ? props.term?.expanded === true : !props.collapsed;
}

/** The look that paints `node`. */
export function lookFor(node: UiNode): ToolLook {
	const props = toolProps(node);
	const look = looks.get(props.term?.look ?? props.name) ?? looks.get("default");
	if (!look) throw new Error("pi-tui: the default tool look is not registered");
	return look;
}
