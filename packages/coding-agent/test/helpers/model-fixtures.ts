import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { type Model, modelKind } from "@oh-my-pi/pi-catalog/types";

/** Select a bundled chat model by behavior so tests survive catalog roster changes. */
export function getTestModel(provider: GeneratedProvider, matches?: (model: Model) => boolean): Model {
	const model = getBundledModels(provider).find(
		candidate => modelKind(candidate) === "chat" && (matches === undefined || matches(candidate)),
	);
	if (!model) throw new Error(`No bundled chat model matches the ${provider} test fixture`);
	return model;
}
