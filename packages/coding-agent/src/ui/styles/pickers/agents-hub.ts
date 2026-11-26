/**
 * The agents hub in the terminal: the fullscreen hub frame (`hub-frame.ts`)
 * with the scope sidebar, a status row over the body (the agent list with
 * the selected agent's summary pinned under it, the model browser, or the
 * create flow) and the footer (key hints, a chip strip or the pattern
 * input). Drawn the same whether the hub is natively a picker (look
 * `omp.agents`) or a card (role `omp.hub.agents`).
 *
 * Row hits name list rows (`row:<id>`), sidebar entries (`scope:<id>`) and
 * footer chips (`chip:<index>`); the hub's widget turns pointer input into
 * the events the hub handles natively.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { definePickerLook, PICKER_HOVER, type PickerTerm, pickerState } from "@oh-my-pi/pi-tui/term/painters/picker";
import { defineRoleWidget, type Widget } from "@oh-my-pi/pi-tui/term/widgets";
import { replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { GeneratedAgentSpec } from "../../overlays/pickers/agents-hub";
import type { ModelBrowserState } from "../../overlays/pickers/model-browser-state";
import { keyGlyph } from "../panels/common";
import { hubChipRow, hubFrameRows, hubGeometry, type HubSidebarEntry, hubSidebarRows } from "./hub-frame";
import { modelBrowserRows } from "./model-browser";

/** A sidebar entry: the all-agents scope, a source, a separator or the New agent action. */
export interface AgentsSidebarEntry extends HubSidebarEntry {
	readonly kind: "all" | "source" | "separator" | "new";
}

/** One list row: an agent, or the trailing New agent row (`id` "new" alone). */
export interface AgentsListRow {
	readonly id: string;
	readonly name?: string;
	readonly disabled?: boolean;
	/** Lowercase source tag. */
	readonly source?: string;
	readonly override?: string;
	readonly prewalk?: string;
	readonly advisor?: string;
}

/** What the body shows. */
export type AgentsHubBody =
	| {
			readonly kind: "list";
			readonly search: { readonly text: string; readonly cursor: number };
			readonly rows: readonly AgentsListRow[];
			readonly selected: number;
			readonly scroll: number;
			/** The list holds the keyboard (its cursor shows). */
			readonly focused: boolean;
			/** The selected agent's summary. */
			readonly detail?: {
				readonly description: string;
				/** Effective model patterns, comma-joined ("" for the session model). */
				readonly patterns: string;
				readonly resolved?: string;
				readonly prewalk?: string;
				readonly advisor?: string;
				readonly path?: string;
			};
	  }
	| { readonly kind: "browser"; readonly browser: ModelBrowserState }
	| {
			readonly kind: "create";
			readonly spec?: GeneratedAgentSpec;
			readonly scope: string;
			/** The description field while it is edited. */
			readonly input?: { readonly text: string; readonly cursor: number };
			readonly generating: boolean;
			readonly streamed: string;
			readonly error?: string;
	  };

/** What the footer shows. */
export type AgentsHubFooter =
	| { readonly kind: "hints"; readonly hints: readonly { readonly keys: readonly string[]; readonly label: string }[] }
	| {
			readonly kind: "chips";
			readonly prefix: readonly TspSpan[];
			readonly chips: readonly (readonly TspSpan[])[];
			readonly index: number;
	  }
	| { readonly kind: "pattern"; readonly label: string; readonly text: string; readonly cursor: number };

/** The hub's term facts. */
export type AgentsHubTerm = PickerTerm & {
	readonly look: "omp.agents";
	readonly role: "omp.agents";
	/** Terminal rows (at least 16). */
	readonly height: number;
	readonly sidebar: readonly AgentsSidebarEntry[];
	readonly activeEntryId: string;
	readonly sidebarFocused: boolean;
	readonly status: readonly TspSpan[];
	readonly body: AgentsHubBody;
	readonly footer: AgentsHubFooter;
	/** A strip, the browser or the create flow covers the list: the pointer only reaches footer chips. */
	readonly inert: boolean;
};

/** Sidebar width bounds. */
const SIDEBAR_BOUNDS = { min: 16, max: 24 };
/** Summary rows pinned under the list (rule and three lines). */
const DETAIL_ROWS = 4;
/** Body rows before the list: the search row and a blank. */
const LIST_TOP = 2;

function styled(theme: Theme, spans: readonly TspSpan[]): string {
	let out = "";
	for (const span of spans) out += theme.style(span.s, span.t);
	return out;
}

/** A field's text with its caret cell in reverse video. */
function caretText(text: string, cursor: number): string {
	const at = text.slice(cursor, cursor + 1) || " ";
	return `${text.slice(0, cursor)}\x1b[7m${at}\x1b[27m${text.slice(cursor + 1)}`;
}

function termOf(node: UiNode): AgentsHubTerm | undefined {
	return (node.props() as { term?: AgentsHubTerm }).term;
}

function hovered(node: UiNode) {
	return pickerState<string | null>(node, PICKER_HOVER, () => null);
}

function listRows(
	theme: Theme,
	body: Extract<AgentsHubBody, { kind: "list" }>,
	hover: string | null,
	width: number,
	rows: number,
): string[] {
	const lines: string[] = [];
	const query = body.search.text;
	const searchText = query
		? theme.style("accent", caretText(query, body.search.cursor))
		: theme.style("dim", "type to filter");
	lines.push(truncate(` ${theme.style("muted", "search:")} ${searchText}`, width), "");
	const visible = Math.max(3, rows - LIST_TOP - DETAIL_ROWS);
	const scroll = Math.max(0, Math.min(body.scroll, Math.max(0, body.rows.length - visible)));
	let nameWidth = 0;
	for (const row of body.rows) if (row.name !== undefined) nameWidth = Math.max(nameWidth, visibleWidth(row.name));
	const cursorGlyph = theme.style("accent", theme.symbols.symbol("nav.cursor"));
	for (let i = scroll; i < Math.min(body.rows.length, scroll + visible); i++) {
		const row = body.rows[i]!;
		const selected = i === body.selected;
		const cursor = selected && body.focused ? cursorGlyph : " ";
		if (row.name === undefined) {
			let line = ` ${cursor} ${theme.style(selected ? "accent" : "dim", "+ New agent…")}`;
			if (row.id === hover) line = theme.bg("selectedBg", line);
			lines.push(truncate(line, width));
			continue;
		}
		const dot = row.disabled
			? theme.style("dim", theme.symbols.symbol("status.disabled"))
			: theme.style("success", theme.symbols.symbol("status.enabled"));
		const name = replaceTabs(row.name).padEnd(nameWidth);
		const label = row.disabled ? theme.style("dim", name) : selected ? theme.style("strong accent", name) : name;
		const badges: string[] = [];
		if (row.override) badges.push(theme.style("warning", row.override));
		if (row.prewalk) badges.push(theme.style("dim", `pre:${row.prewalk}`));
		if (row.advisor) badges.push(theme.style("dim", `adv:${row.advisor}`));
		let line = ` ${cursor} ${dot} ${label}  ${theme.style("dim", row.source ?? "")}`;
		const right = badges.join("  ");
		const rightWidth = visibleWidth(right);
		const lineWidth = visibleWidth(line);
		if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width)
			line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
		line = truncate(line, width);
		if (row.id === hover) line = theme.bg("selectedBg", line + " ".repeat(Math.max(0, width - visibleWidth(line))));
		lines.push(line);
	}
	while (lines.length < rows - DETAIL_ROWS) lines.push("");
	lines.push(theme.style("border", "─".repeat(Math.max(1, width))));
	const detail = body.detail;
	if (!detail) lines.push(theme.style("dim", " Select an agent to inspect"), "", "");
	else {
		lines.push(truncate(` ${theme.style("dim", replaceTabs(detail.description))}`, width));
		const model = detail.patterns ? replaceTabs(detail.patterns) : theme.style("dim", "(session model)");
		const resolved = detail.resolved ? ` ${theme.style("dim", "→")} ${theme.style("success", detail.resolved)}` : "";
		lines.push(truncate(` ${theme.style("muted", "model:")} ${model}${resolved}`, width));
		const flag = (label: string, value: string | undefined): string =>
			`${theme.style("muted", `${label}:`)} ${value ? theme.style("success", value) : theme.style("dim", "off")}`;
		const flags = [flag("prewalk", detail.prewalk), flag("advisor", detail.advisor)];
		if (detail.path) flags.push(theme.style("dim", detail.path));
		lines.push(truncate(` ${flags.join("   ")}`, width));
	}
	return lines.slice(0, rows);
}

/** The description field as the old editor drew it: `> ` gutter, two-space continuation, a `▏` caret. */
function editorRows(theme: Theme, text: string, cursor: number, width: number): string[] {
	const withCaret = `${text.slice(0, cursor)}▏${text.slice(cursor)}`;
	const out: string[] = [];
	withCaret.split("\n").forEach((line, index) => {
		const parts = line === "" ? [""] : wrap(replaceTabs(line), Math.max(1, width - 2));
		parts.forEach((part, at) => {
			const row = `${index === 0 && at === 0 ? "> " : "  "}${theme.fgResolved("text", part)}`;
			// The field fills its width.
			out.push(row + " ".repeat(Math.max(0, width - visibleWidth(row))));
		});
	});
	return out;
}

function createRows(
	theme: Theme,
	body: Extract<AgentsHubBody, { kind: "create" }>,
	width: number,
	rows: number,
): string[] {
	const lines = [""];
	const spec = body.spec;
	if (spec) {
		lines.push(truncate(theme.style("strong accent", " Review generated agent"), width), "");
		lines.push(truncate(theme.style("muted", ` Identifier: ${spec.identifier}`), width));
		lines.push(truncate(theme.style("muted", ` Scope: ${body.scope}`), width), "");
		lines.push(theme.style("muted", " whenToUse:"));
		for (const line of wrap(replaceTabs(spec.whenToUse), Math.max(20, width - 2)).slice(0, 6))
			lines.push(truncate(` ${line}`, width));
		lines.push("", theme.style("muted", " systemPrompt preview:"));
		const wrapped: string[] = [];
		for (const raw of spec.systemPrompt.split("\n")) wrapped.push(...wrap(replaceTabs(raw), Math.max(20, width - 4)));
		const budget = Math.max(3, rows - lines.length - 3);
		for (const line of wrapped.slice(0, budget)) lines.push(truncate(`   ${theme.style("dim", line)}`, width));
		if (wrapped.length > budget) lines.push(theme.style("dim", `   … ${wrapped.length - budget} more lines`));
	} else {
		lines.push(truncate(theme.style("strong accent", " Create new agent"), width), "");
		lines.push(
			truncate(
				theme.style("muted", " Describe what the agent should do; scope: ") + theme.style("accent", body.scope),
				width,
			),
			"",
		);
		if (body.input)
			for (const line of editorRows(theme, body.input.text, body.input.cursor, Math.max(20, width - 2)))
				lines.push(truncate(line, width));
		if (body.generating) {
			lines.push(theme.style("muted", " Generating…"), "");
			const wrapped: string[] = [];
			for (const raw of body.streamed.split("\n")) wrapped.push(...wrap(replaceTabs(raw), Math.max(20, width - 4)));
			const budget = Math.max(3, rows - lines.length - 2);
			for (const line of wrapped.slice(-budget)) lines.push(truncate(`  ${theme.style("dim", line)}`, width));
		}
	}
	if (body.error) lines.push("", truncate(theme.style("error", ` ${replaceTabs(body.error)}`), width));
	while (lines.length < rows) lines.push("");
	return lines.slice(0, rows);
}

function footerRow(theme: Theme, footer: AgentsHubFooter, width: number): { row: string; chips: Hit[] } {
	if (footer.kind === "hints") {
		const text = footer.hints
			.map(hint => (hint.keys.length > 0 ? `${hint.keys.map(keyGlyph).join("/")} ${hint.label}` : hint.label))
			.join(" · ");
		return { row: truncate(theme.style("dim", text), width), chips: [] };
	}
	if (footer.kind === "pattern") {
		const label = theme.style("accent", footer.label);
		const fieldWidth = Math.max(8, Math.min(40, width - visibleWidth(footer.label) - 4));
		const field = truncate(`> ${caretText(footer.text, footer.cursor)}`, fieldWidth);
		return { row: truncate(`${label} ${field}`, width), chips: [] };
	}
	const chips = hubChipRow(
		theme,
		width,
		`${styled(theme, footer.prefix)} `,
		footer.chips.map(chip => styled(theme, chip)),
		footer.index,
		0,
	);
	return {
		row: chips.row,
		chips: chips.ranges.map(
			range =>
				({
					row: 0,
					col: range.start,
					width: range.end - range.start,
					height: 1,
					item: `chip:${range.index}`,
				}) as Hit,
		),
	};
}

function paintAgentsHub(node: UiNode, cx: PaintContext): Block {
	const term = termOf(node);
	const width = cx.width;
	if (!term || width < 8) return { rows: [] };
	const theme = cx.theme;
	const contentRows = Math.max(10, term.height - 4);
	const geometry = hubGeometry(width, term.sidebar, SIDEBAR_BOUNDS, 0);
	const active = Math.max(
		0,
		term.sidebar.findIndex(entry => entry.id === term.activeEntryId),
	);
	const scroll = active >= contentRows ? active - contentRows + 1 : 0;
	const sidebar = hubSidebarRows(
		theme,
		term.sidebar,
		geometry.sidebar,
		contentRows,
		{ activeId: term.activeEntryId, focused: term.sidebarFocused, scroll },
		entry => ({
			icon: theme.style(
				entry.kind === "new" ? "dim" : "accent",
				entry.kind === "all"
					? theme.symbols.symbol("icon.model")
					: entry.kind === "new"
						? "+"
						: theme.symbols.symbol("status.enabled"),
			),
			annotation: theme.style("dim", entry.annotation ?? ""),
		}),
	);
	const bodyWidth = geometry.body;
	const status = term.status.map((span, index) => (index === 0 ? { ...span, t: ` ${span.t}` } : span));
	const body = [truncate(styled(theme, status), bodyWidth)];
	const bodyRows = contentRows - 1;
	const hover = hovered(node)();
	const hits: Hit[] = [];
	const bodyCol = 2 + geometry.sidebar + 3;
	const view = term.body;
	if (view.kind === "list") {
		body.push(...listRows(theme, view, hover, bodyWidth, bodyRows));
		const visible = Math.max(3, bodyRows - LIST_TOP - DETAIL_ROWS);
		const scrollTop = Math.max(0, Math.min(view.scroll, Math.max(0, view.rows.length - visible)));
		for (let i = scrollTop; i < Math.min(view.rows.length, scrollTop + visible); i++)
			hits.push({
				row: 2 + LIST_TOP + i - scrollTop,
				col: bodyCol,
				width: bodyWidth,
				height: 1,
				node,
				item: `row:${view.rows[i]!.id}`,
			});
	} else if (view.kind === "browser") {
		body.push(
			...modelBrowserRows(
				theme,
				view.browser.view(key => theme.symbols.symbol(key)),
				bodyWidth,
			),
		);
	} else body.push(...createRows(theme, view, bodyWidth, bodyRows));
	while (body.length < contentRows) body.push("");
	term.sidebar.forEach((entry, index) => {
		const row = index - scroll;
		if (entry.kind !== "separator" && row >= 0 && row < contentRows)
			hits.push({ row: 1 + row, col: 2, width: geometry.sidebar, height: 1, node, item: `scope:${entry.id}` });
	});
	const footer = footerRow(theme, term.footer, width - 4);
	for (const chip of footer.chips) hits.push({ ...chip, row: contentRows + 2, node });
	const rows = hubFrameRows(theme, width, "Agents", sidebar, body.slice(0, contentRows), footer.row, geometry.sidebar);
	return { rows, hits: [{ row: 0, col: 0, width, height: rows.length, node }, ...hits] };
}

/**
 * The pointer: motion hovers a list row, the wheel over the list moves the
 * selection, a click on a row selects it (on the selected one, opens it), a
 * click on a scope switches to it, a click on a footer chip runs it. While
 * a strip, the browser or the create flow covers the list only chips act.
 */
const widget: Widget = {
	mouse(node, mouse, _at, cx, hit) {
		const term = termOf(node);
		if (!term) return false;
		const item = hit.item ?? "";
		if (mouse.action === "press" && mouse.button === "left" && item.startsWith("chip:")) {
			cx.emit({ type: "activate", key: "footer/strip", item: item.slice(5) });
			return true;
		}
		if (term.inert) return true;
		const list = term.body.kind === "list" ? term.body : undefined;
		if (mouse.action === "move") {
			hovered(node).set(item.startsWith("row:") ? item.slice(4) : null);
			return true;
		}
		if (mouse.action !== "press") return true;
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			// The wheel over the body moves the selection; the sidebar shows every scope.
			if (!list || item.startsWith("scope:")) return true;
			const next =
				list.rows[
					Math.max(0, Math.min(list.rows.length - 1, list.selected + (mouse.button === "wheel-up" ? -1 : 1)))
				];
			if (next) cx.emit({ type: "select", key: "split/body/agents", item: next.id });
			return true;
		}
		if (mouse.button !== "left") return true;
		if (item.startsWith("scope:")) cx.emit({ type: "select", key: "split/scopes", item: item.slice(6) });
		else if (item.startsWith("row:") && list) {
			const id = item.slice(4);
			const selected = list.rows[list.selected]?.id === id;
			cx.emit({ type: selected ? "activate" : "select", key: "split/body/agents", item: id });
		}
		return true;
	},
};

definePickerLook("omp.agents", paintAgentsHub);
defineRolePainter("card", "omp.hub.agents", paintAgentsHub);
defineRoleWidget("picker", "omp.agents", widget);
defineRoleWidget("card", "omp.hub.agents", widget);
