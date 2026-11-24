/**
 * `todo`: the call as `⏳ Todo op · op`; the list in a muted rounded frame
 * headed `☑ Todo 13 tasks`.
 *
 * Expanded, every phase and item (see the `checklist` painter's rows).
 * Collapsed, a phase the update did not touch is its dim title row, and a
 * touched phase shows a walking window: its last closed item, then the
 * active items and the open ones after the first of them, at most
 * {@link COLLAPSED_ITEMS} (a `… N more todos` row for the rest). Items the
 * update just completed strike through character by character once, on the
 * spinner clock from its frame when the list first shows (the still look
 * strikes them at once). Errors use the error frame and tint.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { branchRows, checklistItemText, isClosedItem, phaseTitleRow } from "@oh-my-pi/pi-tui/term/painters/checklist";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspChecklistItem, TspChecklistProps } from "@oh-my-pi/pi-wire";
import { nodePlain, stillMark } from "./agent-common";
import { frameRows } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** Open items a collapsed phase shows. */
const COLLAPSED_ITEMS = 8;
/** Frames a completion holds before its strike sweeps in. */
const STRIKE_HOLD = 2;
/** Frames the strike takes to sweep across. */
const STRIKE_REVEAL = 12;

interface TodoTerm {
	readonly ops?: readonly string[];
}

interface ChecklistTerm {
	readonly touched?: readonly string[];
	readonly struck?: readonly string[];
}

/** `glyph Title meta · meta`, wrapped. */
function statusLine(
	theme: Theme,
	glyph: string,
	title: string,
	meta: readonly string[],
	width: number,
	extra = "",
): string[] {
	let line = `${glyph} ${theme.fg("accent", title)}`;
	if (meta.length > 0)
		line += ` ${theme.fg("dim", meta.map(part => theme.fg("dim", part)).join(theme.fg("dim", " · ")))}`;
	return wrap(`${line}${extra}`, width);
}

/** The rows a collapsed phase shows: closed lead, active items, the open items after them, a summary. */
function collapsedSelection(items: readonly TspChecklistItem[]): {
	items: TspChecklistItem[];
	summary: string;
} {
	const open = items.filter(item => !isClosedItem(item));
	const within = (base: readonly TspChecklistItem[]): { items: TspChecklistItem[]; summary: string } => {
		if (base.length <= COLLAPSED_ITEMS + 1) return { items: [...base], summary: "" };
		const active = base.filter(item => item.status === "active");
		if (active.length > COLLAPSED_ITEMS) {
			const hidden = active.length - COLLAPSED_ITEMS;
			return {
				items: active.slice(0, COLLAPSED_ITEMS),
				summary: `… ${hidden} more active ${hidden === 1 ? "todo" : "todos"}`,
			};
		}
		const first = active.length > 0 ? base.indexOf(active[0]!) : 0;
		const fill: TspChecklistItem[] = [];
		for (let i = first; i < base.length && active.length + fill.length < COLLAPSED_ITEMS; i++) {
			if (base[i]!.status !== "active") fill.push(base[i]!);
		}
		const shown = [...active, ...fill];
		const hidden = base.length - shown.length;
		return {
			items: shown,
			summary: hidden > 0 ? `… ${hidden} more ${hidden === 1 ? "todo" : "todos"}` : "",
		};
	};
	if (open.length === 0) return within(items);
	const lead = items.filter(isClosedItem).slice(-1);
	const selected = within(open);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}

/**
 * Where each checklist's strike started: the clock time and the spinner frame
 * it showed then (the sweep runs on the spinner clock from that frame), or
 * `done` once it finished.
 */
const strikeStarts = new WeakMap<UiNode, { readonly at: number; readonly frame: number } | "done">();

/** The strike frame of `checklist`'s fresh completions, or undefined once they are fully struck. */
function strikeFrame(cx: PaintContext, checklist: UiNode): number | undefined {
	const frames = cx.theme.symbols.spinnerFrames.length;
	if (cx.reduceMotion || frames === 0) return undefined;
	const start = strikeStarts.get(checklist);
	if (start === "done") return undefined;
	const now = cx.now();
	if (start === undefined) {
		const frame = Math.floor(now / SPINNER_INTERVAL_MS) % frames;
		strikeStarts.set(checklist, { at: now, frame });
		return frame;
	}
	const frame = start.frame + Math.floor((now - start.at) / SPINNER_INTERVAL_MS);
	if (frame <= STRIKE_HOLD + STRIKE_REVEAL) return frame;
	strikeStarts.set(checklist, "done");
	return undefined;
}

/** Leading characters of `item` struck at strike `frame`. */
function struckChars(item: TspChecklistItem, frame: number | undefined): number | undefined {
	if (frame === undefined) return undefined;
	if (frame <= STRIKE_HOLD) return 0;
	const count = [...(typeof item.text === "string" ? item.text : item.text.map(span => span.t).join(""))].length;
	return Math.ceil((count * Math.min(frame - STRIKE_HOLD, STRIKE_REVEAL)) / STRIKE_REVEAL);
}

function listRows(checklist: UiNode, cx: PaintContext, expanded: boolean, width: number): string[] {
	const theme = cx.theme;
	const props = checklist.props() as TspChecklistProps & {
		term?: ChecklistTerm;
	};
	const phases = props.phases ?? [];
	const struck = new Set(props.term?.struck ?? []);
	const touched = !expanded && phases.length > 1 && props.term?.touched ? new Set(props.term.touched) : undefined;
	const multi = phases.length > 1;
	const frame = struck.size > 0 ? strikeFrame(cx, checklist) : undefined;
	const rows: string[] = [];
	phases.forEach((phase, index) => {
		if (touched && !touched.has(phase.id)) {
			rows.push(...wrap(phaseTitleRow(theme, phase, index, true), width));
			return;
		}
		if (multi) rows.push(...wrap(phaseTitleRow(theme, phase, index, false), width));
		const selection = expanded ? { items: phase.items, summary: "" } : collapsedSelection(phase.items);
		const lines = selection.items.map(item =>
			// An item without a status (a status the list does not know) draws as pending.
			checklistItemText(
				theme,
				item.status ? item : { ...item, status: "pending" },
				struck.has(item.id) ? struckChars(item, frame) : undefined,
			),
		);
		if (selection.summary) lines.push(theme.fg("muted", selection.summary));
		rows.push(...branchRows(theme, lines, multi ? "  " : "", width));
	});
	return rows;
}

function paintTodo(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const theme = cx.theme;
	const width = cx.width;
	const children = node.children();
	const checklist = children.find(child => child.kind === "checklist");
	if (props.tone === "error" || props.status === "error") {
		const message = children[0] ? nodePlain(children[0]) : "";
		const [first = "", ...rest] = message.split("\n");
		const rows = frameRows(theme, width, {
			head: `${theme.fg("error", theme.symbols.symbol("status.error"))} ${theme.fg("accent", "Todo")}`,
			// A multi-line message leaves the error color open over its first line's padding.
			sections: [
				{
					lines: [
						rest.length > 0
							? `  ${theme.fg("error", "\0").split("\0")[0]}${first}`
							: `  ${theme.fg("error", first)}`,
						...rest,
					],
				},
			],
			border: "error",
			bg: "toolErrorBg",
		});
		return { rows };
	}
	const term = (props.term ?? {}) as TodoTerm;
	if (term.ops)
		return {
			rows: statusLine(theme, stillMark(theme, props), "Todo", term.ops, width),
		};
	const glyph = theme.fg("accent", theme.symbols.symbol("tool.todo"));
	if (!checklist) {
		const note = children[0] ? `\n  ${theme.fg("dim", nodePlain(children[0]))}` : "";
		return { rows: statusLine(theme, glyph, "Todo", ["0 tasks"], width, note) };
	}
	const total = ((checklist.props() as TspChecklistProps).phases ?? []).reduce(
		(sum, phase) => sum + phase.items.length,
		0,
	);
	const head = `${glyph} ${theme.fg("accent", "Todo")} ${theme.fg("dim", `${total} tasks`)}`;
	const inner = Math.max(1, width - 4);
	// The view opens natively; the terminal follows the transcript's expand state.
	const body = listRows(checklist, cx, props.term?.expanded === true, inner);
	return {
		rows: frameRows(theme, width, {
			head,
			sections: body.length > 0 ? [{ lines: body }] : [],
			border: "borderMuted",
		}),
	};
}

defineToolLook("todo", { paint: paintTodo, margin: true, clocked: true });
