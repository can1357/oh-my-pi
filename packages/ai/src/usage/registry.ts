import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";
import { alibabaTokenPlanRankingStrategy, alibabaTokenPlanUsageProvider } from "./alibaba-token-plan";
import { charmHyperUsageProvider } from "./charm-hyper";
import { claudeRankingStrategy, claudeUsageProvider } from "./claude";
import { clinePassUsageProvider } from "./cline-pass";
import { cursorUsageProvider } from "./cursor";
import { devinUsageProvider } from "./devin";
import { googleGeminiCliUsageProvider } from "./gemini";
import { githubCopilotUsageProvider } from "./github-copilot";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./google-antigravity";
import { kimiRankingStrategy, kimiUsageProvider } from "./kimi";
import { museCodeUsageProvider } from "./muse-code";
import { minimaxCodeCnUsageProvider, minimaxCodeUsageProvider } from "./minimax-code";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./openai-codex";
import { opencodeGoRankingStrategy, opencodeGoUsageProvider } from "./opencode-go";
import { syntheticUsageProvider } from "./synthetic";
import { umansUsageProvider } from "./umans";
import { xaiOauthRankingStrategy, xaiOauthUsageProvider } from "./xai-oauth";
import { zaiRankingStrategy, zaiUsageProvider, zhipuCodingPlanUsageProvider } from "./zai";

/** Resolves the usage-based ranking strategy for a provider. */
export type RankingStrategyResolver = (provider: Provider) => CredentialRankingStrategy | undefined;

/** Built-in usage providers, in probe order. */
export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] = [
	alibabaTokenPlanUsageProvider,
	openaiCodexUsageProvider,
	kimiUsageProvider,
	minimaxCodeUsageProvider,
	minimaxCodeCnUsageProvider,
	museCodeUsageProvider,
	antigravityUsageProvider,
	googleGeminiCliUsageProvider,
	ollamaUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	clinePassUsageProvider,
	zaiUsageProvider,
	zhipuCodingPlanUsageProvider,
	umansUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	cursorUsageProvider,
	syntheticUsageProvider,
	xaiOauthUsageProvider,
	devinUsageProvider,
	charmHyperUsageProvider,
];

const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(
	DEFAULT_USAGE_PROVIDERS.map(provider => [provider.id, provider]),
);

/** Built-in usage provider for `provider`. */
export function defaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return DEFAULT_USAGE_PROVIDER_MAP.get(provider);
}

const DEFAULT_RANKING_STRATEGIES = new Map<Provider, CredentialRankingStrategy>([
	["alibaba-token-plan", alibabaTokenPlanRankingStrategy],
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
	["kimi-code", kimiRankingStrategy],
	["zai", zaiRankingStrategy],
	["zhipu-coding-plan", zaiRankingStrategy],
	["opencode-go", opencodeGoRankingStrategy],
	["xai-oauth", xaiOauthRankingStrategy],
]);

/** Built-in ranking strategy for `provider`. */
export function defaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}
