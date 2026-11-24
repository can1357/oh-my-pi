/**
 * `write`: the file in a muted rounded frame tinted by state, headed
 * `✎ Write: icon path · N lines · made executable!` (the spinner while
 * working; no glyph while the call's spinner is stopped). The call follows
 * the streaming content (the last {@link STREAM_ROWS} lines while
 * collapsed, `streaming` in the bottom edge until the args are final); the
 * result shows the first {@link PREVIEW_ROWS} lines then `… N more lines`,
 * the progress text while partial and the diagnostics tree.
 *
 * `write-card`: a URL write's status line (`⏳ IRC ➤ Reviewer`, `✔ Config:
 * path ⟦persist⟧`), the message quoted behind a rail, receipts on branches,
 * a setting's `previous → value`.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { nodePlain, nodeStyle } from "./agent-common";
import { diagnosticsRows, fileLink, sectionDiagnostics, wrapGutterRow } from "./file-common";
import { expandHint, frameInner, frameRows, isActive, spinnerGlyph, statusIcon } from "./frame";
import { defineToolLook, type ToolProps, toolProps } from "./look";

/** Lines a collapsed result shows. */
const PREVIEW_ROWS = 6;
/** Lines a collapsed streaming call shows (its tail). */
const STREAM_ROWS = 12;
/** Narrowest line-number gutter (stable while a file streams in). */
const GUTTER_MIN = 3;
/** Longest progress or error line. */
const LINE_MAX = 110;
/** Quoted message lines while collapsed / expanded. */
const QUOTE_COLLAPSED = 3;
const QUOTE_EXPANDED = 12;
/** Receipts while collapsed. */
const RECEIPTS_COLLAPSED = 8;

interface WriteTerm {
	readonly path?: string;
	/** The file the head's path links to. */
	readonly link?: string;
	readonly call?: boolean;
	readonly streaming?: boolean;
	/** The head spins (the call's args are still streaming in). */
	readonly spinning?: boolean;
	readonly executable?: boolean;
}

/** An error message as a detail line: `Error:` dropped, cut, two cells in. */
export function errorDetail(theme: Theme, message: string): string {
	const clean = message.replace(/^Error:\s*/, "").trim();
	return `  ${theme.fg("error", clean ? replaceTabs(truncate(clean, LINE_MAX)) : "Unknown error")}`;
}

function codeLines(theme: Theme, text: string, lang: string | undefined, plainTail: boolean): string[] {
	const lines = text.split("\n");
	if (!plainTail || text.endsWith("\n")) return highlightCode(text, lang, theme);
	const head = lines.slice(0, -1);
	return [...(head.length > 0 ? highlightCode(head.join("\n"), lang, theme) : []), lines[lines.length - 1]!];
}

function sourceRows(cx: PaintContext, source: UiNode, term: WriteTerm, expanded: boolean, inner: number): string[] {
	const theme = cx.theme;
	const text = (source.props() as { text?: string }).text ?? "";
	if (!text) return [];
	const lang = languageFromPath(term.path ?? "");
	const lines = text.split("\n");
	const total = lines.length;
	const gutter = Math.max(GUTTER_MIN, String(total).length);
	const rows: string[] = [];
	if (term.call) {
		if (total === 1 && lines[0] === "") return [];
		const start = expanded ? 0 : Math.max(0, total - STREAM_ROWS);
		// Highlight from the top so the shown tail keeps the file's lexical state.
		const highlighted = codeLines(theme, text, lang ?? "text", term.streaming === true).slice(start);
		if (start > 0) rows.push(theme.fg("dim", `… (${start} earlier line${start === 1 ? "" : "s"})`));
		highlighted.forEach((line, i) =>
			rows.push(...wrapGutterRow(theme, start + i + 1, gutter, replaceTabs(line), inner)),
		);
		return rows;
	}
	const shown = expanded ? total : Math.min(total, PREVIEW_ROWS);
	highlightCode(lines.slice(0, shown).join("\n"), lang, theme).forEach((line, i) =>
		rows.push(...wrapGutterRow(theme, i + 1, gutter, replaceTabs(line), inner)),
	);
	const hidden = total - shown;
	if (!expanded && hidden > 0)
		rows.push(theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"} ${expandHint(theme)}`));
	return rows;
}

function fileHead(cx: PaintContext, props: ToolProps, term: WriteTerm): string {
	const theme = cx.theme;
	const failed = props.tone === "error" || props.status === "error";
	let glyph = "";
	if (failed) glyph = theme.fg("error", theme.symbols.symbol("status.error"));
	else if (term.call) glyph = cx.reduceMotion || !term.spinning ? "" : spinnerGlyph(cx);
	else if (isActive(props)) glyph = spinnerGlyph(cx);
	else glyph = theme.fg("accent", theme.symbols.symbol("tool.write"));
	const rawPath = term.path ?? "";
	const lang = languageFromPath(rawPath);
	const icon = theme.fg("muted", theme.symbols.langIcon(term.call ? (lang ?? "text") : lang));
	let description = `${icon} ${rawPath ? fileLink(cx, theme.fg("accent", rawPath), term.link) : theme.fg("toolOutput", "…")}`;
	if (!term.call && !failed) {
		const lines = props.meta?.[0];
		if (lines !== undefined) description += theme.fg("dim", ` · ${typeof lines === "string" ? lines : ""}`);
		if (term.executable) description += `${theme.fg("dim", " · ")}${theme.fg("success", "made executable!")}`;
	}
	const title = `${theme.fg("accent", "Write")}: ${theme.fg("muted", description)}`;
	return glyph ? `${glyph} ${title}` : title;
}

function paintWrite(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const theme = cx.theme;
	const term = (props.term ?? {}) as WriteTerm;
	// No view (the path has not streamed in yet): nothing to show.
	if (term.path === undefined) return EMPTY_BLOCK;
	const width = cx.width;
	const inner = Math.max(1, frameInner(width));
	// The transcript's expand state: a live call stays unfolded natively while its body streams.
	const expanded = props.term?.expanded === true;
	const failed = props.tone === "error" || props.status === "error";
	const children = node.children();
	const lines: string[] = [];
	if (failed) {
		const error = children.find(child => (child.props() as { role?: string }).role === "omp.tool.error");
		lines.push(errorDetail(theme, error ? nodePlain(error) : ""));
	} else {
		const source = children.find(child => child.kind === "code");
		const progress = children.find(child => child.kind === "text");
		const code = source ? sourceRows(cx, source, term, expanded, inner) : [];
		if (progress) lines.push(theme.fg("muted", replaceTabs(truncate(nodePlain(progress), LINE_MAX))), "", "");
		lines.push(...code);
		const section = children.find(child => child.kind === "section");
		const diagnostics = section ? sectionDiagnostics(section) : undefined;
		if (diagnostics)
			lines.push(
				...diagnosticsRows(theme, diagnostics, expanded, file => theme.symbols.langIcon(languageFromPath(file))),
			);
		while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
	}
	const bg = failed
		? "toolErrorBg"
		: isActive(props) || props.status === "cancelled"
			? "toolPendingBg"
			: "toolSuccessBg";
	const source = children.find(child => child.kind === "code");
	const foot = term.call && term.streaming && source ? theme.fg("dim", "streaming") : undefined;
	return {
		rows: frameRows(theme, width, {
			head: fileHead(cx, props, term),
			sections: lines.length > 0 ? [{ lines }] : [],
			foot,
			border: failed ? "error" : "borderMuted",
			bg,
		}),
	};
}

defineToolLook("write", { paint: paintWrite, margin: true, animated: true });

// ─── URL write cards ────────────────────────────────────────────────────────

interface CardTerm {
	readonly card?: {
		readonly icon: "pending" | "error" | "success" | "warning" | "aborted" | "irc";
		readonly title: string;
		readonly description?: string;
		readonly meta?: readonly TspSpan[];
		readonly badges?: readonly {
			readonly label: string;
			readonly color: string;
		}[];
	};
}

function cardIcon(theme: Theme, icon: NonNullable<CardTerm["card"]>["icon"]): string {
	const symbol = (key: string, color: string) => theme.fg(color, theme.symbols.symbol(key));
	switch (icon) {
		case "pending":
			return symbol("status.pending", "muted");
		case "error":
			return symbol("status.error", "error");
		case "warning":
			return symbol("status.warning", "warning");
		case "aborted":
			return symbol("status.aborted", "error");
		case "irc":
			return symbol("tool.irc", "accent");
		default:
			return symbol("status.success", "success");
	}
}

/** Spans with each run's surrounding spaces left unstyled. */
function looseSpans(theme: Theme, spans: readonly TspSpan[]): string {
	let out = "";
	for (const span of spans) {
		const match = /^(\s*)(.*?)(\s*)$/s.exec(span.t)!;
		out += `${match[1]}${match[2] ? theme.style(span.s, match[2]) : ""}${match[3]}`;
	}
	return out;
}

/**
 * A message quoted behind a dim rail. A peer message (`width` given) shows
 * whole and wrapped once expanded, its collapsed rows cut to the card; a
 * process input keeps a fixed budget.
 */
function quoteRows(theme: Theme, body: string, expanded: boolean, width?: number): string[] {
	const prefix = `  ${theme.fg("dim", theme.symbols.symbol("md.quoteBorder"))} `;
	const source = body.split("\n").filter(line => line.trim());
	const whole = expanded && width !== undefined;
	const shown = whole ? source : source.slice(0, expanded ? QUOTE_EXPANDED : QUOTE_COLLAPSED);
	const hidden = source.length - shown.length;
	const content = width === undefined ? LINE_MAX : Math.max(1, width - 4);
	const cap = Math.min(LINE_MAX, content);
	let cut = false;
	const rows: string[] = [];
	for (const line of shown) {
		const text = replaceTabs(line.trim());
		if (whole) {
			for (const row of wrap(text, content)) rows.push(`${prefix}${theme.fg("dim", row)}`);
			continue;
		}
		cut ||= visibleWidth(text) > cap;
		rows.push(`${prefix}${theme.fg("dim", truncate(text, cap))}`);
	}
	if (hidden > 0 || cut) {
		const marker = hidden > 0 ? `… +${hidden} more lines` : "…";
		rows.push(`${prefix}${theme.fg("dim", `${marker}${expanded ? "" : ` ${expandHint(theme)}`}`)}`);
	}
	return rows;
}

function receiptRows(theme: Theme, list: UiNode, expanded: boolean): string[] {
	const items = list.children();
	const shown = expanded ? items : items.slice(0, RECEIPTS_COLLAPSED);
	const rows = shown.map((item, index) => {
		const props = item.props() as {
			label?: TspSpan[];
			value?: TspSpan[];
			detail?: TspSpan[];
		};
		const outcome = props.value?.[0];
		const branch = theme.symbols.symbol(
			index === shown.length - 1 && shown.length === items.length ? "tree.last" : "tree.branch",
		);
		let row = `${theme.fg("dim", branch)} ${theme.fg("toolOutput", props.label?.[0]?.t ?? "")} ${theme.fg(outcome?.s ?? "success", `⟦${outcome?.t ?? ""}⟧`)}`;
		const error = props.detail?.[0]?.t;
		if (error) row += ` ${theme.fg("error", `— ${error}`)}`;
		return row;
	});
	const hidden = items.length - shown.length;
	if (hidden > 0)
		rows.push(
			`${theme.fg("dim", theme.symbols.symbol("tree.last"))} ${theme.fg("muted", `… ${hidden} more recipients`)}`,
		);
	return rows;
}

/** Cancelled jobs: `└─ ⏹ ⟦bash⟧ build-42 Build assets 2.0s ⟦cancelled⟧`. */
function cancelledRows(cx: PaintContext, list: UiNode): string[] {
	const theme = cx.theme;
	const items = list.children();
	return items.map((item, index) => {
		const props = item.props() as {
			label?: TspSpan[];
			value?: TspSpan[];
			detail?: TspSpan[];
			term?: { status?: string; durationMs?: number };
		};
		const branch = theme.fg("dim", theme.symbols.symbol(index === items.length - 1 ? "tree.last" : "tree.branch"));
		const outcome = props.value?.[0];
		const badge = theme.fg(outcome?.s ?? "warning", `⟦${outcome?.t ?? ""}⟧`);
		const job = props.term;
		if (!job) return `${branch} ${theme.fg("toolOutput", props.label?.[0]?.t ?? "")} ${badge}`;
		const status = job.status;
		const icon = statusIcon(
			cx,
			status === "cancelled"
				? "aborted"
				: status === "failed"
					? "error"
					: status === "running"
						? "running"
						: "success",
		);
		const typeColor = status === "failed" ? "error" : status === "cancelled" ? "warning" : "accent";
		const type = theme.fg(typeColor, `⟦${props.label?.[0]?.t ?? ""}⟧`);
		const id = theme.fg("toolOutput", props.label?.[2]?.t ?? "");
		const label = theme.fg("dim", props.detail?.[0]?.t ?? "");
		return `${branch} ${icon} ${type} ${id} ${label} ${theme.fg("dim", formatDuration(job.durationMs ?? 0))} ${badge}`;
	});
}

function paintCard(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const theme = cx.theme;
	const card = ((props.term ?? {}) as CardTerm).card;
	if (!card) return { rows: [] };
	let head = `${cardIcon(theme, card.icon)} ${theme.fg("accent", card.title)}`;
	if (card.description) head += `: ${theme.fg("muted", card.description)}`;
	const meta = (card.meta ?? []).map(span => theme.style(span.s, span.t));
	if (meta.length > 0) head += ` ${theme.fg("dim", meta.join(theme.fg("dim", " · ")))}`;
	for (const badge of card.badges ?? []) head += ` ${theme.fg(badge.color, `⟦${badge.label}⟧`)}`;
	const rows = [head];
	// The transcript's expand state: a live call stays unfolded natively while its body streams.
	const expanded = props.term?.expanded === true;
	for (const child of node.children()) {
		const childProps = child.props() as {
			role?: string;
			spans?: readonly TspSpan[];
		};
		if (child.kind === "list" && childProps.role === "omp.tool.proc.cancelled")
			rows.push(...cancelledRows(cx, child));
		else if (child.kind === "list") rows.push(...receiptRows(theme, child, expanded));
		else if (childProps.role === "omp.tool.proc.preview")
			rows.push(
				...quoteRows(theme, nodePlain(child), expanded, card.title.startsWith("IRC") ? cx.width : undefined),
			);
		else if (childProps.role === "omp.tool.error") rows.push(errorDetail(theme, nodePlain(child)));
		else if (nodeStyle(child) === "muted" && childProps.spans?.length === 1)
			rows.push(theme.fg("muted", nodePlain(child)));
		else rows.push(`  ${looseSpans(theme, childProps.spans ?? [])}`);
	}
	return { rows: rows.map(row => truncate(row, cx.width)) };
}

defineToolLook("write-card", { paint: paintCard, margin: true });
