/**
 * The git diff pane in the terminal: the document in its view mode (split
 * columns with word emphasis and faint fillers, stacked inline rows, hunk
 * blocks under `@@` headers with stage/unstage/discard pills, the plain new
 * file), the cursor band and shift selection, and a two-column minimap at the
 * right edge (change density, the viewport brightened). Placeholder states
 * center a dim message; a streaming file shows its arrived lines side by
 * side; a media/binary change compares its two sides.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter, type PaintImages } from "@oh-my-pi/pi-tui/term/paint";
import { renderSpans } from "@oh-my-pi/pi-tui/text/highlight";
import { sliceCells, spaces, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { mixHex } from "@oh-my-pi/pi-utils/color";
import type { DiffDocument } from "../../../../cli/git-tui/model/diff-pane";
import type { FileAssetSide } from "../../../../cli/git-tui/model/state";
import {
	type DiffPaneModel,
	type HeaderHit,
	MINIMAP_COLUMNS,
	type Visual,
	type VisualKind,
	visualKind,
} from "../../../apps/git/diff-pane-model";
import type { DiffRow } from "../../../apps/git/document";
import { bgHex, canvasHex, fgHex, pill, selectionBg, withBg } from "./colors";

const RESET = "\x1b[0m";

interface Palette {
	readonly addSoft: string;
	readonly addStrong: string;
	readonly delSoft: string;
	readonly delStrong: string;
	readonly fillAdd: string;
	readonly fillDel: string;
	readonly mapAdd: string;
	readonly mapDel: string;
	readonly mapChange: string;
	readonly mapContext: string;
	readonly mapHunk: string;
	readonly text: string;
}

const kPalette = Symbol("omp.git.diff-palette");

interface PaletteHolder {
	[kPalette]?: Palette;
}

function paletteOf(theme: Theme): Palette {
	const cached = (theme as PaletteHolder)[kPalette];
	if (cached) return cached;
	const added = theme.hex("toolDiffAdded");
	const removed = theme.hex("toolDiffRemoved");
	const canvas = canvasHex(theme);
	const text = theme.hex("text");
	const tint = (hex: string, dark: number, light: number): string =>
		bgHex(mixHex(canvas, hex, theme.dark ? dark : light));
	const palette: Palette = {
		addSoft: tint(added, 0.18, 0.24),
		addStrong: tint(added, 0.42, 0.48),
		delSoft: tint(removed, 0.18, 0.24),
		delStrong: tint(removed, 0.42, 0.48),
		fillAdd: bgHex(mixHex(canvas, added, 0.07)),
		fillDel: bgHex(mixHex(canvas, removed, 0.07)),
		mapAdd: added,
		mapDel: removed,
		mapChange: mixHex(added, removed, 0.5),
		mapContext: mixHex(canvas, text, 0.2),
		mapHunk: theme.hex("accent"),
		text,
	};
	(theme as PaletteHolder)[kPalette] = palette;
	return palette;
}

/** `text` centered in `width` cells (unchanged when wider). */
export function centered(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth >= width) return text;
	const left = Math.floor((width - textWidth) / 2);
	return `${spaces(left)}${text}${spaces(width - textWidth - left)}`;
}

/** `width` cells of `text` from column `start`, padded (a wide character at the end stays whole). */
function window(text: string, start: number, width: number): string {
	const slice = sliceCells(text, start, width, false);
	return `${slice.text}${spaces(width - slice.width)}`;
}

function messageRows(theme: Theme, message: string, width: number, height: number): string[] {
	return Array.from({ length: height }, (_, row) =>
		row === Math.floor(height / 2)
			? truncate(centered(theme.fg("dim", message), width).trimEnd(), width, theme.symbols.ellipsis)
			: "",
	);
}

/** The text a row shows on `side` (`both` prefers the new side), highlighted when ready. */
function shownText(model: DiffPaneModel, theme: Theme, row: DiffRow, side: "old" | "new" | "both"): string {
	const actual = side === "old" || (side === "both" && row.newNum === undefined) ? "old" : "new";
	const number = actual === "old" ? row.oldNum : row.newNum;
	const plain = actual === "old" ? row.oldText : row.newText;
	const spans = number === undefined ? undefined : model.highlights?.[actual][number - 1];
	return spans ? renderSpans(spans, theme) : plain;
}

/** A changed line on its soft tint with the changed words on the strong one. */
function marked(
	text: string,
	marks: readonly (readonly [number, number])[],
	textWidth: number,
	soft: string,
	strong: string,
	start: number,
): string {
	const end = start + textWidth;
	let at = start;
	let out = "";
	let used = 0;
	const emit = (from: number, to: number, bg: string): void => {
		if (to <= from) return;
		const slice = sliceCells(text, from, to - from, false);
		out += `${withBg(slice.text, bg)}${RESET}`;
		used += slice.width;
	};
	for (const [markStart, markEnd] of marks) {
		if (markEnd <= at) continue;
		if (markStart >= end) break;
		emit(at, Math.min(markStart, end), soft);
		emit(Math.max(markStart, at), Math.min(markEnd, end), strong);
		at = Math.min(markEnd, end);
	}
	emit(at, end, soft);
	if (used < textWidth) out += `${soft}${spaces(textWidth - used)}${RESET}`;
	return out;
}

function changedBody(
	text: string,
	marks: readonly (readonly [number, number])[] | undefined,
	emphasize: boolean,
	textWidth: number,
	soft: string,
	strong: string,
	start: number,
): string {
	const inner =
		emphasize && marks && marks.length > 0
			? marked(text, marks, textWidth, soft, strong, start)
			: window(text, start, textWidth);
	return `${withBg(` ${inner} `, soft)}${RESET}`;
}

function splitSide(
	model: DiffPaneModel,
	theme: Theme,
	colors: Palette,
	row: DiffRow,
	side: "old" | "new",
	gutter: number,
	textWidth: number,
	start: number,
	first: boolean,
): string {
	const num = side === "old" ? row.oldNum : row.newNum;
	const changed = row.kind === "change" || (side === "old" ? row.kind === "del" : row.kind === "add");
	let label = spaces(gutter);
	if (num !== undefined && first) {
		const text = String(num).padStart(gutter);
		label = changed
			? `${fgHex(side === "old" ? colors.mapDel : colors.mapAdd)}${text}${RESET}`
			: theme.fg("dim", text);
	}
	if (num === undefined) {
		const tinted = row.kind === "add" || row.kind === "del";
		const fill = spaces(textWidth + 2);
		return `${label}${tinted ? `${side === "old" ? colors.fillDel : colors.fillAdd}${fill}${RESET}` : fill}`;
	}
	const text = shownText(model, theme, row, side);
	if (!changed) return `${label} ${window(text, start, textWidth)} `;
	const soft = side === "old" ? colors.delSoft : colors.addSoft;
	const strong = side === "old" ? colors.delStrong : colors.addStrong;
	return `${label}${changedBody(text, side === "old" ? row.oldMarks : row.newMarks, true, textWidth, soft, strong, start)}`;
}

function stackedLine(
	model: DiffPaneModel,
	theme: Theme,
	colors: Palette,
	doc: DiffDocument,
	visual: Extract<Visual, { t: "line" }>,
	width: number,
): string {
	const { row, side, seg } = visual;
	const gutter = doc.gutterWidth;
	const textWidth = model.lineTextWidth(width);
	const start = model.wrap ? seg * textWidth : model.scrollLeft;
	const first = seg === 0;
	const oldLabel =
		first && row.oldNum !== undefined && side !== "new" ? String(row.oldNum).padStart(gutter) : spaces(gutter);
	const newLabel =
		first && row.newNum !== undefined && side !== "old" ? String(row.newNum).padStart(gutter) : spaces(gutter);
	const isDel = side === "old" && row.kind !== "context";
	const isAdd = side === "new" && row.kind !== "context";
	const label = isDel
		? `${fgHex(colors.mapDel)}${oldLabel}${spaces(gutter + 1)}${RESET}`
		: isAdd
			? `${spaces(gutter)}${fgHex(colors.mapAdd)}${newLabel}${RESET} `
			: theme.fg("dim", `${oldLabel}${newLabel} `);
	const text = shownText(model, theme, row, side);
	if (!isDel && !isAdd) return `${label} ${window(text, start, textWidth)} `;
	const soft = isDel ? colors.delSoft : colors.addSoft;
	const strong = isDel ? colors.delStrong : colors.addStrong;
	const marks = side === "old" ? row.oldMarks : row.newMarks;
	return `${label}${changedBody(text, marks, row.kind === "change", textWidth, soft, strong, start)}`;
}

function hunkHeader(
	model: DiffPaneModel,
	theme: Theme,
	doc: DiffDocument,
	index: number,
	width: number,
	screenRow: number,
): string {
	const hunk = doc.hunks[index]!;
	const selected = model.mode === "hunk" && index === model.selectedHunk;
	const header = selected ? theme.fg("accent", theme.style("strong", hunk.header)) : theme.fg("accent", hunk.header);
	const lead = selected ? theme.fg("accent", "▶ ") : "";
	const target = model.patchTarget;
	if (!target || !doc.canPatch) {
		model.recordHit(screenRow, { hunk: index });
		return truncate(`${lead}${header}`, width - MINIMAP_COLUMNS, theme.symbols.ellipsis);
	}
	const primary =
		target === "stage"
			? pill(theme, " Stage Hunk ", theme.hex("toolDiffAdded"))
			: pill(theme, " Unstage Hunk ", theme.hex("warning"));
	const discard = target === "stage" ? pill(theme, " Discard Hunk ", theme.hex("toolDiffRemoved")) : "";
	const total = visibleWidth(primary) + (discard ? visibleWidth(discard) + 1 : 0);
	const from = Math.max(0, width - MINIMAP_COLUMNS - total);
	let at = from;
	let buttons = "";
	const hit: { hunk: number; primary?: [number, number]; discard?: [number, number] } = { hunk: index };
	if (discard) {
		hit.discard = [at, at + visibleWidth(discard)];
		buttons += `${discard} `;
		at += visibleWidth(discard) + 1;
	}
	hit.primary = [at, at + visibleWidth(primary)];
	buttons += primary;
	model.recordHit(screenRow, hit as HeaderHit);
	const pad = Math.max(1, from - visibleWidth(hunk.header) - (selected ? 2 : 0));
	return truncate(`${lead}${header}${spaces(pad)}${buttons}`, width - MINIMAP_COLUMNS, theme.symbols.ellipsis);
}

function visualText(
	model: DiffPaneModel,
	theme: Theme,
	colors: Palette,
	doc: DiffDocument,
	visual: Visual,
	width: number,
	screenRow: number,
): string {
	switch (visual.t) {
		case "blank":
			return spaces(width - MINIMAP_COLUMNS);
		case "header":
			return hunkHeader(model, theme, doc, visual.hunk, width, screenRow);
		case "split": {
			const textWidth = model.splitTextWidth(width);
			const start = model.wrap ? visual.seg * textWidth : model.scrollLeft;
			const first = visual.seg === 0;
			const left = splitSide(model, theme, colors, visual.row, "old", doc.gutterWidth, textWidth, start, first);
			const right = splitSide(model, theme, colors, visual.row, "new", doc.gutterWidth, textWidth, start, first);
			return `${left}${theme.fg("borderMuted", "│")}${right}`;
		}
		case "line":
			return stackedLine(model, theme, colors, doc, visual, width);
		case "file": {
			const gutter = doc.gutterWidth;
			const textWidth = model.fileTextWidth(width);
			const start = model.wrap ? visual.seg * textWidth : model.scrollLeft;
			const spans = model.highlights?.new[visual.index];
			const text = spans ? renderSpans(spans, theme) : (doc.fileLines[visual.index]?.text ?? "");
			const label = visual.seg === 0 ? theme.fg("dim", String(visual.index + 1).padStart(gutter)) : spaces(gutter);
			return `${label} ${window(text, start, textWidth)}`;
		}
	}
}

/** The minimap column: two bands per row, the densest change class winning; the viewport brightened. */
function minimap(model: DiffPaneModel, colors: Palette, visuals: readonly Visual[], height: number): string[] {
	const total = visuals.length;
	const top = model.scrollTop;
	const bandKind = (band: number): VisualKind => {
		const from = Math.floor((band * total) / (height * 2));
		const to = Math.max(from + 1, Math.floor(((band + 1) * total) / (height * 2)));
		if (from >= total) return null;
		let best: VisualKind = "context";
		for (let i = from; i < Math.min(to, total); i++) {
			const kind = visualKind(visuals[i]!);
			if (kind === "del") return "del";
			if (kind === "add") best = "add";
			else if (kind === "change" && best !== "add") best = "change";
			else if (kind === "hunk" && best === "context") best = "hunk";
		}
		return best;
	};
	const color = (band: number): string | null => {
		const kind = bandKind(band);
		if (kind === null) return null;
		const base =
			kind === "del"
				? colors.mapDel
				: kind === "add"
					? colors.mapAdd
					: kind === "change"
						? colors.mapChange
						: kind === "hunk"
							? colors.mapHunk
							: colors.mapContext;
		const docRow = Math.floor((band * total) / (height * 2));
		return docRow >= top && docRow < top + height ? mixHex(base, colors.text, 0.25) : base;
	};
	return Array.from({ length: height }, (_, row) => {
		const upper = color(row * 2);
		const lower = color(row * 2 + 1);
		if (upper === null && lower === null) return " ";
		return `${fgHex(upper ?? lower ?? "#000000")}${lower ? bgHex(lower) : ""}▀${RESET}`;
	});
}

function documentRows(model: DiffPaneModel, theme: Theme, doc: DiffDocument, width: number, height: number): string[] {
	const visuals = model.layout(width);
	model.clampScroll();
	const colors = paletteOf(theme);
	const map = minimap(model, colors, visuals, height);
	const anchor = model.anchor;
	const cursor = model.cursor;
	const from = anchor === null ? cursor : Math.min(anchor, cursor);
	const to = anchor === null ? cursor : Math.max(anchor, cursor);
	const band = selectionBg(theme, !model.focused);
	const start = Math.max(0, Math.min(model.scrollTop, Math.max(0, visuals.length - height)));
	const rows: string[] = [];
	for (let i = 0; i < height; i++) {
		const visual = visuals[start + i];
		if (!visual) {
			rows.push(`${spaces(width - 1)}${map[i]}`);
			continue;
		}
		const body = visualText(model, theme, colors, doc, visual, width, i);
		let padded = `${body}${spaces(width - MINIMAP_COLUMNS - visibleWidth(body))}`;
		if (start + i >= from && start + i <= to) padded = `${withBg(padded, band)}${RESET}`;
		rows.push(`${padded} ${map[i]}`);
	}
	return rows;
}

function streamingRows(model: DiffPaneModel, theme: Theme, width: number, height: number): string[] {
	const streaming = model.streaming!;
	const total = Math.max(streaming.oldLines.length, streaming.newLines.length);
	if (total === 0) return messageRows(theme, "Streaming file…", width, height);
	model.clampScroll();
	const gutter = Math.max(3, String(total).length);
	const band = selectionBg(theme, !model.focused);
	const start = Math.max(0, Math.min(model.scrollTop, Math.max(0, total - height)));
	const left = model.scrollLeft;
	const rows: string[] = [];
	for (let screenRow = 0; screenRow < height; screenRow++) {
		const index = start + screenRow;
		if (index >= total) {
			rows.push("");
			continue;
		}
		const number = theme.fg("dim", String(index + 1).padStart(gutter));
		let line: string;
		if (model.mode === "file") {
			const text = streaming.newLines[index];
			line = text === undefined ? "" : `${number} ${window(text, left, Math.max(8, width - gutter - 1))}`;
		} else {
			const textWidth = Math.max(8, Math.floor((width - 2 * (gutter + 1) - 1) / 2));
			const side = (text: string | undefined): string =>
				text === undefined ? spaces(gutter + 1 + textWidth) : `${number} ${window(text, left, textWidth)}`;
			line = `${side(streaming.oldLines[index])}${theme.fg("borderMuted", "│")}${side(streaming.newLines[index])}`;
		}
		line = truncate(line, width, theme.symbols.ellipsis);
		if (index === model.cursor) line = `${withBg(`${line}${spaces(width - visibleWidth(line))}`, band)}${RESET}`;
		rows.push(line);
	}
	return rows;
}

/** The heading of one side of a media/binary change (`Before · PNG · Git LFS`). */
export function assetTitle(label: string, side: FileAssetSide): string {
	let kind: string;
	let lfs: boolean;
	switch (side.kind) {
		case "empty":
			return label;
		case "image":
			kind =
				side.image.sourceMimeType === "image/svg+xml"
					? "SVG"
					: side.image.sourceMimeType.replace(/^image\//, "").toUpperCase();
			lfs = side.image.lfsOid !== undefined;
			break;
		case "text":
			kind = "Text";
			lfs = side.lfsOid !== undefined;
			break;
		case "binary":
			kind = "Binary";
			lfs = side.lfsOid !== undefined;
			break;
		case "tooLarge":
			kind = "Too large";
			lfs = side.lfsOid !== undefined;
			break;
		case "lfsMissing":
			kind = "LFS missing";
			lfs = true;
			break;
	}
	return `${label} · ${kind}${lfs ? " · Git LFS" : ""}`;
}

/**
 * What one side of a media/binary change shows (vertically centered by the
 * caller): the picture through the terminal's image protocol (its label when
 * the terminal draws none), else what the object is.
 */
function assetLines(
	theme: Theme,
	side: FileAssetSide,
	placement: string,
	filePath: string,
	width: number,
	height: number,
	images: PaintImages | undefined,
): readonly string[] {
	const dim = (text: string): string => theme.fg("dim", text);
	let details: string[];
	switch (side.kind) {
		case "image": {
			const image = side.image;
			const label = dim(`[Image: ${filePath} [${image.mimeType}] ${image.widthPx}x${image.heightPx}]`);
			if (!images) return [label];
			const source = {
				key: `git-review:${placement}:${filePath}:${image.key}`,
				data: image.data,
				mime: image.mimeType,
				widthPx: image.widthPx,
				heightPx: image.heightPx,
			};
			return images.rows(source, { maxColumns: Math.max(1, width - 2), maxRows: height, fallback: label }).rows;
		}
		case "empty":
			details = ["No file"];
			break;
		case "text":
			details = ["Text object", formatBytes(side.byteLength)];
			break;
		case "binary":
			details = ["Binary object", side.byteLength === undefined ? "Size unavailable" : formatBytes(side.byteLength)];
			break;
		case "tooLarge":
			details = [
				"Object too large to preview",
				side.byteLength === undefined ? "Exceeds preview limit" : formatBytes(side.byteLength),
			];
			break;
		case "lfsMissing":
			details = ["Git LFS object unavailable", `sha256:${side.oid.slice(0, 12)}… · ${formatBytes(side.byteLength)}`];
			break;
	}
	return details.map(detail => centered(dim(detail), width).trimEnd());
}

function assetRows(
	model: DiffPaneModel,
	theme: Theme,
	width: number,
	height: number,
	images: PaintImages | undefined,
): string[] {
	const asset = model.asset!;
	if (height <= 0) return [];
	const leftWidth = Math.max(1, Math.floor((width - 1) / 2));
	const rightWidth = Math.max(1, width - leftWidth - 1);
	const body = Math.max(0, height - 1);
	const side = (value: FileAssetSide, sideWidth: number, placement: string): string[] => {
		const content = body > 0 ? assetLines(theme, value, placement, asset.filePath, sideWidth, body, images) : [];
		const top = Math.max(0, Math.floor((body - content.length) / 2));
		return Array.from({ length: body }, (_, index) => content[index - top] ?? "");
	};
	const oldLines = side(asset.old, leftWidth, "old");
	const newLines = side(asset.new, rightWidth, "new");
	const border = theme.fg("borderMuted", "│");
	const fit = (text: string, sideWidth: number): string => {
		const cut = truncate(text, sideWidth, theme.symbols.ellipsis);
		return `${cut}${spaces(sideWidth - visibleWidth(cut))}`;
	};
	return Array.from({ length: height }, (_, index) => {
		const left =
			index === 0
				? centered(theme.style("strong", assetTitle("Before", asset.old)), leftWidth).trimEnd()
				: oldLines[index - 1]!;
		const right =
			index === 0
				? centered(theme.style("strong", assetTitle("After", asset.new)), rightWidth).trimEnd()
				: newLines[index - 1]!;
		return `${fit(left, leftWidth)}${border}${fit(right, rightWidth)}`;
	});
}

/** The pane's rows at `width` × `height` (records the size and hunk buttons for clicks). */
export function paintDiffPane(
	model: DiffPaneModel,
	theme: Theme,
	width: number,
	height: number,
	images?: PaintImages,
): string[] {
	model.measure(width, height);
	const state = model.state;
	if (state === "streaming" && model.streaming) return streamingRows(model, theme, width, height);
	if (state === "asset" && model.asset) return assetRows(model, theme, width, height, images);
	const doc = model.doc;
	if (!doc || state !== "ready") {
		return messageRows(theme, state === "loading" ? "Loading diff…" : model.emptyMessage, width, height);
	}
	return documentRows(model, theme, doc, width, height);
}

defineRolePainter("diff", "omp.app.git.diff", (node: UiNode, cx) => {
	const pane = (node.props() as { term?: { pane?: DiffPaneModel } }).term?.pane;
	return { rows: pane ? paintDiffPane(pane, cx.theme, cx.width, cx.height ?? 24, cx.images) : [] };
});
