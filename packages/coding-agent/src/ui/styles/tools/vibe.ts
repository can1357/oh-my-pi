/**
 * `vibe`: three frames (the view's `term.frame`).
 *
 * - `line`: `✔ vibe kill Anna`, a note or the empty wall's gist after it,
 *   the fallback or error text indented on one line under it.
 * - `composer`: a left-railed mini terminal: `╭─ vibe send → Anna`, the
 *   `> message` rows (two while collapsed, six expanded, a blinking `▌`
 *   while the call is working), `╰─` and the delivery outcome.
 * - `wall`: `ⓘ vibe sessions (5) 3 on air · …`, then a mini terminal per
 *   worker card: status, cli badge, id (sweeping while it works), state,
 *   turns, turn age, model; its turn message, recent trace (two collapsed,
 *   six expanded), current tool, output tail (one/three), last activity,
 *   and the settled outcome in the bottom rail.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { elapsedAt } from "@oh-my-pi/pi-tui/term/painters/elapsed";
import { spinnerIndex } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { shimmerTiers } from "@oh-my-pi/pi-tui/term/painters/shimmer";
import { shimmerText } from "@oh-my-pi/pi-tui/text/shimmer";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TspElapsedProps, TspSpan } from "@oh-my-pi/pi-wire";
import { oneLine } from "../../tools/agent-common";
import { nodePlain, nodeStyle, plainText, spansOf } from "./agent-common";
import { bracketed, isActive, spinnerGlyph } from "./frame";
import { defineToolLook, isExpanded, type ToolProps, toolProps } from "./look";

/** Longest composer line. */
const COMPOSER_LINE_MAX = 96;
/** Longest wall line fragment. */
const TV_LINE_MAX = 110;
const COMPOSER_ROWS_COLLAPSED = 2;
const COMPOSER_ROWS_EXPANDED = 6;
const TRACE_COLLAPSED = 2;
const TRACE_EXPANDED = 6;
const OUTPUT_COLLAPSED = 1;
const OUTPUT_EXPANDED = 3;
const CURSOR = "▌";

interface VibeTerm {
	readonly frame?: "line" | "composer" | "wall";
	readonly line?: string;
	readonly gist?: string;
	readonly running?: number;
	/** The call's view (still pending). */
	readonly call?: boolean;
}

/** `╭─ head`, `│ row`…, `╰─ foot`. */
function railRows(theme: Theme, head: string, body: readonly string[], foot?: string): string[] {
	const box = theme.symbols.box;
	const rows = [`${theme.fg("dim", `${box.topLeft}${box.horizontal}`)} ${head}`];
	for (const row of body) rows.push(`${theme.fg("dim", box.vertical)} ${row}`);
	rows.push(
		foot
			? `${theme.fg("dim", `${box.bottomLeft}${box.horizontal}`)} ${foot}`
			: theme.fg("dim", `${box.bottomLeft}${box.horizontal}`),
	);
	return rows;
}

function cutRows(rows: readonly string[], width: number): string[] {
	return rows.map(row => truncate(row, width));
}

function paintLine(node: UiNode, props: ToolProps, term: VibeTerm, cx: PaintContext): string[] {
	const theme = cx.theme;
	const warn = props.tone === "warning";
	const mark = warn
		? theme.fg("warning", theme.symbols.symbol("status.warning"))
		: term.call
			? theme.fg("muted", theme.symbols.symbol("status.pending"))
			: props.tone === "error"
				? theme.fg("error", theme.symbols.symbol("status.error"))
				: theme.fg("success", theme.symbols.symbol("status.success"));
	let head = `${mark} ${theme.fg("accent", term.line ?? "")}`;
	if (warn && term.gist !== undefined) {
		const meta = [theme.fg("dim", oneLine(term.gist, 60))];
		const spans = spansOf(props.title);
		const killed = spans.length > 5 ? spans[spans.length - 1] : undefined;
		if (killed) meta.push(theme.fg("dim", killed.t.replace(/^ · /, "")));
		head += ` ${theme.fg("dim", meta.join(theme.fg("dim", " · ")))}`;
	}
	let text = head;
	const child = node.children()[0];
	if (child) {
		const color = nodeStyle(child) === "error" ? "error" : "dim";
		text += `\n  ${theme.fg(color, oneLine(nodePlain(child), TV_LINE_MAX))}`;
	}
	return wrap(text, cx.width);
}

function paintComposer(node: UiNode, props: ToolProps, term: VibeTerm, cx: PaintContext): string[] {
	const theme = cx.theme;
	const children = node.children();
	const composer = children.find(child => (child.props() as { role?: string }).role === "omp.vibe.composer");
	const spinner = children.find(child => child.kind === "spinner");
	const outcome = children.find(child => child !== composer && child.kind === "text");
	let head: string;
	if (term.line !== undefined) head = theme.fg("muted", term.line);
	else {
		const spans = spansOf(props.title);
		const parts = [theme.fg("muted", `vibe ${spans[2]?.t ?? ""}`)];
		for (const span of spans.slice(3)) {
			if (span.t === " ") continue;
			parts.push(
				span.s === "accent strong"
					? theme.fg("accent", bracketed(theme, span.t))
					: theme.style(span.s, oneLine(span.t, 40)),
			);
		}
		head = parts.join(" ");
	}
	const message = (composer?.props() as { term?: { message?: string } } | undefined)?.term?.message ?? "";
	const lines = message.split(/\r?\n/).filter(line => line.trim().length > 0);
	const max = isExpanded(props) ? COMPOSER_ROWS_EXPANDED : COMPOSER_ROWS_COLLAPSED;
	const visible = lines.slice(0, max).map(line => oneLine(line, COMPOSER_LINE_MAX));
	if (visible.length === 0) visible.push("");
	const last = visible.length - 1;
	if (lines.length > max) visible[last] = `${visible[last]} …`;
	// The cursor blinks on the spinner clock; with decorative motion off it stays shown.
	else if (
		spinner &&
		isActive(props) &&
		(cx.reduceMotion || (spinnerIndex(cx, theme.symbols.spinnerFrames.length) & 1) === 0)
	)
		visible[last] = `${visible[last]}${theme.fg("accent", CURSOR)}`;
	const body = visible.map((line, index) =>
		index === 0 ? `${theme.fg("accent", ">")} ${theme.fg("toolOutput", line)}` : `  ${theme.fg("toolOutput", line)}`,
	);
	const foot = spinner
		? styledText(theme, (spinner.props() as { label?: readonly TspSpan[] }).label)
		: outcome
			? styledText(theme, (outcome.props() as { spans?: readonly TspSpan[] }).spans)
			: undefined;
	return cutRows(railRows(theme, head, body, foot), cx.width);
}

/** The status glyph of a wall card. */
function cardMark(cx: PaintContext, status: string | undefined): string {
	const theme = cx.theme;
	switch (status) {
		case "running":
			return cx.spinnerInterval === 0
				? theme.fg("accent", theme.symbols.symbol("status.running"))
				: spinnerGlyph(cx);
		case "pending":
			return theme.fg("muted", theme.symbols.symbol("status.pending"));
		case "error":
			return theme.fg("error", theme.symbols.symbol("status.error"));
		case "cancelled":
			return theme.fg("error", theme.symbols.symbol("status.aborted"));
		default:
			return theme.fg("success", theme.symbols.symbol("status.success"));
	}
}

interface CardProps {
	readonly head?: readonly TspSpan[];
	readonly status?: string;
}

function paintCard(card: UiNode, cx: PaintContext, expanded: boolean): string[] {
	const theme = cx.theme;
	const props = card.props() as CardProps;
	const head = props.head ?? [];
	const idSpan = head[0];
	const live = idSpan?.fx === "shimmer";
	const parts = [cardMark(cx, props.status)];
	const children = card.children();
	const meta = children[0];
	const badge = meta?.children().find(child => child.kind === "badge");
	if (badge) {
		const badgeProps = badge.props() as {
			text?: string;
			term?: { color?: string };
		};
		parts.push(theme.fg(badgeProps.term?.color ?? "muted", bracketed(theme, badgeProps.text ?? "")));
	}
	const id = idSpan?.t ?? "";
	parts.push(
		live
			? cx.reduceMotion
				? theme.fg("accent", id)
				: shimmerText(id, cx.now(true), "classic", shimmerTiers(theme))
			: theme.fg("toolOutput", id),
	);
	for (const span of head.slice(1, 3)) parts.push(theme.style(span.s, span.t.trimStart()));
	const elapsed = meta?.children().find(child => child.kind === "elapsed");
	if (elapsed) {
		const elapsedProps = elapsed.props() as TspElapsedProps;
		parts.push(theme.fg("dim", formatDuration(elapsedAt(elapsed, elapsedProps, cx.now()))));
	}
	const model = head[3];
	if (model) parts.push(theme.fg("muted", oneLine(model.t, 40)));
	const hook = theme.symbols.symbol("tree.hook");
	const body: string[] = [];
	const traces: string[] = [];
	const outputs: string[] = [];
	let foot: string | undefined;
	let tool: string | undefined;
	for (const child of children.slice(1)) {
		if (child.kind === "shimmer") {
			const label = oneLine(plainText((child.props() as { spans?: readonly TspSpan[] }).spans), TV_LINE_MAX);
			const painted = cx.reduceMotion
				? theme.fg("muted", label)
				: shimmerText(label, cx.now(true), "classic", shimmerTiers(theme));
			tool = `${theme.fg("accent", hook)} ${painted}`;
			continue;
		}
		const part = (child.props() as { term?: { part?: string } }).term?.part;
		const text = oneLine(nodePlain(child), TV_LINE_MAX);
		switch (part) {
			case "message":
				body.push(`${theme.fg("accent", ">")} ${theme.fg("dim", oneLine(text.replace(/^> /, ""), TV_LINE_MAX))}`);
				break;
			case "trace":
				traces.push(`${theme.fg("dim", hook)} ${theme.fg("dim", text)}`);
				break;
			case "intent":
				tool = `${theme.fg("accent", hook)} ${theme.fg("muted", text)}`;
				break;
			case "output":
				outputs.push(`  ${theme.fg("muted", text)}`);
				break;
			case "activity":
				body.push(`${theme.fg("dim", hook)} ${theme.fg("muted", text)}`);
				break;
			case "settled":
				foot = theme.style(nodeStyle(child), nodePlain(child));
				break;
		}
	}
	body.push(...traces.slice(-(expanded ? TRACE_EXPANDED : TRACE_COLLAPSED)));
	if (tool) body.push(tool);
	body.push(...outputs.slice(-(expanded ? OUTPUT_EXPANDED : OUTPUT_COLLAPSED)));
	return railRows(theme, parts.join(" "), body, foot);
}

function paintWall(node: UiNode, props: ToolProps, term: VibeTerm, cx: PaintContext): string[] {
	const theme = cx.theme;
	const spans = spansOf(props.title);
	const mark =
		props.tone === "warning"
			? theme.fg("warning", theme.symbols.symbol("status.warning"))
			: (term.running ?? 0) > 0
				? theme.fg("accent", theme.symbols.symbol("status.info"))
				: theme.fg("success", theme.symbols.symbol("status.success"));
	let head = `${mark} ${theme.fg("accent", term.line ?? "")}`;
	const meta = spans.slice(3).map(span => theme.style(span.s, span.t.replace(/^ · /, "")));
	if (meta.length > 0) head += ` ${theme.fg("dim", meta.join(theme.fg("dim", " · ")))}`;
	const rows = [head];
	const expanded = isExpanded(props);
	for (const card of node.children()) if (card.kind === "card") rows.push(...paintCard(card, cx, expanded));
	return cutRows(rows, cx.width);
}

function paintVibe(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? {}) as VibeTerm;
	switch (term.frame) {
		case "composer":
			return { rows: paintComposer(node, props, term, cx) };
		case "wall":
			return { rows: paintWall(node, props, term, cx) };
		default:
			return { rows: paintLine(node, props, term, cx) };
	}
}

defineToolLook("vibe", { paint: paintVibe, animated: true });
