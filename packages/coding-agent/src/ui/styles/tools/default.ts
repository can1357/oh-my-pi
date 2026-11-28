/**
 * `default`: the generic tool card (tools without a presenter of their own).
 *
 * A state-tinted block padded by one cell and one row: the status glyph and
 * the label, then (collapsed) the args summary under a `└─` and the output's
 * first four lines with an expand hint, or (expanded) an `Args` tree and the
 * whole output.
 *
 * Reads: `title`, `status`, `tone`, `collapsed`, `term.args`, `term.expanded`;
 * the body's `ansi` (output) or `text` (a note such as "(no output)"), and
 * its result images as placeholders but for those the tool block draws as
 * pictures under the card.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { padTo, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { argsSummaryCells, visibleArgKeys } from "../../tools/args";
import { ansiLines } from "@oh-my-pi/pi-tui/term/painters/ansi";
import { resultPictures } from "./file-common";
import { expandHint, isActive, moreLinesHint, statusGlyph } from "./frame";
import { jsonTreeRows } from "./json-tree";
import { defineToolLook, isExpanded, type ToolProps, toolProps } from "./look";

/** Output lines a collapsed card shows before its hint. */
const COLLAPSED_LINES = 4;
/** Narrowest args summary, in cells. */
const MIN_SUMMARY = 20;

/** Background key of the card's tint. */
export function tint(props: ToolProps): string | undefined {
	if (isActive(props) || props.status === "cancelled") return "toolPendingBg";
	if (props.tone === "info") return undefined;
	if (props.status === "error") return "toolErrorBg";
	return "toolSuccessBg";
}

/** A row filled to `width` in the tint's background, kept across nested resets. */
export function tintRow(theme: Theme, key: string | undefined, row: string, width: number): string {
	const padded = padTo(row, width);
	if (!key) return padded;
	const fill = (theme as { bgFill?: (color: string, text: string) => string }).bgFill;
	return fill ? fill.call(theme, key, padded) : theme.bg(key, padded);
}

function argsRecord(args: unknown): Record<string, unknown> | undefined {
	return args !== null && typeof args === "object" && !Array.isArray(args)
		? (args as Record<string, unknown>)
		: undefined;
}

/** What a generic card shows. */
export interface DefaultCard {
	/** Styled head glyph. */
	readonly glyph: string;
	readonly title: string;
	/** Title color key (default `accent`). */
	readonly titleColor?: string;
	/** Background key of the tint (none: untinted). */
	readonly tint?: string;
	readonly args?: unknown;
	readonly expanded: boolean;
	/** Body nodes: `ansi` output, `text` notes. */
	readonly body: readonly UiNode[];
}

/** Body rows of the card at the content width. */
function bodyRows(card: DefaultCard, theme: Theme, content: number): string[] {
	const rows: string[] = [];
	const args = argsRecord(card.args);
	if (!card.expanded && args && visibleArgKeys(args).length > 0) {
		const branch = theme.symbols.symbol("tree.last");
		const budget = Math.max(MIN_SUMMARY, content - visibleWidth(branch) - 2);
		rows.push(` ${theme.fg("dim", branch)} ${theme.fg("dim", argsSummaryCells(args, budget))}`);
	}
	if (card.expanded && card.args !== undefined) {
		rows.push("", theme.fg("dim", "Args"));
		const tree = jsonTreeRows(theme, card.args, undefined, ["i", "__partialJson"]);
		for (const row of tree.rows) rows.push(truncate(row, content));
		if (tree.truncated) rows.push(theme.fg("dim", "…"));
		rows.push("");
	}
	let output: string[] | undefined;
	const flush = (): void => {
		if (!output) return;
		const lines = output.map(line => theme.fg("toolOutput", line));
		output = undefined;
		if (card.expanded) {
			for (const line of lines) rows.push(...wrap(line, content));
			return;
		}
		const shown = lines.length > COLLAPSED_LINES ? lines.slice(0, COLLAPSED_LINES) : lines;
		for (const line of shown) rows.push(truncate(line, content));
		rows.push(
			lines.length > COLLAPSED_LINES ? moreLinesHint(theme, lines.length - COLLAPSED_LINES) : expandHint(theme),
		);
	};
	for (const child of card.body) {
		const childProps = child.props() as {
			text?: string;
			spans?: readonly { t: string }[];
			alt?: string;
			w?: number;
			h?: number;
		};
		if (child.kind === "ansi") {
			(output ??= []).push(...ansiLines(childProps.text ?? ""));
			continue;
		}
		if (child.kind === "image") {
			// Without an image protocol the output names the image instead.
			const size =
				childProps.w !== undefined && childProps.h !== undefined ? ` ${childProps.w}x${childProps.h}` : "";
			(output ??= []).push(`[Image: [${childProps.alt ?? "image"}]${size}]`);
			continue;
		}
		flush();
		if (child.kind === "text") {
			const text = childProps.spans?.map(span => span.t).join("") ?? childProps.text ?? "";
			rows.push(theme.fg("dim", text));
		}
	}
	flush();
	return rows;
}

/** A generic card at `width`: padded by one cell and one row, tinted; its heading is the pad and the (wrapped) title. */
export function defaultCard(theme: Theme, card: DefaultCard, width: number): Block {
	const content = Math.max(1, width - 2);
	const row = (text: string): string => tintRow(theme, card.tint, ` ${text}`, width);
	const pad = tintRow(theme, card.tint, "", width);
	const title = wrap(`${card.glyph} ${theme.fg(card.titleColor ?? "accent", card.title)}`, content).map(row);
	const rows = [pad, ...title];
	for (const line of bodyRows(card, theme, content)) {
		for (const part of line === "" ? [""] : wrap(line, content)) rows.push(row(part));
	}
	rows.push(pad);
	return { rows, heading: 1 + title.length };
}

function paintDefault(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const children = node.children();
	const drawnPictures = resultPictures(node, cx);
	return defaultCard(
		cx.theme,
		{
			glyph: statusGlyph(node, cx),
			title: styledText(cx.theme, props.title),
			titleColor: props.tone === "info" ? "muted" : "accent",
			tint: tint(props),
			args: props.term?.args,
			expanded: isExpanded(props),
			body: drawnPictures.length > 0 ? children.filter(child => !drawnPictures.includes(child)) : children,
		},
		cx.width,
	);
}

defineToolLook("default", { paint: paintDefault, animated: true });
