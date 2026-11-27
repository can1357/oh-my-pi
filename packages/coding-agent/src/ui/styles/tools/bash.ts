/**
 * `bash`: a shell call as one rounded frame.
 *
 * The command (dim `$ cd … && ENV=…` prefix, highlighted command) on top,
 * an `Output` section with the output's tail, and the facts in the bottom
 * edge: the live clock while running, then wall time / timeout, job and
 * service state, exit code. A call still waiting is tinted and accent-ruled;
 * a settled run is ruled by its outcome.
 *
 * Reads the run box (`code#input`, `ansi#output`) and {@link BashTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { ansiLines } from "@oh-my-pi/pi-tui/term/painters/ansi";
import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { ShellVizPresentation } from "@oh-my-pi/pi-wire";
import { lazyText, type RenderedText } from "@oh-my-pi/pi-tui/term/text-layout";
import { mapPrefixed, RowText } from "../rendered-text";
import type { BashStat, BashTerm } from "../../tools/bash";
import { resultPictures, withoutDrawnPlaceholders } from "./file-common";
import {
	bracketed,
	capLines,
	frameInner,
	frameBlock,
	PREVIEW_WINDOW_ROWS,
	runningMs,
	type StatusLine,
	statusIcon,
	statusLine,
	tailBlock,
} from "./frame";
import { defineToolLook, isExpanded, toolProps } from "./look";
import { shellVizRows } from "./shell-viz";
import { toolCommandRows } from "./tool-command";

/** A child of `node` by key, searched depth-first. */
export function findChild(node: UiNode, key: string): UiNode | undefined {
	for (const child of node.children()) {
		if (child.key() === key) return child;
		const nested = findChild(child, key);
		if (nested) return nested;
	}
	return undefined;
}

/** The text prop of a node. */
export function nodeText(node: UiNode | undefined): string {
	return ((node?.props() as { text?: string } | undefined)?.text ?? "") as string;
}

/** `1.5s`, `4s`: a clock reading (whole seconds above a second). */
function clockText(ms: number): string {
	if (ms < 1000) return `${Math.floor(ms)}ms`;
	if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
	const mins = Math.floor(ms / 60_000);
	const secs = Math.floor((ms % 60_000) / 1000);
	return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}

/** Command rows: the dim `$ prefix` ahead of the highlighted first line. */
export function commandLines(theme: Theme, command: string, prefix: string, lang = "bash"): string[] {
	const lead = theme.fg("dim", prefix ? `$ ${prefix} ` : "$ ");
	const lines = highlightCode(command, lang, theme);
	if (lines.length === 0) return [lead.trimEnd()];
	return lines.map((line, i) => (i === 0 ? `${lead}${line}` : line));
}

function statText(theme: Theme, stat: BashStat): string {
	const icon = stat.icon ? (stat.icon.includes(".") ? theme.symbols.symbol(stat.icon) : stat.icon) : "";
	const text = icon ? `${icon}${stat.iconSeparator ?? " "}${stat.text}` : stat.text;
	return theme.fg(stat.color ?? "dim", text);
}

function paintBash(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? {}) as Partial<BashTerm>;
	const theme = cx.theme;
	const width = cx.width;
	const expanded = isExpanded(props);
	const input = findChild(node, "input");
	const commandPrefix = term.prefix ?? "";
	let lines: string[];
	// The command's text past the `$ prefix` lead, when the rows are its lines one to one.
	let commandText: (() => RenderedText) | undefined;
	if (input?.kind === "shell") {
		// The engine's reading of the command; its working directory and env lead on their own row.
		const presentation = (input.props() as { presentation: ShellVizPresentation }).presentation;
		lines = [
			...(commandPrefix ? [theme.fg("dim", `$ ${commandPrefix} `)] : []),
			...shellVizRows(presentation, theme, frameInner(width), false),
		];
	} else {
		const command = nodeText(input);
		const body =
			commandPrefix && command.startsWith(`${commandPrefix} `) ? command.slice(commandPrefix.length + 1) : command;
		const shown = commandLines(theme, body, commandPrefix);
		lines = shown;
		commandText = lazyText(() => mapPrefixed(body, shown, commandPrefix ? `$ ${commandPrefix} ` : "$ ", ""));
	}
	const capped = !expanded && lines.length > PREVIEW_WINDOW_ROWS;
	const inputRows = capped ? capLines(theme, lines, PREVIEW_WINDOW_ROWS) : lines;
	const inputSection = { lines: inputRows, ...(capped || !commandText ? {} : { text: commandText }) };
	const outcome = term.outcome;
	const title = typeof props.title === "string" ? props.title : "";
	let header: string | undefined;
	if (term.header) {
		const glyph = !term.result
			? statusIcon(cx, cx.reduceMotion ? "pending" : "running")
			: outcome === "success"
				? theme.fg("accent", theme.symbols.symbol("tool.bash"))
				: statusIcon(cx, outcome === "running" ? "pending" : outcome === "warning" ? "warning" : "error");
		const line: StatusLine = { glyph, title, ...(term.intent ? { description: term.intent } : {}) };
		header = statusLine(theme, line);
	} else if (term.intent) header = statusLine(theme, { title: term.intent, titleColor: "muted" });

	if (!term.result) {
		// A call sealed while running keeps the time it ran.
		const elapsed =
			props.status === "running" ? runningMs(props, cx) : props.status === "cancelled" ? props.took : undefined;
		const foot =
			elapsed === undefined || elapsed < 1000
				? undefined
				: theme.fg("dim", `elapsed ${clockText(Math.floor(elapsed / 1000) * 1000)}`);
		return frameBlock(theme, width, {
			head: header,
			sections: [inputSection],
			foot,
			border: "accent",
			bg: "toolPendingBg",
		});
	}

	const run = node.children()[0];
	const cards = new RowText();
	for (const child of run?.children() ?? []) {
		if ((child.props() as { role?: string }).role !== "omp.tool.bash.command-tool") continue;
		cards.block(toolCommandRows(child, cx, frameInner(width), expanded));
	}
	// Images the block draws as pictures under the card leave their placeholders out of the output.
	const printed = nodeText(findChild(node, "output"));
	const output = withoutDrawnPlaceholders(printed, props.term?.imageLinks, resultPictures(node, cx).length);
	const outputLines = output.trim().length > 0 ? ansiLines(output).map(line => theme.fg("toolOutput", line)) : [];
	const limit = Math.min(term.previewLines ?? PREVIEW_WINDOW_ROWS, PREVIEW_WINDOW_ROWS);
	const shown = tailBlock(theme, outputLines, expanded ? Number.POSITIVE_INFINITY : limit, frameInner(width));
	if (term.warning) shown.literal(theme.fg("warning", bracketed(theme, term.warning)));
	const stats = (term.stats ?? []).map(stat => statText(theme, stat));
	if (term.liveClock) {
		const seconds = Math.floor(runningMs(props, cx) / 1000);
		if (seconds > 0)
			stats.unshift(theme.fg("dim", `${theme.symbols.symbol("icon.time")} ${clockText(seconds * 1000)}`));
	}
	const border =
		outcome === "error" ? "error" : outcome === "warning" ? "warning" : outcome === "running" ? "accent" : "dim";
	return frameBlock(theme, width, {
		head: header,
		sections: [
			inputSection,
			...(cards.length > 0 ? [{ lines: cards.rows, text: cards.text() }] : []),
			...((term.sole || printed.trim().length > 0) && shown.length === 0
				? []
				: [{ label: theme.fg("toolTitle", "Output"), lines: shown.rows, text: shown.text() }]),
		],
		foot: stats.length > 0 ? stats.join(theme.fg("dim", theme.symbols.symbol("sep.dot"))) : undefined,
		border,
	});
}

defineToolLook("bash", { paint: paintBash, margin: true });
