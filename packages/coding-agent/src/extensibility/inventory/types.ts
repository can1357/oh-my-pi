/**
 * Types for the Extension Control Center dashboard.
 */
/** Discovery snapshot used by provider controls, independent of the loader. */
export interface ExtensionProvider {
	id: string;
	displayName: string;
	enabled: boolean;
	userSourceEnabled: boolean;
	foreignUserSource: boolean;
}

/**
 * Extension kinds matching capability types.
 */
export type ExtensionKind =
	| "extension-module"
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
export type DisabledReason = "provider-disabled" | "user-opt-in" | "item-disabled" | "shadowed";

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
	/**
	 * Raw item data for inspector. For `kind: "mcp"` this remains the discovered
	 * `MCPServer` config — live connection state is joined at render time via
	 * {@link snapshotMcpRuntime}, not stuffed into this bag.
	 */
	raw: unknown;
}

/**
 * True when this row is a lower-precedence copy of another same-name item.
 * Disablement takes display precedence (`state === "disabled"`), but the
 * discovery `_shadowed` flag (and `shadowedBy`) still mark the row as a
 * loser — it must not be toggleable and must not join the winner's live state.
 */
export function isShadowedExtension(ext: Extension): boolean {
	if (ext.state === "shadowed" || ext.shadowedBy) return true;
	return Boolean((ext.raw as { _shadowed?: boolean } | null | undefined)?._shadowed);
}

/**
 * Create extension ID from kind and name.
 */
export function makeExtensionId(kind: ExtensionKind, name: string): string {
	return `${kind}:${name}`;
}

/**
 * Map SourceMeta to extension source shape.
 */
export function sourceFromMeta(meta: Extension["source"]): Extension["source"] {
	return {
		provider: meta.provider,
		providerName: meta.providerName,
		level: meta.level,
	};
}
