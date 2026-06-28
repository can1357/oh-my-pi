/**
 * ExtensionDashboard - Fullscreen alternate-screen control center for extensions.
 *
 * Chrome mirrors the `/settings` overlay: a titled rounded box, a shared
 * {@link TabBar} for provider selection, and a two-column body (inventory list |
 * inspector). Both panes are mouse-aware — wheel scrolls, hover highlights, and
 * clicks select/activate — routed from a single SGR-mouse handler.
 *
 * Navigation:
 * - Tab/Shift+Tab or ←/→: switch provider tab
 * - Up/Down/j/k or wheel: move list selection
 * - Space/Enter or click: toggle selected item (or provider master switch)
 * - Wheel over the inspector: scroll the detail pane
 * - Esc: clear search (if active) then close
 */
import {
	type Component,
	matchesKey,
	padding,
	parseSgrMouse,
	ScrollView,
	type Tab,
	TabBar,
	truncateToWidth,
	visibleWidth,
} from "@pk-nerdsaver-ai/pi-tui";
import { Settings } from "../../../config/settings";
import { getTabBarTheme } from "../../../modes/shared";
import { theme } from "../../../modes/theme/theme";
import { matchesAppInterrupt } from "../../../modes/utils/keybinding-matchers";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";
import { ExtensionList } from "./extension-list";
import { InspectorPanel } from "./inspector-panel";
import {
	applyDisabledExtensionsToState,
	applyFilter,
	createInitialState,
	filterByProvider,
	refreshState,
	toggleProvider,
} from "./state-manager";
import type { DashboardState, ProviderTab } from "./types";

const EXT_FOOTER = " ↑/↓: navigate · Space: toggle · ←/→: provider · Esc: close";

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
	#refreshToken = 0;
	// Frame geometry from the last render, for SGR mouse hit-testing. The
	// fullscreen overlay paints from screen row 0, so mouse rows map 1:1.
	#tabRowStart = 0;
	#tabRowCount = 0;
	#bodyRowStart = 0;
	#bodyRowCount = 0;

	onClose?: () => void;
	onRequestRender?: () => void;

	private constructor(
		private readonly cwd: string,
		private readonly settings: Settings | null,
		private readonly terminalHeight: number,
	) {}

	static async create(
		cwd: string,
		settings: Settings | null = null,
		terminalHeight?: number,
	): Promise<ExtensionDashboard> {
		const dashboard = new ExtensionDashboard(cwd, settings, terminalHeight ?? process.stdout.rows ?? 24);
		await dashboard.#init();
		return dashboard;
	}

	async #init(): Promise<void> {
		const sm = this.settings ?? (await Settings.init());
		const disabledIds = sm ? ((sm.get("disabledExtensions") as string[]) ?? []) : [];
		this.#state = await createInitialState(this.cwd, disabledIds);

		const initialMaxVisible = Math.max(3, this.terminalHeight - 9);
		this.#mainList = new ExtensionList(
			this.#state.searchFiltered,
			{
				onSelectionChange: ext => {
					this.#state.selected = ext;
					this.#inspector.setExtension(ext);
					// A fresh selection resets the inspector to the top.
					this.#body.resetInspectorScroll();
				},
				onToggle: (extensionId, enabled) => this.#handleExtensionToggle(extensionId, enabled),
				onMasterToggle: providerId => this.#handleProviderToggle(providerId),
				masterSwitchProvider: this.#getActiveProviderId(),
			},
			initialMaxVisible,
		);
		this.#mainList.setFocused(true);

		this.#inspector = new InspectorPanel();
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#body = new TwoColumnBody(this.#mainList, this.#inspector, this.terminalHeight);

		this.#tabBar = new TabBar("", buildTabBarTabs(this.#state.tabs), getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = tab => this.#selectProviderById(tab.id);
		const activeId = this.#state.tabs[this.#state.activeTabIndex]?.id;
		if (activeId) this.#tabBar.setActiveById(activeId);
	}

	#getActiveProviderId(): string | null {
		const tab = this.#state.tabs[this.#state.activeTabIndex];
		return tab && tab.id !== "all" ? tab.id : null;
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.terminalHeight || 24;
	}

	/**
	 * Fullscreen frame: titled top border, the tab row(s), a divider, the
	 * two-column body sized to fill the viewport, a divider, the footer hint, and
	 * the bottom border. Records row geometry for mouse hit-testing.
	 */
	render(width: number): readonly string[] {
		const height = Math.max(14, this.#terminalRows());
		const innerWidth = Math.max(1, width - 4);

		const tabLines = this.#tabBar.render(innerWidth);
		// Fixed chrome: top border + tab rows + divider + divider + footer + bottom border.
		const fixedRows = 1 + tabLines.length + 1 + 1 + 1 + 1;
		const contentRows = Math.max(5, height - fixedRows);

		this.#mainList.setMaxVisible(Math.max(3, contentRows - 2));
		this.#body.setMaxHeight(contentRows);
		const bodyLines = this.#body.render(innerWidth);

		const out: string[] = [];
		out.push(topBorder(width, "Extension Control Center"));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) out.push(row(line, width));
		out.push(divider(width));
		this.#bodyRowStart = out.length;
		this.#bodyRowCount = contentRows;
		for (let i = 0; i < contentRows; i++) out.push(row(bodyLines[i] ?? "", width));
		out.push(divider(width));
		out.push(row(theme.fg("dim", EXT_FOOTER), width));
		out.push(bottomBorder(width));
		return out;
	}

	invalidate(): void {
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
		const tabLine = event.row - this.#tabRowStart;
		const overTabs = tabLine >= 0 && tabLine < this.#tabRowCount;
		const bodyLine = event.row - this.#bodyRowStart;
		const overBody = bodyLine >= 0 && bodyLine < this.#bodyRowCount;
		const leftWidth = this.#body.leftWidth;
		const overList = overBody && innerCol < leftWidth;
		const overInspector = overBody && innerCol >= leftWidth + 3;

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
			this.#mainList.setHoverIndex(overList ? this.#mainList.hitTest(bodyLine) : null);
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
			this.#mainList.handleClick(bodyLine);
			this.onRequestRender?.();
		}
	}

	/** Switch to the provider tab with `id`, re-filtering the list around it. */
	#selectProviderById(id: string): void {
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
		toggleProvider(providerId);
		void this.#refreshFromState();
	}

	#handleExtensionToggle(extensionId: string, enabled: boolean): void {
		const sm = this.settings ?? Settings.instance;
		if (!sm) return;

		const disabled = ((sm.get("disabledExtensions") as string[]) ?? []).slice();
		if (enabled) {
			const index = disabled.indexOf(extensionId);
			if (index !== -1) {
				disabled.splice(index, 1);
				sm.set("disabledExtensions", disabled);
			}
		} else {
			if (!disabled.includes(extensionId)) {
				disabled.push(extensionId);
				sm.set("disabledExtensions", disabled);
			}
		}

		this.#applyDisabledExtensions(disabled);
		void this.#refreshFromState();
	}

	async #refreshFromState(): Promise<void> {
		const refreshToken = ++this.#refreshToken;
		// Remember the current tab so it survives the re-sort.
		const currentTabId = this.#state.tabs[this.#state.activeTabIndex]?.id;

		const sm = this.settings ?? Settings.instance;
		const disabledIds = sm ? ((sm.get("disabledExtensions") as string[]) ?? []) : [];
		const nextState = await refreshState(this.#state, this.cwd, disabledIds);
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
		this.#state = applyDisabledExtensionsToState(this.#state, disabledIds);
		this.#mainList.setExtensions(this.#state.searchFiltered);
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}
		this.#tabBar.setTabs(buildTabBarTabs(this.#state.tabs), this.#state.tabs[this.#state.activeTabIndex]?.id);
		this.onRequestRender?.();
	}

	handleInput(data: string): void {
		// SGR mouse reports (the fullscreen overlay enables tracking).
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}

		// Ctrl+C - close immediately
		if (matchesKey(data, "ctrl+c")) {
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
			this.onClose?.();
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
}

/**
 * Two-column body: inventory list on the left, inspector on the right, split by
 * a vertical rule. The inspector is a {@link ScrollView} viewport so long detail
 * panes scroll (wheel) with an auto scrollbar; the left list manages its own
 * windowing. Records the left-column width so the host can hit-test panes.
 */
class TwoColumnBody implements Component {
	#maxHeight: number;
	#rightScroll = 0;
	#rightTotal = 0;
	#leftWidth = 0;

	constructor(
		private readonly leftPane: ExtensionList,
		private readonly rightPane: InspectorPanel,
		maxHeight: number,
	) {
		this.#maxHeight = maxHeight;
	}

	setMaxHeight(maxHeight: number): void {
		this.#maxHeight = maxHeight;
	}

	/** Content width of the left (list) column from the last render. */
	get leftWidth(): number {
		return this.#leftWidth;
	}

	resetInspectorScroll(): void {
		this.#rightScroll = 0;
	}

	/** Wheel notch over the inspector pane: scroll its content, clamped. */
	scrollInspector(delta: -1 | 1): void {
		const max = Math.max(0, this.#rightTotal - this.#maxHeight);
		this.#rightScroll = Math.max(0, Math.min(this.#rightScroll + delta, max));
	}

	render(width: number): readonly string[] {
		const leftWidth = Math.floor(width * 0.5);
		this.#leftWidth = leftWidth;
		const rightWidth = Math.max(0, width - leftWidth - 3);
		const numLines = this.#maxHeight;

		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);
		this.#rightTotal = rightLines.length;
		const maxScroll = Math.max(0, this.#rightTotal - numLines);
		if (this.#rightScroll > maxScroll) this.#rightScroll = maxScroll;

		// `totalRows` omitted so the ScrollView windows `rightLines` by the scroll
		// offset (rather than treating them as a pre-windowed slice) and pads short
		// content to exactly `numLines`.
		const rightView = new ScrollView(rightLines, {
			height: numLines,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		rightView.setScrollOffset(this.#rightScroll);
		const rightRendered = rightView.render(rightWidth);

		const combined: string[] = [];
		const separator = theme.fg("dim", ` ${theme.boxRound.vertical} `);
		for (let i = 0; i < numLines; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = rightRendered[i] ?? "";
			combined.push(leftPadded + separator + right);
		}

		return combined;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}
