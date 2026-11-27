/**
 * The /models hub's terminal look (`picker` with `term.role =
 * "omp.model-hub"`): the hub frame (`hub-frame`) with the scope sidebar, a
 * body showing a status row over the Roles view, a signed-out provider's
 * pane or the kind tabs and the model list, and a footer of key hints or the
 * open strip (role chips, thinking levels, a name field).
 *
 * Its widget routes the pointer to {@link ModelHubState.routeMouse}.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { padTo, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import {
	COMPACTION_INPUT_HINT,
	compactionConfirmPending,
	MODEL_KIND_TABS,
	type ModelHubState,
	type NativeRouteForm,
	nativeRouteFieldView,
	ROLE_TABS,
	type SidebarEntry,
	type StripState,
} from "../../overlays/pickers/model-hub-state";
import { getConfiguredThinkingLevelMetadata } from "../../../thinking/levels";
import { keyLabel } from "../../keys/hints";
import { bindingGlyph, keyLabels, selectNavGlyphs } from "../panels/common";
import { caretField } from "./common";
import {
	type HubChipRange,
	hubChipRow,
	hubChipWindowStart,
	hubFrameRows,
	hubGeometry,
	hubSidebarRows,
} from "./hub-frame";
import { modelBrowserRows, segmentTrack, themeThinkingGlyph } from "./model-browser";

/** What the hub's picker carries in `term`. */
export type ModelHubTerm = {
	readonly role: "omp.model-hub";
	readonly hub: ModelHubState;
};

function spansText(theme: Theme, spans: readonly TspSpan[]): string {
	return spans.map(span => (span.s ? theme.style(span.s, span.t) : span.t)).join("");
}

function hubOf(node: UiNode): ModelHubState {
	// The role is set only by `ModelHub`, which always gives `term.hub`.
	const props = node.props() as { term: ModelHubTerm };
	return props.term.hub;
}

/** A sidebar entry's icon, annotation and dimming. */
function sidebarStyle(theme: Theme, hub: ModelHubState, entry: SidebarEntry, index: number, now: number) {
	const symbol = (key: string): string => theme.symbols.symbol(key);
	const counts = hub.searchCounts;
	let matches: number | undefined;
	if (counts) {
		if (entry.kind === "provider" && !entry.locked) matches = counts.get(entry.providerId ?? "") ?? 0;
		else if (entry.kind === "recent") matches = hub.recentSearchCount;
		else if (entry.kind === "all") matches = hub.searchTotal;
	}
	// Entries a search cannot reach dim but keep their place.
	const muted = entry.locked === true || matches === 0 || (counts !== null && entry.kind === "roles");
	const icon =
		entry.kind === "recent"
			? symbol("icon.time")
			: entry.kind === "roles"
				? symbol("icon.extensionSkill")
				: entry.kind === "all"
					? symbol("icon.model")
					: symbol(muted ? "status.shadowed" : "status.enabled");
	const frames = theme.symbols.spinnerFrames;
	const annotation = hub.isRefreshing(entry.providerId)
		? theme.style("warning", frames[Math.floor(now / 80) % frames.length] ?? "")
		: theme.style("dim", matches !== undefined ? String(matches) : (entry.annotation ?? ""));
	return {
		icon: theme.style(muted ? "dim" : entry.kind === "provider" ? "success" : "accent", icon),
		annotation,
		muted,
		hovered: index === hub.sidebarHover,
	};
}

/** The body's status row. */
function statusRow(theme: Theme, hub: ModelHubState, width: number): string {
	const cut = (text: string): string => truncate(text, width, theme.symbols.ellipsis);
	if (hub.assignmentPending)
		return cut(theme.style("accent", hub.nativeRouteForm ? " Saving native route…" : " Applying model…"));
	if (hub.nativeRouteForm) {
		const test = hub.nativeTestStatus();
		return cut(test ? theme.style(test.style, ` ${test.text}`) : theme.style("accent", ` ${hub.nativeRouteTitle()}`));
	}
	const judge = hub.judgeStatus();
	if (judge?.error) return cut(theme.style("error", ` ${judge.text}`));
	if (judge && hub.assigning === null) return cut(theme.style("muted", ` ${judge.text}`));
	const assigning = hub.assigning;
	if (assigning !== null) {
		const enter = keyLabel(theme, "enter");
		const cancel = bindingGlyph("tui.select.cancel", "escape", theme);
		if (assigning.kind === "fallbackKey")
			return cut(
				theme.style("accent", ` New fallback chain — ${enter} picks the model it protects, ${cancel} cancels`),
			);
		const info = hub.source.getRoleInfo(assigning.role);
		const label = theme.style("accent strong", info.tag ?? info.name ?? assigning.role);
		if (assigning.kind === "fallback") {
			const verb = assigning.index === null ? "Adding fallback for" : "Replacing fallback of";
			return cut(
				`${theme.style("accent", ` ${verb} `)}${label}${theme.style("accent", ` — ${enter} picks the fallback model, ${cancel} cancels`)}`,
			);
		}
		return cut(
			`${theme.style("accent", " Assigning ")}${label}${theme.style("accent", ` — ${enter} assigns, ${cancel} cancels`)}`,
		);
	}
	const entry = hub.activeEntry();
	const scoped = hub.scoped ? " · --models scope" : "";
	if (hub.configError && entry.kind !== "provider") return cut(theme.style("error", ` ${hub.configError}`));
	let text: string;
	switch (entry.kind) {
		case "recent":
			text = `Recently used models${scoped}`;
			break;
		case "roles":
			text = "Model roles — f adds a retry fallback, cleared roles fall back to auto-selection";
			break;
		case "provider":
			text = entry.locked
				? `${entry.label} · not configured`
				: hub.isRefreshing(entry.providerId)
					? `${entry.label} · refreshing model list…`
					: `${entry.label} · ${entry.annotation ?? "0"} models${scoped}`;
			break;
		default:
			text = `All available models${scoped}`;
	}
	return cut(theme.style("muted", ` ${text}`));
}

/** A Roles-view row cut to `width`; the hover band fills it. */
function finishRow(theme: Theme, line: string, width: number, hovered: boolean): string {
	const out = truncate(line, width, theme.symbols.ellipsis);
	return hovered ? theme.bg("selectedBg", padTo(out, width)) : out;
}

/** The Roles view under the status row: role tabs, the rows window, the cycle line. */
function rolesView(theme: Theme, hub: ModelHubState, width: number, rows: number): string[] {
	const symbol = (key: string): string => theme.symbols.symbol(key);
	const cut = (text: string): string => truncate(text, width, theme.symbols.ellipsis);
	const { names, active } = hub.presets();
	const presetKeys =
		hub.browser.query.length > 0
			? keyLabels(theme, ["ctrl+left", "ctrl+right"])
			: `${keyLabels(theme, ["ctrl+left", "ctrl+right"])} · ${keyLabels(theme, ["p", "shift+p"])}`;
	const preset =
		names.length > 0
			? `   ${theme.style("dim", "Preset:")} ${active ? theme.style("accent", active) : theme.style("muted", "custom")}  ${theme.style("dim", presetKeys)}`
			: "";
	const tabs = segmentTrack(
		theme,
		ROLE_TABS.map(tab => (tab === "kind" ? "kinds" : tab)),
		Math.max(0, ROLE_TABS.indexOf(hub.roleTab)),
	);
	const lines = [
		cut(
			`${theme.style("dim", " Roles:")} ${tabs}  ${theme.style("dim", keyLabels(theme, ["alt+left", "alt+right"]))}${preset}`,
		),
	];
	let tagWidth = 0;
	for (const row of hub.rolesRows) {
		if (row.kind !== "role") continue;
		const info = hub.source.getRoleInfo(row.role);
		tagWidth = Math.max(tagWidth, visibleWidth(info.tag ?? info.name ?? row.role));
	}
	const cycle = hub.cycleOrder();
	const listFocused = hub.focus === "list";
	const window = hub.rolesWindow();
	for (let i = window.start; i < window.end; i++) {
		const row = hub.rolesRows[i]!;
		const selected = i === hub.roleIndex;
		const hovered = i === hub.roleHover;
		// The unfocused pane draws no cursor; the accent text still marks the row.
		const cursor = selected && listFocused ? theme.style("accent", symbol("nav.cursor")) : " ";
		switch (row.kind) {
			case "separator":
				lines.push(`   ${theme.style("border", "─".repeat(Math.max(1, width - 6)))}`);
				continue;
			case "newRole":
			case "newFallback": {
				const label = row.kind === "newRole" ? "+ New role…" : "+ New fallback…";
				lines.push(
					finishRow(theme, ` ${cursor} ${theme.style(selected ? "accent" : "dim", label)}`, width, hovered),
				);
				continue;
			}
			case "chainKey": {
				const slash = row.role.lastIndexOf("/");
				const tail = row.role.slice(slash + 1);
				const key = `${theme.style("dim", row.role.slice(0, slash + 1))}${selected ? theme.style("accent", tail) : tail}`;
				lines.push(
					finishRow(theme, ` ${cursor} ${theme.style("dim", symbol("status.shadowed"))} ${key}`, width, hovered),
				);
				continue;
			}
			case "fallback": {
				const branch = theme.style("dim", `${"".padEnd(tagWidth + 3)}↳`);
				const selector = theme.style(selected ? "accent" : "muted", row.selector);
				const invalid = hub.judgeRowError(row) ? theme.style("error", " · invalid native route") : "";
				lines.push(finishRow(theme, ` ${cursor} ${branch} ${selector}${invalid}`, width, hovered));
				continue;
			}
			case "role":
				break;
		}
		const info = hub.source.getRoleInfo(row.role);
		const assignment = hub.roles[row.role];
		const tag = (info.tag ?? info.name ?? row.role).padEnd(tagWidth);
		let dot: string;
		let tagStyled: string;
		let value: string;
		let level = "";
		if (assignment && !assignment.autoSelected) {
			const color = info.color ?? "muted";
			dot = theme.fg(color, symbol("status.enabled"));
			tagStyled = theme.fg(color, tag);
			value = `${theme.style("dim", `${assignment.model.provider}/`)}${selected ? theme.style("accent", assignment.model.id) : assignment.model.id}`;
			if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
				const glyph = themeThinkingGlyph(theme, assignment.thinkingLevel);
				const label = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				level = theme.style("dim", glyph ? `${glyph} ${label}` : label);
			}
		} else {
			dot = theme.style("dim", symbol("status.shadowed"));
			tagStyled = theme.style("dim", tag);
			value = theme.style("dim", assignment ? `auto → ${assignment.model.provider}/${assignment.model.id}` : "—");
		}
		// Quick-cycle stop (`↻ 2` = second stop of the ctrl+p cycle).
		const stop = cycle.indexOf(row.role);
		const right = [level, stop >= 0 ? theme.style("accent", `${symbol("icon.loop")} ${stop + 1}`) : ""]
			.filter(part => part.length > 0)
			.join("  ");
		let line = ` ${cursor} ${dot} ${tagStyled}  ${value}`;
		if (hub.judgeRowError(row)) line += theme.style("error", " · invalid native route");
		const rightWidth = visibleWidth(right);
		const lineWidth = visibleWidth(line);
		if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width)
			line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
		lines.push(finishRow(theme, line, width, hovered));
	}
	if (window.overflow) {
		const parts: string[] = [];
		if (window.start > 0) parts.push(`↑ ${window.start} more`);
		if (hub.rolesRows.length > window.end) parts.push(`↓ ${hub.rolesRows.length - window.end} more`);
		lines.push(cut(theme.style("dim", `   ${parts.join("   ")}`)));
	}
	while (lines.length < rows - 1) lines.push("");
	if (rows >= 2) {
		const cycleKey = keyLabel(theme, "ctrl+p");
		if (cycle.length > 0) {
			const selectedRow = hub.rolesRows[hub.roleIndex];
			const role =
				selectedRow && (selectedRow.kind === "role" || selectedRow.kind === "fallback") ? selectedRow.role : "";
			lines[rows - 1] = cut(
				`  ${theme.style("dim", `${cycleKey} cycle:`)} ${segmentTrack(theme, cycle, cycle.indexOf(role))}`,
			);
		} else lines[rows - 1] = cut(theme.style("dim", `  ${cycleKey} cycle is empty — press c on a role to add it`));
	}
	return lines.slice(0, rows);
}

/** A signed-out provider's pane: how to sign in, the login row, its catalog. */
function lockedView(theme: Theme, hub: ModelHubState, entry: SidebarEntry, width: number, rows: number): string[] {
	const cut = (text: string): string => truncate(text, width, theme.symbols.ellipsis);
	const lines = ["", cut(theme.style("warning", `  ${entry.label} has no credentials configured`)), ""];
	const envVars = hub.envVarsOf(entry.providerId);
	lines.push(
		cut(
			theme.style(
				"muted",
				envVars.length > 0
					? `  Set ${envVars.join(" or ")} in your environment, or add a key in config.`
					: "  Add an API key for this provider in config.",
			),
		),
	);
	if (entry.oauth)
		lines.push(
			cut(
				theme.style(
					"accent",
					`  ${theme.symbols.symbol("nav.cursor")} Log in with OAuth (${keyLabel(theme, "enter")})`,
				),
			),
		);
	lines.push("");
	const catalogCount = entry.catalogCount ?? 0;
	if (catalogCount > 0) {
		lines.push(cut(theme.style("dim", `  ${catalogCount} models in catalog:`)));
		for (const model of hub.lockedCatalog(entry)) {
			if (lines.length >= rows) break;
			lines.push(cut(theme.style("dim", `    ${model.id}`)));
		}
	}
	while (lines.length < rows) lines.push("");
	return lines.slice(0, rows);
}

/**
 * The open Ctrl+R / Ctrl+N step under the status row: its label and help, then its choices (the body row
 * the first one takes is `choiceStart`) or its field with the error or the live request preview.
 */
function nativeRouteRows(
	theme: Theme,
	hub: ModelHubState,
	form: NativeRouteForm,
	width: number,
): { lines: string[]; choiceStart: number } {
	const cut = (text: string): string => truncate(text, width, theme.symbols.ellipsis);
	const step = form.step;
	const lines = ["", cut(theme.style("accent strong", ` ${step.label}`))];
	for (const row of wrap(theme.style("muted", step.description), Math.max(1, width - 2))) lines.push(` ${row}`);
	lines.push("");
	const choiceStart = lines.length + 1;
	if (step.choices) {
		const labelWidth = Math.max(...step.choices.map(choice => visibleWidth(choice.label)));
		step.choices.forEach((choice, index) => {
			const selected = index === step.index;
			const cursor = selected ? theme.style("accent", theme.symbols.symbol("nav.cursor")) : " ";
			const label = theme.style(selected ? "accent" : "muted", padTo(choice.label, labelWidth));
			lines.push(cut(` ${cursor} ${label}  ${theme.style("dim", choice.description)}`));
		});
	} else {
		const view = nativeRouteFieldView(step);
		lines.push(` ${caretField(theme, "> ", view.text, view.cursor, Math.max(4, width - 2))}`);
		const preview = hub.nativeRoutePreview();
		if (step.error)
			for (const row of wrap(theme.style("error", step.error), Math.max(1, width - 3))) lines.push(`   ${row}`);
		else if (preview) lines.push(cut(theme.style("dim", `   ${preview}`)));
	}
	return { lines, choiceStart };
}

/** The body row's choice index under body row `content` of a hub painted `width` wide (the open form's). */
export function nativeRouteChoiceAt(
	theme: Theme,
	hub: ModelHubState,
	width: number,
	content: number,
): number | undefined {
	const form = hub.nativeRouteForm;
	if (!form?.step.choices) return undefined;
	const { choiceStart } = nativeRouteRows(theme, hub, form, hubGeometry(width, hub.entries).body);
	const index = content - choiceStart;
	return index >= 0 && index < form.step.choices.length ? index : undefined;
}

/** The body pane: status row, then the active view. */
function bodyRows(theme: Theme, hub: ModelHubState, width: number, rows: number): string[] {
	const lines = [statusRow(theme, hub, width)];
	const entry = hub.activeEntry();
	const form = hub.nativeRouteForm;
	if (form) lines.push(...nativeRouteRows(theme, hub, form, width).lines);
	else if (hub.rolesView()) lines.push(...rolesView(theme, hub, width, rows - 1));
	else if (hub.lockedView()) lines.push(...lockedView(theme, hub, entry, width, rows - 1));
	else {
		const kinds = segmentTrack(theme, MODEL_KIND_TABS, Math.max(0, MODEL_KIND_TABS.indexOf(hub.modelKindTab)));
		lines.push(
			truncate(
				` ${theme.style("dim", "Kind:")} ${kinds}  ${theme.style("dim", keyLabels(theme, ["alt+left", "alt+right"]))}`,
				width,
				theme.symbols.ellipsis,
			),
		);
		lines.push(
			...modelBrowserRows(
				theme,
				hub.browser.view(key => theme.symbols.symbol(key)),
				width,
			),
		);
	}
	while (lines.length < rows) lines.push("");
	return lines.slice(0, rows);
}

/** The footer's key hints: the open form's, else the view's with the Judge's native-route keys. */
export function footerHint(theme: Theme, hub: ModelHubState): string {
	const cancel = bindingGlyph("tui.select.cancel", "escape", theme);
	const test = hub.canTestNativeRoute() ? ` · ${keyLabel(theme, "ctrl+t")} test route` : "";
	if (hub.nativeRouteForm) {
		const move = hub.nativeRouteForm.step.choices ? `${selectNavGlyphs(theme)} choose · ` : "";
		return `${move}${keyLabel(theme, "enter")} ${hub.nativeSubmitLabel().toLowerCase()}${test} · ${cancel} cancel`;
	}
	const route = hub.canEditNativeRoute() ? ` · ${keyLabel(theme, "ctrl+r")} native route` : "";
	const create = hub.canCreateNativeJudge() ? ` · ${keyLabel(theme, "ctrl+n")} add native judge` : "";
	return `${viewFooterHint(theme, hub)}${route}${create}`;
}

/** The footer's key hints for the current view. */
function viewFooterHint(theme: Theme, hub: ModelHubState): string {
	const enter = keyLabel(theme, "enter");
	const cancel = bindingGlyph("tui.select.cancel", "escape", theme);
	const upDown = selectNavGlyphs(theme);
	const left = keyLabel(theme, "left");
	const enterRight = keyLabels(theme, ["enter", "right"]);
	const kind = keyLabels(theme, ["alt+left", "alt+right"]);
	const strip = hub.strip;
	if (strip) {
		if (strip.kind === "name") {
			if (strip.purpose === "compaction")
				return `${enter} ${compactionConfirmPending(strip) ? "accept" : "set"} compaction point · ${cancel} cancel`;
			if (strip.purpose === "preset") return `${enter} save preset · ${cancel} cancel`;
			return `${enter} create + pick model · ${cancel} cancel`;
		}
		const choose = keyLabels(theme, ["left", "right"]);
		if (strip.kind === "role") return `${choose} choose · ${enter} assign/clear · ${cancel} cancel`;
		if (strip.kind === "scope") return `${choose} save scope · ${enter} choose · ${cancel} cancel`;
		return `${choose} thinking level · ${enter} apply · ${cancel} keep`;
	}
	const assigning = hub.assigning;
	if (assigning !== null) {
		if (hub.focus === "scope")
			return `${enterRight} models · ${upDown} providers · type to search · ${kind} kind · ${cancel} cancel`;
		const browse = `${upDown} models · ${left} providers · type to search · ${kind} kind · ${cancel} cancel`;
		const pick =
			assigning.kind === "fallback"
				? "pick fallback"
				: assigning.kind === "fallbackKey"
					? "pick the protected model"
					: "assign";
		return `${enter} ${pick} · ${browse}`;
	}
	const entry = hub.activeEntry();
	if (entry.kind === "roles") {
		const presets = hub.presets().names.length > 0;
		if (hub.focus !== "list")
			return `${upDown} providers · ${enterRight} roles · ${kind} tabs${presets ? ` · ${keyLabels(theme, ["ctrl+left", "ctrl+right"])} preset` : ""} · ${cancel} close`;
		// A live query takes printable keys, so the letter commands rest.
		if (hub.browser.query.length > 0)
			return `${upDown} rows · ${enter} pick · type to search · ${left} providers · ${cancel} close`;
		const row = hub.rolesRows[hub.roleIndex];
		const compaction = hub.callbacks.onCompactionPointChange && hub.roleRowModel() ? " · k compaction limit" : "";
		if (row?.kind === "fallback") {
			const thinking = hub.resolveFallbackEntry(row.role, row.chainIndex) ? " · t thinking" : "";
			return `${upDown} rows · ${enter} replace · f add another · x remove${thinking}${compaction} · [/] reorder · ${left} providers`;
		}
		if (row?.kind === "chainKey")
			return `${upDown} rows · ${keyLabels(theme, ["enter", "f"])} add fallback · x clear chain · ${left} providers`;
		if (row?.kind === "newFallback")
			return `${upDown} rows · ${enter} new model/provider fallback chain · ${left} providers`;
		const thinking = row?.kind === "role" && hub.roleThinkingTarget(row.role) ? " · t thinking" : "";
		const save = hub.callbacks.onSavePreset ? " · s save preset" : "";
		const switchPreset = presets ? ` · ${keyLabels(theme, ["p", "shift+p"])} preset` : "";
		return `${upDown} rows · ${enter} pick · f fallback · x clear${thinking}${compaction} · c cycle · [/] reorder · n new${save}${switchPreset}`;
	}
	if (entry.kind === "provider" && entry.locked)
		return entry.oauth
			? `${enter} log in · ${upDown} providers · ${cancel} close`
			: `${upDown} providers · ${cancel} close`;
	const refresh = entry.kind === "provider" ? ` · ${keyLabel(theme, "f5")} refresh` : "";
	if (hub.focus === "scope")
		return `${enterRight} models · ${upDown} providers · type to search · ${kind} kind${refresh} · ${cancel} close`;
	return `${enter} assign roles · ${upDown} models · ${left} providers · type to search · ${kind} kind${refresh} · ${cancel} close`;
}

/** The open strip's footer row (and its chips' columns). */
export function stripRow(
	theme: Theme,
	hub: ModelHubState,
	strip: StripState,
	width: number,
): { row: string; ranges: HubChipRange[] } {
	if (strip.kind === "name") {
		const label =
			strip.purpose === "compaction"
				? `${strip.model.id} limit:`
				: strip.purpose === "preset"
					? "Preset name:"
					: "New role name:";
		// A compaction point is a few characters: a narrow field leaves room for its notice.
		const max = strip.purpose === "compaction" ? 10 : 32;
		const fieldWidth = Math.max(8, Math.min(max, width - visibleWidth(label) - 24));
		const field = padTo(caretField(theme, "> ", strip.field.text, strip.field.cursor, fieldWidth), fieldWidth);
		let hint: string;
		if (strip.purpose === "compaction") {
			const notice = compactionNotice(hub, strip);
			hint = theme.style(notice.style, notice.text);
		} else hint = theme.style("dim", "(letters, digits, - and _)");
		return {
			row: truncate(`${theme.style("accent", label)} ${field} ${hint}`, width, theme.symbols.ellipsis),
			ranges: [],
		};
	}
	let prefix: string;
	if (strip.kind === "role") prefix = `${theme.style("accent", strip.item.id)}${theme.style("dim", " →")} `;
	else {
		const info = hub.source.getRoleInfo(strip.role ?? "");
		prefix = `${theme.fg(info.color ?? "muted", (info.tag ?? strip.role ?? "").toLowerCase())}${theme.style("dim", ` · ${strip.item.id} →`)} `;
	}
	const symbol = (key: string): string => theme.symbols.symbol(key);
	const chips = strip.chips.map(chip => spansText(theme, hub.chipSpans(chip, symbol)));
	const start = hubChipWindowStart(
		chips.map(chip => visibleWidth(` ${chip} `)),
		strip.index,
		Math.max(1, width - visibleWidth(prefix)),
	);
	return hubChipRow(theme, width, prefix, chips, strip.index, start);
}

/** The compaction field's note: the last error, a pending warning, the host's preview, else the input syntax. */
export function compactionNotice(
	hub: ModelHubState,
	strip: Extract<StripState, { purpose: "compaction" }>,
): { text: string; style: "error" | "warning" | "dim" } {
	if (strip.error) return { text: strip.error, style: "error" };
	if (strip.confirm && compactionConfirmPending(strip)) return { text: strip.confirm.message, style: "warning" };
	const value = strip.field.text;
	if (value.trim().length > 0) {
		const preview = hub.callbacks.previewCompactionPoint?.(strip.model, value);
		if (preview) return { text: preview, style: "dim" };
	}
	return { text: COMPACTION_INPUT_HINT, style: "dim" };
}

function paintHub(node: UiNode, cx: PaintContext) {
	const theme = cx.theme;
	const width = cx.width;
	const hub = hubOf(node);
	hub.version();
	const rows = hub.contentRows();
	const { sidebar, body } = hubGeometry(width, hub.entries);
	const now = hub.entries.some(entry => hub.isRefreshing(entry.providerId)) ? cx.now() : 0;
	const side = hubSidebarRows(
		theme,
		hub.entries,
		sidebar,
		rows,
		{ activeId: hub.activeEntryId, focused: hub.focus === "scope", scroll: hub.sidebarScroll() },
		(entry, index) => sidebarStyle(theme, hub, entry, index, now),
	);
	const pane = bodyRows(theme, hub, body, rows);
	// The open native-route form owns the footer: its hints, not a strip it was opened from.
	const strip = hub.nativeRouteForm ? null : hub.strip;
	const footer = strip
		? stripRow(theme, hub, strip, width - 4).row
		: truncate(theme.style("dim", footerHint(theme, hub)), width - 4, theme.symbols.ellipsis);
	const out = hubFrameRows(theme, width, "Models", side, pane, footer, sidebar);
	const hits: Hit[] = [{ row: 0, col: 0, width, height: out.length, node }];
	return { rows: out, hits };
}

defineRolePainter("picker", "omp.model-hub", paintHub);

defineRoleWidget("picker", "omp.model-hub", {
	mouse(node, mouse, at, _cx, hit) {
		const hub = hubOf(node);
		const strip = hub.strip;
		hub.routeMouse(
			{ row: at.row, col: at.col, button: mouse.button, action: mouse.action },
			hit.width,
			col => {
				if (!strip || strip.kind === "name") return undefined;
				const { ranges } = stripRow(currentTheme(), hub, strip, hit.width - 4);
				return ranges.find(range => col >= range.start && col < range.end)?.index;
			},
			content => nativeRouteChoiceAt(currentTheme(), hub, hit.width, content),
		);
		return true;
	},
});
