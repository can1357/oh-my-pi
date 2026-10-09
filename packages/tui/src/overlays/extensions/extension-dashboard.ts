/**
 * ExtensionDashboard - Fullscreen alternate-screen control center for extensions.
 *
 * Chrome mirrors the `/settings` overlay: a titled rounded box, a shared
 * {@link TabBar} for provider and aggregate views, and a two-column body (inventory list |
 * inspector). Both panes are mouse-aware — wheel scrolls, hover highlights, and
 * clicks select/activate — routed from a single SGR-mouse handler.
 *
 * Navigation:
 * - Tab/Shift+Tab or ←/→: switch view tab
 * - Up/Down or wheel: move list selection
 * - Enter or click: open MCP actions, otherwise toggle the selected item
 * - Space: toggle the selected item or provider master switch
 * - Esc: clear search (if active) then close
 *
 * Natively (Tern) it is a `picker` sheet: provider scopes, the inventory as
 * rows grouped by kind, the inspector as the side preview, and Toggle /
 * Expand / Close actions; without `picker` it describes a page with the same
 * parts. Pointer events run the key paths above.
 */
import type { TspPickerAction, TspPickerColumn, TspPickerScope } from "@oh-my-pi/pi-wire";
import type { Component } from "../../tui";
import { col, keyed, node, span, text } from "../../native/describe";
import { Memo } from "../../native/memo";
import type { DescribeContext, NativeNode, NativeScroll, NativeUiEvent } from "../../native/node";
import { actionBar, actionButton } from "../../native/overlay";
import { CLOSE_ACTION, type PickerEvent, picker, pickerAction, pickerEvent } from "../../native/picker";
import { type KeyId, matchesKey } from "../../keys";
import { parseSgrMouse } from "../../mouse";
import { SplitPane, type SplitPaneHit } from "../../components/layout/split-pane";
import { Stack } from "../../components/layout/stack";
import { ScrollView } from "../../components/scroll-view";
import { TabBar, type Tab } from "../../components/tab-bar";
import { logger } from "@oh-my-pi/pi-utils";
import { getTabBarTheme } from "../../chrome/shared";
import { theme } from "../../theme";
import {
	matchesAppInterrupt,
	matchesAppToolsExpand,
	matchesSelectPageDown,
	matchesSelectPageUp,
} from "../../keybinding-matchers";
import { expandKeyHint } from "../../render/render-utils";
import { formatKeyHint, formatKeyHints, formatTooltipKey } from "../../app-keybindings";
import { boundKeys, editorKeys, interruptKey } from "../../chrome/keybinding-hints";
import { bottomBorder, divider, PanelRows, row, topBorder } from "../../chrome/overlay-box";
import { ExtensionList, type ExtensionListSwitch } from "./extension-list";
import { InspectorPanel, type ToolRuntimeSource } from "./inspector-panel";
import type { ExtensionInspectorSource } from "./inspector-model";
import { snapshotToolRuntimeSource } from "./live-tool-session";
import type { MCPRuntimeSource } from "./mcp-runtime";
import { MCPActionPanel, type MCPActionPanelRuntime, type MCPActionPanelState } from "./mcp-action-panel";
import {
	applyDisabledExtensionsToState,
	applyFilter,
	createInitialState,
	filterByProvider,
	MCP_SERVERS_TAB_ID,
	refreshState,
} from "./state-manager";
import {
	type DashboardState,
	type Extension,
	type ExtensionProvider,
	isShadowedExtension,
	type ProviderTab,
} from "./types";

/** Runtime operations remain owned by the embedding application. */
export interface ExtensionDashboardRuntime {
	getDisabledExtensions(): string[];
	setDisabledExtensions(ids: string[]): void;
	getProviders(): readonly ExtensionProvider[];
	loadExtensions(disabledIds: string[]): Promise<Extension[]>;
	toggleProvider(providerId: string): boolean;
	toggleUserSource(providerId: string): boolean;
	persistMcpToggle(name: string, enabled: boolean, sourcePath?: string): Promise<void>;
	applyMcpToggle(name: string, enabled: boolean): Promise<void>;
	subscribeMcpChanges(onChange: () => void): Array<() => void>;
	mcpSource?: MCPRuntimeSource;
	inspectorSource?: ExtensionInspectorSource;
	mcpActions?: MCPActionPanelRuntime;
}

export interface ExtensionDashboardOptions {
	runtime: ExtensionDashboardRuntime;
	terminalHeight?: number;
	toolSource?: ToolRuntimeSource;
}

function extFooter(): string {
	const upDown = editorKeys("tui.select.up", "tui.select.down");
	const pages = editorKeys("tui.select.pageUp", "tui.select.pageDown");
	const close = interruptKey();
	return ` ${upDown}: navigate · ${formatKeyHint("enter")}: MCP actions · ${formatKeyHint("space")}: toggle · ${formatKeyHints(["left", "right"])}: view · ${pages}: inspector · ${expandKeyHint()}: expand · ${close}: close`;
}

/**
 * Map dashboard provider tabs to {@link TabBar} tabs. Empty *enabled* providers
 * are muted — skipped by keyboard nav and unclickable; disabled providers stay
 * selectable (with a leading disabled glyph) so their master switch can be
 * re-enabled from the list. The "all" tab is never muted or marked.
 */
export function buildTabBarTabs(tabs: ProviderTab[]): Tab[] {
	return tabs.map(tab => {
		const isAll = tab.id === "all";
		const isEmptyEnabled = tab.count === 0 && tab.enabled && !isAll;
		const isDisabled = !tab.enabled && !isAll;
		let label = tab.label;
		if (tab.count > 0) label += ` (${tab.count})`;
		if (isDisabled) label = `${theme.status.disabled} ${label}`;
		return { id: tab.id, label, short: tab.label, muted: isEmptyEnabled };
	});
}

/** The sheet/page title, shared by the ANSI frame and the native views. */
const DASHBOARD_TITLE = "Extension Control Center";

/** The kind column shown when rows are not grouped under kind headers (a provider scope or a search). */
const KIND_COLUMNS: readonly TspPickerColumn[] = [{ id: "kind", format: "dim", priority: 1 }];

/** Up to two initials of a provider label, for its scope mark. */
function providerInitials(label: string): string {
	const words = label.split(/[\s()_-]+/).filter(word => word.length > 0);
	return words
		.slice(0, 2)
		.map(word => word[0]?.toUpperCase() ?? "")
		.join("");
}

/**
 * Picker scopes from the provider tabs: "all" first, then each provider with
 * its mark and count. Empty enabled providers are disabled (muted in the
 * {@link TabBar}); switched-off providers keep a muted dot and stay
 * selectable so their master switch can be turned back on.
 */
export function buildPickerScopes(tabs: ProviderTab[]): TspPickerScope[] {
	return tabs.map(tab => {
		if (tab.id === "all") return { id: tab.id, label: "All", icon: "extension", count: tab.count };
		if (tab.id === MCP_SERVERS_TAB_ID) return { id: tab.id, label: tab.label, icon: "server", count: tab.count };
		const emptyEnabled = tab.count === 0 && tab.enabled;
		return {
			id: tab.id,
			label: tab.label,
			mark: { text: providerInitials(tab.label), seed: tab.id },
			count: tab.count,
			group: "Providers",
			dot: !tab.enabled ? "muted" : emptyEnabled ? "warning" : "success",
			disabled: emptyEnabled ? "No extensions" : undefined,
		};
	});
}

export class ExtensionDashboard implements Component {
	#state!: DashboardState;
	/** Bumped by every state change that reaches the screen; keys {@link #native}. */
	#nativeVersion = 0;
	readonly #native = new Memo<NativeNode>();
	/** The last inspector page key, forwarded to the native preview (see {@link NativeNode.scroll}). */
	#inspectorScroll: NativeScroll | undefined;
	#mainList!: ExtensionList;
	#inspector!: InspectorPanel;
	#tabBar!: TabBar;
	#body!: TwoColumnBody;
	#mcpActionPanel?: MCPActionPanel;
	/** Set while an action panel's initial state loads; repeated activations are ignored. */
	#mcpActionPanelOpening = false;
	#disposed = false;
	#refreshToken = 0;
	// Persistent fullscreen frame: top, tabs, divider, body, divider, footer,
	// bottom. The fullscreen overlay paints from screen row 0, so mouse rows
	// map 1:1 into the stack.
	readonly #frameTop = new PanelRows();
	readonly #frameTabs = new PanelRows();
	readonly #frameUpperDivider = new PanelRows();
	readonly #frameBody = new PanelRows();
	readonly #frameLowerDivider = new PanelRows();
	readonly #frameFooter = new PanelRows();
	readonly #frameBottom = new PanelRows();
	readonly #frame = new Stack({
		children: [
			{ content: this.#frameTop, height: 1 },
			{ content: this.#frameTabs },
			{ content: this.#frameUpperDivider, height: 1 },
			{ content: this.#frameBody },
			{ content: this.#frameLowerDivider, height: 1 },
			{ content: this.#frameFooter, height: 1 },
			{ content: this.#frameBottom, height: 1 },
		],
	});

	onClose?: () => void;
	onRequestRender?: () => void;
	#unsubscribers: Array<() => void> = [];

	readonly #runtime: ExtensionDashboardRuntime;
	readonly #terminalHeight: number;
	readonly #toolSource: ToolRuntimeSource | undefined;

	private constructor(
		runtime: ExtensionDashboardRuntime,
		terminalHeight: number,
		toolSource: ToolRuntimeSource | undefined,
	) {
		this.#runtime = runtime;
		this.#terminalHeight = terminalHeight;
		this.#toolSource = toolSource;
	}

	static async create(options: ExtensionDashboardOptions): Promise<ExtensionDashboard> {
		const dashboard = new ExtensionDashboard(
			options.runtime,
			options.terminalHeight ?? process.stdout.rows ?? 24,
			options.toolSource,
		);
		await dashboard.#init();
		return dashboard;
	}

	async #init(): Promise<void> {
		const disabledIds = this.#runtime.getDisabledExtensions();
		this.#state = createInitialState(await this.#runtime.loadExtensions(disabledIds), this.#runtime.getProviders());

		const initialMaxVisible = Math.max(3, this.#terminalHeight - 9);
		this.#inspector = new InspectorPanel(this.#runtime.inspectorSource);
		this.#inspector.setMcpSource(this.#runtime.mcpSource);
		this.#inspector.setToolSource(this.#toolSource);
		this.#mainList = new ExtensionList(
			this.#state.searchFiltered,
			{
				getProviders: () => this.#runtime.getProviders(),
				onSelectionChange: ext => {
					this.#state.selected = ext;
					this.#inspector.setExtension(ext);
					this.#body.resetInspectorScroll();
				},
				onToggle: (extensionId, enabled) => this.#handleExtensionToggle(extensionId, enabled),
				onActivate: extension => void this.#openMcpActions(extension),
				onMasterToggle: providerId => this.#handleProviderToggle(providerId),
				onUserSourceToggle: providerId => this.#handleUserSourceToggle(providerId),
				masterSwitchProvider: this.#getActiveProviderId(),
				mcpSource: this.#runtime.mcpSource,
				toolSource: this.#toolSource,
			},
			initialMaxVisible,
		);
		this.#mainList.setFocused(true);
		this.#mainList.setMcpSource(this.#runtime.mcpSource);
		this.#mainList.setToolSource(this.#toolSource);

		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#subscribeMcpRuntime();

		this.#body = new TwoColumnBody(this.#mainList, this.#inspector, this.#terminalHeight);

		this.#tabBar = new TabBar("", buildTabBarTabs(this.#state.tabs), getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = tab => this.#selectTabById(tab.id);
		const activeId = this.#state.tabs[this.#state.activeTabIndex]?.id;
		if (activeId) this.#tabBar.setActiveById(activeId);
	}

	#getActiveProviderId(): string | null {
		const tab = this.#state.tabs[this.#state.activeTabIndex];
		return tab && tab.id !== "all" && tab.id !== MCP_SERVERS_TAB_ID ? tab.id : null;
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.#terminalHeight || 24;
	}

	/**
	 * Fullscreen frame: titled top border, the tab row(s), a divider, the
	 * two-column body sized to fill the viewport, a divider, the footer hint, and
	 * the bottom border.
	 */
	render(width: number): readonly string[] {
		if (this.#mcpActionPanel) {
			this.#mcpActionPanel.terminalHeight = this.#terminalRows();
			return this.#mcpActionPanel.render(width);
		}
		const height = Math.max(14, this.#terminalRows());
		const innerWidth = Math.max(1, width - 4);

		const tabLines = this.#tabBar.render(innerWidth);
		// Fixed chrome: top border + tab rows + divider + divider + footer + bottom border.
		const fixedRows = 1 + tabLines.length + 1 + 1 + 1 + 1;
		const contentRows = Math.max(5, height - fixedRows);

		this.#mainList.setMaxVisible(Math.max(3, contentRows - 2));
		this.#body.setMaxHeight(contentRows);
		const toolFrame = snapshotToolRuntimeSource(this.#toolSource);
		this.#mainList.setToolSource(toolFrame);
		this.#inspector.setToolSource(toolFrame);

		this.#frameTop.setLines([topBorder(width, DASHBOARD_TITLE)]);
		this.#frameTabs.setLines(tabLines.map(line => row(line, width)));
		this.#frameUpperDivider.setLines([divider(width)]);
		this.#frameBody.setLines(this.#body.render(innerWidth).map(line => row(line, width)));
		this.#frameLowerDivider.setLines([divider(width)]);
		this.#frameFooter.setLines([row(theme.fg("dim", extFooter()), width)]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		return this.#frame.render(width);
	}

	invalidate(): void {
		this.#nativeVersion++;
		if (this.#mcpActionPanel) {
			this.#mcpActionPanel.invalidate();
			return;
		}
		this.#frame.invalidate();
		this.#tabBar.invalidate();
		this.#mainList.invalidate();
		this.#inspector.invalidate();
	}

	/**
	 * Route an SGR mouse report against the last render's geometry. Wheel scrolls
	 * the pane under the pointer, motion drives hover highlights (tabs + rows),
	 * and a left click switches tabs or selects/activates a list row.
	 */
	#handleMouse(data: string): void {
		const event = parseSgrMouse(data);
		if (!event) return;

		// row() insets content by two columns (border + space).
		const innerCol = event.col - 2;
		const tabRect = this.#frame.childRect(1);
		const tabLine = tabRect ? event.row - tabRect.row : -1;
		const overTabs = tabRect !== undefined && tabLine >= 0 && tabLine < tabRect.height;
		const bodyHit = this.#frame.locate(event.row, event.col);
		let paneLine = -1;
		let overList = false;
		let overInspector = false;
		if (bodyHit && bodyHit.index === 3) {
			const pane = this.#body.locate(bodyHit.line, bodyHit.col - 2);
			if (pane?.pane === "left") {
				overList = true;
				paneLine = pane.line;
			} else if (pane?.pane === "right") {
				overInspector = true;
				paneLine = pane.line;
			}
		}

		if (event.wheel !== null) {
			if (overList) {
				this.#mainList.handleWheel(event.wheel);
				this.#requestRender();
			} else if (overInspector) {
				this.#body.scrollInspector(event.wheel);
				this.#requestRender();
			}
			return;
		}

		if (event.motion) {
			const hoveredTab = overTabs ? this.#tabBar.tabAt(tabLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hoveredTab && !hoveredTab.muted ? hoveredTab.id : null);
			this.#mainList.setHoverIndex(overList ? this.#mainList.hitTest(paneLine) : null);
			this.#requestRender();
			return;
		}

		if (!event.leftClick) return;

		if (overTabs) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) this.#tabBar.selectTab(tab.id);
			return;
		}
		if (overList) {
			this.#mainList.handleClick(paneLine);
			this.#requestRender();
		}
	}

	/** Switch to the tab with `id`, re-filtering the list around it. */
	#selectTabById(id: string): void {
		const index = this.#state.tabs.findIndex(t => t.id === id);
		if (index < 0) return;
		this.#state.activeTabIndex = index;

		const tab = this.#state.tabs[index];
		this.#state.tabFiltered = filterByProvider(this.#state.extensions, tab.id);
		this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, this.#state.searchQuery);
		this.#state.listIndex = 0;
		this.#state.scrollOffset = 0;
		this.#state.selected = this.#state.searchFiltered[0] ?? null;

		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(this.#getActiveProviderId());
		this.#mainList.resetSelection();
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}
		this.#body.resetInspectorScroll();
		this.#requestRender();
	}

	#handleProviderToggle(providerId: string): void {
		const enabling = this.#state.tabs.find(tab => tab.id === providerId)?.enabled === false;
		this.#runtime.toggleProvider(providerId);
		if (!enabling) {
			void this.#disconnectProviderMcpServers(providerId);
			return;
		}
		void this.#refreshFromState();
	}

	/** Flip the `~/` opt-in for a foreign provider; user-level MCP servers go down on opt-out. */
	#handleUserSourceToggle(providerId: string): void {
		const enabled = this.#runtime.toggleUserSource(providerId);
		if (!enabled) {
			void this.#disconnectProviderMcpServers(providerId, "user");
			return;
		}
		void this.#refreshFromState();
	}

	/**
	 * Provider disable is discovery-only: do not rewrite mcp.json. Disconnect
	 * the MCP servers owned by this provider so their tools leave the session.
	 * Every server, not only the connected ones: a lost remote server reads
	 * "disconnected" between its scheduled reconnects, and only
	 * `disconnectServer` ends that schedule. Re-enable does not auto-connect —
	 * startup/reload still owns that.
	 */
	async #disconnectProviderMcpServers(providerId: string, level?: "user" | "project"): Promise<void> {
		const names = [
			...new Set(
				this.#state.extensions
					.filter(
						ext =>
							ext.kind === "mcp" &&
							ext.source.provider === providerId &&
							(level === undefined || ext.source.level === level) &&
							!isShadowedExtension(ext),
					)
					.map(ext => ext.name),
			),
		];
		for (const name of names) {
			try {
				await this.#runtime.applyMcpToggle(name, false);
			} catch (error) {
				logger.warn("Failed to disconnect MCP server after provider disable", {
					name,
					providerId,
					error: String(error),
				});
			}
		}
		await this.#refreshFromState();
	}

	#handleExtensionToggle(extensionId: string, enabled: boolean): void {
		// MCP toggles route through the canonical denylist in
		// `~/.omp/agent/mcp.json` so `/mcp list`, the MCP runtime, and this
		// dashboard agree on every server's enabled state (issue #3827).
		if (extensionId.startsWith("mcp:")) {
			void this.#toggleMcpExtension(extensionId, enabled);
			return;
		}

		const disabled = this.#runtime.getDisabledExtensions().slice();
		if (enabled) {
			const index = disabled.indexOf(extensionId);
			if (index !== -1) {
				disabled.splice(index, 1);
				this.#runtime.setDisabledExtensions(disabled);
			}
		} else {
			if (!disabled.includes(extensionId)) {
				disabled.push(extensionId);
				this.#runtime.setDisabledExtensions(disabled);
			}
		}

		this.#applyDisabledExtensions(disabled);
		void this.#refreshFromState();
	}

	async #toggleMcpExtension(extensionId: string, enabled: boolean): Promise<void> {
		const name = extensionId.slice("mcp:".length);
		try {
			await this.#runtime.persistMcpToggle(name, enabled, this.#writableMcpSourcePath(extensionId));
		} catch (error) {
			logger.warn("Failed to persist MCP toggle", { name, enabled, error: String(error) });
			await this.#refreshFromState();
			return;
		}

		try {
			await this.#runtime.applyMcpToggle(name, enabled);
		} catch (error) {
			logger.warn("Failed to apply MCP toggle to live manager", { name, enabled, error: String(error) });
		}

		// Reconcile `settings.disabledExtensions` with the canonical mcp.json
		// state so a legacy `mcp:<name>` flag from before this routing change
		// doesn't keep the server marked disabled after the user re-enables it
		// via the UI.
		const stored = this.#runtime.getDisabledExtensions().slice();
		const had = stored.indexOf(extensionId);
		if (enabled && had !== -1) {
			stored.splice(had, 1);
			this.#runtime.setDisabledExtensions(stored);
			this.#applyDisabledExtensions(stored);
		}

		await this.#refreshFromState();
	}

	#writableMcpSourcePath(extensionId: string): string | undefined {
		const extension = this.#state.extensions.find(ext => ext.id === extensionId && !isShadowedExtension(ext));
		if (!extension) return undefined;
		if (extension.source.provider !== "native" && extension.source.provider !== "mcp-json") return undefined;
		return extension.path;
	}

	async #refreshFromState(): Promise<void> {
		const refreshToken = ++this.#refreshToken;
		// Remember the current tab so it survives the re-sort.
		const currentTabId = this.#state.tabs[this.#state.activeTabIndex]?.id;

		const disabledIds = this.#runtime.getDisabledExtensions();
		const extensions = await this.#runtime.loadExtensions(disabledIds);
		const nextState = refreshState(this.#state, extensions, this.#runtime.getProviders());
		if (refreshToken !== this.#refreshToken) return;
		this.#state = nextState;

		// Re-anchor on the same tab id in the (re-sorted) list.
		if (currentTabId) {
			const newIndex = this.#state.tabs.findIndex(t => t.id === currentTabId);
			if (newIndex >= 0) {
				this.#state.activeTabIndex = newIndex;
			}
		}

		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(this.#getActiveProviderId());
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#tabBar.setTabs(buildTabBarTabs(this.#state.tabs), currentTabId);
		this.#requestRender();
	}

	#applyDisabledExtensions(disabledIds: string[]): void {
		this.#state = applyDisabledExtensionsToState(this.#state, disabledIds, this.#runtime.getProviders());
		this.#mainList.setExtensions(this.#state.searchFiltered);
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}
		this.#tabBar.setTabs(buildTabBarTabs(this.#state.tabs), this.#state.tabs[this.#state.activeTabIndex]?.id);
		this.#requestRender();
	}

	async #openMcpActions(extension: Extension): Promise<void> {
		const runtime = this.#runtime.mcpActions;
		if (!runtime || extension.kind !== "mcp") return;
		if (this.#disposed || this.#mcpActionPanel || this.#mcpActionPanelOpening) return;
		this.#mcpActionPanelOpening = true;
		let state: MCPActionPanelState;
		try {
			state = await runtime.loadState(extension);
		} catch (error) {
			logger.warn("Failed to open MCP action panel", { name: extension.name, error: String(error) });
			return;
		} finally {
			this.#mcpActionPanelOpening = false;
		}
		// The dashboard can close while the state loads; a late panel would
		// capture input for a dashboard that is no longer on screen.
		if (this.#disposed || this.#mcpActionPanel) return;
		const panel = new MCPActionPanel(extension, state, runtime, this.#terminalHeight);
		panel.onRequestRender = () => this.onRequestRender?.();
		panel.onChanged = () => void this.#refreshFromState();
		panel.onClose = () => {
			panel.dispose();
			if (this.#mcpActionPanel === panel) this.#mcpActionPanel = undefined;
			this.onRequestRender?.();
		};
		this.#mcpActionPanel = panel;
		this.onRequestRender?.();
	}

	handleInput(data: string): void {
		if (this.#mcpActionPanel) {
			this.#mcpActionPanel.handleInput(data);
			return;
		}
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		// Ctrl+C - close immediately
		if (matchesKey(data, "ctrl+c")) {
			this.#close();
			return;
		}

		// Escape - clear search first, then close
		if (matchesAppInterrupt(data)) {
			if (this.#state.searchQuery.length > 0) {
				this.#clearSearch();
				return;
			}
			this.#close();
			return;
		}

		if (matchesAppToolsExpand(data)) {
			this.#inspector.toggleExpanded();
			this.#requestRender();
			return;
		}

		const page = matchesSelectPageUp(data) ? -1 : matchesSelectPageDown(data) ? 1 : 0;
		if (page !== 0) {
			this.#inspectorScroll = { by: page < 0 ? "page-up" : "page-down", n: (this.#inspectorScroll?.n ?? 0) + 1 };
		}
		if (this.#body.pageInspector(page)) {
			this.#requestRender();
			return;
		}

		// Tab/Shift+Tab or ←/→: switch provider tabs (fires onTabChange).
		if (this.#tabBar.handleInput(data)) {
			return;
		}

		// All other input goes to the list.
		this.#mainList.handleInput(data);

		// Sync search query back to state.
		const query = this.#mainList.getSearchQuery();
		if (query !== this.#state.searchQuery) {
			this.#state.searchQuery = query;
			this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, query);
		}
		this.#requestRender();
	}

	#close(): void {
		this.dispose();
		this.onClose?.();
	}

	#clearSearch(): void {
		this.#state.searchQuery = "";
		this.#state.searchFiltered = this.#state.tabFiltered;
		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.clearSearch();
		this.#requestRender();
	}

	/** Every repaint request: the native description is stale too. */
	#requestRender(): void {
		this.#nativeVersion++;
		this.onRequestRender?.();
	}

	/** The dashboard is a `picker` sheet (scopes = providers, preview = inspector) wherever Tern draws pickers. */
	nativeSheet(cx: DescribeContext): boolean {
		return !this.#mcpActionPanel && cx.supports("picker");
	}

	/**
	 * The picker sheet, or without `picker` a page: head, provider tabs,
	 * search, the inventory list beside the inspector, and an action bar.
	 * Rebuilt when state moves or the live tool set changes (MCP health
	 * changes arrive as render requests, which bump the version).
	 */
	describe(cx: DescribeContext): NativeNode {
		if (this.#mcpActionPanel) {
			this.#mcpActionPanel.terminalHeight = this.#terminalRows();
			return col([this.#mcpActionPanel]);
		}
		const sheet = this.nativeSheet(cx);
		const toolFrame = snapshotToolRuntimeSource(this.#toolSource);
		let tools = "";
		for (const tool of toolFrame?.listLiveTools?.() ?? []) tools += `${tool.name}${tool.hidden ? "!" : ""}\0`;
		return this.#native.get([this.#nativeVersion, sheet, tools, this.#inspectorScroll], () => {
			this.#mainList.setToolSource(toolFrame);
			this.#inspector.setToolSource(toolFrame);
			return sheet ? this.#describePicker() : this.#describePage();
		});
	}

	#describePicker(): NativeNode {
		const view = this.#mainList.pickerView();
		const activeTab = this.#state.tabs[this.#state.activeTabIndex];
		return picker(
			{
				title: DASHBOARD_TITLE,
				icon: "extension",
				noun: "extensions",
				size: "lg",
				layout: "rows",
				preview: "side",
				...this.#mainList.nativeQuery(),
				placeholder: "Search extensions…",
				scopes: buildPickerScopes(this.#state.tabs),
				scope: activeTab?.id ?? "all",
				columns: view.grouped ? undefined : KIND_COLUMNS,
				items: view.items,
				order: view.order,
				hits: view.hits,
				selected: view.selected,
				total: this.#state.tabFiltered.length,
				empty: "No extensions found for this provider.",
				actions: this.#pickerActions(this.#mainList.selectedSwitch()),
				focus: "list",
			},
			this.#inspectorPreview(),
		);
	}

	/** The inspector's preview nodes, the first carrying the page-key scroll so Tern scrolls the pane holding it. */
	#inspectorPreview(): NativeNode[] {
		const preview = this.#inspector.describePreview();
		const scroll = this.#inspectorScroll;
		const [first, ...rest] = preview;
		return scroll && first ? [{ ...first, scroll }, ...rest] : preview;
	}

	/** Action bar: Toggle (Space/Enter), Expand (the tools-expand key), Close (Esc). */
	#pickerActions(selected: ExtensionListSwitch | undefined): TspPickerAction[] {
		const expanded = this.#inspector.isExpanded();
		return [
			pickerAction("toggle", "Toggle", "space", {
				primary: true,
				on: selected?.on,
				disabled: selected ? selected.blocked : "Select an extension",
			}),
			pickerAction("expand", expanded ? "Collapse" : "Expand", this.#expandKey(), { on: expanded }),
			CLOSE_ACTION,
		];
	}

	#expandKey(): KeyId {
		return boundKeys("app.tools.expand", ["ctrl+o"])[0] ?? "ctrl+o";
	}

	#describePage(): NativeNode {
		const selected = this.#mainList.selectedSwitch();
		const query = this.#state.searchQuery;
		const shown = this.#state.searchFiltered.length;
		const total = this.#state.tabFiltered.length;
		const head = node(
			"row",
			{ justify: "between", align: "center", role: "omp.app.head" },
			[
				node("row", { gap: "sm", align: "center", role: "omp.app.where" }, [
					text(DASHBOARD_TITLE, { role: "omp.app.title" }),
					text([span(query ? `${shown} of ${total}` : `${total} extensions`, "muted")], { truncate: "end" }),
				]),
				node("icon", {
					name: "x",
					role: "omp.app.ibtn",
					title: `Close  ${formatTooltipKey(boundKeys("app.interrupt", ["escape"])[0] ?? "escape")}`,
					aria: "Close",
					actions: { click: "close" },
				}),
			],
			"head",
		);
		const search = text([span("Search: ", "muted"), query ? span(query, "accent") : span("type to filter", "dim")], {
			truncate: "end",
		});
		const body = node(
			"row",
			{ gap: "md", grow: 1 },
			[
				this.#mainList.describeList("list"),
				{
					...keyed(col(this.#inspector.describePreview(), { gap: "sm", grow: 1, basis: 0 }), "inspector"),
					scroll: this.#inspectorScroll,
				},
			],
			"body",
		);
		const expanded = this.#inspector.isExpanded();
		const buttons: (NativeNode | null)[] = [
			actionButton(selected?.on === false ? "Enable" : selected ? "Disable" : "Toggle", "toggle", {
				keys: "space",
				tone: "accent",
				title: selected?.blocked ?? (selected ? undefined : "Select an extension"),
			}),
			actionButton(expanded ? "Collapse" : "Expand", "expand", { keys: this.#expandKey() }),
		];
		if (query) buttons.push(actionButton("Clear search", "clear", { keys: "escape" }));
		buttons.push(null, actionButton("Close", "close", { keys: "escape" }));
		return col([head, this.#tabBar, keyed(search, "search"), body, actionBar(buttons)], { gap: "md", grow: 1 });
	}

	/**
	 * Pointer input, each on the path of the key it stands for: a row click
	 * selects (click on the selected row or double click toggles, like
	 * Space/Enter), a scope switches provider (←/→), `toggle`/`expand` run
	 * Space and the expand key, `clear` empties the search (first Esc) and
	 * `close` closes. Provider tabs in the page route to the {@link TabBar}.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#mcpActionPanel) {
			if (event.type === "action" && event.act === "close") this.#mcpActionPanel.handleInput("\x1b");
			return;
		}
		const pick = pickerEvent(event);
		if (pick) {
			this.#handlePick(pick);
			return;
		}
		if (event.type === "action") {
			this.#handlePick({ kind: "action", act: event.act, value: event.value });
			return;
		}
		if (
			(event.type === "select" || event.type === "activate") &&
			event.key.slice(event.key.lastIndexOf("/") + 1) === "list"
		) {
			this.#handlePick({ kind: event.type, item: event.item });
		}
	}

	#handlePick(pick: PickerEvent): void {
		if (pick.kind !== "action") {
			if (this.#mainList.pickNative(pick.item, pick.kind === "activate")) this.#requestRender();
			return;
		}
		switch (pick.act) {
			case "close":
				this.#close();
				return;
			case "clear":
				this.#clearSearch();
				return;
			case "scope":
				if (pick.value) this.#tabBar.selectTab(pick.value);
				return;
			case "toggle":
				this.#mainList.activateSelected("toggle");
				this.#requestRender();
				return;
			case "expand":
				this.#inspector.toggleExpanded();
				this.#requestRender();
				return;
		}
	}

	/**
	 * Live MCP health is joined at render time. Connection-status events and
	 * list-changed notifications only need to request a repaint — they must not
	 * rewrite Extension.raw.
	 */
	#subscribeMcpRuntime(): void {
		this.#unsubscribers.push(
			...this.#runtime.subscribeMcpChanges(() => {
				this.#requestRender();
				const panel = this.#mcpActionPanel;
				if (!panel) return;
				void panel.reloadState().catch(error => {
					logger.warn("Failed to reload open MCP action panel", {
						name: panel.extension.name,
						error: String(error),
					});
				});
			}),
		);
	}

	dispose(): void {
		this.#disposed = true;
		this.#mcpActionPanel?.dispose();
		this.#mcpActionPanel = undefined;
		for (const unsub of this.#unsubscribers) unsub();
		this.#unsubscribers = [];
	}
}

/**
 * Two-column body: inventory list on the left, inspector on the right, split by
 * a dim vertical rule. The inspector is a {@link ScrollView} viewport so long
 * detail panes scroll (wheel) with an auto scrollbar; the left list manages its
 * own windowing. Pane-local hit-testing goes through the owned split.
 */
class TwoColumnBody implements Component {
	#maxHeight: number;
	#rightScroll = 0;
	#rightTotal = 0;

	readonly #leftPane: ExtensionList;
	readonly #rightPane: InspectorPanel;
	readonly #split: SplitPane;

	#renderInspectorPane = (width: number, height: number | undefined): readonly string[] => {
		const numLines = Math.max(0, Math.floor(height ?? this.#maxHeight));
		const inspectorWidth = Math.max(0, width - 2);
		this.#rightPane.setHeight(numLines);
		const rightLines = this.#rightPane.render(inspectorWidth);
		this.#rightTotal = rightLines.length;
		const maxScroll = Math.max(0, this.#rightTotal - numLines);
		if (this.#rightScroll > maxScroll) this.#rightScroll = maxScroll;
		const rightView = new ScrollView(rightLines, {
			height: numLines,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		rightView.setScrollOffset(this.#rightScroll);
		return rightView.render(width);
	};

	constructor(leftPane: ExtensionList, rightPane: InspectorPanel, maxHeight: number) {
		this.#leftPane = leftPane;
		this.#rightPane = rightPane;
		this.#maxHeight = maxHeight;
		this.#split = new SplitPane({
			left: this.#leftPane,
			right: this.#renderInspectorPane,
			leftSize: { ratio: 0.5 },
			divider: () => theme.fg("dim", ` ${theme.boxRound.vertical} `),
			height: maxHeight,
		});
	}

	setMaxHeight(maxHeight: number): void {
		this.#maxHeight = maxHeight;
		this.#split.setHeight(maxHeight);
	}

	/** Pane-local hit test from the last render. */
	locate(line: number, col: number): SplitPaneHit | undefined {
		return this.#split.locate(line, col);
	}

	resetInspectorScroll(): void {
		this.#rightScroll = 0;
	}

	/** Wheel notch over the inspector pane: scroll its content, clamped. */
	scrollInspector(delta: -1 | 1): void {
		const max = Math.max(0, this.#rightTotal - this.#maxHeight);
		this.#rightScroll = Math.max(0, Math.min(this.#rightScroll + delta, max));
	}

	pageInspector(delta: -1 | 0 | 1): boolean {
		if (delta === 0 || this.#rightTotal <= this.#maxHeight) return false;
		const before = this.#rightScroll;
		const step = Math.max(1, this.#maxHeight - 1);
		const max = Math.max(0, this.#rightTotal - this.#maxHeight);
		this.#rightScroll = Math.max(0, Math.min(this.#rightScroll + delta * step, max));
		return this.#rightScroll !== before;
	}

	render(width: number): readonly string[] {
		this.#split.setHeight(this.#maxHeight);
		return this.#split.render(width);
	}

	invalidate(): void {
		this.#split.invalidate();
		this.#rightPane.invalidate?.();
	}
}
