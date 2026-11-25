/**
 * The `lsp` look: `💡 LSP: hover a.ts:3 (retry)` (a spinner while a result
 * streams, `⏳` for the pending call), then per answer: diagnostics as a
 * branch tree (`🟦 src/a.ts:1:1 [error] message`, the message on its own row
 * when expanded), hover as the highlighted signature with its docs (collapsed:
 * the first line and `… N more lines`), other answers as a tree of lines.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { highlightCode, supportsLanguage } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { LspDiagnostic, LspLocationFile, LspTerm } from "../../tools/lsp";
import { expandHint, spinnerGlyph } from "./frame";
import { defineToolLook, toolProps } from "./look";
import { moreItem, pathText, type TreeItem, treeRows } from "./search";

/** Diagnostics and answer lines listed while collapsed. */
const COLLAPSED_DIAGNOSTICS = 3;
const COLLAPSED_LINES = 4;
/** Location files, and locations per file, listed while collapsed. */
const COLLAPSED_FILES = 3;
const COLLAPSED_LOCATIONS = 2;

const SEVERITY_COLOR: Readonly<Record<string, string>> = {
	error: "error",
	warning: "warning",
	info: "accent",
	hint: "muted",
};

function diagnosticItem(theme: Theme, diagnostic: LspDiagnostic, expanded: boolean): TreeItem {
	const at = /^(.*?)((?::\d+){1,2})$/.exec(diagnostic.location);
	const file = at ? at[1]! : diagnostic.location;
	const position = at ? at[2]! : "";
	const icon = theme.fg("muted", theme.symbols.langIcon(languageFromPath(file)));
	const severity = theme.fg(SEVERITY_COLOR[diagnostic.severity] ?? "muted", `[${diagnostic.severity}]`);
	const head = `${icon} ${pathText(theme, file)}${theme.fg("muted", position)} ${severity}`;
	const message = theme.fg("muted", replaceTabs(diagnostic.message));
	return expanded ? [head, message] : [`${head} ${message}`];
}

/** Hover markdown as rows: docs muted, the fenced signature highlighted. */
function hoverRows(theme: Theme, markdown: string): { readonly rows: string[]; readonly first: string } {
	const fence = /```(\w*)\n([\s\S]*?)```/.exec(markdown);
	const docs = (doc: string) => (doc ? doc.split("\n").map(line => theme.fg("muted", replaceTabs(line))) : []);
	if (!fence) {
		const rows = docs(markdown.trim());
		return { rows, first: rows[0] ?? "" };
	}
	const code = highlightCode(replaceTabs(fence[2]!.trim()), fence[1] || undefined, theme);
	const before = markdown.slice(0, fence.index).trim();
	const after = markdown.slice(fence.index + fence[0].length).trim();
	const rows = [...docs(before), ...code, ...docs(after)];
	return { rows, first: code[0] ?? rows[0] ?? "" };
}

function paintLsp(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? { look: "lsp", description: "" }) as LspTerm;
	const theme = cx.theme;
	const expanded = props.collapsed === false;
	let glyph: string;
	if (!term.result) glyph = theme.fg("muted", theme.symbols.symbol("status.pending"));
	else if (props.status === "running") glyph = spinnerGlyph(cx);
	else if (term.error !== undefined || props.tone === "error")
		glyph = theme.fg("error", theme.symbols.symbol("status.error"));
	else if (term.empty || props.tone === "warning") glyph = theme.fg("warning", theme.symbols.symbol("status.warning"));
	else glyph = theme.fg("accent", theme.symbols.symbol("tool.lsp"));
	let head = `${glyph} ${theme.fg("accent", "LSP")}: ${theme.fg("muted", replaceTabs(term.description ?? ""))}`;
	if (term.newName !== undefined) head += ` ${theme.fg("dim", `new:${replaceTabs(term.newName)}`)}`;
	if (term.facts && term.facts.length > 0) head += ` ${theme.fg("dim", term.facts.join(" · "))}`;
	let body: string[] = [];
	if (term.error !== undefined) {
		body = term.error.split("\n").flatMap(line => wrap(`  ${theme.fg("error", replaceTabs(line))}`, cx.width));
	} else if (term.diagnostics) {
		const all = term.diagnostics;
		const shown = expanded || all.length <= COLLAPSED_DIAGNOSTICS ? all : all.slice(0, COLLAPSED_DIAGNOSTICS);
		const items = shown.map(diagnostic => diagnosticItem(theme, diagnostic, expanded));
		if (shown.length < all.length) items.push(moreItem(theme, all.length - shown.length, "diagnostics"));
		body = treeRows(theme, items, cx.width);
	} else if (term.locations && term.locations.length > 0) {
		const files = term.locations;
		const shown = expanded ? files : files.slice(0, COLLAPSED_FILES);
		const clamp = (file: LspLocationFile) =>
			expanded ? file.locations : file.locations.slice(0, COLLAPSED_LOCATIONS);
		const hidden = files.length > shown.length || shown.some(file => clamp(file).length < file.locations.length);
		if (hidden) head += expandHint(theme);
		let labelWidth = 0;
		for (const file of shown)
			for (const location of clamp(file))
				labelWidth = Math.max(labelWidth, `${location.line}:${location.column}`.length);
		const items: TreeItem[] = shown.map(file => {
			const locations = clamp(file);
			const lang = languageFromPath(file.path);
			const rows = [`${pathText(theme, file.path)} ${theme.fg("dim", `(${file.locations.length})`)}`];
			locations.forEach((location, i) => {
				const last = i === locations.length - 1;
				const branch = theme.fg("dim", theme.symbols.symbol(last ? "tree.last" : "tree.branch"));
				const trunk = last ? "   " : `${theme.fg("dim", theme.symbols.symbol("tree.vertical"))}  `;
				const label = theme.fg("muted", `${`${location.line}:${location.column}`.padStart(labelWidth)}│`);
				const code = replaceTabs(location.text.trim());
				const text =
					lang && supportsLanguage(lang) ? highlightCode(code, lang, theme)[0]! : theme.fg("muted", code);
				// Expanded, a long line wraps under its branch; collapsed, the tree cuts it.
				const parts = expanded ? wrap(`${label} ${text}`, Math.max(1, cx.width - 6)) : [`${label} ${text}`];
				parts.forEach((part, k) => rows.push(k === 0 ? `${branch} ${part}` : `${trunk}${part}`));
			});
			return rows;
		});
		if (shown.length < files.length) {
			const more = files.length - shown.length;
			items.push(moreItem(theme, more, more === 1 ? "file" : "files"));
		}
		body = treeRows(theme, items, cx.width, theme.symbols.ellipsis);
	} else if (term.hover !== undefined) {
		const hover = hoverRows(theme, term.hover);
		const hidden = hover.rows.length - 1;
		if (!expanded && hidden > 0) {
			head += expandHint(theme);
			body = [
				hover.first,
				theme.fg("muted", `${theme.symbols.ellipsis} ${hidden} more ${hidden === 1 ? "line" : "lines"}`),
			];
		} else body = hover.rows;
		body = body.flatMap(row => wrap(row, cx.width));
	} else if (term.lines) {
		const all = term.lines;
		const shown = expanded || all.length <= COLLAPSED_LINES ? all : all.slice(0, COLLAPSED_LINES);
		// Expanded, a long line hang-wraps under its branch; collapsed, the tree cuts it.
		const items: TreeItem[] = shown.map(line => {
			const text = theme.fg("muted", replaceTabs(line));
			const parts = expanded ? wrap(text, Math.max(1, cx.width - 3)) : [];
			return parts.length > 0 ? parts : [text];
		});
		if (shown.length < all.length) items.push(moreItem(theme, all.length - shown.length, "lines"));
		body = treeRows(theme, items, cx.width);
	}
	return { rows: [...wrap(head, cx.width), ...body] };
}

defineToolLook("lsp", { paint: paintLsp, margin: true });
