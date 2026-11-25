/**
 * The hook prompts in the terminal: a box titled with the prompt (its title
 * on one line, a countdown in parentheses), the field between blank rows,
 * and the dim key hints.
 *
 * - hook input: `> ` and the one-line field (scrolled to keep the caret);
 * - hook editor: the text in a rounded composer box, or after `> ` in the
 *   prompt style.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { inputLine } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspEditorProps, TspInputProps } from "@oh-my-pi/pi-wire";
import { type ComposerChromeContext, composerShape } from "../composer/shapes";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { keyLabel } from "../../keys/hints";
import { bindingGlyph, boxRows, findNode, keyLabels, propsOf, termOf } from "./common";
import { appExternalEditorKeys, appFollowUpKeys, appInterruptKeys } from "../../../config/keybindings/matchers";

/** The interrupt key (`app.interrupt`) as hint glyphs. */
function interruptGlyph(theme: Theme): string {
	return keyLabel(theme, appInterruptKeys()[0] ?? "escape");
}

defineRolePainter("col", "omp.overlay.hook-input", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 6) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	const input = findNode(node, child => child.kind === "input");
	const props = input ? propsOf<TspInputProps>(input) : {};
	const text = props.text ?? "";
	const field = `> ${inputLine(text, props.cursor ?? text.length, inner - 2, "")}`;
	const hints = theme.fg(
		"dim",
		`${bindingGlyph("tui.input.submit", "enter", theme)} submit  ${interruptGlyph(theme)} cancel`,
	);
	const title = termOf<{ title: string }>(node).title ?? "";
	return { rows: boxRows(theme, title, ["", field, "", ...wrap(hints, inner), ""], cx.width) };
});

/**
 * The editor's text rows (with a thin caret unless the terminal draws its
 * own), `visible` of them around the caret's row. A line wider than the
 * field wraps without its indentation.
 */
function editorRows(editor: UiNode | undefined, width: number, caret: boolean, visible: number): string[] {
	if (!editor) return [""];
	const props = propsOf<TspEditorProps>(editor);
	const text = props.text ?? "";
	const cursor = Math.min(props.cursor ?? text.length, text.length);
	const marked = `${text.slice(0, cursor)}\u0000${text.slice(cursor)}`;
	const rows: string[] = [];
	for (const line of marked.split("\n")) {
		if (line === "") rows.push("");
		else if (visibleWidth(line.replace("\u0000", "▏")) <= width) rows.push(line);
		else rows.push(...wrap(line.trimStart(), width));
	}
	const at = Math.max(
		0,
		rows.findIndex(row => row.includes("\u0000")),
	);
	const start = Math.max(0, Math.min(rows.length - visible, at));
	return rows.slice(start, start + visible).map(row => row.replace("\u0000", caret ? "▏" : ""));
}

defineRolePainter("col", "omp.overlay.hook-editor", (node, cx): Block => {
	const theme = cx.theme;
	if (cx.width < 8) return EMPTY_BLOCK;
	const inner = cx.width - 4;
	const term = termOf<{ title: string; detail?: string; prompt: boolean; caret: boolean }>(node);
	const editor = findNode(node, child => child.kind === "editor");
	// The field's chrome takes two of its rows.
	const maxLines = Math.max(1, (editor ? (propsOf<TspEditorProps>(editor).maxLines ?? 18) : 18) - 2);
	const content: string[] = [""];
	if (term.detail) content.push(...term.detail.split("\n").flatMap(line => wrap(theme.fg("accent", line), inner)), "");
	if (term.prompt) {
		const rows = editorRows(editor, inner - 2, term.caret !== false, maxLines);
		rows.forEach((row, i) => content.push(`${i === 0 ? "> " : "  "}${theme.fgResolved("text", row)}`));
	} else {
		const shape = composerShape("box");
		const paddingX = shape.paddingX;
		const side = shape.sideWidth(paddingX);
		const contentWidth = Math.max(1, inner - 2 * side);
		const chrome: ComposerChromeContext = {
			width: inner,
			paddingX,
			theme,
			border: text => theme.fg("borderMuted", text),
			accent: text => theme.fg("accent", text),
			surface: text => text,
			box: theme.symbols.box,
		};
		const top = shape.top?.(chrome);
		if (top !== undefined) content.push(top);
		const rows = editorRows(editor, contentWidth, term.caret !== false, maxLines);
		rows.forEach((plain, i) => {
			const text = theme.fgResolved("text", plain);
			const width = visibleWidth(plain);
			content.push(
				...shape.row({
					...chrome,
					text,
					pad: " ".repeat(Math.max(0, contentWidth - width)),
					gutter: "",
					first: i === 0,
					last: i === rows.length - 1,
					overflow: 0,
				}),
			);
		});
	}
	const cancel = term.prompt ? keyLabel(theme, "escape") : interruptGlyph(theme);
	const tail = `${cancel} cancel  ${keyLabel(theme, appExternalEditorKeys()[0] ?? "ctrl+g")} external editor`;
	const followUp = appFollowUpKeys();
	const hint = term.prompt
		? `${keyLabel(theme, "enter")} or ${keyLabel(theme, followUp[0]!)} submit  ${tail}`
		: `${keyLabels(theme, followUp)} submit  ${tail}`;
	content.push("", ...wrap(theme.fg("dim", hint), inner), "");
	return { rows: boxRows(theme, term.title ?? "", content, cx.width) };
});
