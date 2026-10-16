/**
 * A cached OpenZoo row with `supportsTools: false` is the `existing` model
 * `mergeDiscoveredModel` sees on the next `/models` refresh. That merge keeps
 * `model.supportsTools ?? existing.supportsTools`, so a refresh that leaves
 * the field unset stays tool-disabled for the rest of the process. An
 * explicit `tools` advertisement must come back `true` and clear the cache;
 * a row that omits the parameter list must stay neutral and leave the
 * cached no in place.
 */
import { expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { openzooModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openzoo";
import { mergeDiscoveredModel } from "@oh-my-pi/pi-coding-agent/config/model-registry";

async function discoverOpenzoo(
	supportedParameters: readonly string[] | undefined,
): Promise<Model<"openai-completions">> {
	const options = openzooModelManagerOptions({
		fetch: async () =>
			Response.json({
				data: [
					{
						id: "example-lab/now-tools",
						owned_by: "openrouter",
						...(supportedParameters !== undefined ? { supported_parameters: supportedParameters } : {}),
					},
				],
			}),
	});
	const models = await options.fetchDynamicModels?.();
	const spec = models?.[0];
	if (spec === undefined) {
		throw new Error("OpenZoo discovery returned no model");
	}
	return buildModel(spec);
}

test("an explicit tools advertisement clears a cached supportsTools false", async () => {
	const stale = await discoverOpenzoo(["temperature"]);
	expect(stale.supportsTools).toBe(false);

	const refreshed = await discoverOpenzoo(["tools", "temperature"]);
	expect(mergeDiscoveredModel(refreshed, stale).supportsTools).toBe(true);

	const silent = await discoverOpenzoo(undefined);
	expect(mergeDiscoveredModel(silent, stale).supportsTools).toBe(false);
});
