import type { ConfiguredThinkingLevel } from "../thinking";

/** Supported ways a panel can combine its members' perspectives. */
export const PANEL_STRATEGIES = Object.freeze(["independent", "personas"] as const);
export type PanelStrategy = (typeof PANEL_STRATEGIES)[number];

/** The kind of work a panel member receives. */
export const PANEL_TASK_MODES = Object.freeze(["answer", "plan"] as const);
export type PanelTaskMode = (typeof PANEL_TASK_MODES)[number];

/**
 * Maximum members in a panel. It bounds panel cost and guarantees the synthesis
 * evidence budget can retain a labeled record for every member.
 */
export const PANEL_MAX_MEMBERS = 4;

/** Read-only capability profiles available to a panel persona. */
export const PANEL_PERSONA_TOOLS = Object.freeze(["none", "workspace-read"] as const);
export type PanelPersonaTools = (typeof PANEL_PERSONA_TOOLS)[number];

/** One configured member of a saved panel role. */
export interface PanelMember {
	/** A literal model selector or an ordinary `@modelRole` reference. */
	readonly model: string;
	/** An explicit panel-member thinking override, when configured. */
	readonly thinking?: ConfiguredThinkingLevel;
	/** A built-in or configured persona identifier, required by persona panels. */
	readonly persona?: string;
}

/** A saved lineup selected through a panel role alias such as `@frontier`. */
export interface PanelRole {
	readonly strategy: PanelStrategy;
	readonly members: readonly PanelMember[];
}

/** A read-only perspective that can be assigned to a personas panel member. */
export interface PanelPersona {
	readonly label: string;
	readonly modes: readonly PanelTaskMode[];
	readonly instructions: string;
	readonly tools: PanelPersonaTools;
}

/** Panel configuration stored at the root `panel` settings path. */
export interface PanelSettings {
	readonly defaultRole?: string;
	readonly roles: Readonly<Record<string, PanelRole>>;
	readonly personas: Readonly<Record<string, PanelPersona>>;
}

/** A saved panel role selected by an explicit or default role identifier. */
export interface ResolvedPanelRole {
	readonly roleId: string;
	readonly role: PanelRole;
}

/** A panel member after its selector, model id, effort, and family have been resolved. */
export interface ResolvedPanelMember extends PanelMember {
	/** The role-local member position, assigned by host code. */
	readonly index: number;
	/** The selector resolved for dispatch. */
	readonly selector: string;
	/** The selected model's canonical id, without a display suffix. */
	readonly modelId: string;
	/** The coarse model lineage token, or an empty string when unknown. */
	readonly family: string;
	/** The actual resolved thinking level, including a configured model-role default. */
	readonly thinking?: ConfiguredThinkingLevel;
}

/** A terminal outcome that host code assigns to a panel member. */
export const PANELIST_STATUSES = Object.freeze(["completed", "failed", "aborted"] as const);
export type PanelistStatus = (typeof PANELIST_STATUSES)[number];

/** Host-owned, typed evidence from one settled panel member. */
export interface PanelistResult {
	readonly member: ResolvedPanelMember;
	readonly status: PanelistStatus;
	readonly output: string;
	readonly error?: string;
	readonly truncated: boolean;
	readonly durationMs: number;
	readonly tokens: number;
	readonly requests: number;
	readonly cost: number;
}
