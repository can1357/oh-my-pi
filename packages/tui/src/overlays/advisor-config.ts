/**
 * Fullscreen `/advisor configure` overlay: a three-pane editor for the
 * `WATCHDOG.yml` advisor rosters.
 *
 * Layout (paints the whole alternate screen from row 0 so SGR mouse rows index
 * directly into the frame):
 *
 *   ┌ Project · <folder> ┬ <selected advisor> ─────────┐
 *   │ roster (own cursor)│ inline field editor          │
 *   ├ Global ────────────┤   Enabled / Name / Model /   │
 *   │ roster (own cursor)│   Tools / Instructions ...   │
 *   └────────────────────┴──────────────────────────────┘
 *
 * Both rosters are live at once (each backed by its own {@link SelectList} and
 * {@link WatchdogConfigDoc}); the right pane always edits the advisor under the
 * cursor of the *focused* roster. ←/→ (and clicks) move focus between the three
 * panes. Field editors (model browser, tools, thinking, name, instructions) open
 * inside the right pane, never as a separate screen.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Model, resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	type Component,
	Input,
	type MouseRoutable,
	replaceTabs,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "../index";
import { bottomBorder, row, splitBodyWidth, splitRow, topBorderSplit } from "../chrome/overlay-box";
import { fitLayoutLine } from "../components/layout/geometry";
import { sanitizeDisplayWarnings } from "../render/render-utils";
import type { TspPrefsProps, TspPrefsRow } from "@oh-my-pi/pi-wire";
import { col, node } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { formatKeyHints } from "../key-hint-format";
import { getSelectListTheme, theme } from "../theme";
import type { ConfiguredThinkingLevel } from "../thinking";
import { HookEditorComponent } from "./hook-editor";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserSource,
	type ResolvedModelRoleValue,
	sortModelItems,
} from "./model-browser";
import { formatModelSelectorValue, MAX_THINKING_SUFFIX_OPTIONS, parseModelString } from "./model-selector";

/**
 * Literal-first resolution of an advisor's stored model selector.
 *
 * Advisor values are concrete `provider/id[:effort]` selectors far more often
 * than role aliases, and real model ids contain colons (`z-route:free`). A
 * registered literal id therefore wins over any effort-suffix reading; only
 * when nothing matches literally do we fall back to the host's role
 * resolution (`pi/advisor`, role aliases, settings defaults).
 */
function resolveLiteralModelValue(
	current: string | undefined,
	models: readonly Model[],
): ResolvedModelRoleValue | undefined {
	if (!current) return undefined;
	const find = (provider: string, id: string): Model | undefined =>
		models.find(model => model.provider === provider && model.id === id);
	const slashIdx = current.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const literal = find(current.slice(0, slashIdx), current.slice(slashIdx + 1));
	if (literal) return { model: literal, explicitThinkingLevel: false };
	const parsed = parseModelString(current, {
		...MAX_THINKING_SUFFIX_OPTIONS,
		isLiteralModelId: (provider, id) => find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	const model = find(parsed.provider, parsed.id);
	if (!model) return undefined;
	return {
		model,
		thinkingLevel: parsed.thinkingLevel,
		explicitThinkingLevel: parsed.thinkingLevel !== undefined,
	};
}

/** One advisor declared in `WATCHDOG.yml`; its instructions specialize the shared baseline. */
export interface AdvisorConfig {
	name: string;
	/** Model selector with an optional `:level` thinking suffix, resolved like any other model override. */
	model?: string;
	/** Built-in tool names, including mutating tools; omitted uses read/grep/glob plus available recall, empty grants none. */
	tools?: string[];
	instructions?: string;
	/** Defaults to true; false retains the advisor in the roster and status displays without building its runtime. */
	enabled?: boolean;
	/** Maximum non-blocker notes per advisor prompt update (default 4); blockers are exempt. */
	maxNotesPerUpdate?: number;
}

/** Which level a `WATCHDOG.yml` lives at: the project root or the user agent dir. */
export type AdvisorConfigScope = "project" | "user";

/** Editable raw contents of one `WATCHDOG.yml`, without cross-level merging or `@import` expansion, for exact round trips. */
export interface WatchdogConfigDoc {
	instructions?: string;
	maxNotesPerUpdate?: number;
	advisors: AdvisorConfig[];
	/** Per-entry problems found while loading (dropped entries). Shown when the file becomes active in the editor. */
	warnings?: string[];
}

/** Live per-advisor runtime stats surfaced by the host session. */
export interface AdvisorConfigStat {
	name: string;
	sessionId?: string;
	status: string;
	model?: { provider: string };
	tokens: { input: number; output: number; cacheRead: number };
	cost: number;
	contextWindow: number;
	contextTokens: number;
}

/** Host callbacks: all disk + live-runtime effects flow through these. */
export interface AdvisorConfigCallbacks {
	/** Load a scope's `WATCHDOG.yml` into an editable doc (empty when absent). */
	loadDoc: (scope: AdvisorConfigScope) => Promise<WatchdogConfigDoc>;
	/** Persist the doc to the scope's file and rebuild the live advisors. */
	save: (scope: AdvisorConfigScope, doc: WatchdogConfigDoc) => Promise<void>;
	/** Tear down the overlay and restore the editor. */
	close: () => void;
	requestRender: () => void;
	/** Surface a transient status/warning line to the user. */
	notify: (message: string) => void;
	/**
	 * Surface a sticky warning (e.g. malformed entries in the file just made
	 * active by a scope switch). Falls back to `notify` when omitted.
	 */
	warn?: (message: string) => void;
	/** Live advisor usage stats; lets the editor show tokens/cost per advisor. */
	getAdvisorStats?: () => AdvisorConfigStat[];
	/** Reports normalized by the host to collapse shared credential pools. */
	getUsageReports?: () => Promise<UsageReport[] | null>;
	/** Filter to the advisor's active credential; absent identity includes every limit. */
	getQuotaLimitFilter?: (
		provider: string,
		sessionId: string | undefined,
	) => ((report: UsageReport, limit: UsageLimit) => boolean) | undefined;
}

export interface AdvisorConfigDeps {
	/** Catalog models offered by the picker when no scoped models are supplied. */
	getAvailableModels: () => Model[];
	/** Host preferences + role resolution consumed by the model browser. */
	browserSource: ModelBrowserSource;
	/** Tool names an advisor gets when `tools` is omitted. */
	defaultToolNames: ReadonlySet<string>;
	/** Edit instructions with the host's configured external editor. */
	externalEditor?: (text: string) => Promise<string | null>;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	availableToolNames: string[];
	/** Formatted advisor-role model shown for advisors without an explicit model (e.g. "anthropic/claude-..."). */
	defaultModelLabel?: string;
	/** Project folder name, shown as the project pane title. */
	projectName?: string;
}

const PREVIEW_WIDTH = 60;

/**
 * One-line provider quota display. The host supplies normalized usage reports
 * and an optional credential filter; the overlay owns only presentation.
 */
export function formatCompactQuota(
	provider: string,
	reports: UsageReport[],
	nowMs: number,
	includeLimit?: (report: UsageReport, limit: UsageLimit) => boolean,
): string | null {
	const byWindow = new Map<string, { limit: UsageLimit; fraction: number }>();
	for (const report of reports) {
		if (report.provider !== provider) continue;
		for (const limit of report.limits) {
			if (includeLimit && !includeLimit(report, limit)) continue;
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const key = limit.window?.id ?? limit.scope.windowId ?? "—";
			const existing = byWindow.get(key);
			if (!existing || fraction > existing.fraction) byWindow.set(key, { limit, fraction });
		}
	}
	if (byWindow.size === 0) return null;
	const entries = [...byWindow.values()].sort((a, b) => b.fraction - a.fraction);
	const lines: string[] = [];
	for (const { limit, fraction } of entries) {
		const pct = Math.round(fraction * 100);
		const windowLabel = limit.window?.label ?? limit.scope.windowId ?? "—";
		const identity = limit.label.trim();
		const header = identity && identity !== windowLabel ? `${windowLabel} (${identity})` : windowLabel;
		const parts = [`${header}: ${pct}% used`];
		const window = limit.window;
		if (window?.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt > nowMs) {
			parts.push(`${window.resetLabel ?? "resets"} in ${formatDuration(window.resetsAt - nowMs)}`);
		}
		lines.push(parts.join(" · "));
	}
	return `Quota: ${lines.join(" │ ")}`;
}

function previewLine(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Omitted means default read/grep/glob; an explicit empty set means no tools. */
function commitTools(
	selected: ReadonlySet<string>,
	all: readonly string[],
	defaults: ReadonlySet<string>,
): string[] | undefined {
	if (selected.size === 0) return [];
	if (selected.size === defaults.size) {
		let matchesDefault = true;
		for (const name of defaults) {
			if (!selected.has(name)) {
				matchesDefault = false;
				break;
			}
		}
		if (matchesDefault) return undefined;
	}
	return all.filter(name => selected.has(name));
}

function formatAdvisorTools(tools: readonly string[] | undefined, emptyLabel: string): string {
	if (tools === undefined) return "read, grep, glob (default)";
	return tools.length === 0 ? emptyLabel : tools.join(", ");
}

/** Soft-wrap text to `width`, preserving embedded newlines. */
function wrap(text: string | undefined, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

type Pane = "project" | "user" | "editor";
/** What the right pane currently hosts. */
type EditorMode = "fields" | "name" | "model" | "thinking" | "tools" | "instructions";

interface ScopeState {
	doc: WatchdogConfigDoc;
	list: SelectList;
	dirty: boolean;
	revision: number;
	loading: boolean;
	failed: boolean;
	/** Remembered roster row value so rebuilds keep the cursor. */
	cursor: string | undefined;
}

/**
 * Fullscreen advisor-configuration overlay. Implements {@link Component} directly
 * (rather than extending Container) so it owns the whole frame and the mouse
 * geometry needed to make every row clickable.
 */
/** Display form of advisor text: no tabs, control or ANSI sequences, one line. */
function displayText(value: string): string {
	return replaceTabs(sanitizeText(value)).replace(/\s+/g, " ").trim();
}

export class AdvisorConfigOverlayComponent implements Component {
	#tui: TUI;
	#deps: AdvisorConfigDeps;
	#scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#availableToolNames: readonly string[];
	#defaultModelLabel: string | undefined;
	#projectName: string | undefined;
	#cb: AdvisorConfigCallbacks;
	#cachedReports: UsageReport[] | null = null;

	#savePending = false;
	#scopes: Record<AdvisorConfigScope, ScopeState>;
	#focus: Pane;
	#mode: EditorMode = "fields";
	/** Right-pane component (field list or an open field editor). */
	#editor: Component = new SelectList([], 1, getSelectListTheme());
	#applyPendingTools: (() => void) | undefined;
	/** Remembered field-list row so returning from a field editor lands on it. */
	#fieldCursor: string | undefined;
	#editorScroll = 0;
	#editorContentOffset = 2;
	#editorWindowRows = 0;
	#editorWindowWidth = 0;
	#editorHasOverflow = false;

	// Frame geometry from the last render (frame paints from screen row 0).
	#sidebarWidth = 0;
	#dividerCol = 0;
	#projectRowStart = 0;
	#projectRows = 0;
	#userRowStart = 0;
	#userRows = 0;

	constructor(
		tui: TUI,
		deps: AdvisorConfigDeps,
		initialScope: AdvisorConfigScope,
		initialDoc: WatchdogConfigDoc,
		callbacks: AdvisorConfigCallbacks,
	) {
		this.#tui = tui;
		this.#deps = deps;
		this.#scopedModels = deps.scopedModels;
		this.#availableToolNames = deps.availableToolNames;
		this.#defaultModelLabel = deps.defaultModelLabel;
		this.#projectName = deps.projectName === undefined ? undefined : displayText(deps.projectName);
		this.#cb = callbacks;
		this.#focus = initialScope;
		const empty = (): WatchdogConfigDoc => ({ advisors: [] });
		this.#scopes = {
			project: this.#newScope(initialScope === "project" ? initialDoc : empty()),
			user: this.#newScope(initialScope === "user" ? initialDoc : empty()),
		};
		const other: AdvisorConfigScope = initialScope === "project" ? "user" : "project";
		this.#scopes[other].loading = true;
		callbacks
			.loadDoc(other)
			.then(doc => {
				this.#scopes[other].doc = doc;
				if (doc.warnings?.length) {
					const message = `WATCHDOG.yml: ${sanitizeDisplayWarnings(doc.warnings).join("; ")}`;
					if (this.#cb.warn) this.#cb.warn(message);
					else this.#cb.notify(message);
				}
				this.#scopes[other].loading = false;
				this.#rebuildRoster(other);
				if (this.#focus === other) this.#showFields();
				this.#cb.requestRender();
			})
			.catch(err => {
				this.#scopes[other].loading = false;
				this.#scopes[other].failed = true;
				this.#rebuildRoster(other);
				callbacks.notify(`Advisor config: ${err instanceof Error ? err.message : String(err)}`);
				this.#cb.requestRender();
			});
		this.#rebuildRoster("project");
		this.#rebuildRoster("user");
		this.#showFields();
		if (callbacks.getUsageReports) {
			callbacks
				.getUsageReports()
				.then(r => {
					this.#cachedReports = r;
					this.#cb.requestRender();
				})
				.catch(() => {});
		}
	}

	#newScope(doc: WatchdogConfigDoc): ScopeState {
		return {
			doc,
			list: new SelectList([], 1, getSelectListTheme()),
			dirty: false,
			revision: 0,
			loading: false,
			failed: false,
			cursor: undefined,
		};
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const bodyRows = Math.max(6, height - 3);
		this.#sidebarWidth = Math.max(22, Math.min(42, Math.floor(width * 0.34)));
		this.#dividerCol = this.#sidebarWidth + 3;
		const bodyWidth = splitBodyWidth(width, this.#sidebarWidth);

		// Left column: project roster on top, global roster below, each half the body.
		const projectRows = Math.max(2, Math.floor((bodyRows - 1) / 2));
		const userRows = Math.max(2, bodyRows - 1 - projectRows);
		this.#scopes.project.list.setMaxVisible(Math.max(1, projectRows - 1));
		this.#scopes.user.list.setMaxVisible(Math.max(1, userRows - 1));
		// Only the focused pane shows a cursor; the others keep their selection silently.
		this.#scopes.project.list.setFocused(this.#focus === "project");
		this.#scopes.user.list.setFocused(this.#focus === "user");
		if (this.#editor instanceof SelectList) this.#editor.setFocused(this.#focus === "editor");
		const left: string[] = [];
		left.push(...this.#padTo(this.#scopes.project.list.render(this.#sidebarWidth), projectRows));
		left.push(this.#sectionRule("user", this.#sidebarWidth));
		left.push(...this.#padTo(this.#scopes.user.list.render(this.#sidebarWidth), userRows));

		const dirty = this.#scopes.project.dirty || this.#scopes.user.dirty;
		const title = `${this.#paneTitle("project")}${dirty ? `  ${theme.symbol("status.pending")} unsaved` : ""}`;
		const right = this.#editorWindow(bodyWidth, bodyRows);

		const out: string[] = [];
		out.push(topBorderSplit(width, title, this.#sidebarWidth));
		this.#projectRowStart = 1;
		this.#projectRows = projectRows;
		this.#userRowStart = 1 + projectRows + 1;
		this.#userRows = userRows;
		for (let i = 0; i < bodyRows; i++) {
			out.push(splitRow(left[i] ?? "", right[i] ?? "", width, this.#sidebarWidth));
		}
		out.push(row(theme.fg("dim", this.#footerHint()), width));
		out.push(bottomBorder(width));
		return out;
	}

	#padTo(lines: readonly string[], rows: number): string[] {
		const out = lines.slice(0, rows);
		while (out.length < rows) out.push("");
		return out;
	}

	#paneTitle(scope: AdvisorConfigScope): string {
		const label = scope === "project" ? `Project · ${this.#projectName ?? "project"}` : "Global";
		const focused = this.#focus === scope;
		return focused ? theme.fg("accent", label) : theme.fg("dim", label);
	}

	#sectionRule(scope: AdvisorConfigScope, width: number): string {
		const label = ` ${this.#paneTitle(scope)} `;
		const rule = theme.fg(
			"border",
			theme.boxRound.horizontal.repeat(Math.max(0, width - 1 - Bun.stringWidth(Bun.stripANSI(label)))),
		);
		return fitLayoutLine(`${theme.fg("border", theme.boxRound.horizontal)}${label}${rule}`, width);
	}

	#footerHint(): string {
		// Keys and separator come from the active symbol preset, so the ascii preset
		// never shows arrow or middle-dot glyphs.
		const k = formatKeyHints;
		const join = (...parts: string[]): string => parts.filter(Boolean).join(` ${theme.sep.dot} `);
		const move = k(["up", "down"]);
		const enter = k("enter");
		const esc = k("escape");
		const left = k("left");
		const right = k("right");
		if (this.#focus === "editor") {
			switch (this.#mode) {
				case "name":
					return join("Type a name", `${enter} save`, `${esc} cancel`);
				case "model":
					return join("Type to search", `${enter} / click twice picks`, `${esc} back`);
				case "thinking":
					return join(`${enter} / click pick`, `${esc} back`);
				case "tools":
					return join(`${enter} / click toggle`, `Done or ${esc} apply`, `${left} rosters`);
				case "instructions":
					return "";
				default:
					return join(`${move} move`, `${enter} / click edit`, `${left} rosters`, `${esc} close`);
			}
		}
		return join(`${move} move`, `${right} / ${enter} edit`, "click select", `${esc} close`);
	}

	#editorWindow(bodyWidth: number, rows: number): string[] {
		this.#editorWindowWidth = bodyWidth;
		this.#editorWindowRows = rows;
		const lines = this.#editorContent(bodyWidth);
		const overflow = lines.length > rows;
		// When the content overflows, the last window row holds the "↓ more" / "(end)" marker, so one row
		// fewer shows content; scrolling must be able to bring the final content row above the marker.
		const visibleRows = overflow ? rows - 1 : rows;
		const maxScroll = Math.max(0, lines.length - visibleRows);
		this.#editorScroll = Math.min(this.#editorScroll, maxScroll);
		const window = lines.slice(this.#editorScroll, this.#editorScroll + visibleRows);
		this.#editorHasOverflow = overflow;
		if (overflow) {
			window.push(
				this.#editorScroll + visibleRows < lines.length
					? theme.fg("dim", `  ↓ ${lines.length - this.#editorScroll - visibleRows} more`)
					: theme.fg("dim", "  (end)"),
			);
		}
		return this.#padTo(window, rows);
	}

	#editorContent(bodyWidth: number): string[] {
		const target = this.#selected();
		const header = target
			? theme.bold(
					`${displayText(target.advisor.name) || "(unnamed)"}  ${theme.fg("dim", `· ${this.#scopeLabel(target.scope)}`)}`,
				)
			: theme.bold(this.#focus === "editor" ? "Advisor" : this.#scopeLabel(this.#focus));
		const scope = target?.scope ?? (this.#focus === "editor" ? this.#lastRosterFocus : this.#focus);
		const warnings = this.#scopes[scope].doc.warnings;
		const lines: string[] = warnings?.length
			? [
					theme.fg("warning", "Config problems — dropped while loading:"),
					...sanitizeDisplayWarnings(warnings).flatMap(warning =>
						wrap(warning, bodyWidth).map(line => theme.fg("warning", line)),
					),
					"",
					header,
					"",
				]
			: [header, ""];
		this.#editorContentOffset = lines.length;
		if (this.#mode === "fields") {
			if (target) {
				lines.push(...this.#editor.render(bodyWidth));
				lines.push("", ...this.#usageLines(target.advisor));
			} else {
				lines.push(...this.#editor.render(bodyWidth));
			}
		} else {
			lines.push(...this.#editor.render(bodyWidth));
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	#scopeLabel(scope: AdvisorConfigScope): string {
		return scope === "project" ? `Project · ${this.#projectName ?? "project"}` : "Global";
	}

	#usageLines(advisor: AdvisorConfig): string[] {
		const liveStat = this.#cb.getAdvisorStats?.().find(s => s.name === (advisor.name || "default"));
		if (!liveStat || (liveStat.status !== "running" && liveStat.status !== "quota_exhausted")) return [];
		const lines: string[] = [theme.fg("dim", "Usage:")];
		const spendParts = [
			`${liveStat.tokens.input.toLocaleString()} in`,
			`${liveStat.tokens.output.toLocaleString()} out`,
		];
		if (liveStat.tokens.cacheRead > 0) spendParts.push(`${liveStat.tokens.cacheRead.toLocaleString()} cache`);
		lines.push(theme.fg("dim", `  Tokens: ${spendParts.join(", ")}`));
		if (liveStat.cost > 0) lines.push(theme.fg("dim", `  Cost: $${liveStat.cost.toFixed(4)}`));
		if (liveStat.contextWindow > 0) {
			const pct = Math.round((liveStat.contextTokens / liveStat.contextWindow) * 100);
			lines.push(
				theme.fg(
					"dim",
					`  Context: ${liveStat.contextTokens.toLocaleString()}/${liveStat.contextWindow.toLocaleString()} (${pct}%)`,
				),
			);
		}
		const quotaProvider =
			(advisor.model?.includes("/") ? advisor.model.split("/")[0] : null) ?? liveStat.model?.provider;
		if (this.#cachedReports && quotaProvider) {
			const includeLimit = this.#cb.getQuotaLimitFilter?.(quotaProvider, liveStat.sessionId);
			const quota = formatCompactQuota(quotaProvider, this.#cachedReports, Date.now(), includeLimit);
			if (quota) lines.push(theme.fg("dim", `  ${quota}`));
		}
		return lines;
	}

	// ───────────────────────────── native (Tern Surface Protocol) ─────────────────────────────

	/** Docks as a side sheet beside the transcript, like `/settings`, when the terminal draws `prefs` with `aside`. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("prefs") && cx.feature("aside");
	}

	/**
	 * The native settings page (`prefs`) when the terminal draws it: one page per advisor and one
	 * for each scope's shared instructions, the advisor's fields as typed rows, the file actions,
	 * and the classic editors (model, tools, instructions) over the page. Any other terminal keeps
	 * the three-pane frame, drawn from `render()`.
	 */
	describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("prefs") ? this.#describePrefs() : null;
	}

	/** The page the roster selection shows: `<scope>:advisor:<n>`, else that scope's `<scope>:shared`. */
	#pageKey(): string {
		const scope = this.#focus === "editor" ? this.#lastRosterFocus : this.#focus;
		const value = this.#scopes[scope].list.getSelectedItem()?.value ?? "";
		return /^advisor:\d+$/.test(value) ? `${scope}:${value}` : `${scope}:shared`;
	}

	#parsePage(key: string): { scope: AdvisorConfigScope; index: number } | undefined {
		const match = /^(project|user):(?:advisor:(\d+)|shared)$/.exec(key);
		if (!match) return undefined;
		return { scope: match[1] === "user" ? "user" : "project", index: match[2] === undefined ? -1 : Number(match[2]) };
	}

	/** Select a page's roster entry and rebuild the classic editor pane for it, keeping both views in step. */
	#openPage(key: string): void {
		const page = this.#parsePage(key);
		if (!page) return;
		const state = this.#scopes[page.scope];
		if (state.loading || state.failed) return;
		const value = page.index < 0 ? "shared" : `advisor:${page.index}`;
		state.list.setSelectedValue(value);
		state.cursor = value;
		this.#focus = page.scope;
		this.#lastRosterFocus = page.scope;
		this.#showFields();
		this.#cb.requestRender();
	}

	#describePrefs(): NativeNode {
		const pageKey = this.#pageKey();
		const page = this.#parsePage(pageKey) ?? { scope: this.#lastRosterFocus, index: -1 };
		const state = this.#scopes[page.scope];
		const advisor = page.index >= 0 ? state.doc.advisors[page.index] : undefined;
		const dirty = this.#scopes.project.dirty || this.#scopes.user.dirty;

		const pages: TspPrefsProps["pages"][number][] = [];
		for (const scope of ["project", "user"] as const) {
			const scopeState = this.#scopes[scope];
			const group = this.#scopeLabel(scope);
			const disabled = scopeState.loading
				? "Loading…"
				: scopeState.failed
					? "Unable to load configuration"
					: undefined;
			for (const [index, entry] of scopeState.doc.advisors.entries()) {
				pages.push({
					id: `${scope}:advisor:${index}`,
					label: displayText(entry.name) || "(unnamed)",
					icon: "advisor",
					group,
				});
			}
			pages.push({
				id: `${scope}:shared`,
				label: "Shared instructions",
				icon: "doc",
				group,
				...(disabled === undefined ? {} : { disabled }),
			});
		}

		const sections: TspPrefsProps["sections"][number][] = [];
		let lead: string;
		if (state.loading || state.failed) {
			lead = state.loading
				? "Loading this file…"
				: "Unable to load this file; it stays read-only until it loads successfully.";
		} else {
			lead = advisor
				? "An advisor watches the session and leaves notes; set its model, tools and instructions here."
				: `Instructions every advisor in ${this.#scopeLabel(page.scope)} gets before its own.`;
			if (state.doc.warnings?.length) {
				sections.push({
					id: "warnings",
					title: "Config problems",
					rows: sanitizeDisplayWarnings(state.doc.warnings).map((warning, i) => ({
						id: `warning:${i}`,
						label: "Dropped while loading",
						warning,
						control: { k: "action", label: "Save to rewrite", act: "save" },
					})),
				});
			}
			if (advisor) {
				const model = advisor.model?.trim();
				const modelDefault = this.#defaultModelLabel ?? "advisor role default";
				const rows: TspPrefsRow[] = [
					{
						id: "toggleEnabled",
						label: "Enabled",
						hint: "Run this advisor alongside the session.",
						control: { k: "switch", on: advisor.enabled !== false },
					},
					{ id: "name", label: "Name", control: { k: "text", value: advisor.name } },
					{
						id: "model",
						label: "Model",
						hint: model ? undefined : `Uses the advisor role default (${this.#defaultModelLabel ?? "unset"}).`,
						changed: model ? true : undefined,
						defaultLabel: model ? modelDefault : undefined,
						control: { k: "action", label: model || modelDefault, act: "edit" },
					},
				];
				if (model) {
					rows.push({
						id: "resetModel",
						label: "Model default",
						control: { k: "action", label: "Reset to advisor role default", act: "reset" },
					});
				}
				rows.push(
					{
						id: "tools",
						label: "Tools",
						hint: "None means no tools; read, grep and glob are the default.",
						changed: advisor.tools !== undefined,
						control: {
							k: "multi",
							values: advisor.tools ?? [...this.#deps.defaultToolNames],
							options: this.#availableToolNames.map(name => ({ value: name, label: name })),
						},
					},
					{
						id: "instructions",
						label: "Instructions",
						hint: previewLine(advisor.instructions),
						control: { k: "action", label: "Edit…", act: "edit" },
					},
					{
						id: "delete",
						label: "Delete this advisor",
						control: { k: "action", label: "Delete", act: "delete" },
					},
				);
				sections.push({ id: "advisor", title: displayText(advisor.name) || "Advisor", rows });
			} else {
				sections.push({
					id: "shared",
					title: `Shared instructions · ${this.#scopeLabel(page.scope)}`,
					rows: [
						{
							id: "instructions",
							label: "Instructions",
							hint: previewLine(state.doc.instructions),
							control: { k: "action", label: "Edit…", act: "edit" },
						},
					],
				});
			}
			sections.push({
				id: "file",
				title: `WATCHDOG.yml · ${this.#scopeLabel(page.scope)}`,
				rows: [
					{
						id: "save",
						label: "Save & apply",
						hint: "Write this file and reload the live advisors without a restart.",
						warning: state.dirty ? "Unsaved changes" : undefined,
						control: { k: "action", label: "Save", act: "save" },
					},
					{
						id: "add",
						label: "Add advisor",
						hint: "Create a new advisor entry, then set its model, tools and instructions.",
						control: { k: "action", label: "Add", act: "add" },
					},
				],
			});
		}

		// A classic picker or editor (model, tools, instructions) sits over the page while it is open.
		const editor = this.#mode === "fields" ? undefined : this.#editor;
		const props: TspPrefsProps = {
			title: dirty ? "Advisors · unsaved" : "Advisors",
			pages,
			page: pageKey,
			lead,
			sections,
			focus:
				this.#mode === "fields" && this.#editor instanceof SelectList
					? (this.#editor.getSelectedItem()?.value ?? null)
					: null,
			editing: null,
		};
		const signature = JSON.stringify(props);
		const prev = this.#nativePrefs;
		if (prev && prev.signature === signature && prev.editor === editor) return prev.node;
		const children: NativeChild[] = editor ? [col([editor], { role: "omp.prefs.editor" })] : [];
		const root = node("prefs", props, children);
		this.#nativePrefs = { signature, editor, node: root };
		return root;
	}

	/**
	 * Native page events: a page opens that advisor (or the scope's shared instructions), a field
	 * change writes through the same rules as the classic pickers, a field's action button runs its
	 * editor, and closing an open editor cancels it like Esc.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.key !== "") return;
		const page = this.#parsePage(this.#pageKey());
		if (!page) return;
		switch (event.type) {
			case "action": {
				if (event.act === "page" && event.value) {
					this.#openPage(event.value);
					return;
				}
				if (event.act === "close") {
					if (event.value !== undefined) this.handleInput("\x1b");
					else this.#cb.close();
					return;
				}
				if (event.act === "save" || event.act === "add") {
					void this.#onRosterSelect(page.scope, event.act).catch(err => {
						this.#cb.notify(`Advisor config: ${err instanceof Error ? err.message : String(err)}`);
					});
					return;
				}
				const field = event.value;
				if (field === undefined) return;
				const state = this.#scopes[page.scope];
				if (state.loading || state.failed) return;
				this.#focusEditor();
				if (page.index < 0) {
					if (field === "instructions") this.#showInstructionsEditor(page.scope, -1);
					return;
				}
				this.#onFieldSelect(page.scope, page.index, field);
				return;
			}
			case "change": {
				if (page.index < 0) return;
				const state = this.#scopes[page.scope];
				if (state.loading || state.failed) return;
				const advisor = state.doc.advisors[page.index];
				if (!advisor || !this.#applyNativeChange(advisor, event.item, event.value)) return;
				this.#markDirty(page.scope);
				if (this.#mode === "fields") this.#showFields();
				this.#cb.requestRender();
				return;
			}
			default:
				return;
		}
	}

	/** Apply one typed row value to an advisor with the classic pickers' rules; `null` resets to the default. */
	#applyNativeChange(
		advisor: AdvisorConfig,
		item: string,
		value: Extract<NativeUiEvent, { type: "change" }>["value"],
	): boolean {
		switch (item) {
			case "toggleEnabled":
				if (value === null) advisor.enabled = undefined;
				else if (typeof value === "boolean") advisor.enabled = value ? undefined : false;
				else return false;
				return true;
			case "name": {
				if (typeof value !== "string" || !value.trim()) return false;
				advisor.name = value.trim();
				return true;
			}
			case "tools": {
				if (value === null) {
					advisor.tools = undefined;
					return true;
				}
				if (typeof value !== "object") return false;
				advisor.tools = commitTools(new Set(value), this.#availableToolNames, this.#deps.defaultToolNames);
				return true;
			}
			default:
				return false;
		}
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		if (this.#focus !== "editor") {
			if (data === "\x1b[C") {
				// → only moves focus where there is something to edit: an advisor's
				// field list, or the shared-instructions text editor (as if ↵). Rows
				// like "+ Add advisor" / "Save & apply" / the empty placeholder keep
				// the cursor in the roster instead of dropping it into the void.
				const scope = this.#focus;
				if (this.#scopes[scope].loading) return;
				const value = this.#scopes[scope].list.getSelectedItem()?.value;
				if (value === "shared") {
					this.#focusEditor();
					this.#showInstructionsEditor(scope, -1);
				} else if (this.#selected()) {
					this.#showFields();
					this.#focusEditor();
				}
				return;
			}
			if (data === "\x1b[D") {
				return;
			}
			// The two rosters read as one ring, project above global. ↓ past a roster's end and ↑ above
			// its top cross into the neighbouring roster, keeping that roster's own cursor; at the ends
			// of the ring the move wraps across (↑ from the project's top lands on the global roster's
			// last row, ↓ from the global's bottom on the project's first) rather than inside one roster.
			const list = this.#scopes[this.#focus].list;
			const at = list.getSelectedIndex();
			const down = data === "\x1b[B" && at >= list.getItemCount() - 1;
			const up = data === "\x1b[A" && at <= 0;
			if (down || up) {
				const crossing = down ? this.#focus === "project" : this.#focus === "user";
				const target: AdvisorConfigScope = this.#focus === "project" ? "user" : "project";
				const targetState = this.#scopes[target];
				// Wrapping across the ring's ends into a roster whose file is still loading would drop the
				// cursor onto placeholder rows that cannot be acted on, so that case keeps the roster's own wrap.
				if (crossing || !targetState.loading) {
					if (!crossing) {
						targetState.list.setSelectedIndex(down ? 0 : targetState.list.getItemCount() - 1);
						targetState.cursor = targetState.list.getSelectedItem()?.value;
					}
					this.#focus = target;
					this.#showFields();
					return;
				}
			}
			list.handleInput(data);
			return;
		}
		// Editor pane: ← returns to the rosters unless a text editor is open.
		if (data === "\x1b[D" && this.#mode === "tools") {
			this.#applyPendingTools?.();
			this.#applyPendingTools = undefined;
			this.#focus = this.#lastRosterFocus;
			this.#showFields();
			return;
		}
		if (data === "\x1b[D" && this.#mode !== "name" && this.#mode !== "instructions" && this.#mode !== "model") {
			this.#focus = this.#lastRosterFocus;
			this.#cb.requestRender();
			return;
		}
		this.#editor.handleInput?.(data);
		this.#revealEditorSelection();
	}

	/**
	 * A key moved the nested list's cursor without touching the pane's scroll. Bring its row into the
	 * visible window, so Enter never toggles a row that is clipped or hidden behind the overflow marker.
	 * The wheel is not pulled back: this runs only after keyboard input.
	 */
	#revealEditorSelection(): void {
		if (!(this.#editor instanceof SelectList) || this.#editorWindowRows === 0) return;
		const visibleRows = this.#editorHasOverflow ? this.#editorWindowRows - 1 : this.#editorWindowRows;
		const selectedLine = this.#editorContentOffset + this.#editor.getSelectedIndex();
		if (selectedLine < this.#editorScroll) this.#editorScroll = selectedLine;
		else if (selectedLine >= this.#editorScroll + visibleRows) this.#editorScroll = selectedLine - visibleRows + 1;
	}

	/** Forward enhanced-paste transports into a multiline instructions editor. */
	pasteText(text: string): void {
		if (this.#editor instanceof HookEditorComponent) this.#editor.pasteText(text);
	}

	#lastRosterFocus: AdvisorConfigScope = "project";
	/** The last native page built, reused while its data and open editor are unchanged. */
	#nativePrefs: { signature: string; editor: Component | undefined; node: NativeNode } | undefined;

	#focusEditor(): void {
		if (this.#focus !== "editor") this.#lastRosterFocus = this.#focus;
		this.#focus = "editor";
		this.#cb.requestRender();
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		if (event.col >= this.#dividerCol) {
			let editorRow = event.row - 1 - this.#editorContentOffset + this.#editorScroll;
			const markerRow = this.#editorWindowRows;
			const inEditorWindow = event.row >= 1 && event.row <= markerRow;
			const onOverflowMarker = this.#editorHasOverflow && event.row === markerRow;
			if (event.wheel !== null) {
				const el = this.#editor as Partial<MouseRoutable>;
				const nestedVisible =
					this.#mode !== "fields" &&
					typeof el.routeMouse === "function" &&
					inEditorWindow &&
					event.row > this.#editorContentOffset - this.#editorScroll &&
					event.row < markerRow;
				if (nestedVisible) {
					el.routeMouse?.(event, editorRow, event.col - this.#dividerCol - 1);
				} else {
					this.#editorScroll = Math.max(0, this.#editorScroll + event.wheel);
				}
				this.#cb.requestRender();
				return true;
			}
			if (!inEditorWindow || onOverflowMarker || editorRow < 0) return true;
			if (event.leftClick) {
				if (this.#focus !== "editor") {
					this.#showFields();
					this.#editorWindow(this.#editorWindowWidth, this.#editorWindowRows);
					editorRow = event.row - 1 - this.#editorContentOffset + this.#editorScroll;
				}
				this.#focusEditor();
			}
			const el = this.#editor as Partial<MouseRoutable>;
			if (typeof el.routeMouse === "function") el.routeMouse(event, editorRow, event.col - this.#dividerCol - 1);
			return true;
		}
		const inProject = event.row >= this.#projectRowStart && event.row < this.#projectRowStart + this.#projectRows;
		const inUser = event.row >= this.#userRowStart && event.row < this.#userRowStart + this.#userRows;
		const scope: AdvisorConfigScope | undefined = inProject ? "project" : inUser ? "user" : undefined;
		if (!scope) return false;
		if (event.wheel !== null && this.#focus === "editor" && this.#mode !== "fields") return true;
		if (event.leftClick && this.#focus === "editor" && (this.#mode === "name" || this.#mode === "instructions"))
			return true;
		if (event.leftClick && this.#focus !== scope) {
			this.#applyPendingTools?.();
			this.#focus = scope;
			this.#showFields();
		}
		const start = scope === "project" ? this.#projectRowStart : this.#userRowStart;
		this.#scopes[scope].list.routeMouse(event, event.row - start, event.col - 2);
		return true;
	}
	// ───────────────────────────── rosters ───────────────────────────

	#selected(): { scope: AdvisorConfigScope; index: number; advisor: AdvisorConfig } | undefined {
		const scope = this.#focus === "editor" ? this.#lastRosterFocus : this.#focus;
		const value = this.#scopes[scope].list.getSelectedItem()?.value;
		const match = value ? /^advisor:(\d+)$/.exec(value) : null;
		if (!match) return undefined;
		const index = Number(match[1]);
		const advisor = this.#scopes[scope].doc.advisors[index];
		return advisor ? { scope, index, advisor } : undefined;
	}

	#rebuildRoster(scope: AdvisorConfigScope): void {
		const state = this.#scopes[scope];
		if (state.failed) {
			state.list = new SelectList(
				[
					{
						value: "load-failed",
						label: "Unable to load configuration",
						description: "Read-only until the file loads successfully",
					},
				],
				1,
				getSelectListTheme(),
			);
			return;
		}
		const items: SelectItem[] = state.doc.advisors.map((advisor, index) => ({
			value: `advisor:${index}`,
			label: `${theme.symbol(advisor.enabled === false ? "status.disabled" : "status.enabled")} ${displayText(advisor.name) || "(unnamed)"}`,
			description: this.#advisorSummary(advisor),
		}));
		if (items.length === 0)
			items.push({ value: "empty", label: "(no advisors)", description: "role default applies" });
		items.push({ value: "add", label: "+ Add advisor" });
		items.push({ value: "shared", label: "Shared instructions", description: previewLine(state.doc.instructions) });
		items.push({
			value: "save",
			label: state.dirty ? `Save & apply ${theme.symbol("status.pending")}` : "Save & apply",
		});
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		const remembered = state.cursor ? items.findIndex(item => item.value === state.cursor) : -1;
		if (remembered >= 0) list.setSelectedIndex(remembered);
		list.onSelectionChange = item => {
			state.cursor = item.value;
			// An editor left open (the thinking picker) belongs to the advisor that was selected when it opened;
			// the new selection gets its own field list instead of a picker for the previous one.
			this.#showFields();
			this.#cb.requestRender();
		};
		list.onSelect = item => {
			state.cursor = item.value;
			void this.#onRosterSelect(scope, item.value).catch(err => {
				this.#cb.notify(`Advisor config: ${err instanceof Error ? err.message : String(err)}`);
			});
		};
		list.onCancel = () => this.#cb.close();
		state.list = list;
		state.cursor = list.getSelectedItem()?.value;
	}

	#hasSyntheticDefaultAdvisor(doc: WatchdogConfigDoc): boolean {
		if (doc.advisors.length !== 1) return false;
		const advisor = doc.advisors[0];
		return (
			advisor?.name === "default" &&
			!advisor.model?.trim() &&
			advisor.tools === undefined &&
			!advisor.instructions?.trim() &&
			advisor.enabled !== false &&
			advisor.maxNotesPerUpdate === undefined
		);
	}

	#advisorSummary(advisor: AdvisorConfig): string {
		const model = advisor.model?.trim() || this.#defaultModelLabel || "advisor role default";
		const tools = formatAdvisorTools(advisor.tools, "no tools");
		return `${model} · ${tools}`;
	}

	#markDirty(scope: AdvisorConfigScope): void {
		const state = this.#scopes[scope];
		state.dirty = true;
		state.revision++;
		this.#rebuildRoster(scope);
	}

	async #onRosterSelect(scope: AdvisorConfigScope, value: string): Promise<void> {
		const state = this.#scopes[scope];
		if (state.loading || state.failed) return;
		if (value === "add") {
			state.doc.advisors.push({ name: `Advisor ${state.doc.advisors.length + 1}` });
			state.cursor = `advisor:${state.doc.advisors.length - 1}`;
			this.#markDirty(scope);
			this.#focusEditor();
			this.#showFields();
			return;
		}
		if (value === "shared") {
			this.#focusEditor();
			this.#showInstructionsEditor(scope, -1);
			return;
		}
		if (value === "save") {
			if (this.#savePending) return;
			this.#savePending = true;
			const revision = state.revision;
			try {
				const doc = this.#hasSyntheticDefaultAdvisor(state.doc) ? { ...state.doc, advisors: [] } : state.doc;
				await this.#cb.save(scope, doc);
				if (state.revision === revision) {
					delete state.doc.warnings;
					state.dirty = false;
					this.#rebuildRoster(scope);
					this.#cb.notify(`Saved ${this.#scopeLabel(scope)} advisors`);
				}
				this.#cb.requestRender();
			} finally {
				this.#savePending = false;
			}
			return;
		}
		if (value === "empty") return;
		if (/^advisor:\d+$/.test(value)) {
			this.#focusEditor();
			this.#showFields();
		}
	}

	// ───────────────────────────── editor pane ───────────────────────

	#setEditor(mode: EditorMode, component: Component): void {
		this.#mode = mode;
		this.#editor = component;
		this.#editorScroll = 0;
		// Overflow and content offset describe the editor drawn last; refresh them for this one so keys that
		// arrive before the next frame still keep the selection inside the window.
		if (this.#editorWindowRows > 0) this.#editorWindow(this.#editorWindowWidth, this.#editorWindowRows);
		this.#cb.requestRender();
	}

	#showFields(): void {
		const target = this.#selected();
		if (!target) {
			const scope = this.#focus === "editor" ? this.#lastRosterFocus : this.#focus;
			const value = this.#scopes[scope].list.getSelectedItem()?.value;
			const help =
				value === "add"
					? "Create a new advisor entry, then edit its model, tools, and instructions here."
					: value === "shared"
						? `Shared instructions prepended to every advisor in ${this.#scopeLabel(scope)}: ${previewLine(this.#scopes[scope].doc.instructions)}`
						: value === "save"
							? `Write ${this.#scopeLabel(scope)}'s WATCHDOG.yml and reload the live advisors without a restart.`
							: `No advisors configured in ${this.#scopeLabel(scope)}. The advisor role default (${this.#defaultModelLabel ?? "none"}) applies. Use "+ Add advisor" to configure one.`;
			const text = new StaticLines(help);
			this.#setEditor("fields", text);
			return;
		}
		const { scope, index, advisor } = target;
		const modelDescription = advisor.model?.trim() || this.#defaultModelLabel || "advisor role default";

		const items: SelectItem[] = [
			{
				value: "toggleEnabled",
				label: "Enabled",
				description:
					advisor.enabled === false
						? `${theme.symbol("status.disabled")} off`
						: `${theme.symbol("status.enabled")} on`,
			},
			{ value: "name", label: "Name", description: displayText(advisor.name) },
			{ value: "model", label: "Model", description: modelDescription },
		];
		if (advisor.model?.trim()) items.push({ value: "resetModel", label: "Reset model to advisor-role default" });
		items.push(
			{ value: "tools", label: "Tools", description: formatAdvisorTools(advisor.tools, "no tools") },
			{ value: "instructions", label: "Instructions", description: previewLine(advisor.instructions) },
			{ value: "delete", label: "Delete this advisor" },
		);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		const remembered = this.#fieldCursor ? items.findIndex(item => item.value === this.#fieldCursor) : -1;
		if (remembered >= 0) list.setSelectedIndex(remembered);
		list.onSelectionChange = item => {
			this.#fieldCursor = item.value;
		};
		list.onSelect = item => {
			this.#fieldCursor = item.value;
			this.#onFieldSelect(scope, index, item.value);
		};
		// Esc steps back to the roster like ←; only the roster closes the overlay, so a stray
		// Esc never discards unsaved edits.
		list.onCancel = () => {
			this.#focus = this.#lastRosterFocus;
			this.#cb.requestRender();
		};
		this.#setEditor("fields", list);
	}

	#onFieldSelect(scope: AdvisorConfigScope, index: number, field: string): void {
		const doc = this.#scopes[scope].doc;
		switch (field) {
			case "toggleEnabled": {
				const a = doc.advisors[index];
				a.enabled = a.enabled === false ? undefined : false;
				this.#markDirty(scope);
				this.#showFields();
				return;
			}
			case "name":
				this.#showNameEditor(scope, index);
				return;
			case "model":
				this.#showModelPicker(scope, index);
				return;
			case "tools":
				this.#showToolsEditor(
					scope,
					index,
					new Set(doc.advisors[index].tools ?? [...this.#deps.defaultToolNames]),
					0,
				);
				return;
			case "resetModel":
				doc.advisors[index].model = undefined;
				this.#markDirty(scope);
				this.#showFields();
				return;
			case "instructions":
				this.#showInstructionsEditor(scope, index);
				return;
			case "delete":
				doc.advisors.splice(index, 1);
				this.#scopes[scope].cursor = undefined;
				this.#markDirty(scope);
				this.#focus = scope;
				this.#showFields();
				return;
			default:
				this.#showFields();
		}
	}

	#showNameEditor(scope: AdvisorConfigScope, index: number): void {
		const input = new Input();
		input.setValue(this.#scopes[scope].doc.advisors[index].name);
		input.onSubmit = value => {
			const name = value.trim();
			if (name) {
				this.#scopes[scope].doc.advisors[index].name = name;
				this.#markDirty(scope);
			}
			this.#showFields();
		};
		input.onEscape = () => this.#showFields();
		this.#setEditor("name", input);
	}

	#showModelPicker(scope: AdvisorConfigScope, index: number): void {
		const source = this.#deps.browserSource;
		const mruOrder = source.mruOrder;
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
		} else {
			try {
				models = this.#deps.getAvailableModels();
			} catch {
				models = [];
			}
		}
		const items = buildBrowserItems(models);
		sortModelItems(items, { mruOrder });
		const current = this.#scopes[scope].doc.advisors[index].model?.trim();
		const resolvedCurrent =
			resolveLiteralModelValue(current, models) ?? source.resolveRoleValue(current, [...models]);
		const currentModel = resolvedCurrent.model;
		const currentSelector = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
		const picker = new ModelBrowser(source, {});
		picker.setMruOrder(mruOrder);
		picker.setPerfStats(source.modelPerf);
		picker.setCurrentSelector(currentSelector);
		picker.setItems(items);
		if (currentSelector) picker.selectSelector(currentSelector);
		picker.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			const isCurrentModel = currentModel?.provider === item.model.provider && currentModel.id === item.model.id;
			if (efforts.length === 0) {
				this.#scopes[scope].doc.advisors[index].model = item.selector;
				this.#markDirty(scope);
				this.#showFields();
			} else {
				const currentLevel =
					isCurrentModel && resolvedCurrent.explicitThinkingLevel && resolvedCurrent.thinkingLevel !== "auto"
						? resolvedCurrent.thinkingLevel
						: undefined;
				this.#showThinkingPicker(scope, index, item.selector, efforts, currentLevel);
			}
		};
		picker.onCancel = () => this.#showFields();
		this.#setEditor("model", picker);
	}

	#showThinkingPicker(
		scope: AdvisorConfigScope,
		index: number,
		selector: string,
		efforts: readonly string[],
		currentLevel?: ConfiguredThinkingLevel,
	): void {
		const items: SelectItem[] = [{ value: "", label: "(model default thinking)" }];
		for (const effort of efforts) items.push({ value: effort, label: effort });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		const currentIndex = currentLevel ? items.findIndex(item => item.value === currentLevel) : -1;
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
		list.onSelect = item => {
			const level = item.value ? (item.value as ThinkingLevel) : undefined;
			this.#scopes[scope].doc.advisors[index].model = formatModelSelectorValue(selector, level);
			this.#markDirty(scope);
			this.#showFields();
		};
		list.onCancel = () => this.#showModelPicker(scope, index);
		this.#setEditor("thinking", list);
	}

	#showToolsEditor(scope: AdvisorConfigScope, index: number, selected: Set<string>, cursor: number): void {
		const all = this.#availableToolNames;
		const items: SelectItem[] = all.map(name => ({
			value: name,
			label: `${selected.has(name) ? "[x]" : "[ ]"} ${name}`,
		}));
		items.push({ value: "__done", label: "Done" });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.setSelectedIndex(cursor);
		let cursorIndex = cursor;
		list.onSelectionChange = item => {
			cursorIndex = items.findIndex(i => i.value === item.value);
		};
		const apply = (): void => {
			this.#scopes[scope].doc.advisors[index].tools = commitTools(selected, all, this.#deps.defaultToolNames);
			this.#markDirty(scope);
			this.#applyPendingTools = undefined;
			this.#showFields();
		};
		this.#applyPendingTools = apply;
		list.onSelect = item => {
			if (item.value === "__done") {
				apply();
				return;
			}
			if (selected.has(item.value)) selected.delete(item.value);
			else selected.add(item.value);
			this.#showToolsEditor(scope, index, selected, cursorIndex);
		};
		list.onCancel = apply;
		this.#setEditor("tools", list);
	}

	/** `index === -1` edits the scope's shared instructions; otherwise advisor[index]. */
	#showInstructionsEditor(scope: AdvisorConfigScope, index: number): void {
		const doc = this.#scopes[scope].doc;
		const shared = index < 0;
		const current = shared ? doc.instructions : doc.advisors[index].instructions;
		const title = shared
			? `Shared instructions · ${this.#scopeLabel(scope)}`
			: `Instructions — ${displayText(doc.advisors[index].name) || "(unnamed)"}`;
		const editor = new HookEditorComponent(
			this.#tui,
			title,
			current,
			value => {
				const text = value.trim() ? value : undefined;
				if (shared) doc.instructions = text;
				else doc.advisors[index].instructions = text;
				this.#markDirty(scope);
				this.#showFields();
			},
			() => this.#showFields(),
			{ externalEditor: this.#deps.externalEditor },
		);
		this.#setEditor("instructions", editor);
	}
}

/** Static wrapped help text for the editor pane when no advisor is under the cursor. */
class StaticLines implements Component {
	constructor(private readonly text: string) {}
	render(width: number): readonly string[] {
		return wrap(this.text, width).map(line => theme.fg("muted", line));
	}
	handleInput(): void {}
}
