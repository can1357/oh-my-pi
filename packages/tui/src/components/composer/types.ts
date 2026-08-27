/**
 * Composer chrome contract. A {@link ComposerStyle} owns everything about how
 * the input editor's frame looks — top/bottom chrome, per-row side chrome,
 * default padding and prompt gutter — plus metadata telling the host where the
 * status bar attaches. The editor, the /settings preview, and the setup-wizard
 * preview all render through the same style object, so the three surfaces can
 * never drift apart.
 */
import type { SymbolTheme } from "../../symbols";

/** Box-drawing glyph set used for composer chrome (the theme's `boxRound`). */
export type ComposerBox = SymbolTheme["boxRound"];

/** Built-in composer shape identifiers shipped by pi-tui. */
export const BUILTIN_EDITOR_BORDER_STYLES = ["box", "claude", "pi", "borderless", "rule", "field", "rail"] as const;

/** Identifier for a built-in composer shape. */
export type BuiltinEditorBorderStyle = (typeof BUILTIN_EDITOR_BORDER_STYLES)[number];

/** Composer shape identifier; extensions may register additional strings. */
export type EditorBorderStyle = string;

/** Pre-rendered status content injected into the top chrome. */
export interface EditorTopBorder {
	/** The status content (already styled) */
	content: string;
	/** Visible width of the content */
	width: number;
	/** Optional logical revision that changes independently of available width. */
	revision?: number;
}

/** Inputs shared by every chrome row. */
export interface ComposerChromeContext {
	/** Full terminal width available to the composer. */
	width: number;
	/** Horizontal padding inside the side chrome. */
	paddingX: number;
	borderColor: (str: string) => string;
	/** Stable accent used by shape-defining chrome such as field caps and rails. */
	accentColor: (str: string) => string;
	/** Background fill for composer surfaces; preserves the fill across nested SGR resets. */
	surfaceColor: (str: string) => string;
	/** Box-drawing glyph set (theme's `boxRound`). */
	box: ComposerBox;
	/** Status content for the top chrome; box embeds it after the corner while
	 * rule-based styles dock it against the right edge. */
	topBorder?: EditorTopBorder;
}

/** Inputs for one content row. */
export interface ComposerRowContext extends ComposerChromeContext {
	/** Fully decorated row text (cursor glyph / IME marker included). */
	text: string;
	/** Spaces padding the text out to the content width. */
	pad: string;
	/** Prompt gutter cells for this row ("" when the style has none). */
	gutter: string;
	isLastRow: boolean;
	/** Cells the end-of-line cursor overflowed into the right chrome (box). */
	cursorOverflow: number;
	/** Emit an empty right chrome after the cursor so terminal-local IME
	 *  preedit cannot shift the frame (box last row). */
	imeSafeCursorTail: boolean;
	/** Row lies inside the right-border scrollbar thumb (box). */
	scrollbarThumb: boolean;
}

export interface ComposerStyle {
	readonly id: EditorBorderStyle;
	/** Content rows carry left/right border glyphs; drives the cursor-reserve
	 *  column, IME-safe layout, and the right-border scrollbar. */
	readonly sideBorders: boolean;
	/** Rows consumed by top+bottom chrome (drives maxHeight budgeting). */
	readonly verticalChrome: 0 | 1 | 2;
	/** Where the host should attach the status bar: embedded in the top border,
	 * docked onto a top rule, or detached into a standalone bottom bar. */
	readonly statusAttachment: "top-border" | "top-rule-chip" | "none";
	/** Which segment groups the standalone bottom status bar shows. */
	readonly bottomBar: "none" | "left" | "full";
	/** Insert a blank spacer row between the editor and the standalone bottom
	 * bar. Styles without bottom chrome need it so the bar doesn't sit flush
	 * against the last input row. */
	readonly bottomBarGap: boolean;
	/** Default prompt gutter when the host sets none. */
	readonly defaultPromptGutter: string | undefined;
	/** Default horizontal padding; `themePaddingX` is the theme's request. */
	defaultPaddingX(themePaddingX: number | undefined): number;
	/** Cells consumed per side on content rows (border glyph + padding). */
	sideChromeWidth(paddingX: number): number;
	/** Top chrome row; `undefined` renders none. */
	renderTop(ctx: ComposerChromeContext): string | undefined;
	/** Chrome-wrapped content row; box's IME-safe last row emits two rows. */
	renderRow(ctx: ComposerRowContext): string[];
	/** Bottom chrome row; `undefined` renders none (box merges the bottom
	 *  border into its last content row). */
	renderBottom(ctx: ComposerChromeContext): string | undefined;
}
