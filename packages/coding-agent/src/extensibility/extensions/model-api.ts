/**
 * Model query facade exposed to extensions as `ctx.models`.
 *
 * Read-only: lets an extension select a model the same way core does — list
 * authenticated models, read the session model, resolve a model string or role
 * alias, and compare model families — without touching the mutable registry or
 * duplicating resolution/family heuristics.
 *
 * Every model it answers with is a copy taken by what a model is (`handHostModel`), whether the
 * host holds it as a registry row or as a class an SDK caller selected, its `resolveHeaders` the
 * session's call. The registry's rows and the session's model are what the host builds requests
 * from — the credential chosen by `provider`, the endpoint `baseUrl` names — so an edit to a model
 * an extension was handed stays on that copy.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { handHostModel, handSessionFacade, sessionCall } from "./boundary-data";
import type { ExtensionCallbackOwner, ExtensionModelQuery } from "./types";

/**
 * Build the `ctx.models` facade for one session (`owner`). `getModel` is read lazily so `current()`
 * always reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
	owner: ExtensionCallbackOwner,
): ExtensionModelQuery {
	// Each member reads the host — the registry, the session's model getter — as that session's
	// host call: refused once it has gone, and a failure there crosses as a copy.
	const call = sessionCall(owner);
	return handSessionFacade(
		{
			list: () => modelRegistry.getAvailable().map(model => handHostModel(model, call)),
			current: () => {
				const model = getModel();
				return model && handHostModel(model, call);
			},
			// resolveModelRoleValue expands a role alias (`@slow`) to its full configured
			// priority list and tries each pattern — the same path core selection uses — so a
			// fallback model lower in the list still resolves. Plain model strings pass through
			// as a single pattern.
			resolve: (spec: string): Model<Api> | undefined => {
				const model = resolveModelRoleValue(spec, modelRegistry.getAvailable(), {
					settings,
					matchPreferences: getModelMatchPreferences(settings),
				}).model;
				return model && handHostModel(model, call);
			},
			family: (model: Model<Api>): string =>
				model.identity.class === "unknown" ? model.provider.toLowerCase() : model.identity.class,
		},
		owner,
	);
}
