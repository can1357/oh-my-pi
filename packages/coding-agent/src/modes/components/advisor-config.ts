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
import type { Model, UsageReport } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
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
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	ADVISOR_DEFAULT_TOOL_NAMES,
	type AdvisorConfig,
	type AdvisorConfigScope,
	type WatchdogConfigDoc,
} from "../../advisor";
import type { ModelRegistry } from "../../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { PerAdvisorStat } from "../../session/agent-session";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import { formatCompactQuota } from "../controllers/command-controller";
import { getSelectListTheme, theme } from "../theme/theme";
import { HookEditorComponent } from "./hook-editor";
import { buildBrowserItems, ModelBrowser, resolveRoleAssignments, sortModelItems } from "./model-browser";
import { bottomBorder, fit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";

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
	/** Live advisor usage stats; lets the editor show tokens/cost per advisor. */
	getAdvisorStats?: () => PerAdvisorStat[];
	getUsageReports?: () => Promise<UsageReport[] | null>;
	/** Resolve the active OAuth identity for quota filtering (per-advisor account stickiness). */
	resolveActiveAccount?: (provider: string, sessionId?: string) => OAuthAccountIdentity | undefined;
}

export interface AdvisorConfigDeps {
	modelRegistry: ModelRegistry;
	settings: Settings;
	scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	availableToolNames: string[];
	/** Formatted advisor-role model shown for advisors without an explicit model (e.g. "anthropic/claude-..."). */
	defaultModelLabel?: string;
	/** Project folder name, shown as the project pane title. */
	projectName?: string;
}

const PREVIEW_WIDTH = 60;

function previewLine(text: string | undefined): string {
	if (!text?.trim()) return "(none)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Omitted means default read/grep/glob; an explicit empty set means no tools. */
function commitTools(selected: ReadonlySet<string>, all: readonly string[]): string[] | undefined {
	if (selected.size === 0) return [];
	if (selected.size === ADVISOR_DEFAULT_TOOL_NAMES.size) {
		let matchesDefault = true;
		for (const name of ADVISOR_DEFAULT_TOOL_NAMES) {
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
	loading: boolean;
	/** Remembered roster row value so rebuilds keep the cursor. */
	cursor: string | undefined;
}

/**
 * Fullscreen advisor-configuration overlay. Implements {@link Component} directly
 * (rather than extending Container) so it owns the whole frame and the mouse
 * geometry needed to make every row clickable.
 */
export class AdvisorConfigOverlayComponent implements Component {
	#tui: TUI;
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	#scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#availableToolNames: readonly string[];
	#defaultModelLabel: string | undefined;
	#projectName: string | undefined;
	#cb: AdvisorConfigCallbacks;
	#cachedReports: UsageReport[] | null = null;

	#scopes: Record<AdvisorConfigScope, ScopeState>;
	#focus: Pane;
	#mode: EditorMode = "fields";
	/** Right-pane component (field list or an open field editor). */
	#editor: Component = new SelectList([], 1, getSelectListTheme());
	/** Remembered field-list row so returning from a field editor lands on it. */
	#fieldCursor: string | undefined;
	#editorScroll = 0;

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
		this.#modelRegistry = deps.modelRegistry;
		this.#settings = deps.settings;
		this.#scopedModels = deps.scopedModels;
		this.#availableToolNames = deps.availableToolNames;
		this.#defaultModelLabel = deps.defaultModelLabel;
		this.#projectName =
			deps.projectName === undefined ? undefined : replaceTabs(sanitizeText(deps.projectName)).replace(/\s+/g, " ");
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
				this.#scopes[other].loading = false;
				this.#rebuildRoster(other);
				if (this.#focus === other) this.#showFields();
				this.#cb.requestRender();
			})
			.catch(err => {
				this.#scopes[other].loading = false;
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
			loading: false,
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
		return fit(`${theme.fg("border", theme.boxRound.horizontal)}${label}${rule}`, width);
	}

	#footerHint(): string {
		if (this.#focus === "editor") {
			switch (this.#mode) {
				case "name":
					return "Type a name · Enter save · Esc cancel";
				case "model":
					return "Type to search · Enter / click twice picks · Esc back";
				case "thinking":
					return "Enter / click pick · Esc back";
				case "tools":
					return "Enter / click toggle · Done or Esc apply · ← rosters";
				case "instructions":
					return "";
				default:
					return "↑↓ move · Enter / click edit · ← rosters · Esc close";
			}
		}
		return "↑↓ move · → / Enter edit · click select · Esc close";
	}

	#editorWindow(bodyWidth: number, rows: number): string[] {
		const lines = this.#editorContent(bodyWidth);
		const maxScroll = Math.max(0, lines.length - rows);
		this.#editorScroll = Math.min(this.#editorScroll, maxScroll);
		const window = lines.slice(this.#editorScroll, this.#editorScroll + rows);
		if (lines.length > rows) {
			const marker =
				this.#editorScroll + rows < lines.length
					? theme.fg("dim", `  ↓ ${lines.length - this.#editorScroll - rows} more`)
					: theme.fg("dim", "  (end)");
			window[rows - 1] = marker;
		}
		return this.#padTo(window, rows);
	}

	#editorContent(bodyWidth: number): string[] {
		const target = this.#selected();
		const header = target
			? theme.bold(
					`${target.advisor.name || "(unnamed)"}  ${theme.fg("dim", `· ${this.#scopeLabel(target.scope)}`)}`,
				)
			: theme.bold(this.#focus === "editor" ? "Advisor" : this.#scopeLabel(this.#focus));
		const lines: string[] = [header, ""];
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
			const activeAccount = this.#cb.resolveActiveAccount?.(quotaProvider, liveStat.sessionId);
			const quota = formatCompactQuota(quotaProvider, this.#cachedReports, Date.now(), activeAccount);
			if (quota) lines.push(theme.fg("dim", `  ${quota}`));
		}
		return lines;
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
			// ↓ past the project roster's end drops into the global roster; ↑ above the
			// global roster's top climbs back. Each roster keeps its own cursor.
			const list = this.#scopes[this.#focus].list;
			const at = list.getSelectedIndex();
			if (data === "\x1b[B" && this.#focus === "project" && at >= list.getItemCount() - 1) {
				this.#focus = "user";
				this.#showFields();
				return;
			}
			if (data === "\x1b[A" && this.#focus === "user" && at <= 0) {
				this.#focus = "project";
				this.#showFields();
				return;
			}
			list.handleInput(data);
			return;
		}
		// Editor pane: ← returns to the rosters unless a text editor is open.
		if (data === "\x1b[D" && this.#mode !== "name" && this.#mode !== "instructions" && this.#mode !== "model") {
			this.#focus = this.#lastRosterFocus;
			this.#cb.requestRender();
			return;
		}
		this.#editor.handleInput?.(data);
	}

	/** Forward enhanced-paste transports into a multiline instructions editor. */
	pasteText(text: string): void {
		if (this.#editor instanceof HookEditorComponent) this.#editor.pasteText(text);
	}

	#lastRosterFocus: AdvisorConfigScope = "project";

	#focusEditor(): void {
		if (this.#focus !== "editor") this.#lastRosterFocus = this.#focus;
		this.#focus = "editor";
		this.#cb.requestRender();
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		if (event.col >= this.#dividerCol) {
			if (event.wheel !== null) {
				const el = this.#editor as Partial<MouseRoutable>;
				if (this.#mode !== "fields" && typeof el.routeMouse === "function") {
					el.routeMouse(event, event.row - 3, event.col - this.#dividerCol - 1);
				} else {
					this.#editorScroll = Math.max(0, this.#editorScroll + event.wheel);
				}
				this.#cb.requestRender();
				return true;
			}
			if (event.leftClick) {
				if (this.#focus !== "editor") this.#showFields();
				this.#focusEditor();
			}
			const el = this.#editor as Partial<MouseRoutable>;
			// Editor content starts 2 rows below the body top (header + blank).
			if (typeof el.routeMouse === "function")
				el.routeMouse(event, event.row - 1 - 2 + this.#editorScroll, event.col - this.#dividerCol - 1);
			return true;
		}
		const inProject = event.row >= this.#projectRowStart && event.row < this.#projectRowStart + this.#projectRows;
		const inUser = event.row >= this.#userRowStart && event.row < this.#userRowStart + this.#userRows;
		const scope: AdvisorConfigScope | undefined = inProject ? "project" : inUser ? "user" : undefined;
		if (!scope) return false;
		if (event.leftClick && this.#focus !== scope) {
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
		const items: SelectItem[] = state.doc.advisors.map((advisor, index) => ({
			value: `advisor:${index}`,
			label: `${theme.symbol(advisor.enabled === false ? "status.disabled" : "status.enabled")} ${advisor.name || "(unnamed)"}`,
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
			if (this.#mode === "fields") this.#showFields();
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
		this.#scopes[scope].dirty = true;
		this.#rebuildRoster(scope);
	}

	async #onRosterSelect(scope: AdvisorConfigScope, value: string): Promise<void> {
		const state = this.#scopes[scope];
		if (state.loading) return;
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
			const doc = this.#hasSyntheticDefaultAdvisor(state.doc) ? { ...state.doc, advisors: [] } : state.doc;
			await this.#cb.save(scope, doc);
			state.dirty = false;
			this.#rebuildRoster(scope);
			this.#cb.notify(`Saved ${this.#scopeLabel(scope)} advisors`);
			this.#cb.requestRender();
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
			{ value: "name", label: "Name", description: advisor.name },
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
		list.onCancel = () => this.#cb.close();
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
					new Set(doc.advisors[index].tools ?? [...ADVISOR_DEFAULT_TOOL_NAMES]),
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
		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
		} else {
			try {
				models = this.#modelRegistry.getAvailable();
			} catch {
				models = [];
			}
		}
		const allModels = this.#scopedModels.length > 0 ? models : this.#modelRegistry.getAll();
		const roles = resolveRoleAssignments(this.#settings, allModels, models);
		const items = buildBrowserItems(models);
		sortModelItems(items, { roles, mruOrder });
		const current = this.#scopes[scope].doc.advisors[index].model?.trim();
		const resolvedCurrent = resolveModelRoleValue(current, [...models], { settings: this.#settings });
		const currentModel = resolvedCurrent.model;
		const currentSelector = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
		const picker = new ModelBrowser(this.#settings, {});
		picker.setRoles(roles);
		picker.setMruOrder(mruOrder);
		picker.setPerfStats(storage?.getModelPerf() ?? new Map());
		picker.setCurrentSelector(currentSelector);
		picker.setItems(items);
		if (currentSelector) picker.selectSelector(currentSelector);
		picker.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			const isCurrentModel = currentModel?.provider === item.model.provider && currentModel.id === item.model.id;
			const selector = isCurrentModel ? formatModelStringWithRouting(currentModel) : item.selector;
			if (efforts.length === 0) {
				this.#scopes[scope].doc.advisors[index].model = selector;
				this.#markDirty(scope);
				this.#showFields();
			} else {
				const currentLevel =
					isCurrentModel && resolvedCurrent.explicitThinkingLevel && resolvedCurrent.thinkingLevel !== "auto"
						? resolvedCurrent.thinkingLevel
						: undefined;
				this.#showThinkingPicker(scope, index, selector, efforts, currentLevel);
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
		currentLevel?: ThinkingLevel,
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
			this.#scopes[scope].doc.advisors[index].tools = commitTools(selected, all);
			this.#markDirty(scope);
			this.#showFields();
		};
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
			: `Instructions — ${doc.advisors[index].name}`;
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
