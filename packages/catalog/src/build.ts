/**
 * The single Model constructor. Resolution order is a dependency chain, each
 * step materialized exactly once per spec:
 *
 *   1. compat   — URL/provider/id detection resolved into a complete record;
 *   2. thinking — derived from identity + resolved compat (or trusted verbatim
 *                 when the spec carries explicit metadata);
 *
 * Request handlers read fields — they never detect, parse ids, or allocate
 * compat per request.
 */

import { buildAnthropicCompat } from "./compat/anthropic";
import { buildBedrockCompat } from "./compat/bedrock";
import { buildDevinCompat } from "./compat/devin";
import { buildOpenAICompat, buildOpenAIResponsesCompat, buildOpenRouterCompat } from "./compat/openai";
import { bareModelId, parseOpenAIModel, semverGte } from "./identity/classify";
import { isClaudeModelId } from "./identity/family";
import { resolveModelThinking } from "./model-thinking";
import { resolveModelTokenizer } from "./model-tokenizer";
import type { Api, CompatOf, Model, ModelSpec } from "./types";
import { cleanModelName } from "./utils";

function isDirectOpenAIResponsesEndpoint(spec: ModelSpec<Api>): boolean {
	if (spec.api === "openai-responses") {
		if (spec.provider !== "openai") return false;
		if (!spec.baseUrl) return true;
		try {
			const url = new URL(spec.baseUrl);
			return url.protocol === "https:" && url.hostname === "api.openai.com";
		} catch {
			return false;
		}
	}
	if (spec.api !== "azure-openai-responses" || (spec.provider !== "azure" && spec.provider !== "azure-openai")) {
		return false;
	}
	if (!spec.baseUrl) return true;
	try {
		const url = new URL(spec.baseUrl);
		return (
			url.protocol === "https:" &&
			(url.hostname.endsWith(".openai.azure.com") || url.hostname === "models.inference.ai.azure.com")
		);
	} catch {
		return false;
	}
}

function explicitComputerUseConfig(spec: ModelSpec<Api>): boolean | undefined {
	return "supportsComputerUseConfig" in spec
		? (spec as Model<Api>).supportsComputerUseConfig
		: spec.supportsComputerUse;
}

function supportsOpenAIGAComputerUse(spec: ModelSpec<Api>, explicitSupport: boolean | undefined): boolean {
	if (explicitSupport !== undefined) return explicitSupport;
	if (!isDirectOpenAIResponsesEndpoint(spec)) return false;
	const parsed = parseOpenAIModel(bareModelId(spec.requestModelId ?? spec.id));
	return parsed !== null && semverGte(parsed.version, "5.4");
}

/**
 * Build one model from an authored spec. Bundled models.json rows are fully
 * materialized by the generator and consumed directly (see `models.ts`), so
 * this only runs for discovered/custom/override specs.
 */
export function buildModel<TApi extends Api>(spec: ModelSpec<TApi>): Model<TApi> {
	const compat = buildCompat(spec) as CompatOf<TApi>;
	const supportsComputerUseConfig = explicitComputerUseConfig(spec);
	return {
		...spec,
		name: cleanModelName(spec.name),
		requiresGlyphTokenization: isClaudeModelId(spec.id),
		tokenizer: spec.tokenizer ?? resolveModelTokenizer(spec.requestModelId ?? spec.id),
		thinking: resolveModelThinking(spec, compat),
		supportsComputerUse: supportsOpenAIGAComputerUse(spec, supportsComputerUseConfig),
		supportsComputerUseConfig,
		compat,
		compatConfig: spec.compat,
	} as Model<TApi>;
}

export function buildCompat(spec: ModelSpec<Api>): CompatOf<Api> {
	switch (spec.api) {
		case "openrouter":
			return buildOpenRouterCompat(spec as ModelSpec<"openrouter">);
		case "openai-completions":
			return buildOpenAICompat(spec as ModelSpec<"openai-completions">);
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			return buildOpenAIResponsesCompat(spec as ModelSpec<"openai-responses">);
		case "anthropic-messages":
			return buildAnthropicCompat(spec as ModelSpec<"anthropic-messages">);
		case "bedrock-converse-stream":
			return buildBedrockCompat(spec as ModelSpec<"bedrock-converse-stream">);
		case "devin-agent":
			return buildDevinCompat(spec as ModelSpec<"devin-agent">);
		default:
			return undefined;
	}
}
