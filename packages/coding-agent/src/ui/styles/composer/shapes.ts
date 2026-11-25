/**
 * Composer shapes: the chrome the terminal draws around the composer's text.
 *
 * A shape is a small row renderer over pieces the composer's painter has
 * already computed (the wrapped, caret-carrying text rows, their padding, the
 * prompt gutter, the status content). It owns the top and bottom chrome, the
 * side chrome of every row, its default padding and gutter, and whether rows
 * are filled with the composer surface. Shapes are registered by id
 * ({@link registerComposerShape}): the built-ins `box`, `band`, `claude`,
 * `pi`, `borderless`, `rule`, `field` and `rail`, plus any an extension
 * registers; an unknown id draws as `box`.
 *
 * A shape also says where the status line goes: into its top chrome
 * ({@link StatusAttachment}: the box's top border, a band row above the
 * prompt, a chip docked on the top rule) and/or as a bar under the composer
 * (`bottomBar`, after a blank row when `bottomBarGap`).
 */
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import type { BoxGlyphs, Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";

/** Pre-styled status content a shape shows in its top chrome. */
export interface ComposerStatusContent {
	readonly content: string;
	/** Cells of `content`. */
	readonly width: number;
}

/** Where a shape's top chrome carries the status line. */
export type StatusAttachment = "top-border" | "top-band" | "top-rule-chip";

/**
 * Status drawn on demand for the shape's attachment at the cells the top
 * chrome offers (the width inside the side chrome); reads inside it repaint
 * the composer.
 */
export type ComposerStatusSource = (
	cx: PaintContext,
	attachment: StatusAttachment,
	width: number,
) => ComposerStatusContent | undefined;

/** The composer's status: fixed content, or a source drawing it for the shape. */
export type ComposerStatus = ComposerStatusContent | ComposerStatusSource;

/** What every chrome row of a shape can use. */
export interface ComposerChromeContext {
	/** Cells the whole composer takes. */
	readonly width: number;
	/** Padding inside the side chrome. */
	readonly paddingX: number;
	readonly theme: Theme;
	/** The border color (the composer's state picks it). */
	border(text: string): string;
	/** The theme accent (field caps, rails). */
	accent(text: string): string;
	/** The composer surface: its background and text color, kept across the row's own resets. */
	surface(text: string): string;
	/** Rounded box glyphs. */
	readonly box: BoxGlyphs;
	/** Status content for the top chrome, if the composer shows one. */
	readonly status?: ComposerStatusContent;
}

/** One content row. */
export interface ComposerRowContext extends ComposerChromeContext {
	/** The styled text of the row (caret included), not padded. */
	readonly text: string;
	/** Blanks padding `text` to the content width. */
	readonly pad: string;
	/** The gutter cells of this row: the gutter on the first row, blanks after it, "" without one. */
	readonly gutter: string;
	readonly first: boolean;
	readonly last: boolean;
	/** Cells an end-of-row caret took from the right chrome's padding. */
	readonly overflow: number;
	/** The end-of-input row of a side-bordered shape: the bottom border moves to its own row. */
	readonly imeSafeCursorTail?: boolean;
}

/** A composer shape (see the module docs). */
export interface ComposerShape {
	readonly id: string;
	/** Name in the shape picker. */
	readonly label?: string;
	/** One-line description in the shape picker. */
	readonly description?: string;
	/** Where the top chrome carries the status line; none when absent. */
	readonly statusAttachment?: StatusAttachment;
	/** The status bar under the composer: both groups, the left group only, or none (default). */
	readonly bottomBar?: "full" | "left" | "none";
	/** A blank row between the composer and its bottom bar. */
	readonly bottomBarGap?: boolean;
	/** Rows are filled with the composer surface (its text color comes with it). */
	readonly filled?: boolean;
	/** Rows carry side chrome with padding: an end-of-row caret may take a padding cell. */
	readonly sideBorders: boolean;
	/** Prompt gutter before the first row (blanks before the others). */
	readonly gutter?: string;
	/** Default padding inside the side chrome. */
	readonly paddingX: number;
	/** Cells the chrome takes on each side of a content row. */
	sideWidth(paddingX: number): number;
	/** Top chrome row, if any. */
	top?(cx: ComposerChromeContext): string | undefined;
	/** A content row in its chrome (usually one row). */
	row(cx: ComposerRowContext): string[];
	/** Bottom chrome row, if any. */
	bottom?(cx: ComposerChromeContext): string | undefined;
}

const shapes = new Map<string, ComposerShape>();

/** Ids of the built-in shapes (extensions cannot replace them). */
const BUILTIN_SHAPE_IDS: Readonly<Record<string, true>> = {
	band: true,
	box: true,
	claude: true,
	pi: true,
	borderless: true,
	rule: true,
	field: true,
	rail: true,
};

/** Whether `id` names a built-in shape. */
export function isBuiltinComposerShape(id: string): boolean {
	// `=== true`: inherited keys such as `constructor` are not built-ins.
	return BUILTIN_SHAPE_IDS[id] === true;
}

/**
 * Register a shape (a later registration of the same id replaces it); returns
 * its removal, which restores the shape it replaced.
 */
export function registerComposerShape(shape: ComposerShape): () => void {
	const previous = shapes.get(shape.id);
	shapes.set(shape.id, shape);
	return () => {
		if (shapes.get(shape.id) !== shape) return;
		if (previous) shapes.set(shape.id, previous);
		else shapes.delete(shape.id);
	};
}

/** The shape registered as `id`; `box` when there is none. */
export function composerShape(id: string | undefined): ComposerShape {
	return (id !== undefined ? shapes.get(id) : undefined) ?? shapes.get("box")!;
}

/** Ids of every registered shape. */
export function composerShapeIds(): string[] {
	return [...shapes.keys()];
}

/**
 * Cells right of the wrap width an end-of-row caret may take: a padding cell
 * of side-bordered shapes (the right chrome gives it up).
 */
export function caretOverflow(shape: ComposerShape, paddingX: number): number {
	return shape.sideBorders && paddingX > 0 ? 1 : 0;
}

/** A full-width rule, with the status docked against its right end. */
function topRule(cx: ComposerChromeContext): string {
	const { box, width, status } = cx;
	if (status && status.width > 0 && width > 2) {
		let content = status.content;
		let chip = status.width;
		if (chip > width - 2) {
			content = truncate(content, width - 2);
			chip = visibleWidth(content);
		}
		return cx.border(box.horizontal.repeat(Math.max(0, width - chip - 1))) + content + cx.border(box.horizontal);
	}
	return cx.border(box.horizontal.repeat(width));
}

function fullRule(cx: ComposerChromeContext): string {
	return cx.border(cx.box.horizontal.repeat(cx.width));
}

/** Right chrome cells left after an end-of-row caret took `overflow` of them (at least the glyph). */
function rightCells(cx: ComposerRowContext): number {
	return Math.max(1, cx.paddingX + 1 - cx.overflow);
}

/** The classic frame: rounded box, status in the top border, the last row merged into the bottom border. */
const box: ComposerShape = {
	id: "box",
	label: "Rounded Box",
	description: "Status line embedded in top border, compact 2-line prompt",
	statusAttachment: "top-border",
	bottomBar: "none",
	sideBorders: true,
	paddingX: 2,
	sideWidth: paddingX => paddingX + 1,
	top(cx) {
		const { box: g, paddingX, width, status } = cx;
		const left = cx.border(`${g.topLeft}${g.horizontal.repeat(paddingX)}`);
		const right = cx.border(`${g.horizontal.repeat(paddingX)}${g.topRight}`);
		const fill = Math.max(0, width - (paddingX + 1) * 2);
		if (!status) return left + cx.border(g.horizontal.repeat(fill)) + right;
		const content = status.width <= fill ? status.content : truncate(status.content, Math.max(0, fill - 1));
		const used = status.width <= fill ? status.width : visibleWidth(content);
		return left + content + cx.border(g.horizontal.repeat(Math.max(0, fill - used))) + right;
	},
	row(cx) {
		const { box: g, paddingX } = cx;
		const cells = rightCells(cx);
		if (cx.last) {
			const left = cx.border(`${g.bottomLeft}${g.horizontal}${" ".repeat(Math.max(0, paddingX - 1))}`);
			const right = cx.border(
				`${" ".repeat(Math.max(0, cells - 2))}${cells >= 2 ? g.horizontal : ""}${g.bottomRight}`,
			);
			return [`${left}${cx.text}${cx.pad}${right}`];
		}
		const left = cx.border(`${g.vertical}${" ".repeat(paddingX)}`);
		return [`${left}${cx.text}${cx.pad}${cx.border(`${" ".repeat(cells - 1)}${g.vertical}`)}`];
	},
};

/** The status as a band above the input, the prompt as a corner gutter. */
const band: ComposerShape = {
	id: "band",
	label: "Status Band (Default)",
	description: "Flush soft-capped status band above a curved prompt, no frame",
	statusAttachment: "top-band",
	bottomBar: "none",
	sideBorders: false,
	gutter: "╰─ ",
	paddingX: 0,
	sideWidth: () => 0,
	top(cx) {
		const status = cx.status;
		if (!status?.content) return "";
		return status.width > cx.width ? truncate(status.content, cx.width) : status.content;
	},
	row: cx => [(cx.gutter ? cx.border(cx.gutter) : "") + cx.text + cx.pad],
};

/** Rules above and below, a `❯` prompt, the status docked on the top rule. */
const claude: ComposerShape = {
	id: "claude",
	label: "Claude Code",
	description: "Full-width horizontal rules above and below, status line at bottom",
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	sideBorders: false,
	gutter: "❯ ",
	paddingX: 0,
	sideWidth: paddingX => paddingX,
	top: topRule,
	row: cx => [cx.gutter + cx.text + cx.pad],
	bottom: fullRule,
};

/** Plain rules above and below, padded text. */
const pi: ComposerShape = {
	id: "pi",
	label: "Pi",
	description: "Framed horizontal rules with status line at bottom",
	bottomBar: "full",
	sideBorders: false,
	paddingX: 1,
	sideWidth: paddingX => paddingX,
	top: fullRule,
	row: cx => [" ".repeat(cx.paddingX) + cx.gutter + cx.text + cx.pad],
	bottom: fullRule,
};

/** No chrome, a `❯` prompt. */
const borderless: ComposerShape = {
	id: "borderless",
	label: "Borderless",
	description: "Clean prompt glyph with status line at bottom, no box borders",
	bottomBar: "full",
	sideBorders: false,
	gutter: "❯ ",
	paddingX: 0,
	sideWidth: () => 0,
	row: cx => [cx.gutter + cx.text + cx.pad],
};

/** One rule above (status docked on it), a `❯` prompt. */
const rule: ComposerShape = {
	id: "rule",
	label: "Top Rule Dock",
	description: "Single top rule with status docked onto it and below",
	statusAttachment: "top-rule-chip",
	bottomBar: "left",
	bottomBarGap: true,
	sideBorders: false,
	gutter: "❯ ",
	paddingX: 0,
	sideWidth: paddingX => paddingX,
	top: topRule,
	row: cx => [cx.gutter + cx.text + cx.pad],
};

/** A filled field between accent caps. */
const field: ComposerShape = {
	id: "field",
	label: "Compact Field",
	description: "Filled one-row field with accent end caps",
	bottomBar: "full",
	bottomBarGap: true,
	filled: true,
	sideBorders: true,
	paddingX: 1,
	sideWidth: paddingX => paddingX + 1,
	row(cx) {
		const interior = `${" ".repeat(cx.paddingX)}${cx.gutter}${cx.text}${cx.pad}${" ".repeat(rightCells(cx) - 1)}`;
		return [cx.accent("▐") + cx.surface(interior) + cx.accent("▌")];
	},
};

/** A filled surface behind an accent rail. */
const rail: ComposerShape = {
	id: "rail",
	label: "Accent Rail",
	description: "Filled one-row field anchored by a single accent rail",
	bottomBar: "full",
	bottomBarGap: true,
	filled: true,
	sideBorders: true,
	paddingX: 1,
	sideWidth: paddingX => paddingX + 1,
	row(cx) {
		const fill = Math.max(0, cx.paddingX + 1 - cx.overflow);
		return [
			cx.accent("▎") + cx.surface(`${" ".repeat(cx.paddingX)}${cx.gutter}${cx.text}${cx.pad}${" ".repeat(fill)}`),
		];
	},
};

// Picker order: the default first.
for (const shape of [band, box, claude, pi, borderless, rule, field, rail]) registerComposerShape(shape);
