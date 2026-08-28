import type { Api, ModelSpec } from "../types";

const BEDROCK_MANTLE_OPENAI_MODEL_IDS: Readonly<Record<string, true>> = {
	"openai.gpt-5.4": true,
	"openai.gpt-5.5": true,
	"openai.gpt-5.6-luna": true,
	"openai.gpt-5.6-sol": true,
	"openai.gpt-5.6-terra": true,
};

/**
 * Remove models.dev rows that OMP cannot route successfully.
 *
 * Generation and runtime refresh share this policy so a live catalog cannot
 * reintroduce selectors deliberately excluded from the bundled catalog.
 */
export function filterModelsDevCatalogRows<TApi extends Api>(models: readonly ModelSpec<TApi>[]): ModelSpec<TApi>[] {
	return models.filter(model => {
		if (model.provider === "amazon-bedrock") {
			// AWS does not document the jp. Opus 5 profile, and the openai.gpt-5.x
			// rows are Mantle-only ids that Bedrock rejects or misroutes.
			return model.id !== "jp.anthropic.claude-opus-5" && !BEDROCK_MANTLE_OPENAI_MODEL_IDS[model.id];
		}
		if (model.provider === "zai") {
			// [1m] is a Claude Code selector convention, not an inference id.
			return !model.id.endsWith("[1m]");
		}
		if (model.provider === "fireworks" || model.provider === "firepass") {
			// Control-plane resource ids are not accepted by the inference API.
			return !model.id.startsWith("accounts/fireworks/");
		}
		if (model.provider === "xiaomi" || model.provider.startsWith("xiaomi-token-plan-")) {
			// Text-chat transports cannot serve Xiaomi's audio-only models.
			return !model.id.includes("-tts") && !model.id.includes("-asr");
		}
		return true;
	});
}
