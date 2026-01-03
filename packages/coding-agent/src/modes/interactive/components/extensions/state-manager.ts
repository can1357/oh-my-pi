/**
 * State manager for the Extension Control Center.
 * Handles data loading, tree building, filtering, and toggle persistence.
 */

import type { ContextFile } from "../../../../capability/context-file";
import type { Hook } from "../../../../capability/hook";
import type { MCPServer } from "../../../../capability/mcp";
import type { Prompt } from "../../../../capability/prompt";
import type { Rule } from "../../../../capability/rule";
import type { Skill } from "../../../../capability/skill";
import type { CustomTool } from "../../../../capability/tool";
import type { SourceMeta } from "../../../../capability/types";
import {
	disableProvider,
	enableProvider,
	getAllProvidersInfo,
	isProviderEnabled,
	loadSync,
} from "../../../../discovery";
import type {
	DashboardState,
	Extension,
	ExtensionKind,
	ExtensionState,
	FlatTreeItem,
	ProviderTab,
	TreeNode,
} from "./types";
import { makeExtensionId, sourceFromMeta } from "./types";

/**
 * Settings manager interface for granular toggle persistence.
 */
export interface ExtensionSettingsManager {
	getDisabledExtensions(): string[];
	setDisabledExtensions(ids: string[]): void;
}

/**
 * Load all extensions from all capabilities.
 */
export function loadAllExtensions(cwd?: string, disabledIds?: string[]): Extension[] {
	const extensions: Extension[] = [];
	const disabledExtensions = new Set<string>(disabledIds ?? []);

	// Helper to convert capability items to extensions
	function addItems<T extends { name: string; path: string; _source: SourceMeta }>(
		items: T[],
		kind: ExtensionKind,
		opts?: {
			getDescription?: (item: T) => string | undefined;
			getTrigger?: (item: T) => string | undefined;
			getShadowedBy?: (item: T) => string | undefined;
		},
	): void {
		for (const item of items) {
			const id = makeExtensionId(kind, item.name);
			const isDisabled = disabledExtensions.has(id);
			const isShadowed = (item as { _shadowed?: boolean })._shadowed;
			const providerEnabled = isProviderEnabled(item._source.provider);

			let state: ExtensionState;
			let disabledReason: "shadowed" | "provider-disabled" | "item-disabled" | undefined;

			// Item-disabled takes precedence over shadowed
			if (isDisabled) {
				state = "disabled";
				disabledReason = "item-disabled";
			} else if (isShadowed) {
				state = "shadowed";
				disabledReason = "shadowed";
			} else if (!providerEnabled) {
				state = "disabled";
				disabledReason = "provider-disabled";
			} else {
				state = "active";
			}

			extensions.push({
				id,
				kind,
				name: item.name,
				displayName: item.name,
				description: opts?.getDescription?.(item),
				trigger: opts?.getTrigger?.(item),
				path: item.path,
				source: sourceFromMeta(item._source),
				state,
				disabledReason,
				shadowedBy: opts?.getShadowedBy?.(item),
				raw: item,
			});
		}
	}

	const loadOpts = cwd ? { cwd } : {};

	// Load skills
	try {
		const skills = loadSync<Skill>("skills", loadOpts);
		addItems(skills.all, "skill", {
			getDescription: (s) => s.frontmatter?.description,
			getTrigger: (s) => s.frontmatter?.globs?.join(", "),
		});
	} catch {
		// Capability may not be registered
	}

	// Load rules
	try {
		const rules = loadSync<Rule>("rules", loadOpts);
		addItems(rules.all, "rule", {
			getDescription: (r) => r.description,
			getTrigger: (r) => r.globs?.join(", ") || (r.alwaysApply ? "always" : undefined),
		});
	} catch {
		// Capability may not be registered
	}

	// Load custom tools
	try {
		const tools = loadSync<CustomTool>("tools", loadOpts);
		addItems(tools.all, "tool", {
			getDescription: (t) => t.description,
		});
	} catch {
		// Capability may not be registered
	}

	// Load MCP servers
	try {
		const mcps = loadSync<MCPServer>("mcps", loadOpts);
		for (const server of mcps.all) {
			const id = makeExtensionId("mcp", server.name);
			const isDisabled = disabledExtensions.has(id);
			const isShadowed = (server as { _shadowed?: boolean })._shadowed;
			const providerEnabled = isProviderEnabled(server._source.provider);

			let state: ExtensionState;
			let disabledReason: "shadowed" | "provider-disabled" | "item-disabled" | undefined;

			if (isDisabled) {
				state = "disabled";
				disabledReason = "item-disabled";
			} else if (isShadowed) {
				state = "shadowed";
				disabledReason = "shadowed";
			} else if (!providerEnabled) {
				state = "disabled";
				disabledReason = "provider-disabled";
			} else {
				state = "active";
			}

			extensions.push({
				id,
				kind: "mcp",
				name: server.name,
				displayName: server.name,
				description: server.command || server.url,
				trigger: server.transport || "stdio",
				path: server._source.path,
				source: sourceFromMeta(server._source),
				state,
				disabledReason,
				raw: server,
			});
		}
	} catch {
		// Capability may not be registered
	}

	// Load prompts
	try {
		const prompts = loadSync<Prompt>("prompts", loadOpts);
		addItems(prompts.all, "prompt", {
			getDescription: () => undefined,
			getTrigger: (p) => `/prompts:${p.name}`,
		});
	} catch {
		// Capability may not be registered
	}

	// Load hooks
	try {
		const hooks = loadSync<Hook>("hooks", loadOpts);
		for (const hook of hooks.all) {
			const id = makeExtensionId("hook", `${hook.type}:${hook.tool}:${hook.name}`);
			const isDisabled = disabledExtensions.has(id);
			const isShadowed = (hook as { _shadowed?: boolean })._shadowed;
			const providerEnabled = isProviderEnabled(hook._source.provider);

			let state: ExtensionState;
			let disabledReason: "shadowed" | "provider-disabled" | "item-disabled" | undefined;

			if (isDisabled) {
				state = "disabled";
				disabledReason = "item-disabled";
			} else if (isShadowed) {
				state = "shadowed";
				disabledReason = "shadowed";
			} else if (!providerEnabled) {
				state = "disabled";
				disabledReason = "provider-disabled";
			} else {
				state = "active";
			}

			extensions.push({
				id,
				kind: "hook",
				name: hook.name,
				displayName: hook.name,
				description: `${hook.type}-${hook.tool}`,
				trigger: `${hook.type}:${hook.tool}`,
				path: hook.path,
				source: sourceFromMeta(hook._source),
				state,
				disabledReason,
				raw: hook,
			});
		}
	} catch {
		// Capability may not be registered
	}

	// Load context files
	try {
		const contextFiles = loadSync<ContextFile>("context-files", loadOpts);
		for (const file of contextFiles.all) {
			// Extract filename from path for display
			const name = file.path.split("/").pop() || file.path;
			const id = makeExtensionId("context-file", `${file.level}:${name}`);
			const isDisabled = disabledExtensions.has(id);
			const isShadowed = (file as { _shadowed?: boolean })._shadowed;
			const providerEnabled = isProviderEnabled(file._source.provider);

			let state: ExtensionState;
			let disabledReason: "shadowed" | "provider-disabled" | "item-disabled" | undefined;

			if (isDisabled) {
				state = "disabled";
				disabledReason = "item-disabled";
			} else if (isShadowed) {
				state = "shadowed";
				disabledReason = "shadowed";
			} else if (!providerEnabled) {
				state = "disabled";
				disabledReason = "provider-disabled";
			} else {
				state = "active";
			}

			extensions.push({
				id,
				kind: "context-file",
				name,
				displayName: name,
				description: file.level === "user" ? "User-level context" : "Project-level context",
				trigger: file.level,
				path: file.path,
				source: sourceFromMeta(file._source),
				state,
				disabledReason,
				raw: file,
			});
		}
	} catch {
		// Capability may not be registered
	}

	return extensions;
}

/**
 * Build sidebar tree from extensions.
 * Groups by provider → kind.
 */
export function buildSidebarTree(extensions: Extension[]): TreeNode[] {
	const providers = getAllProvidersInfo();
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

	return extensions.filter((ext) => {
		const searchable = [
			ext.name,
			ext.displayName,
			ext.description || "",
			ext.trigger || "",
			ext.source.providerName,
			ext.kind,
		]
			.join(" ")
			.toLowerCase();

		return tokens.every((token) => searchable.includes(token));
	});
}

/**
 * Get display name for extension kind.
 */
function getKindDisplayName(kind: ExtensionKind): string {
	switch (kind) {
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
export function buildProviderTabs(extensions: Extension[]): ProviderTab[] {
	const providers = getAllProvidersInfo();
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
	return extensions.filter((ext) => ext.source.provider === providerId);
}

/**
 * Create initial dashboard state.
 */
export function createInitialState(cwd?: string, disabledIds?: string[]): DashboardState {
	const extensions = loadAllExtensions(cwd, disabledIds);
	const tabs = buildProviderTabs(extensions);
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
 * Toggle provider enabled state.
 */
export function toggleProvider(providerId: string): boolean {
	if (isProviderEnabled(providerId)) {
		disableProvider(providerId);
		return false;
	} else {
		enableProvider(providerId);
		return true;
	}
}

/**
 * Refresh state after toggle.
 */
export function refreshState(state: DashboardState, cwd?: string, disabledIds?: string[]): DashboardState {
	const extensions = loadAllExtensions(cwd, disabledIds);
	const tabs = buildProviderTabs(extensions);

	// Get current provider from tabs
	const activeTab = state.tabs[state.activeTabIndex];
	const providerId = activeTab?.id ?? "all";

	// Re-apply filters
	const tabFiltered = filterByProvider(extensions, providerId);
	const searchFiltered = applyFilter(tabFiltered, state.searchQuery);

	// Find new index for current provider (tabs may have reordered)
	const newActiveTabIndex = tabs.findIndex((t) => t.id === providerId);
	const activeTabIndex = newActiveTabIndex >= 0 ? newActiveTabIndex : 0;

	// Try to preserve selection
	const selectedId = state.selected?.id;
	let selected = selectedId ? searchFiltered.find((e) => e.id === selectedId) : null;
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
