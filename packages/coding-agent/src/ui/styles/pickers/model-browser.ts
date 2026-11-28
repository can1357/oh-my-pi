/**
 * The model list's terminal look, shared by every model screen (the alt+p
 * switcher's sheet, the /models hub's pane, the standalone browser): a
 * search row, a blank, the list window, a blank and two detail rows — a
 * fixed height, so pointer rows stay put.
 *
 * Each row is the cursor, a dim `provider/`, the model id (accent when
 * selected), the current mark and an over-context flag, then right-aligned
 * metric columns sized to the window's widest cell: intelligence and
 * measured speed from 76 cells (time-to-first-token too from 96), context
 * window and price (dropped, price first, when the id would get under 16
 * cells). Over-context rows are dim. The pointer's row gets the selection
 * band. A scrollbar takes the last column when the list overflows.
 *
 * The detail rows: the selection's facts (muted, cut at the width), then the
 * over-context warning or the current mark and the roles it holds.
 *
 * The standalone browser is a `col` with `term.role = "omp.model-browser"`
 * whose `term.browser` is its {@link ModelBrowserState}; its widget routes
 * the pointer (wheel pans, motion hovers, a press selects then activates).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter, type Hit } from "@oh-my-pi/pi-tui/term/paint";
import { scrollbar } from "@oh-my-pi/pi-tui/term/painters/picker";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type {
	DetailView,
	ModelBrowserState,
	ModelBrowserView,
	ModelRowView,
	PerfMode,
} from "../../overlays/pickers/model-browser-state";
import type { ConfiguredThinkingLevel } from "../../../utils/render-utils";
import { caretField } from "./common";

/** Rows above the list window: the search row and a blank. */
export const MODEL_LIST_TOP = 2;
/** Rows under the list window: a blank and two detail rows. */
export const MODEL_DETAIL_ROWS = 3;
/** Row width from which the perf column shows speed. */
const PERF_TPS_MIN_WIDTH = 76;
/** Row width from which it also shows time-to-first-token. */
const PERF_FULL_MIN_WIDTH = 96;
/** Narrowest id cell kept before price, then context, drop. */
const MIN_NAME_WIDTH = 16;

/** Colors that tell ctrl+p segments apart, most preferred first. */
const SEGMENT_COLORS = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

/** Up to `count` segment colors that render distinctly in `theme` (at least `accent`). */
export function segmentPalette(theme: Theme, count: number): string[] {
	const palette: string[] = [];
	const seen = new Set<string>();
	for (const color of SEGMENT_COLORS) {
		const sgr = theme.fgSgr(color);
		if (seen.has(sgr)) continue;
		seen.add(sgr);
		palette.push(color);
		if (palette.length >= count) break;
	}
	return palette;
}

/**
 * A segment track (the ctrl+p cycle, kind and role tabs): position-colored
 * labels split by thin separators, the active one filled as a capped chip.
 */
export function segmentTrack(theme: Theme, labels: readonly string[], active: number): string {
	const symbol = theme.symbols.symbol.bind(theme.symbols);
	const thin = theme.style("statusLineSep", symbol("sep.powerlineThin"));
	const palette = segmentPalette(theme, labels.length);
	let track = "";
	labels.forEach((label, i) => {
		// A thin separator reads cleanly only between two plain labels; the chip's caps delimit it.
		if (i > 0) track += i === active || i - 1 === active ? "  " : ` ${thin} `;
		const color = palette[i % palette.length]!;
		if (i !== active) {
			track += theme.fg(color, label);
			return;
		}
		const fill = theme.fgSgr(color).replace("\x1b[38;", "\x1b[48;");
		const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(theme.hex(color).slice(at, at + 2), 16));
		const contrast = 0.299 * r! + 0.587 * g! + 0.114 * b! > 140 ? "\x1b[38;2;0;0;0m" : "\x1b[38;2;255;255;255m";
		track += `${theme.fg(color, symbol("sep.powerlineRight"))}${fill}${contrast}\x1b[1m ${label} \x1b[22m\x1b[49m\x1b[39m${theme.fg(color, symbol("sep.powerlineLeft"))}`;
	});
	return track;
}

/** Total width of present columns joined by two-space gaps. */
function columnsWidth(widths: readonly number[]): number {
	let total = 0;
	let count = 0;
	for (const width of widths) {
		if (width <= 0) continue;
		total += width;
		count++;
	}
	return count > 0 ? total + 2 * (count - 1) : 0;
}

/** `text` right-aligned in `width` cells. */
function padLeft(text: string, width: number): string {
	const missing = width - visibleWidth(text);
	return missing > 0 ? `${" ".repeat(missing)}${text}` : text;
}

/** The thinking glyph of a role chip in `theme`: ⦸ for off, the level's own (its first word) otherwise. */
export function themeThinkingGlyph(theme: Theme, level: ConfiguredThinkingLevel): string {
	if (level === ThinkingLevel.Inherit) return "";
	if (level === ThinkingLevel.Off) return theme.symbols.symbol("status.disabled");
	const symbol = theme.symbols.symbol(`thinking.${level === "auto" ? "autoPending" : level}`);
	const space = symbol.indexOf(" ");
	return space < 0 ? symbol : symbol.slice(0, space);
}

/** `🧠 71` intelligence cell. */
function intelligenceCell(theme: Theme, row: ModelRowView): string {
	return row.intelligence === undefined ? "" : `${theme.symbols.symbol("icon.intelligence")} ${row.intelligence}`;
}

/** `200k ◫` context cell (the icon trails so right-alignment pins it). */
function contextCell(theme: Theme, row: ModelRowView): string {
	return row.ctx === undefined ? "" : `${row.ctx} ${theme.symbols.symbol("icon.context").replace(/:$/, "")}`;
}

interface Columns {
	readonly intelligence: number;
	readonly perf: number;
	readonly ctx: number;
	readonly cost: number;
	readonly mode: PerfMode;
}

/** Column widths for the window's rows at `width`. */
function windowColumns(theme: Theme, rows: readonly (ModelRowView | null)[], width: number): Columns {
	const mode: PerfMode = width >= PERF_FULL_MIN_WIDTH ? "full" : width >= PERF_TPS_MIN_WIDTH ? "tps" : "off";
	let intelligence = 0;
	let perf = 0;
	let ctx = 0;
	let cost = 0;
	for (const row of rows) {
		if (!row) continue;
		ctx = Math.max(ctx, visibleWidth(contextCell(theme, row)));
		cost = Math.max(cost, visibleWidth(row.cost));
		if (mode !== "off") {
			intelligence = Math.max(intelligence, visibleWidth(intelligenceCell(theme, row)));
			perf = Math.max(perf, visibleWidth(mode === "full" ? row.perf.full : row.perf.tps));
		}
	}
	if (width - 2 - columnsWidth([intelligence, perf, ctx, cost]) < MIN_NAME_WIDTH) cost = 0;
	if (width - 2 - columnsWidth([intelligence, perf, ctx, cost]) < MIN_NAME_WIDTH) ctx = 0;
	return { intelligence, perf, ctx, cost, mode };
}

/** One list row at `width`. */
function modelRow(
	theme: Theme,
	view: ModelBrowserView,
	row: ModelRowView | null,
	columns: Columns,
	width: number,
	state: { selected: boolean; hovered: boolean },
): string {
	if (!row) return `  ${theme.style("muted", "─".repeat(Math.max(0, width - 4)))}  `;
	const symbols = theme.symbols;
	const prefix = state.selected && view.focused ? `${theme.style("accent", symbols.symbol("nav.cursor"))} ` : "  ";
	const provider = view.showProvider && row.displayName === undefined ? theme.style("dim", `${row.provider}/`) : "";
	const label = row.displayName ?? row.id;
	const name = row.labelColor
		? theme.fg(row.labelColor, label)
		: state.selected
			? theme.style("accent", label)
			: label;
	const current = row.current ? ` ${theme.style("success", symbols.symbol("status.enabled"))}` : "";
	const over = row.overContext ? ` ${symbols.symbol("status.disabled")} context>${row.overContext}` : "";
	const cells: string[] = [];
	if (columns.intelligence > 0)
		cells.push(theme.style("dim", padLeft(intelligenceCell(theme, row), columns.intelligence)));
	if (columns.perf > 0)
		cells.push(theme.style("dim", padLeft(columns.mode === "full" ? row.perf.full : row.perf.tps, columns.perf)));
	if (columns.ctx > 0) cells.push(theme.style("dim", padLeft(contextCell(theme, row), columns.ctx)));
	if (columns.cost > 0) cells.push(theme.style("dim", padLeft(row.cost, columns.cost)));
	const used = columnsWidth([columns.intelligence, columns.perf, columns.ctx, columns.cost]);
	const available = Math.max(1, width - used - (cells.length > 0 ? 1 : 0));
	const left = truncate(`${prefix}${provider}${name}${current}${over}`, available, symbols.ellipsis);
	const gap = " ".repeat(Math.max(0, available - visibleWidth(left)));
	let line = cells.length > 0 ? `${left}${gap} ${cells.join("  ")}` : `${left}${gap}`;
	if (row.overContext) {
		// Dim the whole row past the cursor: over-context models stay selectable.
		const plain = Bun.stripANSI(line);
		const lead = Bun.stripANSI(prefix).length;
		line = `${prefix}${theme.style("dim", plain.slice(lead))}`;
	}
	return state.hovered ? theme.bg("selectedBg", line) : line;
}

/** The two detail rows of the selection. */
function detailRows(theme: Theme, detail: DetailView | undefined, width: number): string[] {
	if (!detail) return ["", ""];
	const symbols = theme.symbols;
	const facts = truncate(theme.style("muted", `  ${detail.facts.join(" · ")}`), width, symbols.ellipsis);
	if (detail.overContext) {
		const [session, window] = detail.overContext;
		const warning = `  ${symbols.symbol("status.disabled")} context ${session} exceeds ${window} limit · compacts with current model, then switches`;
		return [facts, truncate(theme.style("warning", warning), width, symbols.ellipsis)];
	}
	const chips: string[] = [];
	if (detail.current) chips.push(theme.style("success", `${symbols.symbol("status.enabled")} current`));
	for (const role of detail.roles) {
		const glyph = themeThinkingGlyph(theme, role.level);
		const suffix = glyph ? ` ${theme.style("dim", glyph)}` : "";
		chips.push(
			role.auto
				? `${theme.style("dim", `${symbols.symbol("status.shadowed")} ${role.label}`)}${suffix}`
				: `${theme.fg(role.color ?? "muted", `${symbols.symbol("status.enabled")} ${role.label}`)}${suffix}`,
		);
	}
	return [
		facts,
		chips.length > 0 ? truncate(`  ${chips.join(theme.style("dim", " · "))}`, width, symbols.ellipsis) : "",
	];
}

/**
 * The browser block at `width`: search row, blank, `maxVisible` list rows,
 * blank, two detail rows.
 */
export function modelBrowserRows(theme: Theme, view: ModelBrowserView, width: number): string[] {
	const symbols = theme.symbols;
	const icon = symbols.symbol("icon.search");
	const field = caretField(theme, "> ", view.query, view.cursor, Math.max(4, width - visibleWidth(icon) - 2));
	const out = [` ${theme.style("accent", icon)} ${field}`, ""];
	if (view.total === 0) {
		out.push(truncate(theme.style("muted", view.empty), width, symbols.ellipsis));
		for (let i = 1; i < view.maxVisible; i++) out.push("");
	} else {
		const rowWidth = width - 1;
		const columns = windowColumns(theme, view.rows, width);
		const rows = view.rows.map((row, i) =>
			modelRow(theme, view, row, columns, rowWidth, {
				selected: view.start + i === view.selected,
				hovered: view.start + i === view.hovered,
			}),
		);
		if (view.total > rows.length) {
			const bar = scrollbar(theme, view.total, view.start, rows.length);
			for (let i = 0; i < rows.length; i++)
				out.push(`${padTo(truncate(rows[i]!, rowWidth, symbols.ellipsis), rowWidth)}${bar[i]}`);
		} else for (const row of rows) out.push(truncate(row, width, symbols.ellipsis));
		for (let i = rows.length; i < view.maxVisible; i++) out.push("");
	}
	out.push("", ...detailRows(theme, view.detail, width));
	return out;
}

/** What a standalone browser `col` carries in `term`. */
export type ModelBrowserTerm = {
	readonly role: "omp.model-browser";
	readonly browser: ModelBrowserState;
};

function browserOf(node: UiNode): ModelBrowserState {
	// The role is set only by `ModelBrowser`, which always gives `term.browser`.
	const props = node.props() as { term: ModelBrowserTerm };
	return props.term.browser;
}

defineRolePainter("col", "omp.model-browser", (node, cx) => {
	const theme = cx.theme;
	const rows = modelBrowserRows(
		theme,
		browserOf(node).view(key => theme.symbols.symbol(key)),
		cx.width,
	);
	const hits: Hit[] = [{ row: 0, col: 0, width: cx.width, height: rows.length, node }];
	return { rows, hits };
});

defineRoleWidget("col", "omp.model-browser", {
	mouse(node, mouse, at) {
		const browser = browserOf(node);
		const line = at.row - MODEL_LIST_TOP;
		const row = line >= 0 && line < browser.maxVisible ? line : null;
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			browser.wheel(mouse.button === "wheel-up" ? -1 : 1, row);
			return true;
		}
		if (mouse.action === "move") {
			browser.hover(row);
			return true;
		}
		if (mouse.action === "press" && mouse.button === "left" && row !== null) {
			browser.click(row);
			return true;
		}
		return false;
	},
});
