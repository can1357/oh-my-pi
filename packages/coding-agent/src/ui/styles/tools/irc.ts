/**
 * `omp.irc.*` cards: `✉ IRC Anna ➤ Ben reply · 1m ago`, then the message's
 * non-blank lines behind a dim quote rail — three (cut to the row) and an
 * expand hint while collapsed, every line wrapped once expanded.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { elapsedAt } from "@oh-my-pi/pi-tui/term/painters/elapsed";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { formatAge } from "@oh-my-pi/pi-utils";
import type { TspElapsedProps, TspSpan } from "@oh-my-pi/pi-wire";
import { type IrcMessage, ircTitle } from "../../tools/irc";
import { expandHint } from "./frame";

/** Body lines a collapsed card shows. */
const COLLAPSED_LINES = 3;
/** Longest collapsed body row, in cells. */
const LINE_WIDTH = 100;
const INDENT = "  ";

function bodyRows(cx: PaintContext, body: string, expanded: boolean): string[] {
	const theme = cx.theme;
	const prefix = `${INDENT}${theme.fg("dim", theme.symbols.symbol("md.quoteBorder"))} `;
	const source = body.split("\n").filter(line => line.trim());
	const shown = expanded ? source : source.slice(0, COLLAPSED_LINES);
	const hidden = source.length - shown.length;
	const content = Math.max(1, cx.width - visibleWidth(prefix));
	const cap = Math.min(LINE_WIDTH, content);
	let cut = false;
	const rows: string[] = [];
	for (const line of shown) {
		const text = replaceTabs(line.trim());
		if (expanded) {
			for (const row of wrap(text, content)) rows.push(`${prefix}${theme.fg("toolOutput", row)}`);
			continue;
		}
		cut ||= visibleWidth(text) > cap;
		rows.push(`${prefix}${theme.fg("toolOutput", truncate(text, cap))}`);
	}
	if (hidden > 0 || cut) {
		const marker = hidden > 0 ? `… +${hidden} more ${hidden === 1 ? "line" : "lines"}` : "…";
		rows.push(`${prefix}${theme.fg("dim", `${marker} ${expanded ? "" : expandHint(theme)}`.trimEnd())}`);
	}
	return rows;
}

function paintIrcCard(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const props = node.props() as {
		head?: readonly TspSpan[];
		term?: { message?: IrcMessage; expanded?: boolean };
	};
	const head = props.head ?? [];
	const meta = head.slice(1).map(span => span.t.trim());
	const children = node.children();
	const elapsed = children
		.find(child => child.kind === "row")
		?.children()
		.find(child => child.kind === "elapsed");
	if (elapsed) {
		const ms = elapsedAt(elapsed, elapsed.props() as TspElapsedProps, cx.now());
		meta.push(formatAge(Math.max(1, Math.round(ms / 1000))));
	}
	const title = props.term?.message ? ircTitle(props.term.message, theme) : (head[0]?.t ?? "");
	let line = `${theme.fg("accent", theme.symbols.symbol("tool.irc"))} ${theme.fg("accent", title)}`;
	if (meta.length > 0) line += ` ${theme.fg("dim", meta.join(" · "))}`;
	const rows = [line];
	const md = children.find(child => child.kind === "md");
	if (md) rows.push(...bodyRows(cx, (md.props() as { text?: string }).text ?? "", props.term?.expanded === true));
	return { rows: rows.map(row => truncate(row, cx.width)) };
}

defineRolePainter("card", "omp.irc", paintIrcCard, { prefix: true });
