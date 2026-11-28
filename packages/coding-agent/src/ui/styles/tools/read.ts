/**
 * `read`: a file read. Pending: one status row (`⏳ Read: src/a.ts:40-50`).
 * Settled: a code cell headed `✔ Read <path>` (numbered from the read's
 * first line when the tool reported it; 12 rows collapsed) with the
 * resolved path and truncation warnings in its `Output` section; Markdown
 * as a rendered cell; images as a `Details` frame; errors as an
 * error-tinted frame over the message.
 *
 * Reads {@link ReadTerm} (and the `md` child of a Markdown read).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { displayLines } from "@oh-my-pi/pi-tui/text/sanitize";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ReadTerm } from "../../tools/read";
import { codeCellRows, markdownCellRows } from "./code-cell";
import { fileLink } from "./file-common";
import { bracketed, frameInner, frameRows, outcomeBg, statusIcon, statusLine } from "./frame";
import { defineToolLook, isExpanded, toolProps } from "./look";

function paintRead(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as Partial<ReadTerm> | undefined;
	const theme = cx.theme;
	const width = cx.width;
	const phase = term?.phase ?? "call";
	const link = term?.link;
	const shown = term?.display ?? "";
	// The path (not its selector) links to the file the read resolved to.
	const display =
		link && link.length > 0
			? `${fileLink(cx, shown.slice(0, link.length), link.path, link.line)}${shown.slice(link.length)}`
			: shown;
	if (phase === "call") {
		return {
			rows: wrap(
				statusLine(theme, { glyph: statusIcon(cx, "pending"), title: "Read", description: display || "…" }),
				width,
			),
		};
	}
	if (phase === "error") {
		return {
			rows: frameRows(theme, width, {
				head: statusLine(theme, { glyph: statusIcon(cx, "error"), title: display ? `Read ${display}` : "Read" }),
				sections: [{ lines: displayLines(term?.error ?? "").map(line => theme.fg("error", line)) }],
				border: "error",
				bg: outcomeBg("error"),
			}),
		};
	}
	const correction = term?.correctedFrom ? ` ${theme.fg("dim", `(corrected from ${term.correctedFrom})`)}` : "";
	const warnings = (term?.warnings ?? []).map(warning =>
		theme.fg(warning.color, bracketed(theme, replaceTabs(sanitizeText(warning.text)))),
	);
	const expanded = isExpanded(props);
	if (phase === "image") {
		const details = term?.content ? displayLines(term.content).map(line => theme.fg("toolOutput", line)) : [];
		const lines = [...details, ...warnings];
		return {
			rows: frameRows(theme, width, {
				head: statusLine(theme, {
					glyph: statusIcon(cx, term?.correctedFrom ? "warning" : "success"),
					title: "Read",
					description: `${display}${correction}`,
				}),
				sections: [
					{
						label: theme.fg("toolTitle", "Details"),
						lines: lines.length > 0 ? lines : [theme.fg("dim", "(image)")],
					},
				],
				border: "dim",
				bg: outcomeBg("success"),
			}),
		};
	}
	let title = display ? `Read ${display}${correction}` : "Read";
	if (term?.summarySpans !== undefined)
		title += ` (summary: ${term.summarySpans} elided span${term.summarySpans === 1 ? "" : "s"})`;
	if (term?.conflicts)
		title += ` ${theme.fg("warning", `(${theme.symbols.symbol("status.warning")} ${term.conflicts} conflict${term.conflicts === 1 ? "" : "s"})`)}`;
	const output = warnings.length > 0 ? warnings.join("\n") : undefined;
	if (phase === "markdown") {
		const md = node.children().find(child => child.kind === "md");
		const rendered = md && (term?.content ?? "").trim() ? cx.paint(md, Math.max(20, frameInner(width))).rows : [];
		return {
			rows: markdownCellRows(
				cx,
				{ title, status: "complete", expanded, rendered, ...(output ? { output } : {}) },
				width,
			),
		};
	}
	return {
		rows: codeCellRows(
			cx,
			{
				code: term?.content ?? "",
				...(term?.language ? { language: term.language } : {}),
				title,
				status: "complete",
				...(output ? { output } : {}),
				expanded,
				...(term?.startLine !== undefined ? { codeStartLine: term.startLine } : {}),
				...(term?.lineNumbers ? { codeLineNumbers: term.lineNumbers } : {}),
			},
			width,
		),
	};
}

defineToolLook("read", { paint: paintRead, margin: true });
