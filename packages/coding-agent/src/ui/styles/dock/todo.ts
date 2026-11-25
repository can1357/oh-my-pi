/**
 * Terminal look of the todo HUD (`col` `omp.hud.todo`): a blank row, a bold
 * accent `TODO`, then the stage window one cell in on a spine. Each stage
 * block opens with `├─ ` and continues with `│  `; stage titles are bold
 * accent (active) or muted, with a dim ` · done/total`; tasks hang off dim
 * `├─`/`└─` branches as `☐ task` in their status color (done `☑` struck,
 * success; dropped struck, error; in progress or matched, accent; pending,
 * dim), notes counted as a dim italic superscript. An elbow tail `└─────`
 * closes the spine; overall progress paints spine, bend and tail accent in
 * reading order. Wide rows wrap under their own content beside the spine.
 *
 * `todoCompactLine` is the folded form the status row docks right on short
 * terminals: `TODO 2/5 · ☐ next task`.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { terminalPaddingX } from "../terminal-padding";
import type { TodoItem } from "../../../tools/details/todo";
import { moreStages, nextTodo, type TodoHudModel, type TodoWindow } from "../../dock/todo";
import { termOf } from "../messages/fill";

/** Cells of the closing tail (hook plus horizontals). */
const TAIL = 6;
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** ` ⁺²`: how many notes a task carries. */
function noteMarker(theme: Theme, count: number): string {
	if (count <= 0) return "";
	const digits = [...String(count)].map(digit => SUPERSCRIPT[Number(digit)] ?? digit).join("");
	return theme.style("dim em", ` ⁺${digits}`);
}

/** A task as the HUD lists it: box and text in its status color, then its note marker. */
export function todoLine(theme: Theme, todo: TodoItem, matched: boolean): string {
	const symbols = theme.symbols;
	const unchecked = symbols.symbol("checkbox.unchecked");
	const content = replaceTabs(todo.content);
	const marker = noteMarker(theme, todo.notes?.length ?? 0);
	switch (todo.status) {
		case "completed":
			return `${theme.fg("success", `${symbols.symbol("checkbox.checked")} ${theme.style("strike", content)}`)}${marker}`;
		case "abandoned":
			return `${theme.fg("error", `${unchecked} ${theme.style("strike", content)}`)}${marker}`;
		case "in_progress":
			return `${theme.fg("accent", `${unchecked} ${content}`)}${marker}`;
		default:
			return `${theme.fg(matched ? "accent" : "dim", `${unchecked} ${content}`)}${marker}`;
	}
}

/** One content row of the window: its first line and how its wrapped lines hang. */
interface ContentRow {
	/** Leading connector cells (styled) and their width; continuation lines take `hang` instead. */
	readonly lead: string;
	readonly hang: string;
	readonly leadWidth: number;
	readonly body: string;
	/** Starts a stage block (`├─` on the spine). */
	readonly opens: boolean;
}

function windowRows(theme: Theme, view: TodoWindow): ContentRow[] {
	const tree = theme.symbols;
	const dim = (text: string): string => theme.fg("dim", text);
	const rows: ContentRow[] = [];
	for (const stage of view.stages) {
		const progress = dim(` · ${stage.closed}/${stage.phase.tasks.length}`);
		const name = stage.active ? theme.style("strong", theme.fg("accent", stage.name)) : theme.fg("muted", stage.name);
		rows.push({
			lead: "",
			hang: "",
			leadWidth: 0,
			body: `${name}${progress}`,
			opens: true,
		});
		const tasks = stage.tasks;
		if (!tasks) continue;
		const lines = tasks.items.map(todo => todoLine(theme, todo, view.matched(todo)));
		if (tasks.summary) lines.push(theme.fg("muted", tasks.summary));
		lines.forEach((body, index) => {
			const last = index === lines.length - 1;
			const branch = tree.symbol(last ? "tree.last" : "tree.branch");
			const width = visibleWidth(branch) + 1;
			rows.push({
				lead: `${dim(branch)} `,
				hang: last ? " ".repeat(width) : `${dim(tree.symbol("tree.vertical"))}${" ".repeat(width - 1)}`,
				leadWidth: width,
				body,
				opens: false,
			});
		});
	}
	if (view.hiddenStages > 0)
		rows.push({
			lead: "",
			hang: "",
			leadWidth: 0,
			body: theme.fg("muted", moreStages(view.hiddenStages)),
			opens: true,
		});
	return rows;
}

/** The HUD's rows at `width` (see the module docs). */
export function todoHudRows(theme: Theme, view: TodoWindow, width: number): string[] {
	const tree = theme.symbols;
	const vertical = tree.symbol("tree.vertical");
	const content = windowRows(theme, view);
	const tail = `${tree.symbol("tree.hook")}${tree.symbol("tree.horizontal").repeat(Math.max(0, TAIL - 1))}`;
	// Overall progress fills the path: down the spine, round the bend, out along the tail.
	const path = content.length + TAIL;
	let filled = Math.round((view.closed / view.total) * path);
	if (view.closed > 0) filled = Math.max(filled, 1);
	if (view.closed < view.total) filled = Math.min(filled, path - 1);
	const paddingX = terminalPaddingX();
	const pad = " ".repeat(paddingX);
	const contentWidth = Math.max(1, width - 2 * paddingX);
	const rows = ["", `${pad}${theme.style("strong", theme.fg("accent", "TODO"))}`];
	content.forEach((row, index) => {
		const color = index < filled ? "accent" : "dim";
		const spine = ` ${theme.fg(color, row.opens ? `${tree.symbol("tree.branch")} ` : `${vertical}  `)}`;
		const spineHang = ` ${theme.fg(color, `${vertical}  `)}`;
		const room = Math.max(1, contentWidth - visibleWidth(spine) - row.leadWidth);
		wrap(row.body, room).forEach((line, at) => {
			rows.push(`${pad}${at === 0 ? spine : spineHang}${at === 0 ? row.lead : row.hang}${line}`);
		});
	});
	const tailFilled = Math.max(0, Math.min(filled - content.length, TAIL));
	const chars = [...tail];
	rows.push(
		`${pad} ${theme.fg("accent", chars.slice(0, tailFilled).join(""))}${theme.fg("dim", chars.slice(tailFilled).join(""))}`,
	);
	return rows;
}

/** `TODO 2/5 · ☐ next task` (or `☑ done`): the plan folded into the status row. */
export function todoCompactLine(theme: Theme, view: TodoWindow): string {
	const header = `${theme.style("strong", theme.fg("accent", "TODO"))} ${theme.fg("dim", `${view.closed}/${view.total}`)}`;
	const next = nextTodo(view.phases);
	const task = next
		? todoLine(theme, next, view.matched(next))
		: theme.fg("success", `${theme.symbols.symbol("checkbox.checked")} done`);
	return `${header} ${theme.fg("dim", "·")} ${task}`;
}

function paintTodoHud(node: UiNode, cx: PaintContext): Block {
	const model = termOf<{ todo: TodoHudModel }>(node).todo;
	const view = model?.window();
	if (!model || !view || model.compact()) return EMPTY_BLOCK;
	return { rows: todoHudRows(cx.theme, view, cx.width) };
}

defineRolePainter("col", "omp.hud.todo", paintTodoHud);
