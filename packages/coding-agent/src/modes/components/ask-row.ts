import {
	CURSOR_MARKER,
	Ellipsis,
	type MarkdownTheme,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { ExtensionAskDialogQuestion } from "../../extensibility/extensions";
import { PREVIEW_LIMITS } from "../../tools/render-utils";
import { type Theme, theme } from "../theme/theme";

/** Width of the leading prefix column shared by every ask row (the focus
 *  cursor cell, the jump-digit cell, and the option-marker cell). Wrapped
 *  label continuations, descriptions, and the custom-input echo all indent by
 *  this same amount, so every row keeps its content left-aligned across the
 *  dialog, transcript, and legacy surfaces. */
export const ASK_ROW_PREFIX_COLUMNS = 6;

/** Width of the leading prefix column shared by every ask row, derived from
 *  the active theme's option-marker glyph. Four fixed cells (cursor, spacer,
 *  jump digit, spacer) precede the marker, which is followed by a single
 *  spacer; the marker width varies by symbol preset (the ASCII preset ships
 *  three-column `[x]`/`( )` glyphs), so the prefix must track it rather than
 *  assume a one-column marker. {@link ASK_ROW_PREFIX_COLUMNS} is the
 *  default-preset value (6) kept for callers that only need the common case. */
export function askRowPrefixColumns(multi: boolean | undefined): number {
	const marker = askOptionMarker(theme, multi, false);
	return 4 + visibleWidth(marker) + 1;
}

/** A single renderable ask row: an option entry or the "other" custom input.
 *  Mirrors the dialog's internal row shape so the transcript and legacy paths
 *  can feed the same engine without their own copies of the contract. */
export interface AskQuestionRow {
	kind: "option" | "other";
	key: string;
	label: string;
	optionIndex: number | undefined;
}

export interface AskRowRenderContext {
	question: ExtensionAskDialogQuestion;
	focused: boolean;
	checked: boolean;
	/** "1".."9" when a jump digit is rendered for this row, else undefined. */
	jumpDigit: string | undefined;
	/** When true, an option description renders every wrapped line; otherwise it
	 *  collapses to the first {@link PREVIEW_LIMITS.COLLAPSED_LINES} lines and
	 *  the surplus is a counted cue. */
	expanded: boolean;
	note: string | undefined;
	/** Echoed under an `other` row when the user is typing a custom answer. */
	customInput: string | undefined;
	/** Inner content width (the prefix is not part of this budget). */
	width: number;
	mdTheme: MarkdownTheme;
	/** Emit the terminal-cursor sentinel on the focused row. Only the focused,
	 *  declared row ever carries it — TUI extracts the bottom-most marker. */
	declareCursor: boolean;
}

export interface AskRowLines {
	lines: string[];
	/** Number of description lines hidden behind the collapse cue (0 when none
	 *  hidden or the description is expanded). */
	hiddenDescriptionLines: number;
}

/** Shared option marker glyph: a checkbox for multi questions, a radio control
 *  otherwise. Colour is applied by the caller via {@link theme.fg} and follows
 *  `checked` only — focus never changes the marker's hue. Glyphs come from
 *  `uiTheme` so transcript renders match the theme instance they were handed. */
export function askOptionMarker(uiTheme: Theme, multi: boolean | undefined, checked: boolean): string {
	if (multi) return checked ? uiTheme.checkbox.checked : uiTheme.checkbox.unchecked;
	return checked ? uiTheme.radio.selected : uiTheme.radio.unselected;
}

/** Render one ask row. Pure: given the same row and context it returns the same
 *  lines, with no caching or preview state of its own. */
export function renderAskRow(row: AskQuestionRow, ctx: AskRowRenderContext): AskRowLines {
	const isOption = row.kind === "option";
	const isOther = row.kind === "other";
	const option = isOption ? ctx.question.options[row.optionIndex ?? -1] : undefined;

	// Cells 1-4 of the prefix: focus cursor (plus the terminal-cursor sentinel
	// only for the focused, declared row), a spacer, the jump digit, a spacer.
	// Including the cursor glyph, this half of the prefix is exactly four
	// columns wide.
	const cursorCell = ctx.focused ? theme.nav.cursor : " ";
	const cursorMarker = ctx.focused && ctx.declareCursor ? CURSOR_MARKER : "";
	const jumpCell = ctx.jumpDigit !== undefined ? theme.fg("dim", ctx.jumpDigit) : " ";
	const prefix = `${cursorCell}${cursorMarker} ${jumpCell} `;

	// Cells 5+: the option marker followed by a spacer. The marker's colour
	// tracks `checked`, never `focused`. The marker width varies by symbol
	// preset, so the prefix column count (and thus the continuation indent and
	// content budget) is derived from the active glyph rather than a constant.
	const marker = theme.fg(ctx.checked ? "success" : "dim", askOptionMarker(theme, ctx.question.multi, ctx.checked));
	const prefixColumns = askRowPrefixColumns(ctx.question.multi);

	const color = ctx.focused ? "accent" : ctx.checked ? "toolOutput" : "text";
	const label = renderInlineMarkdown(replaceTabs(row.label), ctx.mdTheme, t => theme.fg(color, t));
	const contentWidth = Math.max(1, ctx.width - prefixColumns);
	const noteMarker = ctx.note !== undefined ? theme.fg("success", "  ✎ note") : "";
	const noteWidth = noteMarker ? visibleWidth(noteMarker) : 0;
	// Wrap the label at its full content width. The note marker appears once
	// — on the final label row when it fits, otherwise on its own bounded
	// indented row — so continuation lines are not narrowed by the marker's
	// width and the marker stays visible without exceeding ctx.width.
	const wrappedLabel = wrapTextWithAnsi(label, contentWidth);
	const indent = padding(prefixColumns);

	const lines: string[] = [];
	if (wrappedLabel.length === 0) {
		lines.push(`${prefix}${marker} `);
	} else {
		lines.push(`${prefix}${marker} ${wrappedLabel[0] ?? ""}`);
		for (let i = 1; i < wrappedLabel.length; i++) {
			lines.push(`${indent}${wrappedLabel[i] ?? ""}`);
		}
	}

	if (noteMarker) {
		const lastIdx = lines.length - 1;
		const lastLine = lines[lastIdx] ?? "";
		// Both the first line (prefix + marker + spacer) and continuation
		// lines (indent) occupy exactly prefixColumns before the content, so
		// the content used on the last line is the visible width minus the
		// prefix columns.
		const contentUsed = Math.max(0, visibleWidth(lastLine) - prefixColumns);
		if (contentUsed + noteWidth <= contentWidth) {
			lines[lastIdx] = `${lastLine}${noteMarker}`;
		} else {
			lines.push(`${indent}${truncateToWidth(noteMarker, contentWidth, Ellipsis.Unicode)}`);
		}
	}

	let hiddenDescriptionLines = 0;
	if (ctx.focused && isOption && option?.description?.trim()) {
		// The description belongs to the focused row only. Unfocused rows carry
		// the prefix, label, and note marker and nothing else, so the collapse
		// cue can never light up (hiddenDescriptionLines stays 0 below) for a
		// row the user is not looking at. Collapsed: the first
		// PREVIEW_LIMITS.COLLAPSED_LINES wrapped lines, then a counted cue
		// when more remain. Expanded: every line, no cap. A focused
		// description is never truncated without a visible escape.
		const description = renderInlineMarkdown(replaceTabs(option.description.trim()), ctx.mdTheme, t =>
			theme.fg("muted", t),
		);
		const wrapped = wrapTextWithAnsi(description, contentWidth);
		const collapsedLines = PREVIEW_LIMITS.COLLAPSED_LINES;
		hiddenDescriptionLines = ctx.expanded ? 0 : Math.max(0, wrapped.length - collapsedLines);
		for (const line of ctx.expanded ? wrapped : wrapped.slice(0, collapsedLines)) {
			lines.push(`${indent}${truncateToWidth(line, contentWidth, Ellipsis.Unicode)}`);
		}
		if (!ctx.expanded && hiddenDescriptionLines > 0) {
			const glyph = theme.nav.expand || "▾";
			const noun = hiddenDescriptionLines === 1 ? "line" : "lines";
			// Same width contract as the wrapped description above: the cue is
			// bounded to contentWidth so the wording degrades to an ellipsis on
			// narrow terminals instead of being mid-word clipped by the dialog
			// border chrome (row()/fit()).
			const cue = truncateToWidth(`${glyph} ${hiddenDescriptionLines} more ${noun}`, contentWidth, Ellipsis.Unicode);
			lines.push(`${indent}${theme.fg("dim", cue)}`);
		}
	}

	if (isOther && ctx.customInput !== undefined) {
		const preview = replaceTabs(ctx.customInput).replace(/\s+/g, " ").trim();
		lines.push(theme.fg("muted", `${indent}${truncateToWidth(preview, contentWidth, Ellipsis.Unicode)}`));
	}

	return { lines, hiddenDescriptionLines };
}
