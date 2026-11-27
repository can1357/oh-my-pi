/**
 * The extension control center: provider tabs over the inventory list and
 * the inspector of the selected extension. Toggling an item or a provider
 * (its master switch) goes through the runtime, then the inventory reloads.
 *
 * Keys: Tab/Shift+Tab or ←/→ switch provider, ↑/↓ move, Space/Enter toggle,
 * PgUp/PgDn page the inspector (when it overflows), the expand key expands
 * it, typing searches, Esc clears the search then closes, Ctrl+C closes.
 */
import type { Accessor } from "@oh-my-pi/pi-tui";
import { signal } from "@oh-my-pi/pi-tui";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionDashboardRuntime } from "../../../extensibility/inventory/extension-dashboard";
import { applyFilter } from "../../../extensibility/inventory/state-manager";
import { type Extension, isShadowedExtension } from "../../../extensibility/inventory/types";
import { type DashboardLayout, dashboardLayout } from "../../styles/panels/extensions";
import { bindingGlyph, keyGlyph, selectNavGlyphs } from "../../styles/panels/common";
import { ExtensionInspectorModel } from "./extension-inspector-model";
import { ExtensionListModel } from "./extension-list-model";
import {
	filterByProvider,
	type ProviderTab,
	providerTabs,
	type ToolRuntimeSource,
	withDisabledIds,
} from "./extensions-data";
import { appInterruptKeys, matchesAppInterrupt, selectKeyId } from "../../../config/keybindings/matchers";
import { canonicalKeyId } from "../../../config/keybindings/key-id";

export type { ExtensionDashboardRuntime };

/** A provider tab as the tab bar draws it. */
export interface ProviderTabView {
	readonly id: string;
	readonly label: string;
	/** The label without its count (when the bar is too narrow). */
	readonly short: string;
	/** An empty enabled provider: skipped and inert. */
	readonly muted: boolean;
}

export interface ExtensionDashboardOptions {
	readonly runtime: ExtensionDashboardRuntime;
	readonly terminal: {
		readonly theme: Accessor<Theme>;
		readonly size: Accessor<{ readonly columns: number; readonly rows: number }>;
	};
	readonly toolSource?: ToolRuntimeSource;
	/** The key that expands the inspector (default `ctrl+o`). */
	readonly expandKey?: string;
	onClose?(): void;
}

/** Forwarded inspector paging for the native preview (bumped per page key). */
export interface InspectorScrollRequest {
	readonly by: "page-up" | "page-down";
	readonly n: number;
}

export class ExtensionDashboardModel {
	readonly rev = signal(0);
	readonly list: ExtensionListModel;
	readonly inspector: ExtensionInspectorModel;
	tabs: ProviderTab[];
	/** The tab bar's tab (the provider in view). */
	activeTab = 0;
	hoverTab: string | null = null;
	extensions: Extension[];
	tabFiltered: Extension[];
	searchFiltered: Extension[];
	searchQuery = "";
	selected: Extension | null;
	/** The inspector's terminal scroll. */
	inspectorScroll = 0;
	nativeScroll: InspectorScrollRequest | undefined;
	readonly expandKey: string;
	readonly expandGlyph: string;
	#listIndex = 0;
	#refresh = 0;
	#unsubscribers: (() => void)[] = [];
	#rev = 0;

	private constructor(
		readonly runtime: ExtensionDashboardRuntime,
		readonly terminal: ExtensionDashboardOptions["terminal"],
		readonly toolSource: ToolRuntimeSource | undefined,
		readonly options: ExtensionDashboardOptions,
		extensions: Extension[],
	) {
		this.expandKey = options.expandKey ?? "ctrl+o";
		this.expandGlyph = keyGlyph(this.expandKey);
		this.extensions = extensions;
		this.tabs = providerTabs(extensions, runtime.getProviders());
		this.tabFiltered = extensions;
		this.searchFiltered = extensions;
		this.selected = extensions[0] ?? null;
		this.inspector = new ExtensionInspectorModel(runtime.inspectorSource);
		this.inspector.setMcpSource(runtime.mcpSource);
		this.inspector.setToolSource(toolSource);
		this.list = new ExtensionListModel(
			this.searchFiltered,
			{
				getProviders: () => this.runtime.getProviders(),
				onSelectionChange: ext => {
					this.selected = ext;
					this.inspector.setExtension(ext);
					this.inspectorScroll = 0;
				},
				onToggle: (id, enabled) => this.#toggleExtension(id, enabled),
				onMasterToggle: id => this.#toggleProvider(id),
				masterSwitchProvider: null,
				mcpSource: runtime.mcpSource,
				toolSource,
			},
			Math.max(3, terminal.size().rows - 9),
		);
		this.list.setFocused(true);
		if (this.selected) this.inspector.setExtension(this.selected);
		this.#unsubscribers.push(...runtime.subscribeMcpChanges(() => this.touch()));
	}

	static async create(options: ExtensionDashboardOptions): Promise<ExtensionDashboardModel> {
		const runtime = options.runtime;
		const extensions = await runtime.loadExtensions(runtime.getDisabledExtensions());
		return new ExtensionDashboardModel(runtime, options.terminal, options.toolSource, options, extensions);
	}

	touch(): void {
		this.rev.set(++this.#rev);
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
	}

	// ─── Tabs ───────────────────────────────────────────────────────────────

	tabViews(): ProviderTabView[] {
		const disabled = this.terminal.theme().symbols.symbol("status.disabled");
		return this.tabs.map(tab => {
			const all = tab.id === "all";
			let label = tab.count > 0 ? `${tab.label} (${tab.count})` : tab.label;
			if (!tab.enabled && !all) label = `${disabled} ${label}`;
			return { id: tab.id, label, short: tab.label, muted: tab.count === 0 && tab.enabled && !all };
		});
	}

	activeProviderId(): string | null {
		const tab = this.tabs[this.activeTab];
		return tab && tab.id !== "all" ? tab.id : null;
	}

	#setActiveTab(index: number): void {
		const next = Math.max(0, Math.min(index, this.tabs.length - 1));
		if (next === this.activeTab) return;
		this.activeTab = next;
		this.#selectProvider(this.tabs[next]!.id);
	}

	/** Activate tab `id` (muted tabs are inert). */
	selectTab(id: string): void {
		const index = this.tabs.findIndex(tab => tab.id === id);
		if (index < 0 || this.tabViews()[index]?.muted) return;
		this.#setActiveTab(index);
	}

	#stepTab(delta: -1 | 1): void {
		const views = this.tabViews();
		const count = views.length;
		for (let step = 1; step <= count; step++) {
			const index = (((this.activeTab + delta * step) % count) + count) % count;
			if (!views[index]?.muted) {
				this.#setActiveTab(index);
				return;
			}
		}
	}

	#selectProvider(id: string): void {
		this.tabFiltered = filterByProvider(this.extensions, id);
		this.searchFiltered = applyFilter(this.tabFiltered, this.searchQuery);
		this.#listIndex = 0;
		this.selected = this.searchFiltered[0] ?? null;
		this.list.setExtensions(this.searchFiltered);
		this.list.setMasterSwitchProvider(this.activeProviderId());
		this.list.resetSelection();
		if (this.selected) this.inspector.setExtension(this.selected);
		this.inspectorScroll = 0;
	}

	// ─── Toggles ────────────────────────────────────────────────────────────

	#toggleProvider(providerId: string): void {
		const enabling = this.tabs.find(tab => tab.id === providerId)?.enabled === false;
		this.runtime.toggleProvider(providerId);
		if (!enabling) void this.#disconnectMcp(providerId);
		else void this.#reload();
	}

	/** A disabled provider's MCP servers leave the session (its configs stay as they are). */
	async #disconnectMcp(providerId: string): Promise<void> {
		const names = new Set(
			this.extensions
				.filter(ext => ext.kind === "mcp" && ext.source.provider === providerId && !isShadowedExtension(ext))
				.map(ext => ext.name),
		);
		for (const name of names) {
			try {
				await this.runtime.applyMcpToggle(name, false);
			} catch (error) {
				logger.warn("Failed to disconnect MCP server after provider disable", {
					name,
					providerId,
					error: String(error),
				});
			}
		}
		await this.#reload();
	}

	#toggleExtension(id: string, enabled: boolean): void {
		// MCP servers are switched in mcp.json, the one list `/mcp` and the runtime agree on.
		if (id.startsWith("mcp:")) {
			void this.#toggleMcp(id, enabled);
			return;
		}
		const disabled = this.runtime.getDisabledExtensions().slice();
		const at = disabled.indexOf(id);
		if (enabled && at !== -1) {
			disabled.splice(at, 1);
			this.runtime.setDisabledExtensions(disabled);
		} else if (!enabled && at === -1) {
			disabled.push(id);
			this.runtime.setDisabledExtensions(disabled);
		}
		this.#applyDisabled(disabled);
		void this.#reload();
	}

	async #toggleMcp(id: string, enabled: boolean): Promise<void> {
		const name = id.slice("mcp:".length);
		const owner = this.extensions.find(ext => ext.id === id && !isShadowedExtension(ext));
		const writable =
			owner && (owner.source.provider === "native" || owner.source.provider === "mcp-json") ? owner.path : undefined;
		try {
			await this.runtime.persistMcpToggle(name, enabled, writable);
		} catch (error) {
			logger.warn("Failed to persist MCP toggle", { name, enabled, error: String(error) });
			await this.#reload();
			return;
		}
		try {
			await this.runtime.applyMcpToggle(name, enabled);
		} catch (error) {
			logger.warn("Failed to apply MCP toggle to live manager", { name, enabled, error: String(error) });
		}
		// A legacy `mcp:<name>` disable flag must not outlive a re-enable.
		const stored = this.runtime.getDisabledExtensions().slice();
		const at = stored.indexOf(id);
		if (enabled && at !== -1) {
			stored.splice(at, 1);
			this.runtime.setDisabledExtensions(stored);
			this.#applyDisabled(stored);
		}
		await this.#reload();
	}

	#applyDisabled(ids: string[]): void {
		const disabled = new Set(ids);
		const providers = this.runtime.getProviders();
		const update = (ext: Extension) => withDisabledIds(ext, disabled, providers);
		this.extensions = this.extensions.map(update);
		this.tabFiltered = this.tabFiltered.map(update);
		this.searchFiltered = this.searchFiltered.map(update);
		this.selected = this.selected ? update(this.selected) : null;
		this.list.setExtensions(this.searchFiltered);
		if (this.selected) this.inspector.setExtension(this.selected);
		this.touch();
	}

	async #reload(): Promise<void> {
		const token = ++this.#refresh;
		const current = this.tabs[this.activeTab]?.id;
		const extensions = await this.runtime.loadExtensions(this.runtime.getDisabledExtensions());
		if (token !== this.#refresh) return;
		const providerId = current ?? "all";
		this.tabs = providerTabs(extensions, this.runtime.getProviders());
		this.extensions = extensions;
		this.tabFiltered = filterByProvider(extensions, providerId);
		this.searchFiltered = applyFilter(this.tabFiltered, this.searchQuery);
		const selectedId = this.selected?.id;
		let selected = selectedId ? this.searchFiltered.find(ext => ext.id === selectedId) : undefined;
		if (!selected && this.searchFiltered.length > 0)
			selected = this.searchFiltered[Math.min(this.#listIndex, this.searchFiltered.length - 1)];
		this.selected = selected ?? null;
		this.#listIndex = selected ? this.searchFiltered.indexOf(selected) : 0;
		const index = this.tabs.findIndex(tab => tab.id === current);
		this.activeTab = index >= 0 ? index : Math.max(0, Math.min(this.activeTab, this.tabs.length - 1));
		this.list.setExtensions(this.searchFiltered);
		this.list.setMasterSwitchProvider(this.activeProviderId());
		if (this.selected) this.inspector.setExtension(this.selected);
		this.touch();
	}

	// ─── Input ──────────────────────────────────────────────────────────────

	#close(): void {
		this.dispose();
		this.options.onClose?.();
	}

	clearSearch(): void {
		this.searchQuery = "";
		this.searchFiltered = this.tabFiltered;
		this.list.setExtensions(this.searchFiltered);
		this.list.clearSearch();
		this.touch();
	}

	/** The face at the terminal's size, as keys and the wheel see it. */
	#reference(): DashboardLayout {
		const size = this.terminal.size();
		return dashboardLayout(this, size.columns, size.rows, this.terminal.theme());
	}

	/** Page the inspector when it overflows; false when it did not move. */
	#pageInspector(delta: -1 | 1): boolean {
		const layout = this.#reference();
		if (layout.inspectorTotal <= layout.contentRows) return false;
		const before = this.inspectorScroll;
		const max = Math.max(0, layout.inspectorTotal - layout.contentRows);
		this.inspectorScroll = Math.max(
			0,
			Math.min(this.inspectorScroll + delta * Math.max(1, layout.contentRows - 1), max),
		);
		return this.inspectorScroll !== before;
	}

	key(id: string, text: string | undefined): void {
		this.list.maxVisible = Math.max(3, this.#reference().contentRows - 2);
		if (id === "ctrl+c") return this.#close();
		if (matchesAppInterrupt(id)) {
			if (this.searchQuery.length > 0) this.clearSearch();
			else this.#close();
			return;
		}
		if (id === this.expandKey) {
			this.inspector.toggleExpanded();
			this.touch();
			return;
		}
		const nav = selectKeyId(id);
		const page = nav === "pageUp" ? -1 : nav === "pageDown" ? 1 : 0;
		if (page !== 0) {
			this.nativeScroll = { by: page < 0 ? "page-up" : "page-down", n: (this.nativeScroll?.n ?? 0) + 1 };
			if (this.#pageInspector(page)) {
				this.touch();
				return;
			}
		}
		if (id === "tab" || id === "right") this.#stepTab(1);
		else if (id === "shift+tab" || id === "left") this.#stepTab(-1);
		else {
			this.list.key(id, text);
			if (this.list.query !== this.searchQuery) {
				this.searchQuery = this.list.query;
				this.searchFiltered = applyFilter(this.tabFiltered, this.searchQuery);
			}
		}
		this.touch();
	}

	/** A pointer event at a cell of the face `layout`. */
	mouse(layout: DashboardLayout, event: MouseEvent, row: number, col: number): void {
		const innerCol = col - 2;
		const tabLine = row - 1;
		const overTabs = tabLine >= 0 && tabLine < layout.tabRows;
		const bodyLine = row - (layout.tabRows + 2);
		const inBody =
			bodyLine >= 0 && bodyLine < layout.contentRows && col >= 2 && col < 2 + layout.left + 3 + layout.right;
		const overList = inBody && innerCol < layout.left;
		const overInspector = inBody && innerCol >= layout.left + 3;
		const tabAt = () => {
			const zone = layout.zones.find(
				entry => entry.line === tabLine && innerCol >= entry.start && innerCol < entry.end,
			);
			return zone ? this.tabViews()[zone.index] : undefined;
		};
		if (event.button === "wheel-up" || event.button === "wheel-down") {
			const delta = event.button === "wheel-down" ? 1 : -1;
			if (overList) this.list.handleWheel(delta);
			else if (overInspector) {
				const max = Math.max(0, layout.inspectorTotal - layout.contentRows);
				this.inspectorScroll = Math.max(0, Math.min(this.inspectorScroll + delta, max));
			}
		} else if (event.action === "move" || event.action === "drag") {
			const tab = overTabs ? tabAt() : undefined;
			this.hoverTab = tab && !tab.muted ? tab.id : null;
			this.list.setHoverIndex(overList ? this.list.hitTest(bodyLine) : null);
		} else if (event.button === "left" && event.action === "press") {
			if (overTabs) {
				const tab = tabAt();
				if (tab) this.selectTab(tab.id);
			} else if (overList) this.list.handleClick(bodyLine);
		}
		this.touch();
	}

	/** A native pick or action: rows select/toggle, scopes switch provider, toggle/expand/clear/close. */
	event(kind: "select" | "activate" | "action", value: string | undefined, act?: string): void {
		if (kind !== "action") {
			if (value !== undefined) this.list.pickNative(value, kind === "activate");
			this.touch();
			return;
		}
		switch (act) {
			case "close":
				return this.#close();
			case "clear":
				return this.clearSearch();
			case "scope":
				if (value) this.selectTab(value);
				break;
			case "toggle":
				this.list.activateSelected();
				break;
			case "expand":
				this.inspector.toggleExpanded();
				break;
		}
		this.touch();
	}

	footerText(): string {
		const pages = `${bindingGlyph("tui.select.pageUp", "pageUp")}/${bindingGlyph("tui.select.pageDown", "pageDown")}`;
		const close = keyGlyph(canonicalKeyId(appInterruptKeys()[0] ?? "escape"));
		return ` ${selectNavGlyphs()}: navigate · ${keyGlyph("space")}: toggle · ${keyGlyph("left")}/${keyGlyph("right")}: provider · ${pages}: inspector · ${this.expandGlyph}: expand · ${close}: close`;
	}
}
