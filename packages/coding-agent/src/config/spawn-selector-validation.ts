/**
 * Two-phase spawn selector validation.
 *
 * Structural validation runs after settings merge and never probes the network.
 * Semantic validation runs after providers/agents are known and returns one
 * aggregated diagnostic list for unresolved or unauthenticated selectors.
 */

import type {
	AgentAutonomy,
	AgentEditMode,
	AgentPolicyFields,
	AgentTier,
	CollaborationMode,
	WorkClass,
} from "../orchestration/agent-execution-profile";
import { canonicalizeRoleSelector, resolveKnownModelRole, stripKnownThinkingSuffix } from "./model-resolver";
import { MODEL_ROLE_IDS, type ModelRole } from "./model-roles";
import { normalizeAliasKey } from "./subagent-model-aliases";

export type SpawnSelectorDiagnosticCode =
	| "empty-selector"
	| "normalized-collision"
	| "role-shadow-divergence"
	| "malformed-profile"
	| "malformed-pool"
	| "unresolved-selector"
	| "unauthenticated-selector";

export interface SpawnSelectorDiagnostic {
	code: SpawnSelectorDiagnosticCode;
	message: string;
	path?: string;
	selector?: string;
	details?: readonly string[];
}

export interface StructuralSpawnSelectorValidationInput {
	/** User/built-in alias map (`subagent.modelAliases` merged). */
	aliases?: Readonly<Record<string, string>>;
	/** `task.agentPolicies` record. */
	agentPolicies?: Readonly<Record<string, AgentPolicyFields>>;
	/** Additional model pools to structurally validate. */
	modelPools?: Readonly<Record<string, readonly string[]>>;
	/** Known role ids; defaults to built-in {@link MODEL_ROLE_IDS}. */
	knownRoles?: readonly string[];
}

export interface SemanticSelectorStatus {
	selector: string;
	resolved: boolean;
	authenticated: boolean;
	provider?: string;
	modelId?: string;
}

export interface SemanticSpawnSelectorValidationInput {
	/** Active selectors that must resolve after provider registration. */
	selectors: readonly string[];
	/**
	 * Injectable resolver/auth probe. Callers supply registry-backed status;
	 * this module never touches the network.
	 */
	resolveStatus: (selector: string) => SemanticSelectorStatus;
}

const VALID_TIERS = new Set<AgentTier>(["light", "mid", "frontier"]);
const VALID_AUTONOMY = new Set<AgentAutonomy>(["bound", "supervised", "independent"]);
const VALID_COLLABORATION = new Set<CollaborationMode>(["report-only", "message-peers", "self-coordinate"]);
const VALID_WORK_CLASS = new Set<WorkClass>(["mechanical", "judgment"]);
const VALID_EDIT_MODE = new Set<AgentEditMode>(["none", "replace", "hashline", "apply-patch"]);

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validatePolicyFields(path: string, policy: AgentPolicyFields, diagnostics: SpawnSelectorDiagnostic[]): void {
	if (policy.tier !== undefined && !VALID_TIERS.has(policy.tier)) {
		diagnostics.push({
			code: "malformed-profile",
			message: `Invalid tier at ${path}.tier.`,
			path: `${path}.tier`,
		});
	}
	if (policy.autonomy !== undefined && !VALID_AUTONOMY.has(policy.autonomy)) {
		diagnostics.push({
			code: "malformed-profile",
			message: `Invalid autonomy at ${path}.autonomy.`,
			path: `${path}.autonomy`,
		});
	}
	if (policy.collaboration !== undefined && !VALID_COLLABORATION.has(policy.collaboration)) {
		diagnostics.push({
			code: "malformed-profile",
			message: `Invalid collaboration at ${path}.collaboration.`,
			path: `${path}.collaboration`,
		});
	}
	if (policy.workClass !== undefined && !VALID_WORK_CLASS.has(policy.workClass)) {
		diagnostics.push({
			code: "malformed-profile",
			message: `Invalid workClass at ${path}.workClass.`,
			path: `${path}.workClass`,
		});
	}
	if (policy.editMode !== undefined && !VALID_EDIT_MODE.has(policy.editMode)) {
		diagnostics.push({
			code: "malformed-profile",
			message: `Invalid editMode at ${path}.editMode.`,
			path: `${path}.editMode`,
		});
	}
	if (policy.maxRequests !== undefined && !isNonNegativeNumber(policy.maxRequests)) {
		diagnostics.push({
			code: "malformed-profile",
			message: `Invalid maxRequests at ${path}.maxRequests.`,
			path: `${path}.maxRequests`,
		});
	}
	if (policy.maxRuntimeMs !== undefined && !isNonNegativeNumber(policy.maxRuntimeMs)) {
		diagnostics.push({
			code: "malformed-profile",
			message: `Invalid maxRuntimeMs at ${path}.maxRuntimeMs.`,
			path: `${path}.maxRuntimeMs`,
		});
	}
	if (policy.modelPool) {
		for (const [index, selector] of policy.modelPool.entries()) {
			if (typeof selector !== "string" || selector.trim().length === 0) {
				diagnostics.push({
					code: "malformed-pool",
					message: `Empty or invalid modelPool selector at ${path}.modelPool[${index}].`,
					path: `${path}.modelPool[${index}]`,
					selector: typeof selector === "string" ? selector : undefined,
				});
			}
		}
	}
}

function roleShadowTarget(role: ModelRole, value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return true;
	// Compare role bases only — thinking suffixes on the same role are not divergence.
	const valueBase = stripKnownThinkingSuffix(canonicalizeRoleSelector(trimmed));
	const canonicalRole = `pi/${role}`;
	return valueBase !== canonicalRole && valueBase !== role;
}

/**
 * Structural validation after settings merge: empty selectors, normalized
 * alias collisions, role-shadow divergence, and malformed profiles/pools.
 */
export function validateSpawnSelectorsStructural(
	input: StructuralSpawnSelectorValidationInput,
): SpawnSelectorDiagnostic[] {
	const diagnostics: SpawnSelectorDiagnostic[] = [];
	const roleByNormalized = new Map<string, ModelRole>();
	for (const role of input.knownRoles ?? MODEL_ROLE_IDS) {
		roleByNormalized.set(normalizeAliasKey(role), role as ModelRole);
	}
	const aliases = input.aliases ?? {};

	const byNormalized = new Map<string, { key: string; value: string }[]>();
	for (const [key, value] of Object.entries(aliases)) {
		if (!key.trim()) {
			diagnostics.push({
				code: "empty-selector",
				message: "Alias key must be non-empty.",
				path: `aliases[${JSON.stringify(key)}]`,
				selector: key,
			});
			continue;
		}
		if (!value.trim()) {
			diagnostics.push({
				code: "empty-selector",
				message: `Alias "${key}" has an empty target selector.`,
				path: `aliases.${key}`,
				selector: key,
			});
			continue;
		}

		// Strip thinking suffixes from alias keys before normalization/role lookup
		// so `smol:high` participates in the same shadow rules as `smol`.
		const keyBase = stripKnownThinkingSuffix(key);
		const normalized = normalizeAliasKey(keyBase);
		const group = byNormalized.get(normalized) ?? [];
		group.push({ key, value: value.trim() });
		byNormalized.set(normalized, group);

		const shadowedRole = resolveKnownModelRole(keyBase) ?? roleByNormalized.get(normalized);
		if (shadowedRole && roleShadowTarget(shadowedRole, value)) {
			diagnostics.push({
				code: "role-shadow-divergence",
				message: `Alias "${key}" shadows role "${shadowedRole}" with divergent target "${value.trim()}".`,
				path: `aliases.${key}`,
				selector: key,
				details: [value.trim(), `pi/${shadowedRole}`],
			});
		}
	}

	for (const [normalized, group] of byNormalized) {
		if (group.length < 2) continue;
		const targets = new Set(group.map(entry => entry.value));
		if (targets.size <= 1) continue;
		diagnostics.push({
			code: "normalized-collision",
			message: `Normalized alias collision for "${normalized}".`,
			path: "aliases",
			selector: normalized,
			details: group.map(entry => `${entry.key}=${entry.value}`),
		});
	}

	for (const [agentId, policy] of Object.entries(input.agentPolicies ?? {})) {
		if (!agentId.trim()) {
			diagnostics.push({
				code: "malformed-profile",
				message: "Agent policy id must be non-empty.",
				path: `task.agentPolicies[${JSON.stringify(agentId)}]`,
			});
			continue;
		}
		if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
			diagnostics.push({
				code: "malformed-profile",
				message: `Agent policy "${agentId}" must be an object.`,
				path: `task.agentPolicies.${agentId}`,
			});
			continue;
		}
		validatePolicyFields(`task.agentPolicies.${agentId}`, policy, diagnostics);
	}

	for (const [poolName, selectors] of Object.entries(input.modelPools ?? {})) {
		if (!Array.isArray(selectors)) {
			diagnostics.push({
				code: "malformed-pool",
				message: `Model pool "${poolName}" must be an array of selectors.`,
				path: `modelPools.${poolName}`,
			});
			continue;
		}
		for (const [index, selector] of selectors.entries()) {
			if (typeof selector !== "string" || selector.trim().length === 0) {
				diagnostics.push({
					code: "malformed-pool",
					message: `Empty selector in model pool "${poolName}" at index ${index}.`,
					path: `modelPools.${poolName}[${index}]`,
					selector: typeof selector === "string" ? selector : undefined,
				});
			}
		}
	}

	return diagnostics;
}

/**
 * Semantic validation after providers/agents are known. Returns one aggregated
 * list of unresolved or unauthenticated selector diagnostics.
 */
export function validateSpawnSelectorsSemantic(input: SemanticSpawnSelectorValidationInput): SpawnSelectorDiagnostic[] {
	const diagnostics: SpawnSelectorDiagnostic[] = [];

	for (const raw of input.selectors) {
		const selector = raw.trim();
		if (!selector) {
			diagnostics.push({
				code: "empty-selector",
				message: "Selector must be non-empty.",
				selector: raw,
			});
			continue;
		}

		const status = input.resolveStatus(selector);
		if (!status.resolved) {
			diagnostics.push({
				code: "unresolved-selector",
				message: `Required selector "${selector}" could not be resolved.`,
				selector,
			});
			continue;
		}
		if (!status.authenticated) {
			diagnostics.push({
				code: "unauthenticated-selector",
				message: `Required selector "${selector}" resolved but is unauthenticated.`,
				selector,
			});
		}
	}

	return diagnostics;
}
