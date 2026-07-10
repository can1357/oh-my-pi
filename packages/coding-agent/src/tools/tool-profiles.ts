/**
 * Source-aware tool envelopes and grammar selectors for constrained agents.
 *
 * Pure policy only — Lane E wires construction, session activation, and
 * extension/MCP gates around these ceilings.
 */

import type {
	AgentAutonomy,
	AgentEditMode,
	AgentExecutionProfile,
	AgentTier,
} from "../orchestration/agent-execution-profile";
import {
	DEFAULT_AGENT_EXECUTION_PROFILE,
	resolveAgentExecutionProfile,
} from "../orchestration/agent-execution-profile";
import type { EditMode } from "../utils/edit-mode";

export type ToolSource = "builtin" | "mcp" | "extension" | "custom" | "hidden";

export interface ToolCapability {
	source: ToolSource;
	name: string;
}

export interface ResolvedToolProfile {
	readonly maximum: readonly ToolCapability[];
	readonly editMode: AgentEditMode;
	readonly allowDiscovery: boolean;
	readonly tier: AgentTier;
	readonly autonomy: AgentAutonomy;
	/** True when agent/workflow tools were explicitly supplied (including deny-all `[]`). */
	readonly toolsConstrained: boolean;
}

/**
 * Inputs for resolving an immutable tool ceiling.
 *
 * `agentTools` / `workflowTools`:
 * - `undefined` — unrestricted seed (legacy omission)
 * - `[]` — explicit deny-all except classified control tools
 * - non-empty — allow-list of builtin names (source defaults to `"builtin"`)
 */
export interface ToolProfileInput {
	execution?: AgentExecutionProfile;
	tier?: AgentTier;
	autonomy?: AgentAutonomy;
	editMode?: AgentEditMode;
	agentTools?: readonly string[];
	workflowTools?: readonly string[];
	/** Extra capabilities already classified with source identity. */
	declaredCapabilities?: readonly ToolCapability[];
	requireYield?: boolean;
}

export type ReadGrammarTier = "legacy" | "light" | "standard";

export interface ReadGrammarSelection {
	readonly tier: ReadGrammarTier;
	/** Model-facing description fragment describing allowed selectors. */
	readonly selectorGuidance: string;
	readonly allowRemoteUrls: boolean;
	readonly allowInternalUris: boolean;
	readonly allowMultiRange: boolean;
	readonly allowConflicts: boolean;
	readonly allowRaw: boolean;
}

export interface EditGrammarSelection {
	/** `null` means existing-file mutation is disabled for this profile. */
	readonly runtimeMode: EditMode | null;
	readonly agentEditMode: AgentEditMode;
	readonly descriptionKind: "none" | "replace" | "hashline" | "apply-patch";
}

export const CONTROL_BUILTIN_NAMES: ReadonlySet<string> = new Set([
	"yield",
	"resolve",
	"report_tool_issue",
]);

export const LIGHT_BUILTIN_NAMES: ReadonlySet<string> = new Set([
	"read",
	"find",
	"search",
	"yield",
	"resolve",
	"report_tool_issue",
]);

export const MID_BUILTIN_NAMES: ReadonlySet<string> = new Set([
	...LIGHT_BUILTIN_NAMES,
	"edit",
	"write",
	"bash",
	"irc",
	"task",
	"todo",
	"goal",
	"lsp",
	"ast_grep",
	"ask",
	"checkpoint",
	"rewind",
	"recall",
	"retain",
	"reflect",
	"job",
	"search_tool_bm25",
]);

const EDIT_MODE_RANK: Record<AgentEditMode, number> = {
	none: 0,
	replace: 1,
	hashline: 2,
	"apply-patch": 3,
};

function freezeCapabilities(capabilities: readonly ToolCapability[]): readonly ToolCapability[] {
	return Object.freeze(capabilities.map(capability => Object.freeze({ ...capability })));
}

function minEditMode(left: AgentEditMode, right: AgentEditMode): AgentEditMode {
	return EDIT_MODE_RANK[left] <= EDIT_MODE_RANK[right] ? left : right;
}

function tierEditCap(tier: AgentTier): AgentEditMode {
	switch (tier) {
		case "light":
			return "none";
		case "mid":
			return "replace";
		case "frontier":
			return "apply-patch";
	}
}

function autonomyEditCap(autonomy: AgentAutonomy): AgentEditMode {
	switch (autonomy) {
		case "bound":
			return "replace";
		case "supervised":
			return "hashline";
		case "independent":
			return "apply-patch";
	}
}

function isControlCapability(capability: ToolCapability): boolean {
	return capability.source === "builtin" && CONTROL_BUILTIN_NAMES.has(capability.name);
}

function isLightAllowed(capability: ToolCapability): boolean {
	if (isControlCapability(capability)) return true;
	return capability.source === "builtin" && LIGHT_BUILTIN_NAMES.has(capability.name);
}

function isMidAllowed(capability: ToolCapability): boolean {
	if (isControlCapability(capability)) return true;
	if (capability.source !== "builtin") return false;
	return MID_BUILTIN_NAMES.has(capability.name);
}

function isFrontierAllowed(capability: ToolCapability, autonomy: AgentAutonomy): boolean {
	if (isControlCapability(capability)) return true;
	if (autonomy === "bound") {
		return capability.source === "builtin";
	}
	if (autonomy === "supervised") {
		return capability.source === "builtin" || capability.source === "mcp";
	}
	return true;
}

function tierAllowsCapability(
	tier: AgentTier,
	autonomy: AgentAutonomy,
	capability: ToolCapability,
): boolean {
	switch (tier) {
		case "light":
			return isLightAllowed(capability);
		case "mid":
			return isMidAllowed(capability);
		case "frontier":
			return isFrontierAllowed(capability, autonomy);
	}
}

function autonomyAllowsDiscovery(tier: AgentTier, autonomy: AgentAutonomy): boolean {
	if (tier === "light") return false;
	if (autonomy === "bound") return false;
	return true;
}

function normalizeNameList(names: readonly string[] | undefined): readonly string[] | undefined {
	if (names === undefined) return undefined;
	return Object.freeze([...new Set(names.map(name => name.trim().toLowerCase()).filter(Boolean))]);
}

function capabilitiesFromBuiltinNames(names: readonly string[]): ToolCapability[] {
	return names.map(name => ({ source: "builtin" as const, name }));
}

/**
 * Resolve the immutable source-aware tool ceiling.
 *
 * Effective maximum = model-tier maximum ∩ agent/workflow tool lists ∩
 * autonomy cap ∩ edit-mode policy. Tier never grants autonomy.
 */
export function resolveToolProfile(input: ToolProfileInput = {}): ResolvedToolProfile {
	const execution =
		input.execution ??
		resolveAgentExecutionProfile({
			override: {
				tier: input.tier,
				autonomy: input.autonomy,
				editMode: input.editMode,
			},
		});

	const tier = input.tier ?? execution.tier;
	const autonomy = input.autonomy ?? execution.autonomy;
	const requestedEditMode = input.editMode ?? execution.editMode;
	const editMode = minEditMode(
		minEditMode(requestedEditMode, tierEditCap(tier)),
		autonomyEditCap(autonomy),
	);

	const agentTools = normalizeNameList(input.agentTools);
	const workflowTools = normalizeNameList(input.workflowTools);
	const toolsConstrained = agentTools !== undefined || workflowTools !== undefined;

	let allowNames: Set<string> | undefined;
	if (agentTools !== undefined && workflowTools !== undefined) {
		allowNames = new Set(agentTools.filter(name => workflowTools.includes(name)));
	} else if (agentTools !== undefined) {
		allowNames = new Set(agentTools);
	} else if (workflowTools !== undefined) {
		allowNames = new Set(workflowTools);
	}

	if (input.requireYield !== false && allowNames) {
		allowNames.add("yield");
	}

	const seed: ToolCapability[] = [];
	if (input.declaredCapabilities) {
		seed.push(...input.declaredCapabilities);
	} else if (allowNames) {
		seed.push(...capabilitiesFromBuiltinNames([...allowNames]));
	} else {
		const catalog =
			tier === "light"
				? LIGHT_BUILTIN_NAMES
				: tier === "mid"
					? MID_BUILTIN_NAMES
					: new Set([
							...MID_BUILTIN_NAMES,
							"eval",
							"browser",
							"web_search",
							"github",
							"debug",
							"ast_edit",
							"image_gen",
							"ssh",
							"search_tool_bm25",
							"manage_skill",
							"learn",
							"report_finding",
						]);
		seed.push(...capabilitiesFromBuiltinNames([...catalog]));
		if (autonomy !== "bound" && tier !== "light") {
			seed.push({ source: "mcp", name: "*" });
			if (autonomy === "independent" && tier === "frontier") {
				seed.push({ source: "extension", name: "*" });
				seed.push({ source: "custom", name: "*" });
				seed.push({ source: "hidden", name: "*" });
			}
		}
	}

	const maximum = freezeCapabilities(
		seed.filter(capability => {
			if (!tierAllowsCapability(tier, autonomy, capability)) return false;
			if (
				allowNames &&
				capability.name !== "*" &&
				!allowNames.has(capability.name) &&
				!isControlCapability(capability)
			) {
				return false;
			}
			if (capability.name === "edit" && editMode === "none") return false;
			if (capability.name === "search_tool_bm25" && !autonomyAllowsDiscovery(tier, autonomy)) {
				return false;
			}
			return true;
		}),
	);

	const allowDiscovery =
		autonomyAllowsDiscovery(tier, autonomy) &&
		maximum.some(cap => cap.name === "search_tool_bm25" || (cap.source === "builtin" && cap.name === "*") || cap.name === "*");

	return Object.freeze({
		maximum,
		editMode,
		allowDiscovery,
		tier,
		autonomy,
		toolsConstrained,
	});
}

export function isToolCapabilityAllowed(
	profile: ResolvedToolProfile,
	capability: ToolCapability,
): boolean {
	for (const allowed of profile.maximum) {
		if (allowed.source !== capability.source) continue;
		if (allowed.name === "*" || allowed.name === capability.name) return true;
	}
	return false;
}

export function filterToolCapabilities(
	profile: ResolvedToolProfile,
	candidates: readonly ToolCapability[],
): ToolCapability[] {
	return candidates.filter(candidate => isToolCapabilityAllowed(profile, candidate));
}

/** Filter automatic/restored/forced tool names through the profile ceiling. */
export function filterAutoToolNames(
	profile: ResolvedToolProfile,
	names: readonly string[],
	source: ToolSource = "builtin",
): string[] {
	return names.filter(name =>
		isToolCapabilityAllowed(profile, { source, name: name.toLowerCase() }),
	);
}

export function selectReadGrammar(profile?: ResolvedToolProfile | null): ReadGrammarSelection {
	if (!profile) {
		return Object.freeze({
			tier: "legacy",
			selectorGuidance:
				"Local paths, internal URIs, and URLs; append :<sel> for line ranges, raw mode, multi-range, or :conflicts.",
			allowRemoteUrls: true,
			allowInternalUris: true,
			allowMultiRange: true,
			allowConflicts: true,
			allowRaw: true,
		});
	}

	if (profile.tier === "light") {
		return Object.freeze({
			tier: "light",
			selectorGuidance:
				"Local workspace paths only. Allowed selectors: omitted (start of file), :N, :N-M, :N+L. No URLs, internal URIs, :raw, multi-range, or :conflicts.",
			allowRemoteUrls: false,
			allowInternalUris: false,
			allowMultiRange: false,
			allowConflicts: false,
			allowRaw: false,
		});
	}

	return Object.freeze({
		tier: "standard",
		selectorGuidance:
			"Local paths, internal URIs, and URLs; append :<sel> for line ranges, raw mode, multi-range, or :conflicts.",
		allowRemoteUrls: true,
		allowInternalUris: true,
		allowMultiRange: true,
		allowConflicts: true,
		allowRaw: true,
	});
}

export function agentEditModeToRuntime(mode: AgentEditMode): EditMode | null {
	switch (mode) {
		case "none":
			return null;
		case "replace":
			return "replace";
		case "hashline":
			return "hashline";
		case "apply-patch":
			return "apply_patch";
	}
}

export function selectEditGrammar(profile?: ResolvedToolProfile | null): EditGrammarSelection {
	if (!profile) {
		return Object.freeze({
			runtimeMode: null,
			agentEditMode: DEFAULT_AGENT_EXECUTION_PROFILE.editMode,
			descriptionKind: "hashline" as const,
		});
	}

	const runtimeMode = agentEditModeToRuntime(profile.editMode);
	const descriptionKind =
		profile.editMode === "none"
			? ("none" as const)
			: profile.editMode === "replace"
				? ("replace" as const)
				: profile.editMode === "hashline"
					? ("hashline" as const)
					: ("apply-patch" as const);

	return Object.freeze({
		runtimeMode,
		agentEditMode: profile.editMode,
		descriptionKind,
	});
}

/**
 * Map a profile onto the edit tool's runtime mode. When `profile` is absent,
 * returns `undefined` so callers keep legacy session/settings resolution.
 */
export function resolveProfileEditRuntimeMode(
	profile?: ResolvedToolProfile | null,
): EditMode | undefined {
	if (!profile) return undefined;
	return selectEditGrammar(profile).runtimeMode ?? undefined;
}

export function createCapabilityPredicate(
	profile: ResolvedToolProfile,
): (capability: ToolCapability) => boolean {
	return capability => isToolCapabilityAllowed(profile, capability);
}
