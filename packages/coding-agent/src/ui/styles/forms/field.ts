/**
 * Terminal look of form controls (`src/ui/forms`): a field frame
 * (`omp.form.field`), the select list inside one (`omp.select`), a form of
 * fields (`omp.form`) and a plain select field drawn from its `picker`.
 *
 * A field's children say what they are through `term.slot`; children
 * without one (fields other screens build) read by position: a strong text
 * before the control is the label, other texts before it the description,
 * an error-styled text after it the error, other texts after it the hint.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import {
	type Block,
	defineRolePainter,
	EMPTY_BLOCK,
	type Hit,
	type PaintContext,
	roleOf,
} from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { definePickerLook, type PickerTerm, pickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import { inputLine, selectList } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type {
	TspInputProps,
	TspItemProps,
	TspListProps,
	TspPickerProps,
	TspSpan,
	TspTextProps,
} from "@oh-my-pi/pi-wire";

/** What a text child of a field is. */
export type FieldSlot =
	| "label"
	| "description"
	| "detail"
	| "previewLabel"
	| "preview"
	| "error"
	| "summary"
	| "hint"
	| "footer";

/** Terminal facts of a field (`term` of the `omp.form.field` col). */
export type FieldTerm = {
	/** A blank row above the field. */
	readonly leadingSpace?: boolean;
	/** Blank rows before / after the control (default both). */
	readonly spaceBefore?: boolean;
	readonly spaceAfter?: boolean;
};

/** Terminal facts of a field's text child. */
type SlotTerm = { readonly slot?: FieldSlot; readonly pad?: number };

/** Terminal facts of a field's `input`. */
type InputTerm = { readonly promptStyle?: string };

/** Terminal facts of a plain select field's picker: the error under the list. */
export type SelectLookTerm = PickerTerm & { readonly error?: string };

/** Terminal facts of an `omp.select` col. */
export type SelectTerm = {
	/** Selection pointer glyph, when the list keeps the one it was built with (glyph previews change the theme's). */
	readonly pointer?: string;
};

/** `theme` drawing `pointer` as the list cursor. */
function withPointer(theme: Theme, pointer: string): Theme {
	const symbols = theme.symbols;
	const pinned = new Proxy(symbols, {
		get: (target, key) => {
			if (key === "symbol") return (name: string) => (name === "nav.cursor" ? pointer : target.symbol(name));
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return new Proxy(theme, {
		get: (target, key) => {
			if (key === "symbols") return pinned;
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The picker look of a plain select field. */
export const SELECT_LOOK = "omp.form.select";

function termOf<T>(node: UiNode): Partial<T> {
	return ((node.props() as { term?: Partial<T> }).term ?? {}) as Partial<T>;
}

function textOf(props: TspTextProps): string {
	if (props.spans) return props.spans.map(span => span.t).join("");
	return props.text ?? "";
}

/** One-line input: prompt, then the text around an inverse caret cell. */
function inputRows(theme: Theme, node: UiNode, width: number): string[] {
	const props = node.props() as TspInputProps;
	const term = termOf<InputTerm>(node);
	const text = props.text ?? "";
	const plainPrompt = typeof props.prompt === "string" ? props.prompt : styledText(theme, props.prompt);
	const prompt = term.promptStyle ? theme.fg(term.promptStyle, plainPrompt) : plainPrompt;
	return [inputLine(text, props.cursor ?? text.length, width, prompt)];
}

/** Search status under a select list: muted copy, and the query with an inverse caret cell. */
function statusRow(theme: Theme, status: string, width: number): string {
	const searching = /^Search: /.exec(status);
	if (!searching) return theme.fg("muted", truncate(`  ${status}`, Math.max(1, width - 2), ""));
	return `${theme.fg("muted", "  Search: ")}${status.slice(searching[0].length)}\x1b[7m \x1b[27m`;
}

/**
 * An `omp.select` list: options with a pointer and detail column, scrollbar
 * past `max` rows (the list's, unless the caller fits it to fewer), then the
 * search status ("Type to search" whenever the list scrolls).
 */
export function selectRows(theme: Theme, node: UiNode, width: number, maxRows?: number): string[] {
	const children = node.children();
	const list = children.find(child => child.kind === "list");
	if (!list) return [];
	const props = list.props() as TspListProps;
	const items = list.children();
	const options = items.map(item => {
		const p = item.props() as TspItemProps;
		const detail =
			p.detail === undefined ? undefined : typeof p.detail === "string" ? p.detail : p.detail.map(s => s.t).join("");
		return { label: styledText(theme, p.label), detail };
	});
	const selected = Math.max(
		0,
		items.findIndex(item => item.key() === props.selected),
	);
	const max = maxRows ?? (typeof props.max === "number" ? props.max : (props.max?.lines ?? 10));
	const pointer = termOf<SelectTerm>(node).pointer;
	const rows = [...selectList(pointer ? withPointer(theme, pointer) : theme, options, selected, width, max).rows];
	const status = children.find(child => child.key() === "status");
	if (status) {
		// The list adds "Type to search" itself when it overflows; the status child says what to show.
		if (options.length > max) rows.pop();
		rows.push(statusRow(theme, textOf(status.props() as TspTextProps), width));
	}
	return rows;
}

function controlRows(theme: Theme, node: UiNode, cx: PaintContext): string[] {
	if (node.kind === "input") return inputRows(theme, node, cx.width);
	if (roleOf(node) === "omp.select") return selectRows(theme, node, cx.width);
	return [...cx.paint(node, cx.width).rows];
}

function slotOf(node: UiNode, beforeControl: boolean): FieldSlot {
	const slot = termOf<SlotTerm>(node).slot;
	if (slot) return slot;
	const spans = (node.props() as TspTextProps).spans ?? [];
	if (beforeControl) return spans[0]?.s === "strong" ? "label" : "description";
	return spans.some(span => span.s === "error") ? "error" : "hint";
}

function slotRows(theme: Theme, slot: FieldSlot, node: UiNode, width: number): string[] {
	const props = node.props() as TspTextProps & { hidden?: boolean };
	if (props.hidden) return [];
	const text = textOf(props);
	switch (slot) {
		case "label":
			return wrap(theme.style("strong", theme.fg("accent", text)), width);
		case "description":
		case "previewLabel":
			return wrap(theme.fg("muted", text), width);
		case "error":
			return wrap(theme.fg("error", text), width);
		case "hint":
			return wrap(theme.fg("dim", text), width);
		default: {
			const pad = termOf<SlotTerm>(node).pad ?? 0;
			const styled = props.spans ? styledText(theme, props.spans as readonly TspSpan[]) : text;
			return wrap(styled, Math.max(1, width - pad * 2)).map(row => (pad ? `${" ".repeat(pad)}${row}` : row));
		}
	}
}

/** Which head group a slot belongs to (groups are separated by a blank row). */
const HEAD_GROUP: Partial<Record<FieldSlot, number>> = {
	label: 0,
	description: 1,
	detail: 1,
	previewLabel: 2,
	preview: 2,
};

function paintField(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const term = termOf<FieldTerm>(node);
	const children = node.children();
	const at = children.findIndex(child => child.kind !== "text");
	if (at < 0) return EMPTY_BLOCK;
	const rows: string[] = [];
	if (term.leadingSpace) rows.push("");
	const groups: string[][] = [[], [], []];
	for (const child of children.slice(0, at)) {
		const slot = slotOf(child, true);
		groups[HEAD_GROUP[slot] ?? 1]!.push(...slotRows(theme, slot, child, cx.width));
	}
	let first = true;
	for (const group of groups) {
		if (group.length === 0) continue;
		if (!first) rows.push("");
		rows.push(...group);
		first = false;
	}
	if (term.spaceBefore !== false) rows.push("");
	const controlAt = rows.length;
	rows.push(...controlRows(theme, children[at]!, cx));
	const controlEnd = rows.length;
	if (term.spaceAfter !== false) rows.push("");
	for (const child of children.slice(at + 1)) {
		const slot = slotOf(child, false);
		const shown = slotRows(theme, slot, child, cx.width);
		if (slot === "footer" && shown.length > 0) rows.push("");
		rows.push(...shown);
	}
	const hits: Hit[] = [{ row: controlAt, col: 0, width: cx.width, height: Math.max(1, controlEnd - controlAt), node }];
	return { rows: rows.map(row => (visibleWidth(row) > cx.width ? truncate(row, cx.width, "") : row)), hits };
}

defineRolePainter("col", "omp.form.field", paintField);

/** Clicking a field's control moves the form's focus there. */
defineRoleWidget("col", "omp.form.field", {
	mouse(_node, mouse, _at, cx) {
		if (mouse.action !== "press" || mouse.button !== "left") return false;
		cx.emit({ type: "focus", key: cx.keypath });
		return true;
	},
});

/** A form: its fields stacked (each field ends on its own blank row). */
defineRolePainter("col", "omp.form", (node, cx): Block => {
	const rows: string[] = [];
	const hits: Hit[] = [];
	for (const child of node.children()) {
		const block = cx.paint(child, cx.width);
		for (const hit of block.hits ?? []) hits.push({ ...hit, row: hit.row + rows.length });
		rows.push(...block.rows);
	}
	return { rows, hits };
});

/** A plain select field: its label, the list, the search status, an error. */
definePickerLook(SELECT_LOOK, (node, cx): Block => {
	const theme = cx.theme;
	const props = node.props() as TspPickerProps;
	const term: SelectLookTerm = pickerTerm(node);
	const items = props.items ?? [];
	const max = term.maxRows ?? 10;
	const rows: string[] = [];
	if (props.title)
		rows.push(...wrap(theme.style("strong", theme.fg("accent", textOf({ text: props.title }))), cx.width), "");
	const options = items.map(item => ({
		label: typeof item.label === "string" ? item.label : styledText(theme, item.label),
		detail:
			item.detail === undefined
				? undefined
				: typeof item.detail === "string"
					? item.detail
					: item.detail.map(s => s.t).join(""),
	}));
	const selected = Math.max(
		0,
		items.findIndex(item => item.id === props.selected),
	);
	rows.push(...selectList(theme, options, selected, cx.width, max).rows);
	if (items.length > max) rows.pop();
	if (props.query !== undefined && props.query !== null && (props.query !== "" || items.length > max))
		rows.push(statusRow(theme, props.query ? `Search: ${props.query}` : "Type to search", cx.width));
	rows.push("");
	if (term.error) rows.push(...wrap(theme.fg("error", term.error), cx.width));
	return { rows };
});
