/**
 * The provider catalog table: one entry per chat-model provider, carrying the
 * catalog half of what used to live in `@oh-my-pi/pi-ai`'s registry definitions
 * (default model, runtime model-manager factory, discovery wiring). The auth
 * half (env keys, OAuth login/refresh) stays in the pi-ai registry, which
 * type-checks itself against `KnownProvider` from this table.
 */
import type { ModelManagerConfig, ProviderCatalogEntry, ProviderDescriptor } from "./descriptor-types";
import { googleModelManagerOptions, googleVertexModelManagerOptions } from "./google";
import { ollamaCloudModelManagerOptions } from "./ollama";
import {
	aiandModelManagerOptions,
	aimlApiModelManagerOptions,
	alibabaCodingPlanModelManagerOptions,
	alibabaTokenPlanModelManagerOptions,
	anthropicModelManagerOptions,
	basetenModelManagerOptions,
	bedrockMantleModelManagerOptions,
	cerebrasModelManagerOptions,
	cloudflareAiGatewayModelManagerOptions,
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
import {
	cursorModelManagerOptions,
	devinModelManagerOptions,
	gitLabDuoWorkflowModelManagerOptions,
	zaiModelManagerOptions,
} from "./special";

export const CATALOG_PROVIDERS = [
	{
		id: "aiand",
		defaultModel: "moonshotai/kimi-k2.7-code",
		envVars: ["AIAND_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => aiandModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "ai&" },
	},
	{
		id: "aimlapi",
		defaultModel: "gpt-5.5-2026-04-23",
		envVars: ["AIMLAPI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => aimlApiModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "AIML API" },
	},
	{
		id: "alibaba-coding-plan",
		defaultModel: "qwen3.7-plus",
		envVars: ["ALIBABA_CODING_PLAN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => alibabaCodingPlanModelManagerOptions(config),
		catalogDiscovery: { label: "Alibaba Coding Plan" },
	},
	{
		id: "alibaba-token-plan",
		defaultModel: "qwen3.7-plus",
		envVars: ["ALIBABA_TOKEN_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => alibabaTokenPlanModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "QwenCloud Token Plan" },
	},
	{
		id: "baseten",
		defaultModel: "moonshotai/Kimi-K2.7-Code",
		envVars: ["BASETEN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => basetenModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Baseten" },
	},
	{
		id: "amazon-bedrock",
		defaultModel: "us.anthropic.claude-opus-4-8",
	},
	{
		id: "bedrock-mantle",
		defaultModel: "openai.gpt-5.6-terra",
		envVars: ["AWS_BEARER_TOKEN_BEDROCK"],
		createModelManagerOptions: (config: ModelManagerConfig) => bedrockMantleModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
	},
	{
		id: "anthropic",
		defaultModel: "claude-opus-4-8",
		envVars: ["ANTHROPIC_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => anthropicModelManagerOptions(config),
		catalogDiscovery: { label: "Anthropic" },
	},
	{
		id: "azure",
		defaultModel: "gpt-5.5",
		envVars: ["AZURE_OPENAI_API_KEY"],
	},
	{
		id: "cerebras",
		defaultModel: "zai-glm-4.7",
		envVars: ["CEREBRAS_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => cerebrasModelManagerOptions(config),
		catalogDiscovery: { label: "Cerebras" },
	},
	{
		id: "cloudflare-ai-gateway",
		defaultModel: "anthropic/claude-opus-4-8",
		envVars: ["CLOUDFLARE_AI_GATEWAY_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => cloudflareAiGatewayModelManagerOptions(config),
		catalogDiscovery: { label: "Cloudflare AI Gateway" },
	},
	{
		id: "cursor",
		defaultModel: "claude-4.6-opus-high",
		envVars: ["CURSOR_ACCESS_TOKEN"],
		createModelManagerOptions: (config: ModelManagerConfig) => cursorModelManagerOptions(config),
		catalogDiscovery: { label: "Cursor", envVars: ["CURSOR_API_KEY"], oauthProvider: "cursor" },
	},
	{
		id: "deepinfra",
		defaultModel: "deepseek-ai/DeepSeek-V4-Flash-0731",
		envVars: ["DEEPINFRA_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => deepinfraModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "DeepInfra", allowUnauthenticated: true },
	},
	{
		id: "deepseek",
		defaultModel: "deepseek-v4-pro",
		envVars: ["DEEPSEEK_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => deepseekModelManagerOptions(config),
		catalogDiscovery: { label: "DeepSeek" },
	},
	{
		id: "devin",
		defaultModel: "swe-1-6",
		envVars: ["DEVIN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => devinModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Devin", envVars: ["DEVIN_API_KEY"], oauthProvider: "devin" },
	},
	{
		id: "firepass",
		defaultModel: "kimi-k2.6-turbo",
		envVars: ["FIREPASS_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => firepassModelManagerOptions(config),
	},
	{
		id: "fireworks",
		defaultModel: "kimi-k2.7-code",
		envVars: ["FIREWORKS_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => fireworksModelManagerOptions(config),
		catalogDiscovery: { label: "Fireworks" },
	},
	{
		id: "github-copilot",
		defaultModel: "gpt-5.5",
		envVars: ["COPILOT_GITHUB_TOKEN"],
		createModelManagerOptions: (config: ModelManagerConfig) => githubCopilotModelManagerOptions(config),
	},
	{
		id: "gitlab-duo",
		defaultModel: "duo-chat-opus-4-6",
		envVars: ["GITLAB_TOKEN"],
	},
	{
		id: "gitlab-duo-agent",
		defaultModel: "claude_sonnet_4_6_vertex",
		envVars: ["GITLAB_TOKEN"],
		createModelManagerOptions: (config: ModelManagerConfig) => gitLabDuoWorkflowModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
	},
	{
		id: "gmi-cloud",
		defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
		envVars: ["GMI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => gmiCloudModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "GMI Cloud" },
	},
	{
		id: "google",
		defaultModel: "gemini-3.1-pro-preview",
		envVars: ["GEMINI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => googleModelManagerOptions(config),
	},
	{
		id: "google-antigravity",
		defaultModel: "gemini-3.1-pro",
		specialModelManager: true,
	},
	{
		id: "google-gemini-cli",
		defaultModel: "gemini-3.1-pro-preview",
		specialModelManager: true,
	},
	{
		id: "google-vertex",
		defaultModel: "gemini-3.1-pro-preview",
		createModelManagerOptions: (config: ModelManagerConfig) => googleVertexModelManagerOptions(config),
		allowUnauthenticated: true,
	},
	{
		id: "groq",
		defaultModel: "openai/gpt-oss-120b",
		envVars: ["GROQ_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => groqModelManagerOptions(config),
	},
	{
		id: "huggingface",
		defaultModel: "deepseek-ai/DeepSeek-R1",
		envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"],
		createModelManagerOptions: (config: ModelManagerConfig) => huggingfaceModelManagerOptions(config),
		catalogDiscovery: { label: "Hugging Face" },
	},
	{
		id: "kilo",
		defaultModel: "anthropic/claude-opus-4.8",
		envVars: ["KILO_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => kiloModelManagerOptions(config),
		catalogDiscovery: { label: "Kilo Gateway", allowUnauthenticated: true },
	},
	{
		id: "kimi-code",
		defaultModel: "kimi-for-coding",
		createModelManagerOptions: (config: ModelManagerConfig) => kimiCodeModelManagerOptions(config),
		catalogDiscovery: { label: "Kimi Code", envVars: ["KIMI_API_KEY"] },
	},
	{
		id: "litellm",
		defaultModel: "claude-opus-4-8",
		envVars: ["LITELLM_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => litellmModelManagerOptions(config),
		catalogDiscovery: { label: "LiteLLM", allowUnauthenticated: true },
	},
	{
		id: "lm-studio",
		defaultModel: "llama-3-8b",
		envVars: ["LM_STUDIO_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => lmStudioModelManagerOptions(config),
		allowUnauthenticated: true,
	},
	{
		id: "minimax",
		defaultModel: "MiniMax-M3",
		envVars: ["MINIMAX_API_KEY"],
	},
	{
		id: "minimax-code",
		defaultModel: "MiniMax-M3",
		envVars: ["MINIMAX_CODE_API_KEY"],
	},
	{
		id: "minimax-code-cn",
		defaultModel: "MiniMax-M3",
		envVars: ["MINIMAX_CODE_CN_API_KEY"],
	},
	{
		id: "mistral",
		defaultModel: "devstral-medium-latest",
		envVars: ["MISTRAL_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => mistralModelManagerOptions(config),
	},
	{
		id: "meta",
		defaultModel: "muse-spark-1.1",
		envVars: ["MODEL_API_KEY", "META_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => metaModelManagerOptions(config),
		catalogDiscovery: { label: "Meta Model API" },
	},
	{
		id: "moonshot",
		defaultModel: "kimi-k2.7-code",
		// KIMI_API_KEY is the most intuitive name for a Kimi/Moonshot key; accept it
		// as a fallback so China users need not learn MOONSHOT_API_KEY. (#2883)
		envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => moonshotModelManagerOptions(config),
		catalogDiscovery: { label: "Moonshot" },
	},
	{
		id: "nanogpt",
		defaultModel: "openai/gpt-5.5",
		envVars: ["NANO_GPT_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => nanoGptModelManagerOptions(config),
		catalogDiscovery: { label: "NanoGPT" },
	},
	{
		id: "nvidia",
		defaultModel: "nvidia/llama-3.1-nemotron-70b-instruct",
		envVars: ["NVIDIA_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => nvidiaModelManagerOptions(config),
		catalogDiscovery: { label: "NVIDIA" },
	},
	{
		id: "novita",
		defaultModel: "moonshotai/kimi-k2.7-code",
		envVars: ["NOVITA_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => novitaModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Novita", allowUnauthenticated: true },
	},
	{
		id: "ollama",
		defaultModel: "gpt-oss:20b",
		envVars: ["OLLAMA_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => ollamaModelManagerOptions(config),
		allowUnauthenticated: true,
	},
	{
		id: "ollama-cloud",
		defaultModel: "gpt-oss:120b",
		envVars: ["OLLAMA_CLOUD_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => ollamaCloudModelManagerOptions(config),
		catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" },
	},
	{
		id: "openai",
		defaultModel: "gpt-5.5",
		envVars: ["OPENAI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => openaiModelManagerOptions(config),
	},
	{
		id: "openai-codex",
		defaultModel: "gpt-5.5",
		envVars: ["OPENAI_CODEX_OAUTH_TOKEN"],
		specialModelManager: true,
	},
	{
		id: "opencode-go",
		defaultModel: "kimi-k2.7-code",
		envVars: ["OPENCODE_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => opencodeGoModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
	},
	{
		id: "opencode-zen",
		defaultModel: "claude-opus-4-8",
		envVars: ["OPENCODE_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => opencodeZenModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
	},
	{
		id: "openrouter",
		defaultModel: "openai/gpt-5.5",
		envVars: ["OPENROUTER_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => openrouterModelManagerOptions(config),
		catalogDiscovery: { label: "OpenRouter", allowUnauthenticated: true },
	},
	{
		id: "qianfan",
		defaultModel: "deepseek-v3.2",
		envVars: ["QIANFAN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => qianfanModelManagerOptions(config),
		catalogDiscovery: { label: "Qianfan" },
	},
	{
		id: "qwen-portal",
		defaultModel: "coder-model",
		envVars: ["QWEN_OAUTH_TOKEN", "QWEN_PORTAL_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => qwenPortalModelManagerOptions(config),
		catalogDiscovery: {
			label: "Qwen Portal",
			oauthProvider: "qwen-portal",
		},
	},
	{
		id: "sakana",
		defaultModel: "fugu",
		envVars: ["SAKANA_API_KEY", "FUGU_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => sakanaModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Sakana AI" },
	},
	{
		id: "siliconflow",
		defaultModel: "zai-org/GLM-5.1",
		envVars: ["SILICONFLOW_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => siliconflowModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
	},
	{
		id: "siliconflow-cn",
		defaultModel: "deepseek-ai/DeepSeek-V4-Pro",
		envVars: ["SILICONFLOW_CN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => siliconflowCnModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
	},
	{
		id: "synthetic",
		defaultModel: "hf:zai-org/GLM-5.2",
		envVars: ["SYNTHETIC_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => syntheticModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Synthetic" },
	},
	{
		id: "together",
		defaultModel: "moonshotai/Kimi-K2.7-Code",
		envVars: ["TOGETHER_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => togetherModelManagerOptions(config),
		catalogDiscovery: { label: "Together" },
	},
	{
		id: "umans",
		defaultModel: "umans-coder",
		envVars: ["UMANS_AI_CODING_PLAN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => umansModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Umans AI Coding Plan", allowUnauthenticated: true },
	},
	{
		id: "venice",
		defaultModel: "llama-3.3-70b",
		envVars: ["VENICE_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => veniceModelManagerOptions(config),
		catalogDiscovery: { label: "Venice", allowUnauthenticated: true },
	},
	{
		id: "vercel-ai-gateway",
		defaultModel: "anthropic/claude-opus-4.8",
		envVars: ["AI_GATEWAY_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => vercelAiGatewayModelManagerOptions(config),
		catalogDiscovery: {
			label: "Vercel AI Gateway",
			envVars: ["VERCEL_AI_GATEWAY_API_KEY"],
			allowUnauthenticated: true,
		},
	},
	{
		id: "vllm",
		defaultModel: "gpt-oss-20b",
		envVars: ["VLLM_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => vllmModelManagerOptions(config),
		catalogDiscovery: { label: "vLLM", allowUnauthenticated: true },
	},
	{
		id: "wafer-serverless",
		defaultModel: "GLM-5.1",
		envVars: ["WAFER_SERVERLESS_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => waferServerlessModelManagerOptions(config),
		catalogDiscovery: {
			label: "Wafer Serverless",
			oauthProvider: "wafer-serverless",
		},
	},
	{
		id: "coreweave",
		defaultModel: "openai/gpt-oss-120b",
		envVars: ["COREWEAVE_API_KEY", "WANDB_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => coreWeaveModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "CoreWeave Serverless Inference" },
	},
	{
		id: "xai",
		defaultModel: "grok-4.6",
		envVars: ["XAI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => xaiModelManagerOptions(config),
	},
	{
		id: "xai-oauth",
		defaultModel: "grok-4.6",
		envVars: ["XAI_OAUTH_TOKEN", "XAI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => xaiOAuthModelManagerOptions(config),
		catalogDiscovery: {
			label: "xAI Grok OAuth (SuperGrok)",
			oauthProvider: "xai-oauth",
		},
	},
	{
		id: "xiaomi",
		defaultModel: "mimo-v2.5",
		envVars: ["XIAOMI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => xiaomiModelManagerOptions(config),
		catalogDiscovery: { label: "Xiaomi" },
	},
	{
		id: "xiaomi-token-plan-ams",
		defaultModel: "mimo-v2.5",
		envVars: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) =>
			xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" }),
	},
	{
		id: "xiaomi-token-plan-cn",
		defaultModel: "mimo-v2.5",
		envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) =>
			xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-cn", tokenPlanRegion: "cn" }),
	},
	{
		id: "xiaomi-token-plan-sgp",
		defaultModel: "mimo-v2.5",
		envVars: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) =>
			xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-sgp", tokenPlanRegion: "sgp" }),
	},
	{
		id: "yolo-auto",
		defaultModel: "deepseek-flash-v4",
		envVars: ["YOLO_AUTO_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => yoloAutoModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Yolo-Auto" },
	},
	{
		id: "zai",
		defaultModel: "glm-5.3",
		envVars: ["ZAI_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => zaiModelManagerOptions(config),
		catalogDiscovery: { label: "zAI" },
	},
	{
		id: "zenmux",
		defaultModel: "anthropic/claude-opus-4.8",
		envVars: ["ZENMUX_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => zenmuxModelManagerOptions(config),
		allowUnauthenticated: true,
		catalogDiscovery: { label: "ZenMux", allowUnauthenticated: true },
	},
	{
		id: "zhipu-coding-plan",
		defaultModel: "glm-5.1",
		envVars: ["ZHIPU_API_KEY"],
		createModelManagerOptions: (config: ModelManagerConfig) => zhipuCodingPlanModelManagerOptions(config),
		dynamicModelsAuthoritative: true,
		catalogDiscovery: { label: "Zhipu Coding Plan" },
	},
] as const satisfies readonly ProviderCatalogEntry[];

/** Chat-model providers — every entry in the catalog table. */
export type KnownProvider = (typeof CATALOG_PROVIDERS)[number]["id"];

/**
 * Runtime model-discovery descriptors: every catalog provider that exposes a
 * standard model-manager factory. Special-managed providers
 * (`google-antigravity`/`google-gemini-cli`/`openai-codex`) are built bespoke in
 * the coding-agent runtime and are excluded here.
 */
const CATALOG_ENTRY_LIST: readonly ProviderCatalogEntry[] = CATALOG_PROVIDERS;

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = CATALOG_ENTRY_LIST.flatMap(provider => {
	if (!provider.createModelManagerOptions || provider.specialModelManager) {
		return [];
	}
	return [
		{
			providerId: provider.id,
			defaultModel: provider.defaultModel,
			createModelManagerOptions: provider.createModelManagerOptions,
			allowUnauthenticated: provider.allowUnauthenticated,
			dynamicModelsAuthoritative: provider.dynamicModelsAuthoritative,
			catalogDiscovery: provider.catalogDiscovery
				? { ...provider.catalogDiscovery, envVars: provider.catalogDiscovery.envVars ?? provider.envVars ?? [] }
				: undefined,
		},
	];
});

/** Default model IDs for all known providers, derived from the catalog table. */
export const DEFAULT_MODEL_PER_PROVIDER: Record<KnownProvider, string> = Object.fromEntries(
	CATALOG_PROVIDERS.map(provider => [provider.id, provider.defaultModel] as [string, string]),
) as Record<KnownProvider, string>;

export function getCatalogProviderEntry(id: string): ProviderCatalogEntry | undefined {
	return CATALOG_PROVIDERS.find(provider => provider.id === id);
}
