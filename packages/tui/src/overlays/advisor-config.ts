/**
 * Fullscreen `/advisor configure` overlay: a mouse- and keyboard-driven editor
 * for the `WATCHDOG.yml` advisor roster at project or user level.
 *
 * It paints the entire alternate screen from row 0 (so SGR mouse rows index
 * directly into the rendered frame) using the shared {@link ./overlay-box} chrome.
 * The list screen is a two-pane split (the `/extensions` idiom): a clickable
 * advisor/action sidebar on the left, and a scrollable preview of the highlighted
 * advisor's model / tools / instructions on the right, filling the free space.
 *
 * Each screen is backed by a proven primitive — {@link SelectList} (list / detail
 * / tools / thinking), {@link Input} (name), {@link ModelSelectorComponent} (the
 * same rich `/model` picker, in direct-select mode), and {@link HookEditorComponent}
 * (multiline instructions; Ctrl+G opens `$EDITOR`). The overlay edits an in-memory
 * {@link WatchdogConfigDoc} and only touches disk + the live advisors via the host
 * `save` callback.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Model, resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	type Component,
	Input,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "../index";
import { getSelectListTheme, theme } from "../theme";
import { sanitizeDisplayWarnings } from "../render/render-utils";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { HookEditorComponent } from "./hook-editor";
import { buildBrowserItems, ModelBrowser, type ModelBrowserSource, sortModelItems } from "./model-browser";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import type { TspPrefsProps, TspPrefsRow, TspSpan } from "@oh-my-pi/pi-wire";
import { col, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, type NativeHint, overlayCard } from "../native/overlay";

export const ADVISOR_REVIEW_MODES = ["turn", "agent-end"] as const;
export const ADVISOR_SYNC_BACKLOG_MODES = ["off", "1", "3", "5", "strict"] as const;

export type AdvisorReviewMode = (typeof ADVISOR_REVIEW_MODES)[number];
export type AdvisorSyncBacklog = (typeof ADVISOR_SYNC_BACKLOG_MODES)[number];

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
	reviewMode?: AdvisorReviewMode;
	reviewInterval?: number;
	syncBacklog?: AdvisorSyncBacklog;
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
	/** Live advisor usage stats; lets the preview show tokens/cost per advisor. */
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
	getAvailableModels: () => Model[];
	browserSource: ModelBrowserSource;
	defaultToolNames: ReadonlySet<string>;
	externalEditor?: (text: string) => Promise<string | null>;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** A configured scope stays active even if no models currently match it. */
	scopedModelsConfigured?: boolean;
	availableToolNames: string[];
	syncBacklog?: AdvisorSyncBacklog;
	/** Formatted advisor-role model shown on the seeded default row (e.g. "anthropic/claude-..."). */
	defaultModelLabel?: string;
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

function previewLineOrNone(text: string | undefined): string {
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
	return tools.length > 0 ? tools.join(", ") : emptyLabel;
}

/** Choice value for "no per-advisor override"; matches no {@link ADVISOR_SYNC_BACKLOG_MODES} entry. */
const SYNC_BACKLOG_INHERIT = "inherit";

/** One-line cadence label: mode plus interval. */
function formatReviewCadence(advisor: AdvisorConfig): string {
	const reviewInterval = advisor.reviewInterval ?? 1;
	return `${advisor.reviewMode ?? "turn"} · every ${reviewInterval} eligible update${reviewInterval === 1 ? "" : "s"}`;
}

/** Picker description for one explicit catch-up policy value. */
function describeSyncBacklogMode(mode: AdvisorSyncBacklog): string {
	switch (mode) {
		case "off":
			return "Never wait for this advisor's backlog.";
		case "strict":
			return "Wait for all of this advisor's scheduled reviews; no wall-clock cap.";
		default:
			return `Wait until fewer than ${mode} scheduled reviews remain (30s cap).`;
	}
}

/** Soft-wrap plain text to `width`, returning at least one (possibly empty) line. */
function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

type Screen =
	| "list"
	| "detail"
	| "name"
	| "model"
	| "tools"
	| "thinking"
	| "review-mode"
	| "review-interval"
	| "sync-backlog"
	| "instructions";

/** Footer key hints per screen for the described overlay (the ANSI footer strings carry the same keys). */
function screenHints(screen: Screen): (NativeHint | undefined)[] {
	switch (screen) {
		case "list":
			return [
				actionHint(["tui.select.up", "tui.select.down"], "move"),
				actionHint("tui.select.confirm", "select"),
				actionHint("tui.select.cancel", "close"),
			];
		case "detail":
			return [actionHint("tui.select.confirm", "edit field"), actionHint("tui.select.cancel", "back")];
		case "name":
			return [actionHint("tui.input.submit", "save"), actionHint("tui.select.cancel", "cancel")];
		case "model":
			return [
				{ keys: [], label: "type to search" },
				{ keys: ["enter"], label: "pick" },
				actionHint("tui.select.cancel", "back"),
			];
		case "thinking":
		case "review-mode":
		case "sync-backlog":
			return [actionHint("tui.select.confirm", "pick"), actionHint("tui.select.cancel", "back")];
		case "review-interval":
			return [actionHint("tui.input.submit", "save"), actionHint("tui.select.cancel", "cancel")];
		case "tools":
			return [
				actionHint("tui.select.confirm", "toggle"),
				{ keys: [], label: "Done applies (empty = no tools; read/grep/glob = default)" },
				actionHint("tui.select.cancel", "apply"),
			];
		case "instructions":
			return [];
	}
}

/**
 * Fullscreen advisor-configuration overlay. Implements {@link Component} directly
 * (rather than extending Container) so it owns the whole frame and the mouse
 * geometry needed to make every row clickable.
 */
export class AdvisorConfigOverlayComponent implements Component {
	#tui: TUI;
	#deps: AdvisorConfigDeps;
	#scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#availableToolNames: readonly string[];
	#defaultModelLabel: string | undefined;
	#cb: AdvisorConfigCallbacks;
	#scope: AdvisorConfigScope;
	#doc: WatchdogConfigDoc;
	/** Cached usage reports (quota/window/reset) prefetched on overlay open. */
	#cachedReports: UsageReport[] | null = null;
	#dirty = false;

	/** The advisor the detail screen (and its editors) edits; -1 on the roster or the shared instructions. */
	#detailIndex = -1;
	#nativePrefs: { signature: string; editor: Component | undefined; node: NativeNode } | undefined;
	#screen: Screen = "list";
	/** The interactive element for the current screen. */
	#active: Component = new SelectList([], 1, getSelectListTheme());
	#footerHint = "";
	#previewScroll = 0;
	#nativeHints: { screen: Screen; node: NativeNode | undefined } | undefined;
	#nativePreview: { json: string; node: NativeNode } | undefined;
	#nativeRoot:
		| {
				screen: Screen;
				active: Component;
				title: string;
				preview: NativeNode | undefined;
				hints: NativeNode | undefined;
				node: NativeNode;
		  }
		| undefined;

	// Persistent frame: top, growing two-pane body, divider, footer, bottom.
	// The frame paints from screen row 0, so SGR `event.row`/`event.col` —
	// already 0-based — index directly into the stack. The list screen splits
	// (sidebar + preview); every other screen forces the narrow left pane.
	#bodyRowsLast = 3;
	#renderActivePane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRowsLast));
		const lines = [...this.#active.render(width)];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	#renderPreviewPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(0, Math.floor(height ?? this.#bodyRowsLast));
		const lines = [...this.#previewWindow(width, rows)];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	readonly #split = new SplitPane({
		left: this.#renderActivePane,
		right: this.#renderPreviewPane,
		leftSize: { ratio: 0.34, min: 22, max: 42 },
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #frameTop = new PanelRows();
	readonly #frameDivider = new PanelRows();
	readonly #frameFooter = new PanelRows();
	readonly #frameBottom = new PanelRows();
	readonly #frame = new Stack({
		children: [
			{ content: this.#frameTop, height: 1 },
			{ content: this.#split, grow: 1 },
			{ content: this.#frameDivider, height: 1 },
			{ content: this.#frameFooter, height: 1 },
			{ content: this.#frameBottom, height: 1 },
		],
	});

	constructor(
		tui: TUI,
		deps: AdvisorConfigDeps,
		scope: AdvisorConfigScope,
		doc: WatchdogConfigDoc,
		callbacks: AdvisorConfigCallbacks,
	) {
		this.#tui = tui;
		this.#deps = deps;
		this.#scopedModels = deps.scopedModels;
		this.#availableToolNames = deps.availableToolNames;
		this.#defaultModelLabel = deps.defaultModelLabel;
		this.#cb = callbacks;
		this.#scope = scope;
		this.#doc = doc;
		this.#ensureRosterVisible();
		this.#showList();
		// Prefetch usage reports for quota display; non-fatal if unavailable.
		if (callbacks.getUsageReports) {
			void callbacks
				.getUsageReports()
				.then(r => {
					this.#cachedReports = r;
					this.#cb.requestRender();
				})
				.catch(() => {});
		}
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const bodyRows = Math.max(3, height - 4);
		this.#bodyRowsLast = bodyRows;
		const title = `Advisor configuration · ${this.#scope}${this.#dirty ? "  ● unsaved" : ""}`;
		this.#split.setNarrowPane(this.#screen === "list" ? undefined : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(bodyRows);
		const geometry = this.#split.measure(width);
		const isSplit = geometry.mode === "split";
		const leftWidth = geometry.left?.width ?? 0;
		this.#frameTop.setLines([isSplit ? topBorderSplit(width, title, leftWidth) : topBorder(width, title)]);
		this.#frameDivider.setLines([isSplit ? dividerSplit(width, leftWidth) : divider(width)]);
		this.#frameFooter.setLines([row(theme.fg("dim", this.#footerHint), width)]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(bodyRows + 4);
		return this.#frame.render(width);
	}

	/** Docks as a side sheet beside the transcript, like `/settings`, when the terminal draws `prefs` with `aside`. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("prefs") && cx.feature("aside");
	}

	/**
	 * The native settings page (`prefs`) when the terminal draws it: a page per
	 * advisor plus the shared instructions, the advisor's fields as typed rows,
	 * the file actions, and the model/tools/instructions editors over the page.
	 * Otherwise the root card `omp.overlay.advisor`: on the roster screen a
	 * sidebar (the active `SelectList`) beside the highlighted entry's preview;
	 * every other screen shows its editor component alone. Key hints close the
	 * card.
	 */
	describe(cx: DescribeContext): NativeNode {
		if (cx.supports("prefs")) return this.#describePrefs();
		return this.#describeCard();
	}

	/** The advisor index a page shows: the detail's, else the roster's highlighted advisor, else the first. */
	#pageIndex(): number {
		if (this.#detailIndex >= 0) return this.#detailIndex;
		const value = this.#active instanceof SelectList ? (this.#active.getSelectedItem()?.value ?? "") : "";
		const match = /^advisor:(\d+)$/.exec(value);
		return match ? Number(match[1]) : value === "shared" ? -1 : 0;
	}

	#describePrefs(): NativeNode {
		const doc = this.#doc;
		const index = this.#pageIndex();
		const shared = index < 0;
		const advisor = shared ? undefined : doc.advisors[index];
		const pages: TspPrefsProps["pages"][number][] = doc.advisors.map((a, i) => ({
			id: `advisor:${i}`,
			label: a.name || "(unnamed)",
			icon: "advisor",
			group: "Advisors",
		}));
		pages.push({ id: "shared", label: "Shared instructions", icon: "doc", group: "All advisors" });

		const sections: TspPrefsProps["sections"][number][] = [];
		if (doc.warnings?.length) {
			sections.push({
				id: "warnings",
				title: "Config problems",
				rows: sanitizeDisplayWarnings(doc.warnings).map((warning, i) => ({
					id: `warning:${i}`,
					label: "Dropped while loading",
					warning,
					control: { k: "action", label: "Save to rewrite", act: "save" },
				})),
			});
		}
		if (advisor) {
			const model = advisor.model?.trim();
			const tools = advisor.tools ?? [...this.#deps.defaultToolNames];
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
					defaultLabel: model ? (this.#defaultModelLabel ?? "advisor role default") : undefined,
					control: { k: "action", label: model || this.#defaultModelLabel || "advisor role default", act: "edit" },
				},
				{
					id: "reviewMode",
					label: "Review mode",
					hint: "turn reviews every primary turn; agent-end reviews only final yields.",
					changed: advisor.reviewMode !== undefined ? true : undefined,
					control: {
						k: "choice",
						value: advisor.reviewMode ?? "turn",
						options: ADVISOR_REVIEW_MODES.map(mode => ({ value: mode, label: mode })),
						style: "segmented",
					},
				},
				{
					id: "reviewInterval",
					label: "Review interval",
					hint: "Review every Nth eligible update; skipped updates join the next review.",
					changed: advisor.reviewInterval !== undefined ? true : undefined,
					control: { k: "number", value: advisor.reviewInterval ?? 1, min: 1, step: 1 },
				},
				{
					id: "syncBacklog",
					label: "Sync backlog",
					hint: `Catch-up policy; inherit follows advisor.syncBacklog (currently ${this.#deps.syncBacklog ?? "off"}).`,
					changed: advisor.syncBacklog !== undefined ? true : undefined,
					control: {
						k: "choice",
						value: advisor.syncBacklog ?? SYNC_BACKLOG_INHERIT,
						options: [
							{ value: SYNC_BACKLOG_INHERIT, label: "inherit" },
							...ADVISOR_SYNC_BACKLOG_MODES.map(mode => ({
								value: mode,
								label: mode,
								detail: describeSyncBacklogMode(mode),
							})),
						],
						style: "menu",
					},
				},
				{
					id: "tools",
					label: "Tools",
					hint: "None means no tools; read, grep and glob are the default.",
					control: {
						k: "multi",
						values: tools,
						options: this.#availableToolNames.map(name => ({ value: name, label: name })),
					},
				},
				{
					id: "instructions",
					label: "Instructions",
					hint: previewLineOrNone(advisor.instructions),
					control: { k: "action", label: "Edit…", act: "edit" },
				},
				{ id: "delete", label: "Delete this advisor", control: { k: "action", label: "Delete", act: "delete" } },
			];
			sections.push({ id: "advisor", title: advisor.name || "Advisor", rows });
		} else {
			sections.push({
				id: "shared",
				title: "Shared instructions",
				rows: [
					{
						id: "shared",
						label: "Instructions",
						hint: previewLineOrNone(doc.instructions),
						control: { k: "action", label: "Edit…", act: "edit" },
					},
				],
			});
		}
		sections.push({
			id: "file",
			title: `WATCHDOG.yml · ${this.#scope}`,
			rows: [
				{
					id: "save",
					label: "Save & apply",
					hint: "Write this file and reload the live advisors without a restart.",
					warning: this.#dirty ? "Unsaved changes" : undefined,
					control: { k: "action", label: "Save", act: "save" },
				},
				{
					id: "add",
					label: "Add advisor",
					hint: "Create a new advisor entry, then set its model, tools and instructions.",
					control: { k: "action", label: "Add", act: "add" },
				},
				{
					id: "scope",
					label: "Scope",
					hint: `Editing the ${this.#scope} file. Switch to the ${this.#otherScope()} file.`,
					control: { k: "action", label: `Open ${this.#otherScope()}`, act: "scope" },
				},
			],
		});

		// Name editing shows its draft in the row; the other editors sit over the page.
		const input = this.#screen === "name" && this.#active instanceof Input ? this.#active : undefined;
		const editing = input
			? { row: "name", draft: input.getValue(), cursor: Number(input.debugState().cursor) }
			: null;
		const overlay =
			this.#screen === "model" ||
			this.#screen === "thinking" ||
			this.#screen === "review-mode" ||
			this.#screen === "review-interval" ||
			this.#screen === "sync-backlog" ||
			this.#screen === "tools" ||
			this.#screen === "instructions";
		const editor = overlay ? this.#active : undefined;
		const focus =
			this.#screen === "detail" && this.#active instanceof SelectList
				? (this.#active.getSelectedItem()?.value ?? null)
				: null;
		const props: TspPrefsProps = {
			title: this.#dirty ? "Advisors · unsaved" : "Advisors",
			pages,
			page: shared ? "shared" : `advisor:${index}`,
			lead: shared
				? "Instructions every advisor gets before its own."
				: "An advisor watches the session and leaves notes; set its model, tools and instructions here.",
			sections,
			focus,
			editing,
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
	 * Native page events, each through the roster/detail selections the keys
	 * make: a page opens that advisor (or the shared instructions), a field
	 * change or button runs the field's detail action, and closing an editor
	 * or the page cancels like Esc.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.key !== "") return;
		const index = this.#pageIndex();
		switch (event.type) {
			case "action": {
				if (event.act === "page" && event.value) {
					const match = /^advisor:(\d+)$/.exec(event.value);
					if (match) this.#showDetail(Number(match[1]));
					else if (event.value === "shared") this.#showInstructionsEditor(-1);
					return;
				}
				if (event.act === "close") {
					if (event.value !== undefined) this.#active.handleInput?.("\x1b");
					else this.#cb.close();
					return;
				}
				if (event.act === "save" || event.act === "add" || event.act === "scope") {
					void this.#onListSelect(event.act).catch(err => {
						this.#cb.notify(`Advisor config: ${err instanceof Error ? err.message : String(err)}`);
					});
					return;
				}
				if (event.value === "shared") this.#showInstructionsEditor(-1);
				else if (index >= 0 && event.value)
					this.#onDetailSelect(index, event.act === "delete" ? "delete" : event.value);
				return;
			}
			case "change": {
				if (index < 0) return;
				const advisor = this.#doc.advisors[index];
				if (!advisor) return;
				if (event.item === "toggleEnabled" && typeof event.value === "boolean") {
					if (event.value !== (advisor.enabled !== false)) this.#onDetailSelect(index, "toggleEnabled");
				} else if (event.item === "tools" && Array.isArray(event.value)) {
					advisor.tools = commitTools(new Set(event.value), this.#availableToolNames, this.#deps.defaultToolNames);
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "name" && typeof event.value === "string" && event.value.trim()) {
					advisor.name = event.value.trim();
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "reviewMode" && (typeof event.value === "string" || event.value === null)) {
					// `turn` is the default, stored as an omitted field; `null` resets to it.
					const mode = event.value === null ? "turn" : ADVISOR_REVIEW_MODES.find(m => m === event.value);
					if (!mode) return;
					advisor.reviewMode = mode === "turn" ? undefined : mode;
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "reviewInterval" && (typeof event.value === "number" || event.value === null)) {
					const interval = event.value ?? 1;
					if (!Number.isSafeInteger(interval) || interval < 1) return;
					advisor.reviewInterval = interval === 1 ? undefined : interval;
					this.#dirty = true;
					this.#showDetail(index);
				} else if (event.item === "syncBacklog" && (typeof event.value === "string" || event.value === null)) {
					// The inherit sentinel and `null` match no mode, so the override clears.
					advisor.syncBacklog = ADVISOR_SYNC_BACKLOG_MODES.find(mode => mode === event.value);
					this.#dirty = true;
					this.#showDetail(index);
				}
				return;
			}
			case "activate":
				if (event.item === "shared") this.#showInstructionsEditor(-1);
				else if (index >= 0) this.#onDetailSelect(index, event.item);
				return;
			case "select":
				if (this.#screen === "detail" && this.#active instanceof SelectList) {
					this.#active.setSelectedValue(event.item);
					this.#cb.requestRender();
				}
				return;
			case "toggle":
				return;
		}
	}

	#describeCard(): NativeNode {
		const title = `Advisor configuration · ${this.#scope}${this.#dirty ? "  ● unsaved" : ""}`;
		const preview = this.#screen === "list" ? this.#describePreview() : undefined;
		if (this.#nativeHints?.screen !== this.#screen) {
			const hints = screenHints(this.#screen);
			this.#nativeHints = { screen: this.#screen, node: hints.length > 0 ? hintsRow(hints) : undefined };
		}
		const hints = this.#nativeHints.node;
		const prev = this.#nativeRoot;
		if (
			prev?.screen === this.#screen &&
			prev.active === this.#active &&
			prev.title === title &&
			prev.preview === preview &&
			prev.hints === hints
		) {
			return prev.node;
		}
		const head: TspSpan[] = [span(`Advisor configuration · ${this.#scope}`)];
		if (this.#dirty) head.push(span("  ● unsaved", "warning"));
		const body: NativeNode = preview
			? node(
					"row",
					{ gap: "md", align: "start", grow: 1 },
					[
						node("col", { min: { w: "22ch" }, max: { w: "42ch" }, basis: 0.34 }, [this.#active], "sidebar"),
						preview,
					],
					"split",
				)
			: node("col", { grow: 1 }, [this.#active], "body");
		const children: NativeChild[] = [body];
		if (hints) children.push(node("rule", undefined, undefined, "divider"), hints);
		const card = overlayCard("omp.overlay.advisor", head, children);
		this.#nativeRoot = { screen: this.#screen, active: this.#active, title, preview, hints, node: card };
		return card;
	}

	/** The highlighted roster entry's preview; rebuilt only when its content changes (live stats, quota). */
	#describePreview(): NativeNode {
		const children: NativeNode[] = [];
		if (this.#doc.warnings?.length) {
			children.push(
				node(
					"col",
					{ tone: "warning" },
					[
						text([span("⚠ Config problems — dropped while loading:", "warning")]),
						...sanitizeDisplayWarnings(this.#doc.warnings).map(warning =>
							text([span(warning, "warning")], { wrap: "word" }),
						),
					],
					"warnings",
				),
			);
		}
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		const match = /^advisor:(\d+)$/.exec(value);
		const advisor = match ? this.#doc.advisors[Number(match[1])] : undefined;
		if (advisor) {
			children.push(...this.#describeAdvisorPreview(advisor));
		} else if (value === "shared") {
			const instructions = this.#doc.instructions?.trim();
			children.push(
				text([span("Shared instructions", "strong")]),
				instructions ? text(instructions, { wrap: "word" }) : text([span("(none)", "muted")]),
			);
		} else {
			const help =
				value === "add"
					? "Create a new advisor entry, then edit its model, tools, and instructions."
					: value === "scope"
						? `Switch between the project and user WATCHDOG.yml. Currently editing the ${this.#scope}-level file.`
						: value === "save"
							? "Write this scope's WATCHDOG.yml and reload the live advisors without a restart."
							: value === "close"
								? "Close the editor. Unsaved changes are discarded."
								: "";
			if (help) children.push(text([span(help, "muted")], { wrap: "word" }));
		}
		const candidate = node("col", { gap: "sm", grow: 1 }, children, "preview");
		const json = JSON.stringify(candidate);
		if (this.#nativePreview?.json === json) return this.#nativePreview.node;
		this.#nativePreview = { json, node: candidate };
		return candidate;
	}

	#describeAdvisorPreview(advisor: AdvisorConfig): NativeNode[] {
		const model = advisor.model?.trim() || this.#defaultModelLabel || "advisor role default";
		const instructions = advisor.instructions?.trim();
		const out: NativeNode[] = [
			text([span(advisor.name || "(unnamed)", "strong")]),
			node("kv", {
				items: [
					{ k: "Enabled", v: advisor.enabled === false ? "○ off" : "● on" },
					{ k: "Model", v: model },
					{ k: "Tools", v: formatAdvisorTools(advisor.tools, "no tools") },
					{ k: "Review", v: formatReviewCadence(advisor) },
					{ k: "Sync backlog", v: this.#syncBacklogLabel(advisor) },
				],
			}),
			text([span("Instructions:", "dim")]),
			instructions ? text(instructions, { wrap: "word" }) : text([span("(none)", "muted")]),
		];
		const liveStat = this.#cb.getAdvisorStats?.()?.find(s => s.name === (advisor.name || "default"));
		if (liveStat && (liveStat.status === "running" || liveStat.status === "quota_exhausted")) {
			const spendParts = [
				`${liveStat.tokens.input.toLocaleString()} in`,
				`${liveStat.tokens.output.toLocaleString()} out`,
			];
			if (liveStat.tokens.cacheRead > 0) spendParts.push(`${liveStat.tokens.cacheRead.toLocaleString()} cache`);
			const usage: { k: string; v: string }[] = [{ k: "Tokens", v: spendParts.join(", ") }];
			if (liveStat.cost > 0) usage.push({ k: "Cost", v: `$${liveStat.cost.toFixed(4)}` });
			if (liveStat.contextWindow > 0) {
				const pct = Math.round((liveStat.contextTokens / liveStat.contextWindow) * 100);
				usage.push({
					k: "Context",
					v: `${liveStat.contextTokens.toLocaleString()}/${liveStat.contextWindow.toLocaleString()} (${pct}%)`,
				});
			}
			out.push(text([span("Usage:", "dim")]), node("kv", { items: usage }));
		}
		const quotaProvider =
			(advisor.model?.includes("/") ? advisor.model.split("/")[0] : null) ?? liveStat?.model?.provider;
		if (this.#cachedReports && quotaProvider) {
			const quota = formatCompactQuota(
				quotaProvider,
				this.#cachedReports,
				Date.now(),
				this.#cb.getQuotaLimitFilter?.(quotaProvider, liveStat?.sessionId),
			);
			if (quota) out.push(text([span(quota, "dim")], { wrap: "word" }));
		}
		return out;
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		this.#active.handleInput?.(data);
	}

	/** Forward enhanced-paste transports into a multiline instructions editor. */
	pasteText(text: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (hit && hit.index === 1) {
			const pane = this.#split.locate(hit.line, hit.col);
			// Right pane of the split (the preview) only scrolls; the left pane
			// routes into the active list/component at pane-local coordinates.
			if (pane?.pane === "right") {
				if (event.wheel !== null) {
					this.#previewScroll = Math.max(0, this.#previewScroll + event.wheel);
					this.#cb.requestRender();
				}
				return true;
			}
			if (pane?.pane === "left" && isLayoutMouseRoutable(this.#active)) {
				this.#active.routeMouse(event, pane.line, pane.col);
				return true;
			}
			return true;
		}
		return false;
	}

	// ───────────────────────────── preview ───────────────────────────

	#previewWindow(bodyWidth: number, rows: number): string[] {
		const lines = this.#previewContent(bodyWidth);
		const maxScroll = Math.max(0, lines.length - rows);
		const start = Math.min(this.#previewScroll, maxScroll);
		const window = lines.slice(start, start + rows);
		if (lines.length > rows) {
			const marker =
				start + rows < lines.length
					? theme.fg("dim", `  ↓ ${lines.length - rows - start} more`)
					: theme.fg("dim", "  (end)");
			window[rows - 1] = marker;
		}
		return window;
	}

	#previewContent(bodyWidth: number): string[] {
		// The fullscreen overlay hides the host's chat-mounted warning toasts, so
		// the active file's load problems are pinned at the top of the preview
		// until a successful save rewrites the file without them.
		const warnings = this.#doc.warnings?.length
			? [
					theme.fg("warning", "⚠ Config problems — dropped while loading:"),
					...sanitizeDisplayWarnings(this.#doc.warnings).flatMap(warning =>
						wrap(warning, bodyWidth).map(line => theme.fg("warning", line)),
					),
					"",
				].map(line => truncateToWidth(line, bodyWidth))
			: [];
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		const match = /^advisor:(\d+)$/.exec(value);
		if (match) {
			const advisor = this.#doc.advisors[Number(match[1])];
			if (advisor) return [...warnings, ...this.#advisorPreview(advisor, bodyWidth)];
		}
		if (value === "shared") {
			const lines = [...warnings, theme.bold("Shared instructions"), ""];
			const text = this.#doc.instructions?.trim();
			lines.push(...(text ? wrap(text, bodyWidth) : [theme.fg("muted", "(none)")]));
			return lines.map(line => truncateToWidth(line, bodyWidth));
		}
		const help =
			value === "add"
				? "Create a new advisor entry, then edit its model, tools, and instructions."
				: value === "scope"
					? `Switch between the project and user WATCHDOG.yml. Currently editing the ${this.#scope}-level file.`
					: value === "save"
						? "Write this scope's WATCHDOG.yml and reload the live advisors without a restart."
						: value === "close"
							? "Close the editor. Unsaved changes are discarded."
							: "";
		return [...warnings, ...wrap(help, bodyWidth).map(line => truncateToWidth(theme.fg("muted", line), bodyWidth))];
	}

	#advisorPreview(advisor: AdvisorConfig, bodyWidth: number): string[] {
		const model = advisor.model?.trim() || this.#defaultModelLabel || "advisor role default";
		const tools = formatAdvisorTools(advisor.tools, "no tools");
		const syncBacklog = this.#syncBacklogLabel(advisor);
		const lines = [
			theme.bold(advisor.name || "(unnamed)"),
			"",
			`${theme.fg("dim", "Enabled:")} ${advisor.enabled === false ? "○ off" : "● on"}`,
			`${theme.fg("dim", "Model:")} ${model}`,
			`${theme.fg("dim", "Tools:")} ${tools}`,
			`${theme.fg("dim", "Review:")} ${formatReviewCadence(advisor)}`,
			`${theme.fg("dim", "Sync backlog:")} ${syncBacklog}`,
			"",
			theme.fg("dim", "Instructions:"),
		];
		const instr = advisor.instructions?.trim();
		lines.push(...(instr ? wrap(instr, bodyWidth) : [theme.fg("muted", "(none)")]));
		// Show live usage stats when available from the session.
		const liveStat = this.#cb.getAdvisorStats?.()?.find(s => s.name === (advisor.name || "default"));
		if (liveStat && (liveStat.status === "running" || liveStat.status === "quota_exhausted")) {
			lines.push("", theme.fg("dim", "Usage:"));
			const spendParts: string[] = [
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
		}
		const quotaProvider =
			(advisor.model?.includes("/") ? advisor.model.split("/")[0] : null) ?? liveStat?.model?.provider;
		if (this.#cachedReports && quotaProvider) {
			const quota = formatCompactQuota(
				quotaProvider,
				this.#cachedReports,
				Date.now(),
				this.#cb.getQuotaLimitFilter?.(quotaProvider, liveStat?.sessionId),
			);
			if (quota) lines.push(theme.fg("dim", `  ${quota}`));
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	// ───────────────────────────── screens ───────────────────────────

	#setScreen(screen: Screen, active: Component, footerHint: string): void {
		this.#screen = screen;
		this.#active = active;
		this.#footerHint = footerHint;
		this.#previewScroll = 0;
		this.#cb.requestRender();
	}

	#otherScope(): AdvisorConfigScope {
		return this.#scope === "project" ? "user" : "project";
	}

	#ensureRosterVisible(): void {
		if (this.#doc.advisors.length === 0) this.#doc.advisors.push({ name: "default" });
	}

	#hasSyntheticDefaultAdvisor(doc: WatchdogConfigDoc): boolean {
		if (doc.advisors.length !== 1) return false;
		const advisor = doc.advisors[0];
		return (
			advisor?.name === "default" &&
			!advisor.model?.trim() &&
			advisor.tools === undefined &&
			advisor.reviewMode === undefined &&
			advisor.reviewInterval === undefined &&
			advisor.syncBacklog === undefined &&
			!advisor.instructions?.trim() &&
			advisor.enabled !== false &&
			advisor.maxNotesPerUpdate === undefined
		);
	}

	#advisorSummary(advisor: AdvisorConfig): string {
		const model = advisor.model?.trim() || this.#defaultModelLabel || "advisor role default";
		const tools = formatAdvisorTools(advisor.tools, "no tools");
		return `${model} · ${tools} · review ${advisor.reviewMode ?? "turn"}/${advisor.reviewInterval ?? 1}`;
	}

	/** The advisor's explicit catch-up override, else the inherited global policy. */
	#syncBacklogLabel(advisor: AdvisorConfig): string {
		return advisor.syncBacklog ?? `${this.#deps.syncBacklog ?? "off"} (inherited)`;
	}

	#showList(): void {
		this.#detailIndex = -1;
		this.#ensureRosterVisible();
		const items: SelectItem[] = this.#doc.advisors.map((advisor, index) => ({
			value: `advisor:${index}`,
			label: `${advisor.enabled === false ? "○" : "●"} ${advisor.name || "(unnamed)"}`,
			description: this.#advisorSummary(advisor),
		}));
		items.push({ value: "add", label: "+ Add advisor" });
		items.push({
			value: "shared",
			label: "Shared instructions",
			description: previewLineOrNone(this.#doc.instructions),
		});
		items.push({ value: "scope", label: `Scope: ${this.#scope}`, description: `→ ${this.#otherScope()}` });
		items.push({ value: "save", label: "Save & apply" });
		items.push({ value: "close", label: "Close" });

		// Show every row (no internal overflow-search); the split frame supplies height.
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
			this.#cb.requestRender();
		};
		list.onSelect = item =>
			void this.#onListSelect(item.value).catch(err => {
				this.#cb.notify(`Advisor config: ${err instanceof Error ? err.message : String(err)}`);
			});
		list.onCancel = () => this.#cb.close();
		this.#setScreen(
			"list",
			list,
			`${editorKeys("tui.select.up", "tui.select.down")} move · ${editorKey("tui.select.confirm")} / click select · scroll preview on the right · ${editorKey("tui.select.cancel")} close`,
		);
	}

	async #onListSelect(value: string): Promise<void> {
		if (value === "add") {
			this.#doc.advisors.push({ name: `Advisor ${this.#doc.advisors.length + 1}` });
			this.#dirty = true;
			this.#showDetail(this.#doc.advisors.length - 1);
			return;
		}
		if (value === "shared") {
			this.#showInstructionsEditor(-1);
			return;
		}
		if (value === "scope") {
			if (this.#dirty) {
				this.#cb.notify('Unsaved changes — "Save & apply" or Close before switching scope.');
				return;
			}
			const next = this.#otherScope();
			const doc = await this.#cb.loadDoc(next);
			this.#doc = doc;
			this.#scope = next;
			// Surface malformed entries in the file just made active. The host shows
			// the initial scope's warnings when the overlay opens, so only switches
			// report here — no double-showing the opening file.
			if (doc.warnings?.length) {
				const message = `WATCHDOG.yml: ${sanitizeDisplayWarnings(doc.warnings).join("; ")}`;
				if (this.#cb.warn) this.#cb.warn(message);
				else this.#cb.notify(message);
			}
			this.#ensureRosterVisible();
			this.#showList();
			return;
		}
		if (value === "save") {
			const doc = this.#hasSyntheticDefaultAdvisor(this.#doc) ? { ...this.#doc, advisors: [] } : this.#doc;
			await this.#cb.save(this.#scope, doc);
			// The saved file contains only the normalized entries, so the load-time
			// warnings no longer apply to it. (On failure the throw skips this.)
			this.#doc.warnings = undefined;
			this.#dirty = false;
			this.#showList();
			return;
		}
		if (value === "close") {
			this.#cb.close();
			return;
		}
		const match = /^advisor:(\d+)$/.exec(value);
		if (match) this.#showDetail(Number(match[1]));
	}

	#showDetail(index: number): void {
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		this.#detailIndex = index;
		const modelDescription = advisor.model?.trim() || this.#defaultModelLabel || "advisor role default";
		const toolsDescription = formatAdvisorTools(advisor.tools, "no tools");
		const reviewMode = advisor.reviewMode ?? "turn";
		const reviewInterval = advisor.reviewInterval ?? 1;
		const items: SelectItem[] = [
			{ value: "name", label: "Name", description: advisor.name },
			{
				value: "toggleEnabled",
				label: "Enabled",
				description: advisor.enabled === false ? "○ off" : "● on",
			},
			{ value: "model", label: "Model", description: modelDescription },
			{ value: "reviewMode", label: "Review mode", description: reviewMode },
			{ value: "reviewInterval", label: "Review interval", description: String(reviewInterval) },
			{
				value: "syncBacklog",
				label: "Sync backlog",
				description: this.#syncBacklogLabel(advisor),
			},
		];
		if (advisor.model?.trim()) {
			items.push({ value: "resetModel", label: "Reset model to advisor-role default" });
		}
		items.push(
			{ value: "tools", label: "Tools", description: toolsDescription },
			{ value: "instructions", label: "Instructions", description: previewLineOrNone(advisor.instructions) },
			{ value: "delete", label: "Delete this advisor" },
			{ value: "back", label: "Back" },
		);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelect = item => this.#onDetailSelect(index, item.value);
		list.onCancel = () => this.#showList();
		this.#setScreen(
			"detail",
			list,
			`Editing "${advisor.name}" · ${editorKey("tui.select.confirm")} / click edit field · ${editorKey("tui.select.cancel")} back`,
		);
	}

	#onDetailSelect(index: number, field: string): void {
		switch (field) {
			case "toggleEnabled": {
				const a = this.#doc.advisors[index];
				a.enabled = a.enabled === false ? undefined : false;
				this.#dirty = true;
				this.#showDetail(index);
				return;
			}
			case "name":
				this.#showNameEditor(index);
				return;
			case "model":
				this.#showModelPicker(index);
				return;
			case "reviewMode":
				this.#showReviewModePicker(index);
				return;
			case "reviewInterval":
				this.#showReviewIntervalEditor(index);
				return;
			case "syncBacklog":
				this.#showSyncBacklogPicker(index);
				return;
			case "tools":
				this.#showToolsEditor(index, new Set(this.#doc.advisors[index].tools ?? this.#deps.defaultToolNames), 0);
				return;
			case "resetModel":
				this.#doc.advisors[index].model = undefined;
				this.#dirty = true;
				this.#showDetail(index);
				return;
			case "instructions":
				this.#showInstructionsEditor(index);
				return;
			case "delete":
				this.#doc.advisors.splice(index, 1);
				this.#dirty = true;
				this.#showList();
				return;
			default:
				this.#showList();
		}
	}

	#showNameEditor(index: number): void {
		const input = new Input();
		input.setValue(this.#doc.advisors[index].name);
		input.onSubmit = value => {
			const name = value.trim();
			if (name) {
				this.#doc.advisors[index].name = name;
				this.#dirty = true;
			}
			this.#showDetail(index);
		};
		input.onEscape = () => this.#showDetail(index);
		this.#setScreen(
			"name",
			input,
			`Type a name · ${editorKey("tui.input.submit")} save · ${editorKey("tui.select.cancel")} cancel`,
		);
	}

	#showModelPicker(index: number): void {
		const mruOrder = this.#deps.browserSource.mruOrder;
		let models: ReadonlyArray<Model>;
		if (this.#deps.scopedModelsConfigured ?? this.#scopedModels.length > 0) {
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

		const picker = new ModelBrowser(this.#deps.browserSource, {});
		picker.setMruOrder(mruOrder);
		picker.setPerfStats(this.#deps.browserSource.modelPerf);
		picker.setItems(items);
		picker.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			if (efforts.length === 0) {
				this.#doc.advisors[index].model = item.selector;
				this.#dirty = true;
				this.#showDetail(index);
			} else {
				this.#showThinkingPicker(index, item.selector, efforts);
			}
		};
		picker.onCancel = () => this.#showDetail(index);
		this.#setScreen(
			"model",
			picker,
			`Type to search · ${formatKeyHint("enter")} / click twice picks · ${editorKey("tui.select.cancel")} back`,
		);
	}

	#showThinkingPicker(index: number, selector: string, efforts: readonly string[]): void {
		const items: SelectItem[] = [{ value: "", label: "(model default thinking)" }];
		for (const effort of efforts) items.push({ value: effort, label: effort });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelect = item => {
			// Values are supported efforts or the empty model-default choice.
			this.#doc.advisors[index].model = item.value ? `${selector}:${item.value}` : selector;
			this.#dirty = true;
			this.#showDetail(index);
		};
		list.onCancel = () => this.#showModelPicker(index);
		this.#setScreen(
			"thinking",
			list,
			`Thinking effort for ${selector} · ${editorKey("tui.select.confirm")} / click pick · ${editorKey("tui.select.cancel")} back`,
		);
	}
	#showReviewModePicker(index: number): void {
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		const current = advisor.reviewMode ?? ADVISOR_REVIEW_MODES[0];
		const items: SelectItem[] = ADVISOR_REVIEW_MODES.map(mode => ({
			value: mode,
			label: mode === current ? `${mode} (current)` : mode,
			description:
				mode === "turn"
					? "Review every primary turn (tool-call round)."
					: "Review only at agent end (once per run).",
		}));
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.setSelectedIndex(ADVISOR_REVIEW_MODES.indexOf(current));
		list.onSelect = item => {
			advisor.reviewMode = item.value === "turn" ? undefined : "agent-end";
			this.#dirty = true;
			this.#showDetail(index);
		};
		list.onCancel = () => this.#showDetail(index);
		this.#setScreen(
			"review-mode",
			list,
			`${editorKey("tui.select.confirm")} / click choose review mode · ${editorKey("tui.select.cancel")} back`,
		);
	}

	#showReviewIntervalEditor(index: number): void {
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		const input = new Input();
		input.setValue(String(advisor.reviewInterval ?? 1));
		input.onSubmit = value => {
			const interval = Number(value.trim());
			if (!Number.isSafeInteger(interval) || interval < 1) {
				this.#cb.notify("Review interval must be a positive integer.");
				return;
			}
			advisor.reviewInterval = interval === 1 ? undefined : interval;
			this.#dirty = true;
			this.#showDetail(index);
		};
		input.onEscape = () => this.#showDetail(index);
		this.#setScreen(
			"review-interval",
			input,
			`Type a positive integer · ${editorKey("tui.input.submit")} save · ${editorKey("tui.select.cancel")} cancel`,
		);
	}

	#showSyncBacklogPicker(index: number): void {
		const advisor = this.#doc.advisors[index];
		if (!advisor) {
			this.#showList();
			return;
		}
		const global = this.#deps.syncBacklog ?? "off";
		const current = advisor.syncBacklog;
		const items: SelectItem[] = [
			{
				value: SYNC_BACKLOG_INHERIT,
				label: current === undefined ? "inherit (current)" : "inherit",
				description: `Follow the global advisor.syncBacklog setting (currently "${global}").`,
			},
			...ADVISOR_SYNC_BACKLOG_MODES.map(mode => ({
				value: mode,
				label: mode === current ? `${mode} (current)` : mode,
				description: describeSyncBacklogMode(mode),
			})),
		];
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.setSelectedIndex(current === undefined ? 0 : ADVISOR_SYNC_BACKLOG_MODES.indexOf(current) + 1);
		list.onSelect = item => {
			// The inherit sentinel matches no mode, so `find` yields undefined — the override clears.
			advisor.syncBacklog = ADVISOR_SYNC_BACKLOG_MODES.find(mode => mode === item.value);
			this.#dirty = true;
			this.#showDetail(index);
		};
		list.onCancel = () => this.#showDetail(index);
		this.#setScreen(
			"sync-backlog",
			list,
			`${editorKey("tui.select.confirm")} / click choose catch-up policy · ${editorKey("tui.select.cancel")} back`,
		);
	}

	#showToolsEditor(index: number, selected: Set<string>, cursor: number): void {
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
		list.onSelect = item => {
			if (item.value === "__done") {
				this.#doc.advisors[index].tools = commitTools(selected, all, this.#deps.defaultToolNames);
				this.#dirty = true;
				this.#showDetail(index);
				return;
			}
			if (selected.has(item.value)) selected.delete(item.value);
			else selected.add(item.value);
			this.#showToolsEditor(index, selected, cursorIndex);
		};
		list.onCancel = () => {
			this.#doc.advisors[index].tools = commitTools(selected, all, this.#deps.defaultToolNames);
			this.#dirty = true;
			this.#showDetail(index);
		};
		this.#setScreen(
			"tools",
			list,
			`${editorKey("tui.select.confirm")} / click toggle · select Done or ${editorKey("tui.select.cancel")} to apply (empty = no tools; read/grep/glob = default)`,
		);
	}

	/** `index === -1` edits the shared top-level instructions; otherwise advisor[index]. */
	#showInstructionsEditor(index: number): void {
		const shared = index < 0;
		this.#detailIndex = index;
		const current = shared ? this.#doc.instructions : this.#doc.advisors[index].instructions;
		const title = shared ? "Shared advisor instructions" : `Instructions — ${this.#doc.advisors[index].name}`;
		const editor = new HookEditorComponent(
			this.#tui,
			title,
			current,
			value => {
				const text = value.trim() ? value : undefined;
				if (shared) this.#doc.instructions = text;
				else this.#doc.advisors[index].instructions = text;
				this.#dirty = true;
				if (shared) this.#showList();
				else this.#showDetail(index);
			},
			() => {
				if (shared) this.#showList();
				else this.#showDetail(index);
			},
			{ externalEditor: this.#deps.externalEditor },
		);
		this.#setScreen("instructions", editor, "");
	}
}
