import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { minimumSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting } from "../config/model-resolver";
import { assertModelSupportsEffortCeiling, modelSupportsEffortCeiling } from "../thinking/levels";
import type { ConfiguredThinkingLevel } from "../utils/render-utils";
import type { ExplicitBuildModel, RevivedModels } from "./executor";
import { PerCallModelError, PerCallModelUnavailableError } from "./model-approval";

/** The message of an effort ceiling `model` cannot run at or below: the spawn's own, which names both. */
function ceilingMiss(model: Model, ceiling: Effort): string {
	try {
		assertModelSupportsEffortCeiling(model, ceiling);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

/**
 * Why `model`, which `identity` resolved to, cannot start a revive: the registry does not serve it, its provider has
 * no credential, or it cannot run at or below `ceiling`. Undefined where it can.
 */
export function unusableModelReason(
	models: RevivedModels,
	modelRegistry: ModelRegistry,
	identity: string,
	model: Model | undefined,
	ceiling: Effort | undefined,
): string | undefined {
	if (!model) return models.notFoundMessage(identity);
	if (!modelRegistry.hasConfiguredAuth(model)) return `Model "${identity}" has no credential`;
	if (ceiling && !modelSupportsEffortCeiling(model, ceiling)) return ceilingMiss(model, ceiling);
	return undefined;
}

/** A cold revive's model, and the notice its session records where that model runs above the effort ceiling. */
export interface ColdReviveModelChoice {
	model: ExplicitBuildModel;
	/** Set where neither the stored model nor the parent's can run at or below the ceiling: the text of the notice. */
	ceilingNotice?: string;
}

/**
 * The model a cold revive starts on: the stored model where {@link unusableModelReason} finds none. Else the live
 * parent's model (`fallback`), with one warning that names the cause and both models. A spawn that held its named
 * model (`mayUseParent` false) is refused. A parent model that cannot run at or below the ceiling either still
 * revives the subagent, which stays resumable: at that model's lowest effort, with a `ceilingNotice` that names both
 * models and the ceiling.
 */
export async function chooseColdReviveModel(args: {
	id: string;
	identity: string | null;
	level: ConfiguredThinkingLevel | undefined;
	models: RevivedModels;
	modelRegistry: ModelRegistry;
	ceiling: Effort | undefined;
	fallback: Model | undefined;
	mayUseParent: boolean;
}): Promise<ColdReviveModelChoice> {
	const { id, identity, fallback, ceiling } = args;
	if (identity === null) return { model: { kind: "model", model: undefined, thinkingLevel: args.level } };
	const known = await args.models.resolve(identity);
	const reason = unusableModelReason(args.models, args.modelRegistry, identity, known, ceiling);
	if (reason === undefined) return { model: { kind: "model", model: known, thinkingLevel: args.level } };
	if (!args.mayUseParent) {
		throw new Error(
			`Cannot revive subagent "${id}": ${reason}, and its spawn holds it to that model. The agent was not revived.`,
		);
	}
	const modelName = fallback ? formatModelStringWithRouting(fallback) : undefined;
	if (fallback && ceiling && !modelSupportsEffortCeiling(fallback, ceiling)) {
		const lowest = minimumSupportedEffort(fallback);
		const ceilingNotice = `${reason}, and ${ceilingMiss(fallback, ceiling)}: subagent "${id}" runs on ${modelName} at its lowest effort, ${lowest}, above that ceiling.`;
		logger.warn(ceilingNotice, { subagent: id, model: modelName });
		return { model: { kind: "model", model: fallback, thinkingLevel: lowest }, ceilingNotice };
	}
	logger.warn(reason, { subagent: id, model: modelName });
	return { model: { kind: "model", model: fallback, thinkingLevel: args.level } };
}

/**
 * The model a per-call worker resumes on: its saved model where the registry serves it, its provider has a
 * credential, `approve` (the grants as they are now) passes it and it can run at or below `ceiling`. A saved model
 * that fails any check but the grants falls back to the live parent's model (`fallback`), held to the same grants
 * and ceiling, with one warning that names the cause and both models, unless the spawn held its named model
 * (`mayUseParent` false). A grant refusal of the saved model holds, as does any refusal of the parent's model: the
 * worker is then refused.
 */
export async function choosePerCallModel(args: {
	id: string;
	identity: string;
	level: ConfiguredThinkingLevel | undefined;
	models: RevivedModels;
	modelRegistry: ModelRegistry;
	approve: (model: Model) => void;
	ceiling: Effort | undefined;
	fallback: Model | undefined;
	mayUseParent: boolean;
}): Promise<ExplicitBuildModel> {
	const { id, identity, models, modelRegistry, approve, ceiling } = args;
	// Discovery a spawn started may still add the saved model.
	await modelRegistry.awaitBackgroundRefresh();
	const saved = await models.resolve(identity);
	let reason = unusableModelReason(models, modelRegistry, identity, saved, undefined);
	if (saved && reason === undefined) {
		try {
			approve(saved);
			reason = unusableModelReason(models, modelRegistry, identity, saved, ceiling);
			if (reason === undefined) return { kind: "model", model: saved, thinkingLevel: args.level };
		} catch (error) {
			// A grant refusal holds; a model the registry no longer serves falls back.
			if (!(error instanceof PerCallModelUnavailableError)) throw error;
			reason = error.message;
		}
	}
	const fallback = args.mayUseParent ? args.fallback : undefined;
	if (!fallback) throw new PerCallModelError(`Cannot revive subagent "${id}": ${reason}. The agent was not revived.`);
	approve(fallback);
	if (ceiling) assertModelSupportsEffortCeiling(fallback, ceiling);
	logger.warn(reason ?? models.notFoundMessage(identity), {
		subagent: id,
		model: formatModelStringWithRouting(fallback),
	});
	return { kind: "model", model: fallback, thinkingLevel: args.level };
}
