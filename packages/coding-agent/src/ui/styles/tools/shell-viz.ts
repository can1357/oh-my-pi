/**
 * A shell visualization presentation as terminal rows: one row per
 * presentation row, its gutter (`▶` running, `×` failed, `›` selected), the
 * nesting indent and effect glyphs, then the segments colored by their
 * semantic tokens (dimmed while another leaf runs), with a hanging indent
 * when the text wraps. Split presentations draw both panes.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { ShellVizPresentation, ShellVizRow, ShellVizSegment } from "@oh-my-pi/pi-wire";

/** Untrusted shell text made safe for one row. */
export function shellVizText(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/[\r\n]/g, " ");
}

/** Nerd Font glyphs replacing the whole `/dev/null` discard badge, by style token. */
const DISCARD_ICONS: Readonly<Record<string, string>> = {
	"badge-discard-out": "\u{f164d}",
	"badge-discard-err": "\u{f14bc}",
	"badge-discard-all": "\u{f0581}",
};

/** Theme color of a segment's semantic tokens. */
function tokenColor(tokens: readonly string[]): string {
	if (tokens.includes("comment")) return "syntaxComment";
	if (tokens.includes("kw")) return "syntaxKeyword";
	if (tokens.includes("var") || tokens.includes("secret")) return "syntaxVariable";
	if (tokens.includes("str") || tokens.includes("path")) return "syntaxString";
	if (tokens.includes("num")) return "syntaxNumber";
	if (tokens.includes("op")) return "syntaxOperator";
	if (tokens.includes("cmd") || tokens.includes("fn")) return "syntaxFunction";
	if (tokens.includes("chip") || tokens.includes("badge")) return "accent";
	return "text";
}

const faint = (text: string): string => (text ? `\x1b[2m${text}\x1b[22m` : text);
const bold = (text: string): string => (text ? `\x1b[1m${text}\x1b[22m` : text);

function segmentText(
	segment: ShellVizSegment,
	row: ShellVizRow,
	presentation: ShellVizPresentation,
	theme: Theme,
): string {
	const tokens = segment.style?.split(" ") ?? [];
	const discard = theme.symbols.preset === "nerd" ? tokens.find(token => token in DISCARD_ICONS) : undefined;
	const text = discard ? ` ${DISCARD_ICONS[discard]}` : shellVizText(segment.text);
	const inactive =
		(presentation.running === true && !(segment.active ?? row.active)) || (segment.state ?? row.state) === "skipped";
	const semantic = tokens.some(token => token === "chip" || token === "badge" || token === "secret");
	const styled = presentation.preferences.layers.color || semantic ? theme.fg(tokenColor(tokens), text) : text;
	if (inactive) return faint(styled);
	return segment.active && presentation.running ? bold(styled) : styled;
}

/** A row's lead (gutter, indent, effects) and its wrappable text. */
function rowParts(
	row: ShellVizRow,
	presentation: ShellVizPresentation,
	theme: Theme,
	width: number,
): { lead: string; body: string } {
	const selectedNode = presentation.preferences.selectedNode;
	const selected =
		selectedNode !== undefined &&
		(row.node === selectedNode || row.segments.some(segment => segment.node === selectedNode));
	const failedInSegments = row.segments.some(segment => segment.state === "fail");
	const muted = presentation.running === true && !row.active;
	const failedStatement =
		row.state === "fail" && !failedInSegments && row.role !== "head" && row.role !== "mid" && row.role !== "tail";
	const gutter = failedStatement
		? theme.fg("error", "×")
		: presentation.running && row.segments.some(segment => segment.active)
			? theme.fg("accent", "▶")
			: selected
				? theme.fg("accent", "›")
				: " ";
	const effects = presentation.preferences.layers.effects
		? row.effects.map(item => shellVizText(item.glyph)).join("")
		: "";
	const effect = muted ? faint(effects) : effects;
	const indent = "  ".repeat(Math.min(row.depth, Math.max(0, Math.floor(width / 4))));
	const failures = new Set<string>();
	let body = "";
	for (const segment of row.segments) {
		const execution = segment.executionNode ?? segment.node ?? row.node;
		const failed = segment.state === "fail" && execution !== undefined && !failures.has(execution);
		if (failed && execution !== undefined) failures.add(execution);
		const mark = failed ? theme.fg("error", "× ") : "";
		body += `${muted ? faint(mark) : mark}${segmentText(segment, row, presentation, theme)}`;
	}
	const meta = row.meta ? `  ${theme.fg(row.state === "fail" ? "error" : "dim", shellVizText(row.meta))}` : "";
	const annotations = (row.annotations ?? [])
		.map(variable => {
			const shortened =
				variable.fullLength !== undefined && variable.fullLength > Buffer.byteLength(variable.value, "utf8");
			const name = theme.fg("syntaxVariable", shellVizText(variable.name));
			const value = theme.fg("syntaxString", shellVizText(JSON.stringify(variable.value)) + (shortened ? "…" : ""));
			const annotation = `${name} ${theme.fg("muted", "=")} ${value}`;
			return muted ? faint(annotation) : annotation;
		})
		.join(theme.fg("muted", " · "));
	return {
		lead: `${gutter} ${indent}${effect ? `${effect} ` : ""}`,
		body: `${body}${meta}${annotations ? `  ${theme.fg("muted", "‹")} ${annotations} ${theme.fg("muted", "›")}` : ""}`,
	};
}

function rowLines(row: ShellVizRow, presentation: ShellVizPresentation, theme: Theme, width: number): string[] {
	const { lead, body } = rowParts(row, presentation, theme, width);
	const leadWidth = visibleWidth(lead);
	if (leadWidth >= width) return wrap(`${lead}${body}`, Math.max(1, width));
	const hanging = " ".repeat(leadWidth);
	const rows = wrap(body, width - leadWidth);
	return (rows.length > 0 ? rows : [""]).map((line, index) => `${index === 0 ? lead : hanging}${line}`);
}

function joinPanes(left: readonly string[], right: readonly string[], width: number, separator: string): string[] {
	const pane = Math.max(1, Math.floor((width - visibleWidth(separator)) / 2));
	return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
		const first = truncate(left[index] ?? "", pane);
		return truncate(
			`${first}${" ".repeat(Math.max(0, pane - visibleWidth(first)))}${separator}${right[index] ?? ""}`,
			width,
		);
	});
}

/** The presentation's rows at `width` (with its captured output when `includeOutput`). */
export function shellVizRows(
	presentation: ShellVizPresentation,
	theme: Theme,
	width: number,
	includeOutput = true,
): string[] {
	const w = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	if (presentation.message) lines.push(theme.fg("dim", shellVizText(presentation.message)));
	const rowsOf = (rows: readonly ShellVizRow[], paneWidth: number): string[] =>
		rows.flatMap(row => rowLines(row, presentation, theme, paneWidth));
	if (presentation.preferences.split && presentation.preferences.view !== "raw") {
		if (w >= 90) {
			const pane = Math.floor((w - 3) / 2);
			lines.push(
				...joinPanes(
					[theme.fg("dim", "Original"), ...rowsOf(presentation.original, pane)],
					[theme.fg("dim", "Pseudo"), ...rowsOf(presentation.rows, pane)],
					w,
					" │ ",
				),
			);
		} else {
			lines.push(
				theme.fg("dim", "Split stacked (terminal too narrow for side-by-side)"),
				theme.fg("dim", "Original"),
			);
			lines.push(...rowsOf(presentation.original, w), theme.fg("dim", "Pseudo"), ...rowsOf(presentation.rows, w));
		}
	} else lines.push(...rowsOf(presentation.rows, w));
	if (includeOutput && presentation.output) {
		lines.push(
			theme.fg("dim", "Output"),
			...presentation.output
				.trimEnd()
				.split("\n")
				.flatMap(line => wrap(shellVizText(line), w)),
		);
	}
	if (presentation.timeline.trimmed)
		lines.push(theme.fg("warning", "Replay history/output trimmed to retained limits"));
	return lines.map(line => truncate(line, w));
}
