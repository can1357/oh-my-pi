/**
 * The advisor-configuration overlay's terminal look, drawn for its `prefs`
 * node (`term.role = "omp.advisor-config"`; natively the node stays a plain
 * settings page): a fullscreen frame whose body is, on the roster, a sidebar
 * list beside the highlighted entry's preview (scrolled by the wheel), and on
 * every other screen the screen's editor alone — a select list, a one-line
 * field, the model browser, or the instructions editor — over a dim key-hint
 * footer.
 *
 * The program precomputes every fact (`AdvisorLookTerm`); the painter only
 * lays it out at the width it gets. Pointer input becomes `action pointer`
 * events (`click:<row>`, `wheel:<±1>`, `pick:<model>`) on the node; the
 * preview's scroll offset is terminal state.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { inputLine, selectList } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { nodeState } from "@oh-my-pi/pi-tui/term/painters/state";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { padTo, sliceColumns, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import { bindingGlyph, keyGlyph } from "../panels/common";
import { appExternalEditorKeys, appFollowUpKeys } from "../../../config/keybindings/matchers";
import { canonicalKeyId } from "../../../config/keybindings/key-id";

export const ADVISOR_CONFIG_ROLE = "omp.advisor-config";

/** The pointer action the look's widget emits. */
export const ADVISOR_POINTER_ACT = "pointer";

/** One preview line: `label` (dim) before `text`; `wrap` soft-wraps `text` to the pane. */
export interface AdvisorPreviewLine {
	readonly text: string;
	readonly style?: string;
	readonly label?: string;
	readonly wrap?: boolean;
}

/** One option of a list screen. */
export interface AdvisorListOption {
	readonly label: string;
	readonly detail?: string;
}

/** One row of the model browser: a model, or the rule between the recent and the other models. */
export type AdvisorModelRow =
	| { readonly sep: true }
	| {
			readonly sep?: false;
			readonly id: string;
			readonly provider: string;
			readonly name: string;
			readonly ctx: string;
			readonly price: string;
	  };

/** What the body shows. */
export type AdvisorScreenLook =
	| {
			readonly k: "roster";
			readonly options: readonly AdvisorListOption[];
			readonly cursor: number;
			readonly preview: readonly AdvisorPreviewLine[];
	  }
	| { readonly k: "list"; readonly options: readonly AdvisorListOption[]; readonly cursor: number }
	| { readonly k: "input"; readonly text: string; readonly cursor: number }
	| {
			readonly k: "models";
			readonly query: string;
			readonly cursor: number;
			readonly rows: readonly AdvisorModelRow[];
			/** Selected model id (`provider/id`). */
			readonly selected: string | undefined;
			readonly detail: string;
	  }
	| { readonly k: "editor"; readonly title: string; readonly text: string; readonly cursor: number };

/** The look's term facts. */
export type AdvisorLookTerm = {
	readonly role: typeof ADVISOR_CONFIG_ROLE;
	readonly title: string;
	readonly footer: string;
	/** Changes whenever the preview's scroll resets (screen or roster selection change). */
	readonly previewKey: string;
	readonly screen: AdvisorScreenLook;
};

/** Height when the parent leaves it open (a fullscreen overlay gets the terminal's). */
const DEFAULT_HEIGHT = 40;
const MIN_HEIGHT = 14;
/** The sidebar's share of the width, and its bounds. */
const SIDEBAR_RATIO = 0.34;
const SIDEBAR_MIN = 22;
const SIDEBAR_MAX = 42;
/** Model rows the browser shows. */
const MODEL_ROWS = 10;
/** Rows above the browser's list (search, blank). */
const MODEL_LIST_TOP = 2;
/** The instructions editor's key hint, in the user's bindings. */
function editorHint(): string {
	const glyphs = (keys: readonly string[]): string => keys.map(key => keyGlyph(canonicalKeyId(key))).join("/");
	return `${glyphs(appFollowUpKeys())} submit  ${bindingGlyph("tui.select.cancel", "escape")} cancel  ${glyphs(appExternalEditorKeys())} external editor`;
}
const PREVIEW_SCROLL = "omp.advisor-config.preview";

interface PreviewScroll {
	readonly key: string;
	readonly offset: number;
}

/** The look's facts (the program always sets them on a node with this role). */
function lookTerm(node: UiNode): AdvisorLookTerm {
	const props = node.props() as { term: AdvisorLookTerm };
	return props.term;
}

function previewScroll(node: UiNode) {
	return nodeState<PreviewScroll>(node, PREVIEW_SCROLL, () => ({ key: "", offset: 0 }));
}

/** The sidebar width at `width`, as the two-pane split sizes it. */
function sidebarWidth(width: number): number {
	const available = Math.max(0, width - 7);
	return Math.max(0, Math.min(SIDEBAR_MAX, available, Math.max(SIDEBAR_MIN, Math.floor(width * SIDEBAR_RATIO))));
}

// ─── Frame ──────────────────────────────────────────────────────────────────

function border(theme: Theme, text: string): string {
	return theme.fg("border", text);
}

function titled(theme: Theme, title: string, room: number): { shown: string; width: number } {
	const shown = truncate(` ${title} `, Math.max(0, room));
	return { shown: theme.style("strong", theme.fg("accent", shown)), width: visibleWidth(shown) };
}

function topRule(theme: Theme, width: number, title: string, split: number | undefined): string {
	const box = theme.symbols.box;
	if (split === undefined) {
		const inner = Math.max(0, width - 2);
		const head = titled(theme, title, inner - 2);
		return (
			border(theme, box.topLeft + box.horizontal) +
			head.shown +
			border(theme, box.horizontal.repeat(Math.max(0, inner - 1 - head.width)) + box.topRight)
		);
	}
	const leftLen = split + 2;
	const rightLen = Math.max(0, width - 2 - (split + 3));
	const head = titled(theme, title, leftLen - 1);
	return (
		border(theme, box.topLeft + box.horizontal) +
		head.shown +
		border(
			theme,
			box.horizontal.repeat(Math.max(0, leftLen - 1 - head.width)) +
				box.teeDown +
				box.horizontal.repeat(rightLen) +
				box.topRight,
		)
	);
}

function midRule(theme: Theme, width: number, split: number | undefined): string {
	const box = theme.symbols.box;
	if (split === undefined)
		return border(theme, box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
	const leftLen = split + 2;
	const rightLen = Math.max(0, width - 2 - (split + 3));
	return border(
		theme,
		box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft,
	);
}

function frameRow(theme: Theme, content: string, width: number): string {
	const bar = border(theme, theme.symbols.box.vertical);
	return `${bar} ${width > 4 ? padTo(content, width - 4) : ""} ${bar}`;
}

// ─── Preview ────────────────────────────────────────────────────────────────

function previewLines(theme: Theme, lines: readonly AdvisorPreviewLine[], width: number): string[] {
	const out: string[] = [];
	const style = (line: AdvisorPreviewLine, text: string): string =>
		line.style ? theme.style(line.style, text) : text;
	for (const line of lines) {
		if (line.wrap) {
			const wrapped = line.text ? Bun.wrapAnsi(line.text, Math.max(1, width), { trim: false }).split("\n") : [""];
			for (const part of wrapped) out.push(truncate(style(line, part), width));
			continue;
		}
		const text = line.label === undefined ? style(line, line.text) : `${theme.fg("dim", line.label)} ${line.text}`;
		out.push(truncate(text, width));
	}
	return out;
}

function previewWindow(theme: Theme, lines: readonly string[], rows: number, scroll: number): string[] {
	const maxScroll = Math.max(0, lines.length - rows);
	const start = Math.min(scroll, maxScroll);
	const window = lines.slice(start, start + rows);
	if (lines.length > rows && rows > 0) {
		window[rows - 1] =
			start + rows < lines.length
				? theme.fg("dim", `  ↓ ${lines.length - rows - start} more`)
				: theme.fg("dim", "  (end)");
	}
	return window;
}

// ─── Model browser ──────────────────────────────────────────────────────────

function modelRows(
	theme: Theme,
	screen: Extract<AdvisorScreenLook, { k: "models" }>,
	width: number,
): { rows: string[]; ids: (string | undefined)[] } {
	const cursor = theme.symbols.symbol("nav.cursor") || ">";
	const rows: string[] = [];
	const ids: (string | undefined)[] = [];
	const search = " 🔍 > ";
	rows.push(
		` ${theme.fg("accent", "🔍")} > ${inputLine(screen.query, screen.cursor, Math.max(1, width - visibleWidth(search)), "")}`,
	);
	rows.push("");
	ids.push(undefined, undefined);
	// Window of MODEL_ROWS rows keeping the selection in view.
	const selectedAt = screen.rows.findIndex(row => !row.sep && row.id === screen.selected);
	const start = Math.max(0, Math.min(selectedAt - MODEL_ROWS + 1, screen.rows.length - MODEL_ROWS));
	const shown = screen.rows.slice(Math.max(0, start), Math.max(0, start) + MODEL_ROWS);
	let ctxWidth = 0;
	let priceWidth = 0;
	for (const row of screen.rows) {
		if (row.sep) continue;
		ctxWidth = Math.max(ctxWidth, visibleWidth(row.ctx));
		priceWidth = Math.max(priceWidth, visibleWidth(row.price));
	}
	const factsWidth = ctxWidth + 2 + 2 + priceWidth + 1;
	const labelWidth = Math.max(1, width - 2 - 1 - factsWidth);
	for (const row of shown) {
		if (row.sep) {
			rows.push(`  ${theme.fg("muted", theme.symbols.box.horizontal.repeat(Math.max(0, width - 5)))}   `);
			ids.push(undefined);
			continue;
		}
		const selected = row.id === screen.selected;
		const prefix = selected ? `${theme.fg("accent", cursor)} ` : "  ";
		const label = `${theme.fg("dim", `${row.provider}/`)}${selected ? theme.fg("accent", row.name) : row.name}`;
		const facts = `${theme.fg("dim", `${row.ctx.padStart(ctxWidth)} ◫`)}  ${theme.fg("dim", row.price.padEnd(priceWidth))} `;
		rows.push(`${prefix}${padTo(truncate(label, labelWidth), labelWidth)} ${facts}`);
		ids.push(row.id);
	}
	while (rows.length < MODEL_LIST_TOP + MODEL_ROWS) {
		rows.push("");
		ids.push(undefined);
	}
	rows.push("", truncate(theme.fg("muted", `  ${screen.detail}`), width));
	return { rows, ids };
}

// ─── Instructions editor ────────────────────────────────────────────────────

/** One visual row of the editor's text: `[start, textEnd)` drawn; the next row starts at `end`. */
interface TextRow {
	readonly start: number;
	readonly textEnd: number;
	readonly end: number;
	readonly last: boolean;
}

/**
 * Word-wrap `text` to `width` cells. Blanks and every wide (CJK) grapheme are
 * break opportunities; blanks at a break vanish into it; a word wider than a
 * row breaks between graphemes.
 */
function layoutEditorText(text: string, width: number): TextRow[] {
	const rows: TextRow[] = [];
	let offset = 0;
	const lines = text.split("\n");
	for (let l = 0; l < lines.length; l++) {
		const line = lines[l]!;
		// Runs of blanks, runs of narrow non-blanks, and each wide grapheme alone.
		const tokens: { start: number; end: number; width: number; blank: boolean; wide: boolean }[] = [];
		for (const { segment, index } of segmentGraphemes(line)) {
			const cells = Bun.stringWidth(segment);
			const blank = /^\s+$/.test(segment);
			const wide = !blank && cells >= 2;
			const previous = tokens[tokens.length - 1];
			if (previous && !wide && !previous.wide && previous.blank === blank) {
				previous.end = index + segment.length;
				previous.width += cells;
			} else {
				tokens.push({ start: index, end: index + segment.length, width: cells, blank, wide });
			}
		}
		let start = 0;
		let rowWidth = 0;
		let textEnd = 0;
		const close = (end: number, next: number): void => {
			rows.push({ start: offset + start, textEnd: offset + end, end: offset + next, last: false });
			start = next;
			rowWidth = 0;
			textEnd = next;
		};
		for (const token of tokens) {
			if (token.blank) {
				if (rowWidth + token.width <= width) rowWidth += token.width;
				else close(textEnd, token.end);
				continue;
			}
			if (rowWidth + token.width <= width) {
				rowWidth += token.width;
				textEnd = token.end;
				continue;
			}
			if (token.width <= width) {
				if (rowWidth > 0) close(textEnd, token.start);
				rowWidth = token.width;
				textEnd = token.end;
				continue;
			}
			for (const { segment, index } of segmentGraphemes(line.slice(token.start, token.end))) {
				const cells = Bun.stringWidth(segment);
				const at = token.start + index;
				if (rowWidth + cells > width && rowWidth > 0) close(at === token.start ? textEnd : at, at);
				rowWidth += cells;
				textEnd = at + segment.length;
			}
		}
		rows.push({
			start: offset + start,
			textEnd: offset + Math.max(textEnd, start),
			end: offset + line.length,
			last: true,
		});
		offset += line.length + 1;
	}
	return rows;
}

function editorRows(theme: Theme, screen: Extract<AdvisorScreenLook, { k: "editor" }>, width: number): string[] {
	const box = theme.symbols.box;
	const bar = border(theme, box.vertical);
	const inner = Math.max(1, width - 4);
	const boxed = (content: string): string => `${bar} ${padTo(content, inner)} ${bar}`;
	const out: string[] = [];
	const head = titled(theme, screen.title, inner);
	out.push(
		border(theme, box.topLeft + box.horizontal) +
			head.shown +
			border(theme, box.horizontal.repeat(Math.max(0, width - 3 - head.width)) + box.topRight),
	);
	out.push(boxed(""));
	// The field: a muted box whose last text row sits in its bottom rule; `▏` marks the caret.
	const textWidth = Math.max(1, inner - 6);
	const rows = layoutEditorText(screen.text, textWidth);
	const frame = (text: string): string => theme.fg("borderMuted", text);
	out.push(boxed(frame(`${box.topLeft}──${box.horizontal.repeat(Math.max(0, inner - 6))}──${box.topRight}`)));
	for (let r = 0; r < rows.length; r++) {
		const row = rows[r]!;
		let text = screen.text.slice(row.start, row.textEnd);
		const caretHere =
			screen.cursor >= row.start && (screen.cursor < row.end || (screen.cursor === row.end && row.last));
		if (caretHere) {
			const at = Math.min(screen.cursor, row.textEnd) - row.start;
			text = `${text.slice(0, at)}▏${text.slice(at)}`;
		}
		const shown = theme.fgResolved("text", text);
		const fill = " ".repeat(Math.max(0, textWidth - visibleWidth(text)));
		const last = r === rows.length - 1;
		out.push(
			boxed(
				last
					? `${frame(`${box.bottomLeft}─ `)}${shown}${fill}${frame(` ─${box.bottomRight}`)}`
					: `${frame(`${box.vertical}  `)}${shown}${fill}${frame(`  ${box.vertical}`)}`,
			),
		);
	}
	out.push(boxed(""));
	for (const line of Bun.wrapAnsi(editorHint(), inner).split("\n")) out.push(boxed(theme.fg("dim", line)));
	out.push(boxed(""));
	out.push(border(theme, box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight));
	return out;
}

// ─── Painter ────────────────────────────────────────────────────────────────

function paintAdvisorConfig(node: UiNode, cx: PaintContext): Block {
	const term = lookTerm(node);
	const theme = cx.theme;
	const width = cx.width;
	const height = Math.max(MIN_HEIGHT, cx.height ?? DEFAULT_HEIGHT);
	const body = Math.max(3, height - 4);
	const screen = term.screen;
	const split = screen.k === "roster" ? sidebarWidth(width) : undefined;
	const pane = split ?? Math.max(0, width - 4);
	const hits: Hit[] = [{ row: 1, col: 2, width: pane, height: body, node, item: "pane" }];

	let left: string[];
	switch (screen.k) {
		case "roster":
		case "list": {
			left = selectList(theme, screen.options, screen.cursor, pane, Math.max(1, screen.options.length)).rows;
			for (let i = 0; i < screen.options.length && i < body; i++)
				hits.push({ row: 1 + i, col: 2, width: pane, height: 1, node, item: `row:${i}` });
			break;
		}
		case "input":
			left = [inputLine(screen.text, screen.cursor, pane, "> ")];
			break;
		case "models": {
			const models = modelRows(theme, screen, pane);
			left = models.rows;
			for (let i = 0; i < models.ids.length && i < body; i++) {
				const id = models.ids[i];
				if (id !== undefined) hits.push({ row: 1 + i, col: 2, width: pane, height: 1, node, item: `model:${id}` });
			}
			break;
		}
		case "editor":
			left = editorRows(theme, screen, pane);
			break;
	}

	const rows: string[] = [topRule(theme, width, term.title, split)];
	if (split === undefined) {
		for (let r = 0; r < body; r++) rows.push(frameRow(theme, left[r] ?? "", width));
	} else {
		const right = Math.max(0, width - split - 7);
		const scroll = previewScroll(node)();
		const offset = scroll.key === term.previewKey ? scroll.offset : 0;
		const preview =
			screen.k === "roster" ? previewWindow(theme, previewLines(theme, screen.preview, right), body, offset) : [];
		const bar = border(theme, theme.symbols.box.vertical);
		for (let r = 0; r < body; r++)
			rows.push(`${bar} ${padTo(left[r] ?? "", split)} ${bar} ${padTo(preview[r] ?? "", right)} ${bar}`);
		hits.push({ row: 1, col: split + 5, width: right, height: body, node, item: "preview" });
	}
	rows.push(midRule(theme, width, split));
	rows.push(frameRow(theme, truncate(theme.fg("dim", term.footer), Math.max(0, width - 4)), width));
	rows.push(
		border(
			theme,
			theme.symbols.box.bottomLeft +
				theme.symbols.box.horizontal.repeat(Math.max(0, width - 2)) +
				theme.symbols.box.bottomRight,
		),
	);
	// Never wider than the width (tiny widths cut the frame).
	return { rows: rows.map(row => (visibleWidth(row) > width ? sliceColumns(row, 0, width) : row)), hits };
}

defineRolePainter("prefs", ADVISOR_CONFIG_ROLE, paintAdvisorConfig);

defineRoleWidget("prefs", ADVISOR_CONFIG_ROLE, {
	mouse(node, mouse, _at, cx, hit) {
		const item = hit.item ?? "";
		const wheel = mouse.button === "wheel-up" ? -1 : mouse.button === "wheel-down" ? 1 : 0;
		const emit = (value: string): void =>
			cx.emit({ type: "action", key: cx.keypath, act: ADVISOR_POINTER_ACT, value, mods: [] });
		if (item === "preview") {
			if (wheel !== 0) {
				const term = lookTerm(node);
				const state = previewScroll(node);
				const current = state();
				const base = current.key === term.previewKey ? current.offset : 0;
				state.set({ key: term.previewKey, offset: Math.max(0, base + wheel) });
			}
			return true;
		}
		if (wheel !== 0) {
			emit(`wheel:${wheel}`);
			return true;
		}
		if (mouse.action !== "press" || mouse.button !== "left") return true;
		if (item.startsWith("row:")) emit(`click:${item.slice(4)}`);
		else if (item.startsWith("model:")) emit(`pick:${item.slice(6)}`);
		return true;
	},
});
