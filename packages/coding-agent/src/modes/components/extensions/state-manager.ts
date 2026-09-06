/**
 * State manager for the Extension Control Center.
 * Handles data loading, tree building, filtering, and toggle persistence.
 */
import * as path from "node:path";
import { fuzzyMatch } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import type { ContextFile } from "../../../capability/context-file";
import type { ExtensionModule } from "../../../capability/extension-module";
import type { Hook } from "../../../capability/hook";
import type { MCPServer } from "../../../capability/mcp";
import type { Prompt } from "../../../capability/prompt";
import type { Rule } from "../../../capability/rule";
import type { Skill } from "../../../capability/skill";
import type { SlashCommand } from "../../../capability/slash-command";
import type { CustomTool } from "../../../capability/tool";
import type { SourceMeta } from "../../../capability/types";
import {
	disableProvider,
	enableProvider,
	getAllProvidersInfo,
	isProviderEnabled,
	loadCapability,
} from "../../../discovery";
import { readDisabledServers, readEnabledServers } from "../../../mcp/config-writer";
import { commandPreview } from "./inspector-model";
import { inferMcpTransport } from "./mcp-runtime";
import {
	type DashboardState,
	type Extension,
	type ExtensionKind,
	type ExtensionState,
	type FlatTreeItem,
	isShadowedExtension,
	makeExtensionId,
	type ProviderTab,
	sourceFromMeta,
	type TreeNode,
} from "./types";

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
export async function loadAllExtensions(cwd?: string, disabledIds?: string[]): Promise<Extension[]> {
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

	const loadOpts = cwd ? { cwd, includeDisabled: true } : { includeDisabled: true };

	// Load skills
	try {
		const skills = await loadCapability<Skill>("skills", loadOpts);
		addItems(skills.all, "skill", {
			getDescription: s => s.frontmatter?.description,
			getTrigger: s => s.frontmatter?.globs?.join(", "),
		});
	} catch (error) {
		logger.warn("Failed to load skills capability", { error: String(error) });
	}

	// Load rules
	try {
		const rules = await loadCapability<Rule>("rules", loadOpts);
		addItems(rules.all, "rule", {
			getDescription: r => r.description,
			getTrigger: r => r.globs?.join(", ") || (r.alwaysApply ? "always" : undefined),
		});
	} catch (error) {
		logger.warn("Failed to load rules capability", { error: String(error) });
	}

	// Load custom tools
	try {
		const tools = await loadCapability<CustomTool>("tools", loadOpts);
		addItems(tools.all, "tool", {
			getDescription: t => t.description,
		});
	} catch (error) {
		logger.warn("Failed to load tools capability", { error: String(error) });
	}

	// Load extension modules
	try {
		const modules = await loadCapability<ExtensionModule>("extension-modules", loadOpts);
		const nativeModules = modules.all.filter(module => module._source.provider === "native");
		addItems(nativeModules, "extension-module");
	} catch (error) {
		logger.warn("Failed to load extension-modules capability", { error: String(error) });
	}

	// Load MCP servers. The dashboard mirrors `/mcp list` (issue #3827) by
	// honoring the same disable signals: the dashboard-private settings list,
	// the per-server `enabled: false` flag, and the user-level `disabledServers`
	// denylist that `/mcp disable` writes through `setServerDisabled`. The
	// user-level `enabledServers` allowlist overrides a non-writable source's
	// `enabled: false` (e.g. opencode.json) but never the denylist.
	try {
		const userMcpPath = cwd ? getMCPConfigPath("user", cwd) : undefined;
		const [mcpDisabledNames, mcpForcedEnabled] = await Promise.all([
			userMcpPath
				? readDisabledServers(userMcpPath)
						.then(list => new Set(list))
						.catch(() => new Set<string>())
				: Promise.resolve(new Set<string>()),
			userMcpPath
				? readEnabledServers(userMcpPath)
						.then(list => new Set(list))
						.catch(() => new Set<string>())
				: Promise.resolve(new Set<string>()),
		]);
		const mcps = await loadCapability<MCPServer>("mcps", loadOpts);
		for (const server of mcps.all) {
			const id = makeExtensionId("mcp", server.name);
			const forced = mcpForcedEnabled.has(server.name);
			const sourceSaysDisabled = server.enabled === false && !forced;
			const isDisabled = mcpDisabledNames.has(server.name) || disabledExtensions.has(id) || sourceSaysDisabled;
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
				// Config command/url is plumbing, not a description. Live
				// identity comes from serverInfo at inspector render time.
				description: undefined,
				trigger: inferMcpTransport(server),
				path: server._source.path,
				source: sourceFromMeta(server._source),
				state,
				disabledReason,
				raw: server,
			});
		}
	} catch (error) {
		logger.warn("Failed to load mcps capability", { error: String(error) });
	}

	// Load prompts
	try {
		const prompts = await loadCapability<Prompt>("prompts", loadOpts);
		addItems(prompts.all, "prompt", {
			getDescription: () => undefined,
			getTrigger: p => `/prompts:${p.name}`,
		});
	} catch (error) {
		logger.warn("Failed to load prompts capability", { error: String(error) });
	}

	// Load slash commands
	try {
		const commands = await loadCapability<SlashCommand>("slash-commands", loadOpts);
		addItems(commands.all, "slash-command", {
			getDescription: c => {
				const preserved = typeof c.description === "string" ? c.description.trim() : "";
				return preserved.length > 0 ? preserved : commandPreview(c.content).description;
			},
			getTrigger: c => `/${c.name}`,
		});
	} catch (error) {
		logger.warn("Failed to load slash-commands capability", { error: String(error) });
	}

	// Load hooks
	try {
		const hooks = await loadCapability<Hook>("hooks", loadOpts);
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
	} catch (error) {
		logger.warn("Failed to load hooks capability", { error: String(error) });
	}

	// Load context files
	try {
		const contextFiles = await loadCapability<ContextFile>("context-files", loadOpts);
		for (const file of contextFiles.all) {
			// Extract filename from path for display
			const name = path.basename(file.path);
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
				path: file.path,
				source: sourceFromMeta(file._source),
				state,
				disabledReason,
				raw: file,
			});
		}
	} catch (error) {
		logger.warn("Failed to load context-files capability", { error: String(error) });
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
	return extensions.filter(ext => ext.source.provider === providerId);
}

export { isShadowedExtension } from "./types";

/**
 * Apply setting-backed item disable overrides to an existing dashboard state.
 * This gives the UI immediate feedback while the full capability refresh runs.
 */
export function applyDisabledExtensionsToState(state: DashboardState, disabledIds: string[]): DashboardState {
	const disabled = new Set(disabledIds);
	const updateExtension = (ext: Extension): Extension => {
		if (disabled.has(ext.id)) {
			if (ext.state === "disabled" && ext.disabledReason === "item-disabled") return ext;
			return { ...ext, state: "disabled", disabledReason: "item-disabled" };
		}

		if (ext.state !== "disabled" || ext.disabledReason !== "item-disabled") return ext;
		if (!isProviderEnabled(ext.source.provider)) {
			return { ...ext, state: "disabled", disabledReason: "provider-disabled" };
		}

		if (isShadowedExtension(ext)) {
			const shadowed: Extension = { ...ext, state: "shadowed", disabledReason: "shadowed" };
			return shadowed;
		}

		const enabled: Extension = { ...ext, state: "active" };
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
export async function createInitialState(cwd?: string, disabledIds?: string[]): Promise<DashboardState> {
	const extensions = await loadAllExtensions(cwd, disabledIds);
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
export async function refreshState(
	state: DashboardState,
	cwd?: string,
	disabledIds?: string[],
): Promise<DashboardState> {
	const extensions = await loadAllExtensions(cwd, disabledIds);
	const tabs = buildProviderTabs(extensions);

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
