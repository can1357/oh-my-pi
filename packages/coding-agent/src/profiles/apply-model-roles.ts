import type { Model } from "@oh-my-pi/pi-ai";
import { resolveBudgetReserveTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getModelMatchPreferences, resolveModelRoleValue, type SessionModelRoleLookup } from "../config/model-resolver";
import { getRoleInfo, roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { cfgCompaction } from "../session/context-settings";
import { sessionModelRoleLookup } from "../session/role-models";
import type { ModelRoleAssignments } from "./types";

export interface ApplySetupModelRolesOptions {
	session: AgentSession;
	settings: Settings;
	roles: ModelRoleAssignments;
	signal?: AbortSignal;
	getBlockReason: () => string | undefined;
}

interface DefaultSelection {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

function assertReady(options: ApplySetupModelRolesOptions): void {
	if (options.signal?.aborted) throw new DOMException("Profile application cancelled", "AbortError");
	const reason = options.getBlockReason();
	if (reason) throw new Error(reason);
}

function assertRoleName(role: string): void {
	if (!role.trim() || role === "__proto__" || role === "constructor" || role === "prototype") {
		throw new Error("Profile contains an invalid model role name");
	}
}

function unresolvedRoleError(role: string): Error {
	return new Error(
		`Model role ${JSON.stringify(role)} is not available in the current session. Choose an available model or load the profile in a new session.`,
	);
}

function invalidRoleError(role: string): Error {
	return new Error(
		`Model role ${JSON.stringify(role)} has an invalid selector. Correct the profile or load it in a new session.`,
	);
}

function selectionsEqual(left: DefaultSelection, right: DefaultSelection): boolean {
	return (
		modelsAreEqual(left.model, right.model) &&
		left.explicitThinkingLevel === right.explicitThinkingLevel &&
		left.thinkingLevel === right.thinkingLevel
	);
}

/** The effective default of `settings`; an Automatic default keeps the active model. */
function resolveDefaultSelection(
	activeModel: Model,
	availableModels: Model[],
	settings: Settings,
	roleLookup: SessionModelRoleLookup,
): DefaultSelection | undefined {
	const selector = settings.getModelRole("default");
	if (!selector) return { model: activeModel, explicitThinkingLevel: false };
	const resolved = resolveModelRoleValue(selector, availableModels, {
		settings,
		roleLookup,
		matchPreferences: getModelMatchPreferences(settings),
	});
	return resolved.model
		? {
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			}
		: undefined;
}

function assertContextFits(options: ApplySetupModelRolesOptions, target: Model): void {
	const contextWindow = target.contextWindow ?? 0;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
	const context = options.session.getContextUsage({ contextWindow });
	if (!context) return;
	const reserve = resolveBudgetReserveTokens(contextWindow, cfgCompaction.get(options.settings));
	if (context.tokens <= Math.max(0, contextWindow - reserve)) return;
	throw new Error(
		`The current conversation does not fit ${target.provider}/${target.id}. Compact this conversation first, or load the profile in a new session.`,
	);
}

async function restoreSessionModel(
	session: AgentSession,
	model: Model,
	thinkingLevel: ConfiguredThinkingLevel | undefined,
): Promise<void> {
	if (!modelsAreEqual(session.model, model)) {
		await session.setModelTemporary(model, thinkingLevel);
	}
	if (session.configuredThinkingLevel() !== thinkingLevel) {
		session.setThinkingLevel(thinkingLevel);
	}
}

function applicationFailure(error: unknown, restoreError: unknown, session: AgentSession): AggregateError {
	const active = session.model ? `${session.model.provider}/${session.model.id}` : "no model";
	return new AggregateError(
		[error, restoreError],
		`Applying the profile failed and the previous model state could not be restored. The active model is ${active}.`,
	);
}

/**
 * Apply only a saved setup's model roles to the live conversation. The roles
 * replace the setup layer's model roles; settings a previously loaded setup
 * supplied keep applying.
 */
export async function applySetupModelRoles(options: ApplySetupModelRolesOptions): Promise<void> {
	assertReady(options);
	const previousModel = options.session.model;
	if (!previousModel) {
		throw new Error("The current session has no active model. Load the profile in a new session.");
	}
	for (const role of Object.keys(options.roles)) assertRoleName(role);
	const previousThinkingLevel = options.session.configuredThinkingLevel();
	const availableModels = options.session.getAvailableModels();
	let availableModelsOfAllKinds: Model[] | undefined;
	// Validate against, select from, and commit the same setup, so runtime overrides and roles the
	// outgoing setup supplied rank exactly as they will once it applies.
	const config = { ...options.settings.getSetupLayer(), modelRoles: options.roles };
	const proposed = options.settings.previewSetup(config);
	const proposedLookup = sessionModelRoleLookup(proposed, previousModel);
	const matchPreferences = getModelMatchPreferences(proposed);
	for (const [role, selector] of Object.entries(options.roles)) {
		if (selector === null) continue;
		if (!selector.trim()) throw invalidRoleError(role);
		const roleModels =
			role === "default" ? availableModels : roleCandidatePool(role, proposed, options.session.modelRegistry);
		const resolved = resolveModelRoleValue(selector, roleModels, {
			settings: proposed,
			roleLookup: proposedLookup,
			matchPreferences,
		});
		if (resolved.warning) throw invalidRoleError(role);
		if (!resolved.model) {
			availableModelsOfAllKinds ??= options.session.modelRegistry.getAvailable("all");
			const unrestricted = resolveModelRoleValue(selector, availableModelsOfAllKinds, {
				settings: proposed,
				roleLookup: proposedLookup,
				matchPreferences,
			});
			if (unrestricted.model && !getRoleInfo(role, proposed).accepts(unrestricted.model)) {
				throw invalidRoleError(role);
			}
			throw unresolvedRoleError(role);
		}
		if (!options.session.modelRegistry.hasConfiguredAuth(resolved.model)) throw unresolvedRoleError(role);
	}

	const currentDefault = resolveDefaultSelection(
		previousModel,
		availableModels,
		options.settings,
		sessionModelRoleLookup(options.settings, previousModel),
	);
	let proposedDefault = resolveDefaultSelection(previousModel, availableModels, proposed, proposedLookup);
	const defaultExplicitlyReplaced = Object.hasOwn(options.roles, "default");
	const defaultChanged =
		defaultExplicitlyReplaced ||
		(currentDefault === undefined
			? proposedDefault !== undefined
			: proposedDefault === undefined || !selectionsEqual(currentDefault, proposedDefault));
	if (!defaultChanged) {
		proposedDefault = { model: previousModel, explicitThinkingLevel: false };
	} else if (!proposedDefault) {
		throw unresolvedRoleError("default");
	}

	const target = proposedDefault.model;
	if (!options.session.modelRegistry.hasConfiguredAuth(target)) throw unresolvedRoleError("default");
	if (!modelsAreEqual(previousModel, target)) assertContextFits(options, target);
	assertReady(options);

	let sessionMutated = false;
	try {
		if (!modelsAreEqual(previousModel, target)) {
			sessionMutated = true;
			await options.session.setModelTemporary(
				target,
				proposedDefault.explicitThinkingLevel ? proposedDefault.thinkingLevel : undefined,
			);
			assertReady(options);
		} else if (
			proposedDefault.explicitThinkingLevel &&
			options.session.configuredThinkingLevel() !== proposedDefault.thinkingLevel
		) {
			sessionMutated = true;
			options.session.setThinkingLevel(proposedDefault.thinkingLevel);
		}
		assertReady(options);
		options.settings.applySetupLayer(config);
	} catch (error) {
		const stateChanged =
			sessionMutated ||
			!modelsAreEqual(options.session.model, previousModel) ||
			options.session.configuredThinkingLevel() !== previousThinkingLevel;
		if (!stateChanged) throw error;
		try {
			await restoreSessionModel(options.session, previousModel, previousThinkingLevel);
		} catch (restoreError) {
			throw applicationFailure(error, restoreError, options.session);
		}
		throw error;
	}
}
