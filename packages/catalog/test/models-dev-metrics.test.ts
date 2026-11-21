import { expect, test } from "bun:test";
import {
	mapModelsDevToModels,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

test("models.dev metrics survive catalog mapping", () => {
	const models = mapModelsDevToModels(
		{
			anthropic: {
				models: {
					"claude-opus-test": {
						id: "claude-opus-test",
						name: "Claude Opus Test",
						tool_call: true,
						int: 63.1,
						tps: 56.6,
					},
				},
			},
		},
		MODELS_DEV_PROVIDER_DESCRIPTORS,
	);

	const model = models.find(candidate => candidate.provider === "anthropic" && candidate.id === "claude-opus-test");
	expect(model?.int).toBe(63.1);
	expect(model?.tps).toBe(56.6);
});
