/**
 * Render a code or markdown cell with optional output section.
 */
import { Markdown } from "../components/markdown";
import { getMarkdownTheme, highlightCode, type Theme } from "../theme/theme";
import { formatDuration, formatExpandHint, formatMoreItems, formatStatusIcon, replaceTabs } from "./render-utils";
import { outputBlockContentWidth, renderOutputBlock } from "./output-block";
import { formatOutputPaneLines, splitTerminalOutputLines, styleToolOutputLine } from "./output-pane";
import type { State } from "./types";

/** Content and display limits for a code preview with optional output. */
export interface CodeCellOptions {
	code: string;
	language?: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	codeMaxLines?: number;
	/**
	 * Show the LAST `codeMaxLines` rows (the live streaming edge) instead of the
	 * first, with a "… N earlier lines" marker on top. Lets a pending preview
	 * follow code as it is written while staying bounded. Ignored when `expanded`.
	 */
	codeTail?: boolean;
	expanded?: boolean;
	/**
	 * Prefix the header with the cell's language icon (resolved through the
	 * active symbol preset: nerd-font devicon, unicode emoji, or ascii
	 * shorthand). Opt-in so only the eval kernel renderer labels each cell;
	 * read/write/browser code cells stay icon-free.
	 */
	showLanguage?: boolean;
	width: number;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
}

function getState(status?: CodeCellOptions["status"]): State | undefined {
	if (!status) return undefined;
	if (status === "complete") return "success";
	if (status === "error") return "error";
	if (status === "warning") return "warning";
	if (status === "running") return "running";
	return "pending";
}

function formatHeader(options: CodeCellOptions, theme: Theme): { title: string; meta?: string } {
	const { index, total, title, status, spinnerFrame, duration, language, showLanguage } = options;
	const parts: string[] = [];
	if (showLanguage && language) {
		const langIcon = theme.getLangIconStyled(language);
		if (langIcon) parts.push(langIcon);
	}
	if (status) {
		const icon = formatStatusIcon(
			status === "complete"
				? "done"
				: status === "error"
					? "error"
					: status === "warning"
						? "warning"
						: status === "running"
							? "running"
							: "pending",
			theme,
			spinnerFrame,
		);
		if (status === "pending" || status === "running") {
			parts.push(`${icon} ${theme.fg("muted", status)}`);
		} else {
			parts.push(icon);
		}
	}
	if (index !== undefined && total !== undefined && total > 1) {
		parts.push(theme.fg("accent", `[${index + 1}/${total}]`));
	}
	if (title) {
		parts.push(theme.fg("toolTitle", title));
	}
	const headerTitle = parts.length > 0 ? parts.join(" ") : theme.fg("toolTitle", "Code");

	const metaParts: string[] = [];
	if (duration !== undefined) {
		metaParts.push(theme.fg("dim", `(${formatDuration(duration)})`));
	}
	if (metaParts.length === 0) return { title: headerTitle };
	return { title: headerTitle, meta: metaParts.join(theme.fg("dim", theme.sep.dot)) };
}

function renderCellOutput(
	output: string | undefined,
	expanded: boolean,
	outputMaxLines: number,
	theme: Theme,
): readonly string[] {
	if (!output?.trim()) return [];
	return formatOutputPaneLines(
		{
			lines: splitTerminalOutputLines(output),
			expanded,
			collapsedMaxLines: outputMaxLines,
			edge: "head",
			styleLine: line => styleToolOutputLine(line, theme),
			formatHidden: hidden => formatMoreItems(hidden, "line"),
		},
		theme,
	).lines;
}

/** Render a syntax-highlighted code preview and its optional output block. */
export function renderCodeCell(options: CodeCellOptions, theme: Theme): string[] {
	const {
		code,
		language,
		output,
		expanded = false,
		outputMaxLines = 6,
		codeMaxLines = 12,
		width,
		codeStartLine,
		codeLineNumbers,
	} = options;
	const { title, meta } = formatHeader(options, theme);
	const state = getState(options.status);

	const normalizedCode = replaceTabs(code ?? "");
	const rawCodeLines = splitTerminalOutputLines(normalizedCode);
	const maxCodeLines = expanded ? rawCodeLines.length : Math.min(rawCodeLines.length, codeMaxLines);
	const hiddenCodeLines = rawCodeLines.length - maxCodeLines;
	const tail = options.codeTail === true && !expanded && hiddenCodeLines > 0;
	const startIndex = tail ? rawCodeLines.length - maxCodeLines : 0;
	const visibleCode = rawCodeLines.slice(startIndex, startIndex + maxCodeLines).join("\n");
	const codeLines = highlightCode(visibleCode, language);

	let visibleLineNumbers: Array<number | null> | undefined;
	let lineNumberWidth = 0;
	if (codeLineNumbers) {
		visibleLineNumbers = codeLineNumbers.slice(startIndex, startIndex + maxCodeLines);
	} else if (codeStartLine !== undefined) {
		visibleLineNumbers = Array.from({ length: maxCodeLines }, (_, i) => codeStartLine + startIndex + i);
	}

	if (visibleLineNumbers) {
		const validLineNums = visibleLineNumbers.filter((n): n is number => n !== null && n !== undefined);
		const maxVal = validLineNums.length > 0 ? Math.max(...validLineNums) : 0;
		if (maxVal > 0) {
			lineNumberWidth = Math.max(2, String(maxVal).length);
		}
	}

	if (lineNumberWidth > 0 && visibleLineNumbers) {
		for (let i = 0; i < codeLines.length; i++) {
			const lineNum = visibleLineNumbers[i];
			const gutter =
				lineNum !== null && lineNum !== undefined
					? String(lineNum).padStart(lineNumberWidth, " ")
					: " ".repeat(lineNumberWidth);
			codeLines[i] = theme.fg("dim", `${gutter} `) + codeLines[i];
		}
	}

	if (hiddenCodeLines > 0) {
		const hint = formatExpandHint(theme, expanded, hiddenCodeLines > 0);
		const gutterPad = lineNumberWidth > 0 ? " ".repeat(lineNumberWidth + 1) : "";
		if (tail) {
			// Earlier rows scrolled above the live tail window — mark them on top so
			// the newest streamed line stays pinned to the bottom of the box.
			const earlier = `… ${hiddenCodeLines} earlier line${hiddenCodeLines === 1 ? "" : "s"}${hint ? ` ${hint}` : ""}`;
			codeLines.unshift(theme.fg("dim", gutterPad + earlier));
		} else {
			const moreLine = `${formatMoreItems(hiddenCodeLines, "line")}${hint ? ` ${hint}` : ""}`;
			codeLines.push(theme.fg("dim", gutterPad + moreLine));
		}
	}

	const outputLines = renderCellOutput(output, expanded, outputMaxLines, theme);

	const sections: Array<{ label?: string; lines: readonly string[] }> = [{ lines: codeLines }];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: outputLines });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}

/** Content and display limits for a Markdown preview with optional output. */
export interface MarkdownCellOptions {
	content: string;
	index?: number;
	total?: number;
	title?: string;
	status?: "pending" | "running" | "warning" | "complete" | "error";
	spinnerFrame?: number;
	duration?: number;
	output?: string;
	outputMaxLines?: number;
	contentMaxLines?: number;
	expanded?: boolean;
	width: number;
}

/** Render a Markdown preview and its optional output block. */
export function renderMarkdownCell(options: MarkdownCellOptions, theme: Theme): string[] {
	const { content, output, expanded = false, outputMaxLines = 6, contentMaxLines = 12, width } = options;
	const codeOptions: CodeCellOptions = {
		code: "",
		index: options.index,
		total: options.total,
		title: options.title,
		status: options.status,
		spinnerFrame: options.spinnerFrame,
		duration: options.duration,
		width,
	};
	const { title, meta } = formatHeader(codeOptions, theme);
	const state = getState(options.status);

	// Markdown component manages its own wrapping at the same inner width as
	// `renderOutputBlock`, so collapsed row caps are applied after final wrapping.
	const innerWidth = Math.max(20, outputBlockContentWidth(width));
	const allLines = content.trim() ? new Markdown(content, 0, 0, getMarkdownTheme()).render(innerWidth) : [];
	const maxContentLines = expanded ? allLines.length : Math.min(allLines.length, contentMaxLines);
	const contentLines = allLines.slice(0, maxContentLines);
	const hiddenContentLines = allLines.length - maxContentLines;
	if (hiddenContentLines > 0) {
		const hint = formatExpandHint(theme, expanded, hiddenContentLines > 0);
		const moreLine = `${formatMoreItems(hiddenContentLines, "line")}${hint ? ` ${hint}` : ""}`;
		contentLines.push(theme.fg("dim", moreLine));
	}

	const outputLines = renderCellOutput(output, expanded, outputMaxLines, theme);

	const sections: Array<{ label?: string; lines: readonly string[] }> = [{ lines: contentLines }];
	if (outputLines.length > 0) {
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: outputLines });
	}

	return renderOutputBlock({ header: title, headerMeta: meta, state, sections, width }, theme);
}
