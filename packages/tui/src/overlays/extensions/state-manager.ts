/** Pure dashboard tree, filtering, and selection state. */
import { fuzzyMatch } from "../../fuzzy";
import {
	type DashboardState,
	type DisabledReason,
	type Extension,
	type ExtensionKind,
	type ExtensionState,
	type FlatTreeItem,
	isShadowedExtension,
	type ProviderTab,
	type ExtensionProvider,
	type TreeNode,
} from "./types";

export function resolveExtensionState(
	source: { provider: string; level: string },
	isDisabled: boolean,
	isShadowed: boolean | undefined,
	providers: readonly ExtensionProvider[],
): { state: ExtensionState; disabledReason?: DisabledReason } {
	if (isDisabled) return { state: "disabled", disabledReason: "item-disabled" };
	if (isShadowed) return { state: "shadowed", disabledReason: "shadowed" };
	if (providers.find(provider => provider.id === source.provider)?.enabled === false)
		return { state: "disabled", disabledReason: "provider-disabled" };
	if (
		source.level === "user" &&
		providers.find(provider => provider.id === source.provider)?.userSourceEnabled === false
	) {
		return { state: "disabled", disabledReason: "user-opt-in" };
	}
	return { state: "active" };
}

/**
 * Build sidebar tree from extensions.
 * Groups by provider → kind.
 */
export function buildSidebarTree(extensions: Extension[], providers: readonly ExtensionProvider[]): TreeNode[] {
	const tree: TreeNode[] = [];

	// Group extensions by provider and kind
	const byProvider = new Map<string, Map<ExtensionKind, Extension[]>>();

	for (const ext of extensions) {
		const providerId = ext.source.provider;
		if (!byProvider.has(providerId)) {
			byProvider.set(providerId, new Map());
		}
		const byKind = byProvider.get(providerId)!;
		if (!byKind.has(ext.kind)) {
			byKind.set(ext.kind, []);
		}
		byKind.get(ext.kind)!.push(ext);
	}

	// Build tree nodes for each provider (show ALL providers, even if disabled/empty)
	for (const provider of providers) {
		// Skip the 'native' provider as it cannot be toggled
		if (provider.id === "native") continue;

		const byKind = byProvider.get(provider.id);
		const kindNodes: TreeNode[] = [];
		let totalCount = 0;

		if (byKind && byKind.size > 0) {
			for (const [kind, exts] of byKind) {
				totalCount += exts.length;
				kindNodes.push({
					id: `${provider.id}:${kind}`,
					label: getKindDisplayName(kind),
					type: "kind",
					enabled: provider.enabled,
					collapsed: true,
					children: [],
					count: exts.length,
				});
			}

			// Sort kind nodes by count (most items first)
			kindNodes.sort((a, b) => (b.count || 0) - (a.count || 0));
		}

		tree.push({
			id: provider.id,
			label: provider.displayName,
			type: "provider",
			enabled: provider.enabled,
			collapsed: false,
			children: kindNodes,
			count: totalCount,
		});
	}

	return tree;
}

/**
 * Flatten tree for keyboard navigation.
 */
export function flattenTree(tree: TreeNode[]): FlatTreeItem[] {
	const flat: FlatTreeItem[] = [];
	let index = 0;

	function walk(node: TreeNode, depth: number): void {
		flat.push({ node, depth, index: index++ });
		if (!node.collapsed) {
			for (const child of node.children) {
				walk(child, depth + 1);
			}
		}
	}

	for (const node of tree) {
		walk(node, 0);
	}

	return flat;
}

/**
 * Apply fuzzy filter to extensions.
 */
export function applyFilter(extensions: Extension[], query: string): Extension[] {
	if (!query.trim()) {
		return extensions;
	}

	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return extensions;
	}

	return extensions.filter(ext => {
		const searchable = [
			ext.name,
			ext.displayName,
			ext.description || "",
			ext.trigger || "",
			ext.source.providerName,
			ext.kind,
		].join(" ");

		return tokens.every(token => fuzzyMatch(token, searchable).matches);
	});
}

/**
 * Get display name for extension kind.
 */
function getKindDisplayName(kind: ExtensionKind): string {
	switch (kind) {
		case "extension-module":
			return "Extension Modules";
		case "skill":
			return "Skills";
		case "rule":
			return "Rules";
		case "tool":
			return "Tools";
		case "mcp":
			return "MCP Servers";
		case "prompt":
			return "Prompts";
		case "instruction":
			return "Instructions";
		case "context-file":
			return "Context Files";
		case "hook":
			return "Hooks";
		case "slash-command":
			return "Slash Commands";
		default:
			return kind;
	}
}

/**
 * Build provider tabs from extensions.
 */
export function buildProviderTabs(extensions: Extension[], providers: readonly ExtensionProvider[]): ProviderTab[] {
	const tabs: ProviderTab[] = [];

	// Count extensions per provider
	const countByProvider = new Map<string, number>();
	for (const ext of extensions) {
		const count = countByProvider.get(ext.source.provider) ?? 0;
		countByProvider.set(ext.source.provider, count + 1);
	}

	// ALL tab first
	tabs.push({
		id: "all",
		label: "ALL",
		enabled: true,
		count: extensions.length,
	});

	// Provider tabs (skip native)
	for (const provider of providers) {
		if (provider.id === "native") continue;
		const count = countByProvider.get(provider.id) ?? 0;
		tabs.push({
			id: provider.id,
			label: provider.displayName,
			enabled: provider.enabled,
			count,
		});
	}

	// Sort: ALL first, then enabled by count, then disabled by count, then empty
	tabs.sort((a, b) => {
		if (a.id === "all") return -1;
		if (b.id === "all") return 1;

		// Categorize: 0 = enabled with content, 1 = disabled, 2 = empty+enabled
		const category = (t: ProviderTab) => {
			if (t.count === 0 && t.enabled) return 2; // empty
			if (!t.enabled) return 1; // disabled
			return 0; // enabled with content
		};

		const aCat = category(a);
		const bCat = category(b);
		if (aCat !== bCat) return aCat - bCat;

		// Within same category, sort by count descending
		return b.count - a.count;
	});

	return tabs;
}

/**
 * Filter extensions by provider tab.
 */
export function filterByProvider(extensions: Extension[], providerId: string): Extension[] {
	if (providerId === "all") {
		return extensions;
	}
	return extensions.filter(ext => ext.source.provider === providerId);
}

/**
 * Apply setting-backed item disable overrides to an existing dashboard state.
 * This gives the UI immediate feedback while the full capability refresh runs.
 */
export function applyDisabledExtensionsToState(
	state: DashboardState,
	disabledIds: string[],
	providers: readonly ExtensionProvider[] = [],
): DashboardState {
	const disabled = new Set(disabledIds);
	const updateExtension = (ext: Extension): Extension => {
		if (disabled.has(ext.id)) {
			if (ext.state === "disabled" && ext.disabledReason === "item-disabled") return ext;
			return { ...ext, state: "disabled", disabledReason: "item-disabled" };
		}

		if (ext.state !== "disabled" || ext.disabledReason !== "item-disabled") return ext;
		const { state, disabledReason } = resolveExtensionState(ext.source, false, isShadowedExtension(ext), providers);
		if (disabledReason) return { ...ext, state, disabledReason };
		const enabled: Extension = { ...ext, state };
		delete enabled.disabledReason;
		return enabled;
	};

	return {
		...state,
		extensions: state.extensions.map(updateExtension),
		tabFiltered: state.tabFiltered.map(updateExtension),
		searchFiltered: state.searchFiltered.map(updateExtension),
		selected: state.selected ? updateExtension(state.selected) : null,
	};
}

/**
 * Create initial dashboard state.
 */
export function createInitialState(extensions: Extension[], providers: readonly ExtensionProvider[]): DashboardState {
	const tabs = buildProviderTabs(extensions, providers);
	const tabFiltered = extensions; // "all" tab by default
	const searchFiltered = tabFiltered;

	return {
		tabs,
		activeTabIndex: 0,
		extensions,
		tabFiltered,
		searchFiltered,
		searchQuery: "",
		listIndex: 0,
		scrollOffset: 0,
		selected: searchFiltered[0] ?? null,
	};
}

/**
 * Refresh state after toggle.
 */
export function refreshState(
	state: DashboardState,
	extensions: Extension[],
	providers: readonly ExtensionProvider[],
): DashboardState {
	const tabs = buildProviderTabs(extensions, providers);

	// Get current provider from tabs
	const activeTab = state.tabs[state.activeTabIndex];
	const providerId = activeTab?.id ?? "all";

	// Re-apply filters
	const tabFiltered = filterByProvider(extensions, providerId);
	const searchFiltered = applyFilter(tabFiltered, state.searchQuery);

	// Find new index for current provider (tabs may have reordered)
	const newActiveTabIndex = tabs.findIndex(t => t.id === providerId);
	const activeTabIndex = newActiveTabIndex >= 0 ? newActiveTabIndex : 0;

	// Try to preserve selection
	const selectedId = state.selected?.id;
	let selected = selectedId ? searchFiltered.find(e => e.id === selectedId) : null;
	if (!selected && searchFiltered.length > 0) {
		selected = searchFiltered[Math.min(state.listIndex, searchFiltered.length - 1)];
	}

	return {
		...state,
		tabs,
		activeTabIndex,
		extensions,
		tabFiltered,
		searchFiltered,
		selected: selected ?? null,
		listIndex: selected ? searchFiltered.indexOf(selected) : 0,
	};
}
