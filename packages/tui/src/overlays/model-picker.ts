/**
 * Session-only model picker. Hosts may opt into a passive editor-area popup;
 * the default remains the compact bottom-anchored overlay.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { addKeyAliases, canonicalKeyId } from "../keybindings";
import { type KeyId, parseKey } from "../keys";
import { CURSOR_MARKER, type Focusable, type TUI } from "../tui";
import { applyBackgroundToLine, truncateToWidth } from "../utils";
import { type ThemeColor, theme } from "../theme/theme";
import { buildSessionModelScope, ModelBrowser, type ModelBrowserItem } from "./model-browser";
import type { ModelBrowserRegistry, ModelBrowserSource } from "./model-browser";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ScopedModelItem } from "./model-hub";
import { bottomBorder, row, topBorder } from "../chrome/overlay-box";
import { resolveSegmentPalette } from "../chrome/segment-track";

/** Configured role resolved to a concrete model. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** Catalog refresh capability used by the session picker. */
export interface ModelPickerRegistry extends ModelBrowserRegistry {
	refresh(strategy: "offline"): Promise<void>;
}

export interface ModelPickerCallbacks {
	/**
	 * A model was chosen for a session-only switch. `selector` is `provider/id`.
	 * `overContext` is true when the session transcript exceeds the model's
	 * context window — the host must compact before switching.
	 */
	onPick: (model: Model, selector: string, meta: { overContext: boolean }) => void;
	/** A configured ctrl+p quick role was chosen. */
	onPickRole?: (entry: ResolvedRoleModel) => void;
	/**
	 * A model was chosen for Task subagents (task mode, toggled by pressing the
	 * picker shortcut again). Session-only: the host applies a runtime override.
	 */
	onPickTask?: (model: Model, selector: string) => void;
	/** The picker was dismissed. */
	onCancel: () => void;
}

export interface ModelPickerOptions {
	/** Replace only the existing editor rows; paint the list through the slash-popup path. */
	editorRows?: number;
	/** Preserve editor chrome; mark the input row with CURSOR_MARKER even while unfocused. */
	renderEditorRows?: (width: number) => readonly string[];
	/** Session token count; models with smaller context windows are grayed and compact-first on pick. */
	currentContextTokens?: number;
	/** `provider/id` of the session's active model; highlighted and preselected. */
	currentSelector?: string;
	/** Resolved role models in the same order used by the ctrl+p quick-role cycle. */
	quickRoles?: ReadonlyArray<ResolvedRoleModel>;
	/** Complete ctrl+p order, including unavailable roles, to preserve segment colors. */
	quickRoleOrder?: ReadonlyArray<string>;
	/** Active quick role, highlighted when the search begins with `@`. */
	currentQuickRole?: string;
	/** Keys that toggle task-subagent mode while the picker is open; typically the alt+p binding. */
	taskModeKeys?: readonly KeyId[];
	/** Human-readable label for the toggle key, shown in footer hints (e.g. "alt+p"). */
	taskModeKeyLabel?: string;
	/** `provider/id` highlighted and preselected in task mode (current Task subagent model). */
	taskSelector?: string;
	/** Fill the inline popup with the host's message background. */
	popupFill?: boolean;
}

/** Fixed chrome rows in the default picker. */
const CHROME_ROWS = 4;
/** Rows the browser renders around its list window (search + blank, blank + two detail rows). */
export const BROWSER_FRAME_ROWS = 5;
/** Minimum rows for the browser list window on short terminals. */
const MIN_VISIBLE = 5;
/** Fraction of the terminal height the floating overlay occupies. */
const HEIGHT_FRACTION = 0.4;

const STATUS_HINT = "Session-only switch — role models stay unchanged";
const QUICK_ROLE_STATUS_HINT = "Quick role switch — applies its model and thinking for this session";
const TASK_STATUS_HINT = "Task subagent switch — spawned task agents use this model (session-only)";
const FOOTER_HINT = "↑/↓ models · Enter use for this session · type to search · @ quick roles · Esc close";
const QUICK_ROLE_FOOTER_HINT = "↑/↓ roles · Enter apply role model · type to search · Esc close";
const TASK_FOOTER_HINT = "↑/↓ models · Enter use for Task subagents · type to search · Esc close";

/** Search occupies the editor slot; results use the passive slash-popup renderer. */
export class ModelPickerComponent implements Focusable {
	#tui: TUI;
	#settings: ModelBrowserSource;
	#registry: ModelPickerRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#browser: ModelBrowser;
	#configError: string | undefined;
	#currentSelector: string | undefined;
	#currentQuickRoleSelector: string | undefined;
	#modelItems: ModelBrowserItem[] = [];
	#quickRoleItems: ModelBrowserItem[] = [];
	#quickRoles = new Map<string, ResolvedRoleModel>();
	#roleMode = false;
	#taskMode = false;
	#taskMatchKeys = new Set<string>();
	#taskModeKeyLabel: string;
	#taskSelector: string | undefined;
	#editorRows: number | undefined;
	#renderEditorRows: ((width: number) => readonly string[]) | undefined;
	#popupFill: boolean;
	#focused = false;

	get focused(): boolean {
		return this.#focused;
	}

	set focused(focused: boolean) {
		this.#focused = focused;
		this.#browser.setFocused(focused);
		this.#browser.setSearchFocused(focused);
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#browser.setUseTerminalCursor(useTerminalCursor);
	}

	constructor(
		tui: TUI,
		settings: ModelBrowserSource,
		registry: ModelPickerRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelPickerCallbacks,
		options: ModelPickerOptions = {},
	) {
		this.#tui = tui;
		this.#editorRows = options.editorRows;
		this.#renderEditorRows = options.renderEditorRows;
		this.#popupFill = options.popupFill ?? false;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#currentSelector = options.currentSelector;
		this.#currentQuickRoleSelector = options.currentQuickRole ? `@${options.currentQuickRole}` : undefined;
		this.#taskSelector = options.taskSelector;
		this.#taskModeKeyLabel = options.taskModeKeyLabel ?? "alt+p";
		if (callbacks.onPickTask) {
			for (const key of options.taskModeKeys ?? []) addKeyAliases(this.#taskMatchKeys, key);
		}
		this.#quickRoleItems = this.#buildQuickRoleItems(
			options.quickRoles ?? [],
			options.quickRoleOrder ?? options.quickRoles?.map(entry => entry.role) ?? [],
		);

		this.#browser = new ModelBrowser(settings, {
			searchPrompt: options.editorRows === undefined ? undefined : "",
			searchFocused: options.editorRows !== undefined,
			currentContextTokens: options.currentContextTokens,
			markOverContext: true,
			emptyText: () => (this.#roleMode ? "  No quick roles in the Ctrl+P cycle" : undefined),
		});
		this.#browser.onActivate = item => {
			const quickRole = this.#quickRoles.get(item.selector);
			if (quickRole) {
				callbacks.onPickRole?.(quickRole);
				return;
			}
			if (this.#taskMode) {
				callbacks.onPickTask?.(item.model, item.selector);
				return;
			}
			callbacks.onPick(item.model, item.selector, { overContext: this.#browser.isOverContext(item) });
		};
		this.#browser.onCancel = () => callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#syncItemsForQuery(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();
		if (options.currentSelector) {
			this.#browser.selectSelector(options.currentSelector);
		}

		// Reconcile with cached discovery state in the background. A --models
		// scope is registry-independent, so the offline reload would only repeat
		// the synchronous hydration above.
		if (this.#scopedModels.length === 0) {
			this.#registry
				.refresh("offline")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => this.#tui.requestRender());
		}
	}

	invalidate(): void {}

	/** Rebuild model items and role chips from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		const scope = buildSessionModelScope(
			this.#settings,
			this.#registry,
			this.#scopedModels.map(s => s.model),
		);
		this.#configError = scope.error;
		this.#modelItems = scope.items;
		this.#browser.setRoles(scope.roles);
		this.#browser.setMruOrder(scope.mruOrder);
		this.#browser.setPerfStats(this.#settings.modelPerf);
		this.#syncItemsForQuery(this.#browser.query, true);
	}

	/** Build virtual `@role` rows, colored by their ctrl+p segment position. */
	#buildQuickRoleItems(
		quickRoles: ReadonlyArray<ResolvedRoleModel>,
		quickRoleOrder: ReadonlyArray<string>,
	): ModelBrowserItem[] {
		const order = quickRoleOrder.length > 0 ? quickRoleOrder : quickRoles.map(entry => entry.role);
		const palette = resolveSegmentPalette(order.length);
		return quickRoles.map((entry, index) => {
			const selector = `@${entry.role}`;
			this.#quickRoles.set(selector, entry);
			const orderIndex = order.indexOf(entry.role);
			return {
				provider: "",
				id: selector,
				model: entry.model,
				selector,
				labelColor: palette[(orderIndex >= 0 ? orderIndex : index) % palette.length],
			};
		});
	}

	/** Switch browser content only when a leading `@` changes the search mode. */
	#syncItemsForQuery(query: string, refresh = false): void {
		const roleMode = query.startsWith("@") && !this.#taskMode;
		const modeChanged = roleMode !== this.#roleMode;
		if (!modeChanged && !refresh) return;

		this.#roleMode = roleMode;
		this.#browser.setShowProvider(!roleMode);
		this.#browser.setMarkOverContext(!roleMode && !this.#taskMode);
		this.#browser.setPreserveQueryOrder(roleMode);
		const currentSelector = roleMode
			? this.#currentQuickRoleSelector
			: this.#taskMode
				? this.#taskSelector
				: this.#currentSelector;
		this.#browser.setCurrentSelector(currentSelector);
		this.#browser.setItems(roleMode ? this.#quickRoleItems : this.#modelItems);
		if (modeChanged && currentSelector) {
			this.#browser.selectSelector(currentSelector);
		}
	}

	handleInput(data: string): void {
		// Mouse tracking is off outside fullscreen overlays; drop any stray SGR
		// reports instead of feeding them to the search input.
		if (data.startsWith("\x1b[<")) return;
		if (this.#taskMatchKeys.size > 0) {
			const parsed = parseKey(data);
			const canonical = parsed !== undefined ? canonicalKeyId(parsed) : undefined;
			if (canonical !== undefined && this.#taskMatchKeys.has(canonical)) {
				this.#toggleTaskMode();
				return;
			}
		}
		this.#browser.handleInput(data);
	}

	/** Clipboard payloads edit search rather than the hidden conversation draft. */
	pasteText(text: string): void {
		this.#browser.pasteText(text);
	}
	/** Flip between session-model and Task-subagent targets, repointing the highlight. */
	#toggleTaskMode(): void {
		this.#taskMode = !this.#taskMode;
		this.#syncItemsForQuery(this.#browser.query, true);
		const target = this.#taskMode ? this.#taskSelector : this.#currentSelector;
		if (target) this.#browser.selectSelector(target);
		this.#tui.requestRender();
	}

	render(width: number): string[] {
		if (this.#editorRows !== undefined) {
			const editorRows = this.#renderEditorRows?.(width);
			const count = Math.max(1, editorRows?.length ?? this.#editorRows);
			const markedRow = editorRows?.findIndex(line => line.includes(CURSOR_MARKER)) ?? -1;
			const inputRow = markedRow >= 0 ? markedRow : count - 1;
			const rendered = this.#renderPicker(width, this.#tui.terminal.rows);
			const search = rendered.pop() ?? "";
			this.#tui.setCursorOverlay(
				(popupWidth, available) => {
					const rows = this.#renderPicker(popupWidth, available + 1);
					rows.pop();
					return this.#popupFill
						? rows
								.slice(0, available)
								.map(line =>
									applyBackgroundToLine(line, popupWidth, text => theme.bgFill("userMessageBg", text)),
								)
						: rows.slice(0, available);
				},
				inputRow,
				count,
				"above",
			);
			const rows = editorRows ? Array.from(editorRows) : Array<string>(count).fill("");
			rows[inputRow] = search;
			// Preserve the draft's existing footprint without counting its blank
			// replacement rows as editor chrome: they remain available to results.
			const padding = Math.max(0, Math.min(this.#editorRows, this.#tui.terminal.rows) - rows.length);
			return [...Array<string>(padding).fill(""), ...rows];
		}
		return this.#renderPicker(width, this.#tui.terminal.rows);
	}

	#renderPicker(width: number, availableRows: number): string[] {
		const inline = this.#editorRows !== undefined;
		const termRows = inline
			? Math.max(1, availableRows)
			: Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = inline
			? Math.min(Math.max(MIN_VISIBLE, Math.floor(this.#tui.terminal.rows * HEIGHT_FRACTION) - 7), termRows - 7)
			: Math.floor(termRows * HEIGHT_FRACTION) - CHROME_ROWS - BROWSER_FRAME_ROWS;
		this.#browser.setMaxVisible(Math.max(inline ? 1 : MIN_VISIBLE, listBudget));

		const inner = Math.max(1, width - 4);
		const status = this.#configError
			? this.#configError
			: this.#taskMode
				? TASK_STATUS_HINT
				: this.#roleMode
					? QUICK_ROLE_STATUS_HINT
					: STATUS_HINT;

		const borderColor: ThemeColor | undefined = this.#taskMode ? "error" : undefined;
		let footer = this.#taskMode ? TASK_FOOTER_HINT : this.#roleMode ? QUICK_ROLE_FOOTER_HINT : FOOTER_HINT;
		if (this.#taskMatchKeys.size > 0 && !this.#roleMode) {
			footer += ` · ${this.#taskModeKeyLabel} ${this.#taskMode ? "session model" : "task model"}`;
		}

		const out: string[] = [];
		if (!inline) {
			out.push(topBorder(width, this.#taskMode ? "Switch Task Model" : "Switch Model", borderColor));
			out.push(
				row(theme.fg(this.#configError || this.#taskMode ? "error" : "muted", ` ${status}`), width, borderColor),
			);
			for (const line of this.#browser.render(inner)) out.push(row(line, width, borderColor));
			out.push(row(theme.fg("dim", footer), width, borderColor));
			out.push(bottomBorder(width, borderColor));
			return out;
		}
		const title = this.#taskMode ? "Switch Task Model" : "Switch Model";
		const scope =
			this.#roleMode || this.#taskMode || this.#configError ? status : "Session-only — role models stay unchanged";
		const [searchRow = "", , ...browserRows] = this.#browser.render(inner);
		if (termRows >= 5) out.push(topBorder(width, `${title} · ${scope}`, borderColor));
		for (const line of browserRows.slice(0, Math.max(0, termRows - 1 - out.length))) {
			out.push(row(line, width, borderColor));
		}
		out.push(
			topBorder(width, footer, borderColor)
				.replace(theme.boxRound.topLeft, theme.boxRound.bottomLeft)
				.replace(theme.boxRound.topRight, theme.boxRound.bottomRight),
		);
		const placeholder = this.#browser.query ? "" : theme.fg("dim", "Search model…");
		const prefix = `${theme.boxRound.bottomLeft}${theme.boxRound.horizontal}`;
		out.push(truncateToWidth(`${theme.fg(borderColor ?? "border", prefix)}${searchRow.trim()}${placeholder}`, width));
		return out;
	}
}
