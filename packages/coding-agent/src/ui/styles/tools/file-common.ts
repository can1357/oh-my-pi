/**
 * Pieces the write and edit looks share: the LSP diagnostics tree, the
 * numbered code preview (gutter rows wrap under their code), file paths and
 * the OSC 8 links every tool look draws on them, and which result images a
 * card draws as pictures.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { terminalIdentity } from "@oh-my-pi/pi-tui/driver/session";
import { type PaintContext, roleOf } from "@oh-my-pi/pi-tui/term/paint";
import { hyperlink } from "@oh-my-pi/pi-tui/text/osc";
import { visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { diagnosticOrder, type FileDiagnostics, type ParsedDiagnostic, parseDiagnostic } from "../../tools/file-common";
import { fileUriForTerminal } from "../../../utils/file-links";
import { imageLinkTarget, RESULT_IMAGE_ROLE } from "../../transcript/image-links";
import { expandHint } from "./frame";

/** Diagnostics shown while collapsed. */
const COLLAPSED_DIAGNOSTICS = 5;
/** Color of a file's name in tool bodies. */
const FILE_NAME_COLOR = "customMessageLabel";

/**
 * `text` linked (OSC 8) to `filePath`, at `line` when given, on a terminal
 * that draws links: the terminal's file-link form (`vscode://file/…:line` in
 * VS Code, a configured `PI_LINK_SCHEME` handler, else `file://`). Plain text
 * otherwise, and when the path cannot be encoded.
 */
export function fileLink(
	cx: Pick<PaintContext, "hyperlinks">,
	text: string,
	filePath: string | undefined,
	line?: number,
): string {
	if (!cx.hyperlinks || !filePath || !text) return text;
	const uri = fileUriForTerminal(filePath, line === undefined ? undefined : { line }, terminalIdentity().id);
	return uri ? hyperlink(text, uri) : text;
}

/**
 * An image's placeholder `text` linked (OSC 8) to the file the image opens:
 * `source` when it was read from one, else a blob copy of the bytes
 * registered as `blob` (written only on a terminal that draws links).
 */
export function imageLink(
	cx: Pick<PaintContext, "hyperlinks">,
	text: string,
	blob: string | undefined,
	source?: string,
): string {
	return cx.hyperlinks ? fileLink(cx, text, imageLinkTarget(blob, source)) : text;
}

/**
 * The result images the tool block draws as pictures under the card: those it
 * appended to `node` (present while images are on), on a terminal that draws
 * images. A look shows a placeholder only for an image not drawn.
 */
export function resultPictures(node: UiNode, cx: Pick<PaintContext, "images">): UiNode[] {
	if (!cx.images) return [];
	return node.children().filter(child => child.kind === "image" && roleOf(child) === RESULT_IMAGE_ROLE);
}

/** `text` without the placeholder lines of the first `drawn` images (`placeholders` in result order), each its last occurrence. */
export function withoutDrawnPlaceholders(
	text: string,
	placeholders: readonly { readonly text: string }[] | undefined,
	drawn: number,
): string {
	if (drawn === 0 || !placeholders) return text;
	const lines = text.split("\n");
	for (let i = Math.min(drawn, placeholders.length) - 1; i >= 0; i--) {
		const at = lines.lastIndexOf(placeholders[i]!.text);
		if (at >= 0) lines.splice(at, 1);
	}
	return lines.join("\n");
}

/** `text` linked (OSC 8) to `uri` on a terminal that draws links. */
export function uriLink(cx: Pick<PaintContext, "hyperlinks">, text: string, uri: string | undefined): string {
	return cx.hyperlinks && uri && text ? hyperlink(text, uri) : text;
}

/** `text` linked (OSC 8) to an HTTP(S) `url` (`www.` inputs as `https://`) on a terminal that draws links. */
export function webLink(cx: Pick<PaintContext, "hyperlinks">, text: string, url: string | undefined): string {
	if (!cx.hyperlinks || !url || !text) return text;
	try {
		const parsed = new URL(/^www\./i.test(url) ? `https://${url}` : url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? hyperlink(text, parsed.href) : text;
	} catch {
		return text;
	}
}

/** `dir/` dim, `name` in the file-name color. */
export function styledPath(theme: Theme, filePath: string): string {
	let end = filePath.length;
	while (end > 0 && (filePath[end - 1] === "/" || filePath[end - 1] === "\\")) end--;
	const cut = Math.max(filePath.lastIndexOf("/", end - 1), filePath.lastIndexOf("\\", end - 1)) + 1;
	const name = theme.fg(FILE_NAME_COLOR, filePath.slice(cut));
	return cut > 0 ? `${theme.fg("dim", filePath.slice(0, cut))}${name}` : name;
}

/**
 * The diagnostics tree: `✘ Diagnostics (summary)`, then per file `└─ icon
 * path` with its diagnostics (`✘:11:20 message (code)`) on branches, five
 * while collapsed and a `… N more ⟦⌃O: Expand⟧` row.
 */
export function diagnosticsRows(
	theme: Theme,
	diag: FileDiagnostics,
	expanded: boolean,
	langIcon: (filePath: string) => string,
	title = "Diagnostics",
): string[] {
	if (diag.messages.length === 0) return [];
	const tree = theme.symbols;
	const branchGlyph = tree.symbol("tree.branch");
	const lastGlyph = tree.symbol("tree.last");
	const vertical = tree.symbol("tree.vertical");
	const byFile = new Map<string, ParsedDiagnostic[]>();
	const unparsed: string[] = [];
	for (const message of diag.messages) {
		const parsed = parseDiagnostic(message);
		if (!parsed) {
			unparsed.push(message.replaceAll("\t", "   "));
			continue;
		}
		const list = byFile.get(parsed.filePath) ?? [];
		list.push(parsed);
		byFile.set(parsed.filePath, list);
	}
	for (const list of byFile.values()) list.sort((a, b) => diagnosticOrder(a, b) || a.message.localeCompare(b.message));
	const icon = diag.errored
		? theme.fg("error", tree.symbol("status.error"))
		: theme.fg("warning", tree.symbol("status.warning"));
	const summary = diag.summary.replaceAll("\t", "   ");
	const rows = [`${icon} ${theme.fg("toolTitle", title)}${summary ? ` ${theme.fg("dim", `(${summary})`)}` : ""}`];
	const max = expanded ? diag.messages.length : COLLAPSED_DIAGNOSTICS;
	const files = [...byFile.entries()];
	const total = files.reduce((sum, [, list]) => sum + list.length, 0) + unparsed.length;
	let shown = 0;
	const treeEnd = (fileIdx: number, diagIdx: number | null, unparsedIdx: number | null): boolean => {
		if (total > shown + 1) return false;
		if (unparsedIdx !== null) return unparsedIdx === unparsed.length - 1;
		if (diagIdx === null) return false;
		return diagIdx === files[fileIdx]![1].length - 1 && fileIdx === files.length - 1 && unparsed.length === 0;
	};
	for (let fi = 0; fi < files.length && shown < max; fi++) {
		const [filePath, list] = files[fi]!;
		const after = files.slice(fi + 1).reduce((sum, [, d]) => sum + d.length, 0) + unparsed.length;
		const lastFile = fi === files.length - 1 && unparsed.length === 0 && shown + list.length + after <= max;
		rows.push(
			` ${theme.fg("dim", lastFile ? lastGlyph : branchGlyph)} ${theme.fg("muted", langIcon(filePath))} ${styledPath(theme, filePath)}`,
		);
		for (let di = 0; di < list.length && shown < max; di++) {
			const d = list[di]!;
			const lastVisible = di === list.length - 1 || shown + 1 >= max;
			const veryLast = treeEnd(fi, di, null);
			const glyph = lastVisible || veryLast ? lastGlyph : branchGlyph;
			const branch = lastFile ? `  ${glyph}` : `${vertical} ${glyph}`;
			const sev =
				d.severity === "error"
					? theme.fg("error", tree.symbol("status.error"))
					: d.severity === "warning"
						? theme.fg("warning", tree.symbol("status.warning"))
						: theme.fg("muted", tree.symbol("status.info"));
			const color = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "toolOutput";
			const code = d.code ? theme.fg("dim", ` (${d.code})`) : "";
			rows.push(
				` ${theme.fg("dim", branch)} ${sev}${theme.fg("muted", `:${d.line}:${d.col}`)} ${theme.fg(color, d.message)}${code}`,
			);
			shown++;
		}
	}
	for (let ui = 0; ui < unparsed.length && shown < max; ui++) {
		const message = unparsed[ui]!;
		const glyph = treeEnd(-1, null, ui) ? lastGlyph : branchGlyph;
		const color = message.includes("[error]") ? "error" : message.includes("[warning]") ? "warning" : "dim";
		rows.push(` ${theme.fg("dim", glyph)} ${theme.fg(color, message)}`);
		shown++;
	}
	if (total > shown)
		rows.push(` ${theme.fg("dim", lastGlyph)} ${theme.fg("muted", `… ${total - shown} more`)} ${expandHint(theme)}`);
	return rows;
}

/** The diagnostics report a section node carries for the terminal. */
export function sectionDiagnostics(node: UiNode): FileDiagnostics | undefined {
	return (node.props() as { term?: { diagnostics?: FileDiagnostics } }).term?.diagnostics;
}

/** A numbered code row: the dim gutter (`  1 `) then the code. */
export function gutterRow(theme: Theme, number: number, gutterWidth: number, code: string): string {
	return `${theme.fg("dim", `${String(number).padStart(gutterWidth, " ")} `)}${code}`;
}

/** A numbered row wrapped to `width`, continuation rows indented under the code. */
export function wrapGutterRow(
	theme: Theme,
	number: number,
	gutterWidth: number,
	code: string,
	width: number,
): string[] {
	const gutter = theme.fg("dim", `${String(number).padStart(gutterWidth, " ")} `);
	const indent = gutterWidth + 1;
	if (width <= indent) return wrap(`${gutter}${code}`, width);
	return wrap(code, width - indent).map((row, index) =>
		index === 0 ? `${gutter}${row}` : `${" ".repeat(indent)}${row}`,
	);
}

/** Rows of `text` wrapped to `width` (blank lines kept). */
export function wrapLines(lines: readonly string[], width: number): string[] {
	const rows: string[] = [];
	for (const line of lines) {
		if (visibleWidth(line) === 0) rows.push(line);
		else rows.push(...wrap(line, width));
	}
	return rows;
}
