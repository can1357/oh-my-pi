import type { KnownProvider } from "@oh-my-pi/pi-catalog";
import { aiandProvider } from "./aiand";
import { aimlApiProvider } from "./aimlapi";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan";
import { alibabaTokenPlanProvider } from "./alibaba-token-plan";
import { amazonBedrockProvider } from "./amazon-bedrock";
import { anthropicProvider } from "./anthropic";
import { azureProvider } from "./azure";
import { basetenProvider } from "./baseten";
import { bedrockMantleProvider } from "./bedrock-mantle";
import { cerebrasProvider } from "./cerebras";
import { clinePassProvider } from "./cline-pass";
import { cloudflareAiGatewayProvider } from "./cloudflare-ai-gateway";
import { coreWeaveProvider } from "./coreweave";
import { cursorProvider } from "./cursor";
import { deepinfraProvider } from "./deepinfra";
import { deepseekProvider } from "./deepseek";
import { devinProvider } from "./devin";
import { exaProvider } from "./exa";
import { firepassProvider } from "./firepass";
import { fireworksProvider } from "./fireworks";
import { githubCopilotProvider } from "./github-copilot";
import { gitlabDuoProvider } from "./gitlab-duo";
import { gitLabDuoWorkflowProvider } from "./gitlab-duo-workflow";
import { gmiCloudProvider } from "./gmi-cloud";
import { googleProvider } from "./google";
import { googleAntigravityProvider } from "./google-antigravity";
import { googleGeminiCliProvider } from "./google-gemini-cli";
import { googleVertexProvider } from "./google-vertex";
import { groqProvider } from "./groq";
import { huggingfaceProvider } from "./huggingface";
import { kagiProvider } from "./kagi";
import { kiloProvider } from "./kilo";
import { kimiCodeProvider } from "./kimi-code";
import { litellmProvider } from "./litellm";
import { llamaCppProvider } from "./llama-cpp";
import { lmStudioProvider } from "./lm-studio";
import { metaProvider } from "./meta";
import { minimaxProvider } from "./minimax";
import { minimaxCodeProvider } from "./minimax-code";
import { minimaxCodeCnProvider } from "./minimax-code-cn";
import { mistralProvider } from "./mistral";
import { moonshotProvider } from "./moonshot";
import { nanogptProvider } from "./nanogpt";
import { novitaProvider } from "./novita";
import { nvidiaProvider } from "./nvidia";
import { ollamaProvider } from "./ollama";
import { ollamaCloudProvider } from "./ollama-cloud";
import { openaiProvider } from "./openai";
import { openaiCodexProvider } from "./openai-codex";
import { openaiCodexDeviceProvider } from "./openai-codex-device";
import { opencodeGoProvider } from "./opencode-go";
import { opencodeZenProvider } from "./opencode-zen";
import { openrouterProvider } from "./openrouter";
import { parallelProvider } from "./parallel";
import { perplexityProvider } from "./perplexity";
import { qianfanProvider } from "./qianfan";
import { qwenPortalProvider } from "./qwen-portal";
import { sakanaProvider } from "./sakana";
import { siliconflowProvider } from "./siliconflow";
import { siliconflowCnProvider } from "./siliconflow-cn";
import { syntheticProvider } from "./synthetic";
import { tavilyProvider } from "./tavily";
import { togetherProvider } from "./together";
import type { ProviderDefinition } from "./types";
import { umansProvider } from "./umans";
import { veniceProvider } from "./venice";
import { vercelAiGatewayProvider } from "./vercel-ai-gateway";
import { vllmProvider } from "./vllm";
import { waferServerlessProvider } from "./wafer-serverless";
import { xaiProvider } from "./xai";
import { xaiOauthProvider } from "./xai-oauth";
import { xiaomiProvider } from "./xiaomi";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp";
import { yoloAutoProvider } from "./yolo-auto";
import { zaiCodingPlanProvider, zaiProvider } from "./zai";
import { zenmuxProvider } from "./zenmux";
import { zhipuCodingPlanProvider } from "./zhipu-coding-plan";

/**
 * The single per-provider list. Adding a provider = create `./providers/<id>.ts`
 * and add its export here. Every legacy structure (`KnownProvider`/`OAuthProvider`
 * unions, descriptors, env map, login list, refresh/login dispatch, CLI callback
 * maps) is derived from this registry. Order matches the interactive `/login`
 * list for the loginable providers; non-login model providers are appended.
 */
const ALL = [
	azureProvider,
	openaiCodexProvider,
	anthropicProvider,
	zaiProvider,
	zaiCodingPlanProvider,
	kimiCodeProvider,
	openrouterProvider,
	githubCopilotProvider,
	cursorProvider,
	devinProvider,
	googleAntigravityProvider,
	googleGeminiCliProvider,
	openaiCodexDeviceProvider,
	xaiProvider,
	xaiOauthProvider,
	gitlabDuoProvider,
	gitLabDuoWorkflowProvider,
	alibabaCodingPlanProvider,
	alibabaTokenPlanProvider,
	aiandProvider,
	aimlApiProvider,
	zhipuCodingPlanProvider,
	umansProvider,
	qwenPortalProvider,
	sakanaProvider,
	minimaxCodeProvider,
	minimaxCodeCnProvider,
	xiaomiProvider,
	xiaomiTokenPlanSgpProvider,
	xiaomiTokenPlanAmsProvider,
	xiaomiTokenPlanCnProvider,
	firepassProvider,
	clinePassProvider,
	deepseekProvider,
	metaProvider,
	moonshotProvider,
	cerebrasProvider,
	basetenProvider,
	fireworksProvider,
	togetherProvider,
	nvidiaProvider,
	novitaProvider,
	deepinfraProvider,
	huggingfaceProvider,
	perplexityProvider,
	qianfanProvider,
	veniceProvider,
	siliconflowProvider,
	siliconflowCnProvider,
	syntheticProvider,
	nanogptProvider,
	waferServerlessProvider,
	coreWeaveProvider,
	vercelAiGatewayProvider,
	cloudflareAiGatewayProvider,
	litellmProvider,
	kiloProvider,
	zenmuxProvider,
	opencodeZenProvider,
	opencodeGoProvider,
	yoloAutoProvider,
	tavilyProvider,
	kagiProvider,
	exaProvider,
	parallelProvider,
	ollamaProvider,
	ollamaCloudProvider,
	lmStudioProvider,
	llamaCppProvider,
	vllmProvider,
	openaiProvider,
	googleProvider,
	googleVertexProvider,
	groqProvider,
	mistralProvider,
	minimaxProvider,
	amazonBedrockProvider,
	bedrockMantleProvider,
	gmiCloudProvider,
];

export type RegistryDef = (typeof ALL)[number];
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = ALL;

const BY_ID = new Map<string, ProviderDefinition>(ALL.map(p => [p.id, p] as [string, ProviderDefinition]));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return BY_ID.get(id);
}

/** Compile-time completeness: every catalog chat-model provider must have a registry definition. */
type _MissingCatalogProviders = Exclude<KnownProvider, RegistryDef["id"]>;
type _CheckRegistryComplete = _MissingCatalogProviders extends never
	? true
	: ["registry is missing catalog providers", _MissingCatalogProviders];
true satisfies _CheckRegistryComplete;

/** Loginable providers (those carrying a `login` flow). */
export type OAuthProviderUnion = Extract<RegistryDef, { login: object }>["id"];
