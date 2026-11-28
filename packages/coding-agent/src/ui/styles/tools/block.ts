/**
 * The transcript's tool block (`tool` nodes with role `omp.tool.*`): what
 * every tool shares around its look.
 *
 * - Hidden activity paints nothing (handled by the paint cache).
 * - An extension presenter's compact line (`term.compact`): the status glyph
 *   and the label, then the presenter's rows; a bare one says what runs.
 * - A concise row (`display.toolActivity: concise`): the Agent Hub's
 *   recent-activity row (clock, status, tool, intent) and the elapsed time.
 * - A viewport allocation (the transcript paints the block at a fixed
 *   height): 3 or more rows keep the look's head (through its title row)
 *   above its newest rows, 2 rows open a frame edge with the title, 1 row is
 *   the status line, 0 rows nothing.
 * - Otherwise the tool's look, set off by a blank row above and below when
 *   the look is framed.
 * - Under the look, the result's images where the terminal draws images
 *   (while images are on), each after a blank row; the look leaves their
 *   placeholders out.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { anchoredRise } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { coveredCells, hasGraphics } from "@oh-my-pi/pi-tui/driver/output/ansi";
import { type Block, defineRolePainter, EMPTY_BLOCK, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { spinnerIndex } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { imageLabel, paintImage } from "@oh-my-pi/pi-tui/term/painters/image";
import { terminalPaddingX } from "../terminal-padding";
import { tint, tintRow } from "./default";
import { imageLink, resultPictures } from "./file-common";
import { bodySpans, paintPresenterRows } from "../figures/presented";
import { type HubRecentLine, recentActivityRow } from "../pickers/agent-hub";
import { lookFor, type ToolProps, toolProps } from "./look";

/** `cx` with some fields replaced (its getters keep reading the paint environment). */
function withContext(
	cx: PaintContext,
	fields: {
		readonly width?: number;
		readonly height?: number;
		readonly reduceMotion?: boolean;
		readonly spinnerInterval?: number;
	},
): PaintContext {
	const descriptors: PropertyDescriptorMap = {};
	for (const key in fields)
		descriptors[key] = {
			value: fields[key as keyof typeof fields],
			enumerable: true,
		};
	return Object.create(cx, descriptors) as PaintContext;
}

/** The look of `node` without the transcript's margins (a `tools/<name>` view). */
export function paintToolLook(node: UiNode, cx: PaintContext): Block {
	return linkImagePlaceholders(node, cx, withPictures(node, cx, lookFor(node).paint(node, cx)));
}

/** `block` with the result images it draws as pictures under it (placeholder text where one cannot be drawn). */
function withPictures(node: UiNode, cx: PaintContext, block: Block): Block {
	const pictures = resultPictures(node, cx);
	if (pictures.length === 0) return block;
	const links = toolProps(node).term?.imageLinks;
	const rows = [...block.rows];
	pictures.forEach((picture, i) => {
		const text = links?.[i]?.text;
		const label = text ? cx.theme.fg("toolOutput", text) : imageLabel(picture, cx);
		rows.push("", ...paintImage(picture, cx, label).rows);
	});
	return { ...block, rows };
}

/** The compact summary text: bold label, muted ` · detail`, dim live seconds while running. */
function compactText(props: ToolProps, cx: PaintContext): string {
	const theme = cx.theme;
	const term = props.term;
	const label = term?.activity?.label ?? styledText(theme, props.title);
	const detail = term?.activity?.detail ? oneLine(term.activity.detail) : "";
	let text = theme.style("toolTitle strong", oneLine(label));
	if (detail) text += theme.fg("muted", ` · ${detail}`);
	if (term?.running && term.startedAt !== undefined)
		text += theme.fg("dim", ` ${Math.max(0, Math.floor((cx.now() - term.startedAt) / 1000))}s`);
	return truncate(text, Math.max(1, cx.width - 4));
}

/** The compact row's lead glyph: the muted spinner while running, else a dim bullet. */
function compactGlyph(node: UiNode, props: ToolProps, cx: PaintContext, allocated = false): string {
	const theme = cx.theme;
	// A viewport allocation's row spins while the call runs. A presenter's compact row: a view that
	// says whether it spins decides, else running animated looks spin.
	const spins = allocated
		? props.term?.running === true
		: (props.term?.spinning ?? (props.term?.running === true && lookFor(node).animated === true));
	if (!spins || cx.spinnerInterval === 0) return theme.fg("dim", "•");
	const frames = theme.symbols.spinnerFrames;
	return theme.fg("muted", frames[spinnerIndex(cx, frames.length)] ?? "•");
}

function oneLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/\x1b\[[0-9;]*m/g, "");
}

/** The block at a fixed number of rows (the transcript's viewport allocation). */
function paintAllocated(node: UiNode, cx: PaintContext, rows: number): Block {
	if (rows <= 0) return EMPTY_BLOCK;
	// The look's own rows when they fit (margins dropped), else its head over its newest rows, else the compact rows.
	const own = paintLook(node, withContext(cx, { height: undefined }));
	if (own.rows.length > 0 && own.rows.length <= rows) return own;
	const cut = rows >= 3 ? headAndTail(own, rows) : undefined;
	if (cut) return cut;
	const props = toolProps(node);
	const theme = cx.theme;
	const text = compactText(props, cx);
	if (rows === 1)
		return {
			rows: [truncate(`${compactGlyph(node, props, cx, true)} ${text}`, cx.width)],
		};
	return {
		rows: [truncate(`${theme.fg("dim", "╭─")} ${text}`, cx.width), theme.fg("dim", "╰")],
	};
}

/**
 * A concise row: the recent-activity row, then how long the call has run (whole seconds, ticking)
 * or ran, when the transcript saw it run.
 */
function paintConcise(props: ToolProps, line: HubRecentLine, cx: PaintContext): Block {
	const term = props.term;
	const elapsed =
		term?.running && term.startedAt !== undefined
			? `${Math.max(0, Math.floor((cx.now() - term.startedAt) / 1000))}s`
			: props.took !== undefined
				? formatDuration(props.took)
				: undefined;
	const tail = elapsed ? cx.theme.fg("dim", ` ${elapsed}`) : "";
	const row = recentActivityRow(cx.theme, line, Math.max(1, cx.width - visibleWidth(tail)));
	return { rows: cx.height === 0 ? [] : [truncate(`${row}${tail}`, cx.width)] };
}

/**
 * `block` cut to `rows` rows: its heading (the look's `heading` rows, else
 * through its first non-blank row: a framed look's titled edge) over the
 * newest rows that fit. An image is kept whole or dropped: its draw rides on
 * its last row and moves up over the reserved rows above it (`anchoredRise`,
 * which a look's tint or indent does not hide), so a cut image would paint
 * over the rows above it; older rows fill the room a dropped image leaves.
 * Rows that draw nothing (blank rows, a pending or demoted image's reserved
 * rows, tinted or not, the separator above a dropped image) spend no room,
 * but a row under a scaled (OSC 66) glyph above it is that glyph's and stays.
 * Hits are clipped to the rows kept; a cursor in a dropped row goes.
 * Undefined when the heading leaves no room or no row fits.
 */
function headAndTail(block: Block, rows: number): Block | undefined {
	const total = block.rows.length;
	const head = block.heading ?? block.rows.findIndex(row => Bun.stripANSI(row).trim().length > 0) + 1;
	if (head <= 0 || head >= rows) return undefined;
	// Newest first, one row or one whole image at a time.
	const tail: number[] = [];
	let room = rows - head;
	for (let end = total; end > head && room > 0;) {
		const row = block.rows[end - 1]!;
		const start = end - 1 - anchoredRise(row);
		const drawsNothing =
			!hasGraphics(row) && Bun.stripANSI(row).trim().length === 0 && coveredCells(block.rows, end - 1) === 0;
		if (!drawsNothing && start >= head && end - start <= room) {
			for (let source = end - 1; source >= start; source--) tail.push(source);
			room -= end - start;
		}
		end = start;
	}
	if (tail.length === 0) return undefined;
	tail.reverse();
	// Where each source row lands; -1 when dropped.
	const to = new Int32Array(total).fill(-1);
	for (let source = 0; source < head; source++) to[source] = source;
	tail.forEach((source, at) => {
		to[source] = head + at;
	});
	const hits = block.hits?.flatMap(hit => {
		const kept: Hit[] = [];
		for (let source = hit.row; source < hit.row + hit.height; source++) {
			const row = to[source] ?? -1;
			if (row < 0) continue;
			const last = kept.at(-1);
			if (last && last.row + last.height === row) kept[kept.length - 1] = { ...last, height: last.height + 1 };
			else kept.push({ ...hit, row, height: 1 });
		}
		return kept;
	});
	const cursorRow = block.cursor ? (to[block.cursor.row] ?? -1) : -1;
	return {
		rows: [...block.rows.slice(0, head), ...tail.map(source => block.rows[source]!)],
		...(hits && hits.length > 0 ? { hits } : {}),
		...(block.cursor && cursorRow >= 0 ? { cursor: { row: cursorRow, col: block.cursor.col } } : {}),
	};
}

/** An extension presenter's compact presentation: glyph and label (or the summary), then its rows. */
function paintCompact(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const line = props.term?.activityLine;
	if (props.term?.compact === "concise" && line) return paintConcise(props, line, cx);
	const glyph = compactGlyph(node, props, cx);
	const withLabel = props.term?.compact === "label";
	const shown = withLabel ? styledText(cx.theme, props.target) : compactText(props, cx);
	const rows = [truncate(`${glyph} ${shown}`, cx.width)];
	if (withLabel) rows.push(...paintPresenterRows(bodySpans(node), cx));
	const limit = cx.height;
	return {
		rows: limit === undefined ? rows : rows.slice(0, Math.max(0, limit)),
	};
}

function paintToolBlock(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	if (props.term?.compact) return paintCompact(node, cx);
	if (cx.height !== undefined) return paintAllocated(node, cx, cx.height);
	const block = paintLook(node, cx);
	// A view may override its look's margins (`term.margin`).
	if (!(props.term?.margin ?? lookFor(node).margin) || block.rows.length === 0) return block;
	return {
		...block,
		rows: ["", ...block.rows, ""],
		...(block.hits ? { hits: block.hits.map(hit => ({ ...hit, row: hit.row + 1 })) } : {}),
		...(block.cursor ? { cursor: { row: block.cursor.row + 1, col: block.cursor.col } } : {}),
	};
}

/**
 * `block` with the result's image placeholders linked to their images (on a
 * terminal that draws links): each placeholder, in order, at its first
 * occurrence at or below the previous one.
 */
function linkImagePlaceholders(node: UiNode, cx: PaintContext, block: Block): Block {
	const links = toolProps(node).term?.imageLinks;
	if (!cx.hyperlinks || !links || links.length === 0) return block;
	const rows = [...block.rows];
	let row = 0;
	for (const link of links) {
		for (let index = row; index < rows.length; index++) {
			const at = rows[index]!.indexOf(link.text);
			if (at < 0) continue;
			const text = rows[index]!;
			rows[index] =
				text.slice(0, at) + imageLink(cx, link.text, link.blob, link.source) + text.slice(at + link.text.length);
			row = index + 1;
			break;
		}
	}
	return { ...block, rows };
}

/** The look's rows (a boxed look in its tinted box), without margins; image placeholders linked. */
function paintLook(node: UiNode, cx: PaintContext): Block {
	return linkImagePlaceholders(node, cx, withPictures(node, cx, paintLookRows(node, cx)));
}

function paintLookRows(node: UiNode, cx: PaintContext): Block {
	const look = lookFor(node);
	// A look that does not animate draws its still frame in the transcript (its spinner never ticks there).
	const still = look.animated || look.clocked ? cx : withContext(cx, { reduceMotion: true, spinnerInterval: 0 });
	if (look.boxed) {
		const inner = look.paint(node, withContext(still, { width: Math.max(1, cx.width - 2) }));
		if (inner.rows.length === 0) return EMPTY_BLOCK;
		const key = tint(toolProps(node));
		const rows = ["", ...inner.rows.map(row => ` ${row}`), ""].map(row => tintRow(cx.theme, key, row, cx.width));
		return { rows, ...(inner.heading === undefined ? {} : { heading: inner.heading + 1 }) };
	}
	const paddingX = look.inset ? terminalPaddingX() : 0;
	if (paddingX > 0) {
		const pad = " ".repeat(paddingX);
		const inner = look.paint(node, withContext(still, { width: Math.max(1, cx.width - paddingX) }));
		return {
			...inner,
			rows: inner.rows.map(row => (row === "" ? row : pad + row)),
			...(inner.hits ? { hits: inner.hits.map(hit => ({ ...hit, col: hit.col + paddingX })) } : {}),
			...(inner.cursor ? { cursor: { row: inner.cursor.row, col: inner.cursor.col + paddingX } } : {}),
		};
	}
	return look.paint(node, still);
}

defineRolePainter("tool", "omp.tool", paintToolBlock, { prefix: true });
