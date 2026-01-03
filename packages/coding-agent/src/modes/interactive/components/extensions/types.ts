/**
 * Types for the Extension Control Center dashboard.
 */

import type { SourceMeta } from "../../../../capability/types";

/**
 * Extension kinds matching capability types.
 */
export type ExtensionKind =
	| "skill"
	| "rule"
	| "tool"
	| "mcp"
	| "prompt"
	| "instruction"
	| "context-file"
	| "hook"
	| "slash-command";

/**
 * Extension state (active, disabled, or shadowed).
 */
export type ExtensionState = "active" | "disabled" | "shadowed";

/**
 * Reason why an extension is disabled.
 */
export type DisabledReason = "provider-disabled" | "item-disabled" | "shadowed";

/**
 * Unified extension representation for the dashboard.
 * Normalizes all capability types into a common shape.
 */
export interface Extension {
	/** Unique ID: `${kind}:${name}` */
	id: string;
	/** Extension kind */
	kind: ExtensionKind;
	/** Extension name */
	name: string;
	/** Display name (may differ from name) */
	displayName: string;
	/** Description if available */
	description?: string;
	/** Trigger pattern (slash command, glob, regex) */
	trigger?: string;
	/** Absolute path to source file */
	path: string;
	/** Source metadata */
	source: {
		provider: string;
		providerName: string;
		level: "user" | "project" | "native";
	};
	/** Current state */
	state: ExtensionState;
	/** Reason for disabled state */
	disabledReason?: DisabledReason;
	/** If shadowed, what shadows it */
	shadowedBy?: string;
	/** Raw item data for inspector */
	raw: unknown;
}

/**
 * Tree node types for sidebar hierarchy.
 */
export type TreeNodeType = "provider" | "kind" | "item";

/**
 * Sidebar tree node.
 */
export interface TreeNode {
	/** Unique ID */
	id: string;
	/** Display label */
	label: string;
	/** Node type (provider can be toggled, kind groups items) */
	type: TreeNodeType;
	/** Whether this node/provider is enabled */
	enabled: boolean;
	/** Whether collapsed */
	collapsed: boolean;
	/** Child nodes */
	children: TreeNode[];
	/** Extension count (for display) */
	count?: number;
}

/**
 * Flattened tree item for navigation.
 */
export interface FlatTreeItem {
	node: TreeNode;
	depth: number;
	index: number;
}

/**
 * Focus pane in the dashboard.
 */
export type FocusPane = "sidebar" | "main" | "inspector";

/**
 * Dashboard state.
 */
export interface DashboardState {
	/** Currently focused pane */
	focusPane: FocusPane;

	/** Sidebar tree nodes */
	sidebarTree: TreeNode[];
	/** Flattened tree for navigation */
	flatTree: FlatTreeItem[];
	/** Selected index in flattened tree */
	sidebarIndex: number;

	/** All extensions (unfiltered) */
	extensions: Extension[];
	/** Filtered extensions (after search) */
	filtered: Extension[];
	/** Current search query */
	searchQuery: string;
	/** Selected index in main list */
	mainIndex: number;
	/** Scroll offset for main list */
	scrollOffset: number;

	/** Currently selected extension for inspector */
	selected: Extension | null;
}

/**
 * Callbacks from dashboard to parent.
 */
export interface DashboardCallbacks {
	/** Called when provider is toggled */
	onProviderToggle: (providerId: string, enabled: boolean) => void;
	/** Called when extension item is toggled */
	onExtensionToggle: (extensionId: string, enabled: boolean) => void;
	/** Called when dashboard is closed */
	onClose: () => void;
}

/**
 * Create extension ID from kind and name.
 */
export function makeExtensionId(kind: ExtensionKind, name: string): string {
	return `${kind}:${name}`;
}

/**
 * Parse extension ID into kind and name.
 */
export function parseExtensionId(id: string): { kind: ExtensionKind; name: string } | null {
	const colonIdx = id.indexOf(":");
	if (colonIdx === -1) return null;
	return {
		kind: id.slice(0, colonIdx) as ExtensionKind,
		name: id.slice(colonIdx + 1),
	};
}

/**
 * Map SourceMeta to extension source shape.
 */
export function sourceFromMeta(meta: SourceMeta): Extension["source"] {
	return {
		provider: meta.provider,
		providerName: meta.providerName,
		level: meta.level,
	};
}
