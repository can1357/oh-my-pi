import type { ShellVizPresentation, ShellVizRow, ShellVizSegment } from "@oh-my-pi/pi-wire";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme/theme";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

/** Sanitize untrusted shell source, values and outputs before applying terminal styling. */
export function shellVizText(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/[\r\n]/g, " ");
}

function color(style: string | undefined): ThemeColor {
	const tokens = style?.split(" ") ?? [];
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

function segmentText(
	segment: ShellVizSegment,
	row: ShellVizRow,
	presentation: ShellVizPresentation,
	theme: Theme,
): string {
	const text = shellVizText(segment.text);
	const inactive =
		(presentation.running && !(segment.active ?? row.active)) || (segment.state ?? row.state) === "skipped";
	const tokens = segment.style?.split(" ") ?? [];
	const semantic = tokens.some(token => ["chip", "badge", "secret"].includes(token));
	const styled = presentation.preferences.layers.color || semantic ? theme.fg(color(segment.style), text) : text;
	const emphasized = inactive
		? theme.faint(styled)
		: segment.active && presentation.running
			? theme.bold(styled)
			: styled;
	return emphasized;
}

function rowText(row: ShellVizRow, presentation: ShellVizPresentation, theme: Theme, width: number): string {
	const selected =
		presentation.preferences.selectedNode !== undefined &&
		(row.node === presentation.preferences.selectedNode ||
			row.segments.some(segment => segment.node === presentation.preferences.selectedNode));
	const failures = new Set<string>();
	const rowFailedInSegments = row.segments.some(segment => segment.state === "fail");
	const muted = presentation.running && !row.active;
	const failedStatement =
		row.state === "fail" && !rowFailedInSegments && row.role !== "head" && row.role !== "mid" && row.role !== "tail";
	const gutter = failedStatement
		? theme.fg("error", "×")
		: presentation.running && row.active
			? theme.fg("accent", "▶")
			: selected
				? theme.fg("accent", "›")
				: " ";
	const effects = presentation.preferences.layers.effects
		? row.effects.map(item => shellVizText(item.glyph)).join("")
		: "";
	const effect = muted ? theme.faint(effects) : effects;
	const indent = "  ".repeat(Math.min(row.depth, Math.max(0, Math.floor(width / 4))));
	const body = row.segments
		.map(segment => {
			const execution = segment.executionNode ?? segment.node ?? row.node;
			const failed = segment.state === "fail" && execution !== undefined && !failures.has(execution);
			if (failed && execution !== undefined) failures.add(execution);
			const mark = failed ? theme.fg("error", "× ") : "";
			return `${muted ? theme.faint(mark) : mark}${segmentText(segment, row, presentation, theme)}`;
		})
		.join("");
	const meta = row.meta ? `  ${theme.fg(row.state === "fail" ? "error" : "dim", shellVizText(row.meta))}` : "";
	const annotations = (row.annotations ?? [])
		.map(variable => {
			const shortened =
				variable.fullLength !== undefined && variable.fullLength > Buffer.byteLength(variable.value, "utf8");
			const name = theme.fg("syntaxVariable", shellVizText(variable.name));
			const value = theme.fg("syntaxString", shellVizText(JSON.stringify(variable.value)) + (shortened ? "…" : ""));
			const annotation = `${name} ${theme.fg("muted", "=")} ${value}`;
			return muted ? theme.faint(annotation) : annotation;
		})
		.join(theme.fg("muted", " · "));
	return `${gutter} ${indent}${effect ? `${effect} ` : ""}${body}${meta}${annotations ? `  ${theme.fg("muted", "‹")} ${annotations} ${theme.fg("muted", "›")}` : ""}`;
}

function rowLines(row: ShellVizRow, presentation: ShellVizPresentation, theme: Theme, width: number): string[] {
	return wrapTextWithAnsi(rowText(row, presentation, theme, width), Math.max(1, width));
}

function joinPanes(left: string[], right: string[], width: number, separator: string): string[] {
	const pane = Math.max(1, Math.floor((width - visibleWidth(separator)) / 2));
	return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
		const first = truncateToWidth(left[index] ?? "", pane);
		return truncateToWidth(
			`${first}${" ".repeat(Math.max(0, pane - visibleWidth(first)))}${separator}${right[index] ?? ""}`,
			width,
		);
	});
}

/** Render the canonical presentation; transcript cards and focused inspector share this path. */
export function renderShellVisualization(
	presentation: ShellVizPresentation,
	theme: Theme,
	width: number,
	includeOutput = true,
): string[] {
	width = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	if (presentation.message) lines.push(theme.fg("dim", shellVizText(presentation.message)));
	if (presentation.preferences.split && presentation.preferences.view !== "raw") {
		if (width >= 90) {
			const pane = Math.floor((width - 3) / 2);
			lines.push(
				...joinPanes(
					[
						theme.fg("dim", "Original"),
						...presentation.original.flatMap(row => rowLines(row, presentation, theme, pane)),
					],
					[
						theme.fg("dim", "Pseudo"),
						...presentation.rows.flatMap(row => rowLines(row, presentation, theme, pane)),
					],
					width,
					" │ ",
				),
			);
		} else {
			lines.push(
				theme.fg("dim", "Split stacked (terminal too narrow for side-by-side)"),
				theme.fg("dim", "Original"),
			);
			lines.push(
				...presentation.original.flatMap(row => rowLines(row, presentation, theme, width)),
				theme.fg("dim", "Pseudo"),
				...presentation.rows.flatMap(row => rowLines(row, presentation, theme, width)),
			);
		}
	} else lines.push(...presentation.rows.flatMap(row => rowLines(row, presentation, theme, width)));
	if (includeOutput && presentation.output) {
		lines.push(
			theme.fg("dim", "Output"),
			...presentation.output
				.trimEnd()
				.split("\n")
				.flatMap(line => wrapTextWithAnsi(shellVizText(line), width)),
		);
	}
	if (presentation.timeline.trimmed)
		lines.push(theme.fg("warning", "Replay history/output trimmed to retained limits"));
	return lines.map(line => truncateToWidth(line, width));
}
