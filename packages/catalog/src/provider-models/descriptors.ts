/**
 * Runtime model-manager factories for catalog providers. Everything else a
 * provider entry carries — default model, env keys, discovery wiring, seed
 * rows — is authored in `src/compat/rules/providers/<id>.kdl` and read from
 * the compiled entry (`src/compat/providers.ts`); this table holds only the
 * code half. Providers without a factory (`amazon-bedrock`, `azure`,
 * `gitlab-duo`, MiniMax, and the bespoke OAuth-driven managers
 * `google-antigravity` / `google-gemini-cli` / `openai-codex` built by the
 * coding-agent runtime) still have a KDL entry but no runtime discovery here.
 */
import type { KnownProvider } from "../compat/provider-ids";
import { providerEntries, providerEntry } from "../compat/providers";
import type { Api } from "../types";
import type { ModelManagerOptions } from "../model-manager";
import type { ModelManagerConfig, ProviderDescriptor } from "./descriptor-types";
import { googleModelManagerOptions, googleVertexModelManagerOptions } from "./google";
import { ollamaCloudModelManagerOptions } from "./ollama";
import {
	abliterationModelManagerOptions,
	aiandModelManagerOptions,
	aimlApiModelManagerOptions,
	alibabaCodingPlanModelManagerOptions,
	alibabaTokenPlanModelManagerOptions,
	anthropicModelManagerOptions,
	basetenModelManagerOptions,
	bedrockMantleModelManagerOptions,
	cerebrasModelManagerOptions,
	charmHyperModelManagerOptions,
	clinePassModelManagerOptions,
	cloudflareAiGatewayModelManagerOptions,
	commandCodeModelManagerOptions,
	coreWeaveModelManagerOptions,
	deepinfraModelManagerOptions,
	deepseekModelManagerOptions,
	firepassModelManagerOptions,
	fireworksModelManagerOptions,
	githubCopilotModelManagerOptions,
	gmiCloudModelManagerOptions,
	groqModelManagerOptions,
	huggingfaceModelManagerOptions,
	kiloModelManagerOptions,
	kimiCodeModelManagerOptions,
	litellmModelManagerOptions,
	lmStudioModelManagerOptions,
	metaModelManagerOptions,
	museCodeModelManagerOptions,
	mistralModelManagerOptions,
	moonshotModelManagerOptions,
	nanoGptModelManagerOptions,
	novitaModelManagerOptions,
	nvidiaModelManagerOptions,
	ollamaModelManagerOptions,
	openaiModelManagerOptions,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
	openrouterModelManagerOptions,
	qianfanModelManagerOptions,
	qwenPortalModelManagerOptions,
	sakanaModelManagerOptions,
	siliconflowCnModelManagerOptions,
	siliconflowModelManagerOptions,
	singularityApiDevModelManagerOptions,
	singularityApiTechModelManagerOptions,
	syntheticModelManagerOptions,
	togetherModelManagerOptions,
	umansModelManagerOptions,
	veniceModelManagerOptions,
	vercelAiGatewayModelManagerOptions,
	vllmModelManagerOptions,
	waferServerlessModelManagerOptions,
	xaiModelManagerOptions,
	xaiOAuthModelManagerOptions,
	xiaomiModelManagerOptions,
	yoloAutoModelManagerOptions,
	zenmuxModelManagerOptions,
	zhipuCodingPlanModelManagerOptions,
} from "./openai-compat";
import { openzooModelManagerOptions } from "./openzoo";
import {
	cursorModelManagerOptions,
	devinModelManagerOptions,
	gitLabDuoWorkflowModelManagerOptions,
	localModelManagerOptions,
	typesafeModelManagerOptions,
	webModelManagerOptions,
	zaiModelManagerOptions,
} from "./special";

export type { KnownProvider } from "../compat/provider-ids";

type ModelManagerFactory = (config: ModelManagerConfig) => ModelManagerOptions<Api>;

const MODEL_MANAGER_FACTORIES: Readonly<Partial<Record<KnownProvider, ModelManagerFactory>>> = {
	abliteration: config => abliterationModelManagerOptions(config),
	aiand: config => aiandModelManagerOptions(config),
	aimlapi: config => aimlApiModelManagerOptions(config),
	"alibaba-coding-plan": config => alibabaCodingPlanModelManagerOptions(config),
	"alibaba-token-plan": config => alibabaTokenPlanModelManagerOptions(config),
	baseten: config => basetenModelManagerOptions(config),
	"bedrock-mantle": config => bedrockMantleModelManagerOptions(config),
	anthropic: config => anthropicModelManagerOptions(config),
	cerebras: config => cerebrasModelManagerOptions(config),
	"charm-hyper": config => charmHyperModelManagerOptions(config),
	"cloudflare-ai-gateway": config => cloudflareAiGatewayModelManagerOptions(config),
	commandcode: config => commandCodeModelManagerOptions(config),
	cursor: config => cursorModelManagerOptions(config),
	deepinfra: config => deepinfraModelManagerOptions(config),
	deepseek: config => deepseekModelManagerOptions(config),
	devin: config => devinModelManagerOptions(config),
	"cline-pass": config => clinePassModelManagerOptions(config),
	firepass: config => firepassModelManagerOptions(config),
	fireworks: config => fireworksModelManagerOptions(config),
	"github-copilot": config => githubCopilotModelManagerOptions(config),
	"gitlab-duo-agent": config => gitLabDuoWorkflowModelManagerOptions(config),
	"gmi-cloud": config => gmiCloudModelManagerOptions(config),
	google: config => googleModelManagerOptions(config),
	"google-vertex": config => googleVertexModelManagerOptions(config),
	groq: config => groqModelManagerOptions(config),
	huggingface: config => huggingfaceModelManagerOptions(config),
	kilo: config => kiloModelManagerOptions(config),
	"kimi-code": config => kimiCodeModelManagerOptions(config),
	litellm: config => litellmModelManagerOptions(config),
	local: () => localModelManagerOptions(),
	"lm-studio": config => lmStudioModelManagerOptions(config),
	mistral: config => mistralModelManagerOptions(config),
	"muse-code": config => museCodeModelManagerOptions(config),
	meta: config => metaModelManagerOptions(config),
	moonshot: config => moonshotModelManagerOptions(config),
	nanogpt: config => nanoGptModelManagerOptions(config),
	nvidia: config => nvidiaModelManagerOptions(config),
	novita: config => novitaModelManagerOptions(config),
	ollama: config => ollamaModelManagerOptions(config),
	"ollama-cloud": config => ollamaCloudModelManagerOptions(config),
	openai: config => openaiModelManagerOptions(config),
	"opencode-go": config => opencodeGoModelManagerOptions(config),
	"opencode-zen": config => opencodeZenModelManagerOptions(config),
	openrouter: config => openrouterModelManagerOptions(config),
	openzoo: config => openzooModelManagerOptions(config),
	qianfan: config => qianfanModelManagerOptions(config),
	"qwen-portal": config => qwenPortalModelManagerOptions(config),
	sakana: config => sakanaModelManagerOptions(config),
	siliconflow: config => siliconflowModelManagerOptions(config),
	"siliconflow-cn": config => siliconflowCnModelManagerOptions(config),
	"singularityapi-dev": config => singularityApiDevModelManagerOptions(config),
	"singularityapi-tech": config => singularityApiTechModelManagerOptions(config),
	synthetic: config => syntheticModelManagerOptions(config),
	together: config => togetherModelManagerOptions(config),
	typesafe: config => typesafeModelManagerOptions(config),
	umans: config => umansModelManagerOptions(config),
	venice: config => veniceModelManagerOptions(config),
	"vercel-ai-gateway": config => vercelAiGatewayModelManagerOptions(config),
	vllm: config => vllmModelManagerOptions(config),
	"wafer-serverless": config => waferServerlessModelManagerOptions(config),
	web: () => webModelManagerOptions(),
	coreweave: config => coreWeaveModelManagerOptions(config),
	xai: config => xaiModelManagerOptions(config),
	"xai-oauth": config => xaiOAuthModelManagerOptions(config),
	xiaomi: config => xiaomiModelManagerOptions(config),
	"xiaomi-token-plan-ams": config =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" }),
	"xiaomi-token-plan-cn": config =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-cn", tokenPlanRegion: "cn" }),
	"xiaomi-token-plan-sgp": config =>
		xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-sgp", tokenPlanRegion: "sgp" }),
	"yolo-auto": config => yoloAutoModelManagerOptions(config),
	zai: config => zaiModelManagerOptions(config),
	zenmux: config => zenmuxModelManagerOptions(config),
	"zhipu-coding-plan": config => zhipuCodingPlanModelManagerOptions(config),
};

function isKnownProvider(id: string): id is KnownProvider {
	return providerEntry(id) !== undefined;
}

/**
 * Runtime model-discovery descriptors: every catalog provider with a
 * model-manager factory, paired with its compiled KDL entry.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = Object.values(providerEntries()).flatMap(entry => {
	const createModelManagerOptions = isKnownProvider(entry.id) ? MODEL_MANAGER_FACTORIES[entry.id] : undefined;
	if (!createModelManagerOptions) return [];
	const discovery = entry.discovery;
	return [
		{
			providerId: entry.id,
			defaultModel: entry.defaultModel,
			createModelManagerOptions,
			allowUnauthenticated: entry.allowUnauthenticated,
			dynamicModelsAuthoritative: entry.dynamicModelsAuthoritative,
			skipCrossProviderReferenceFills: entry.skipCrossProviderReferenceFills,
			catalogDiscovery: discovery ? { ...discovery, envVars: discovery.envVars ?? entry.envVars ?? [] } : undefined,
		},
	];
});

/** Default model IDs for all known providers, from their KDL entries. */
export const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<KnownProvider, string>> = Object.fromEntries(
	Object.values(providerEntries()).map(entry => [entry.id, entry.defaultModel] as const),
) as Record<KnownProvider, string>;
