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
 */
import type { Component } from "../../tui";
import { matchesKey } from "../../keys";
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
import { bottomBorder, divider, PanelRows, row, topBorder } from "../../chrome/overlay-box";
import { ExtensionList } from "./extension-list";
import { InspectorPanel, type ToolRuntimeSource } from "./inspector-panel";
import type { ExtensionInspectorSource } from "./inspector-model";
import { snapshotToolRuntimeSource } from "./live-tool-session";
import type { MCPRuntimeSource } from "./mcp-runtime";
import { MCPActionPanel, type MCPActionPanelRuntime } from "./mcp-action-panel";
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
	return ` ↑/↓: navigate · Enter: MCP actions · Space: toggle · ←/→: view · PgUp/PgDn: inspector · ${expandKeyHint()}: expand · Esc: close`;
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

export class ExtensionDashboard implements Component {
	#state!: DashboardState;
	#mainList!: ExtensionList;
	#inspector!: InspectorPanel;
	#tabBar!: TabBar;
	#body!: TwoColumnBody;
	#mcpActionPanel?: MCPActionPanel;
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
		if (this.#mcpActionPanel) return this.#mcpActionPanel.render(width);
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

		this.#frameTop.setLines([topBorder(width, "Extension Control Center")]);
		this.#frameTabs.setLines(tabLines.map(line => row(line, width)));
		this.#frameUpperDivider.setLines([divider(width)]);
		this.#frameBody.setLines(this.#body.render(innerWidth).map(line => row(line, width)));
		this.#frameLowerDivider.setLines([divider(width)]);
		this.#frameFooter.setLines([row(theme.fg("dim", extFooter()), width)]);
		this.#frameBottom.setLines([bottomBorder(width)]);
		return this.#frame.render(width);
	}

	invalidate(): void {
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
				this.onRequestRender?.();
			} else if (overInspector) {
				this.#body.scrollInspector(event.wheel);
				this.onRequestRender?.();
			}
			return;
		}

		if (event.motion) {
			const hoveredTab = overTabs ? this.#tabBar.tabAt(tabLine, innerCol) : undefined;
			this.#tabBar.setHoverTab(hoveredTab && !hoveredTab.muted ? hoveredTab.id : null);
			this.#mainList.setHoverIndex(overList ? this.#mainList.hitTest(paneLine) : null);
			this.onRequestRender?.();
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
			this.onRequestRender?.();
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
		this.onRequestRender?.();
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
		this.onRequestRender?.();
	}

	#applyDisabledExtensions(disabledIds: string[]): void {
		this.#state = applyDisabledExtensionsToState(this.#state, disabledIds, this.#runtime.getProviders());
		this.#mainList.setExtensions(this.#state.searchFiltered);
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}
		this.#tabBar.setTabs(buildTabBarTabs(this.#state.tabs), this.#state.tabs[this.#state.activeTabIndex]?.id);
		this.onRequestRender?.();
	}

	async #openMcpActions(extension: Extension): Promise<void> {
		const runtime = this.#runtime.mcpActions;
		if (!runtime || extension.kind !== "mcp") return;
		try {
			const panel = new MCPActionPanel(extension, await runtime.loadState(extension), runtime, this.#terminalHeight);
			panel.onRequestRender = () => this.onRequestRender?.();
			panel.onChanged = () => void this.#refreshFromState();
			panel.onClose = () => {
				panel.dispose();
				if (this.#mcpActionPanel === panel) this.#mcpActionPanel = undefined;
				this.onRequestRender?.();
			};
			this.#mcpActionPanel = panel;
			this.onRequestRender?.();
		} catch (error) {
			logger.warn("Failed to open MCP action panel", { name: extension.name, error: String(error) });
		}
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
			this.dispose();
			this.onClose?.();
			return;
		}

		// Escape - clear search first, then close
		if (matchesAppInterrupt(data)) {
			if (this.#state.searchQuery.length > 0) {
				this.#state.searchQuery = "";
				this.#state.searchFiltered = this.#state.tabFiltered;
				this.#mainList.setExtensions(this.#state.searchFiltered);
				this.#mainList.clearSearch();
				this.onRequestRender?.();
				return;
			}
			this.dispose();
			this.onClose?.();
			return;
		}

		if (matchesAppToolsExpand(data)) {
			this.#inspector.toggleExpanded();
			this.onRequestRender?.();
			return;
		}

		if (this.#body.pageInspector(matchesSelectPageUp(data) ? -1 : matchesSelectPageDown(data) ? 1 : 0)) {
			this.onRequestRender?.();
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
		this.onRequestRender?.();
	}

	/** Keep an open action panel synchronized with live MCP lifecycle changes. */
	#subscribeMcpRuntime(): void {
		this.#unsubscribers.push(
			...this.#runtime.subscribeMcpChanges(() => {
				const panel = this.#mcpActionPanel;
				if (!panel) {
					this.onRequestRender?.();
					return;
				}
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
