/**
 * `tool-command`: a tool command invoked inside a bash run.
 *
 * `--help` is one status row (`✔ srv/tool: --help`); a mounted tool with
 * row-drawing hooks draws its own rows; anything else is the wrapped tool's
 * look (the generic card for tools without one). The same rows appear as a
 * nested card inside the bash frame ({@link toolCommandRows}).
 *
 * Reads {@link ToolCommandTerm} (on the `tool` node, or on the nested
 * `omp.tool.bash.command-tool` column).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { ToolCommandTerm } from "../../tools/tool-command";
import { defaultCardRows, tint } from "./default";
import { legacyPartRows } from "./legacy";
import { statusGlyph, statusIcon, statusLine } from "./frame";
import { defineToolLook, isExpanded, toolLook, toolProps } from "./look";

/** The `--help` row. */
function helpRow(cx: PaintContext, term: ToolCommandTerm, width: number): string {
	const theme = cx.theme;
	const line = statusLine(theme, {
		glyph: statusIcon(cx, term.exitCode === 0 ? "success" : "error"),
		title: term.commandLabel,
		description: theme.fg("dim", "--help"),
	});
	return truncate(line, width);
}

/** A nested tool command card inside a shell run, at `width`. */
export function toolCommandRows(node: UiNode, cx: PaintContext, width: number, expanded: boolean): string[] {
	const term = (node.props() as { term?: ToolCommandTerm & { tone?: string } }).term;
	if (!term) return [];
	if (term.mode === "help") return [helpRow(cx, term, width)];
	if (term.mode === "legacy") return legacyPartRows(cx, term.parts ?? [], width);
	const inner = term.inner && term.inner !== "default" ? toolLook(term.inner) : undefined;
	// The wrapped tool's look at the nested card's width (getters keep reading the paint environment).
	if (inner)
		return [...inner.paint(node, Object.create(cx, { width: { value: Math.max(1, width), enumerable: true } })).rows];
	const failed = term.exitCode !== 0;
	return defaultCardRows(
		cx.theme,
		{
			glyph: statusIcon(cx, failed ? "error" : "success"),
			title: term.commandLabel,
			tint: failed ? "toolErrorBg" : "toolSuccessBg",
			args: term.args,
			expanded,
			body: node.children().slice(1),
		},
		width,
	);
}

function paintToolCommand(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as ToolCommandTerm | undefined;
	if (!term) return { rows: [] };
	if (term.mode === "help") return { rows: [helpRow(cx, term, cx.width)] };
	if (term.mode === "legacy") return { rows: legacyPartRows(cx, term.parts ?? [], cx.width) };
	const inner = term.inner && term.inner !== "default" ? toolLook(term.inner) : undefined;
	if (inner) return inner.paint(node, cx);
	return {
		rows: defaultCardRows(
			cx.theme,
			{
				glyph: statusGlyph(node, cx),
				title: styledText(cx.theme, props.title),
				tint: tint(props),
				args: term.args,
				expanded: isExpanded(props),
				body: node.children(),
			},
			cx.width,
		),
	};
}

defineToolLook("tool-command", { paint: paintToolCommand });
