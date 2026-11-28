import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";
import { alibabaTokenPlanRankingStrategy, alibabaTokenPlanUsageProvider } from "./alibaba-token-plan";
import { bifrostRankingStrategy, bifrostUsageProvider } from "./bifrost";
import { charmHyperUsageProvider } from "./charm-hyper";
import { claudeRankingStrategy, claudeUsageProvider } from "./claude";
import { clinePassUsageProvider } from "./cline-pass";
import { commandCodeRankingStrategy, commandCodeUsageProvider } from "./commandcode";
import { cursorRankingStrategy, cursorUsageProvider } from "./cursor";
import { devinRankingStrategy, devinUsageProvider } from "./devin";
import { factoryDroidRankingStrategy, factoryDroidUsageProvider } from "./factory-droid";
import { githubCopilotUsageProvider } from "./github-copilot";
import { kimiGlobalUsageProvider, kimiRankingStrategy, kimiUsageProvider } from "./kimi";
import { kiroRankingStrategy, kiroUsageProvider } from "./kiro";
import { museCodeUsageProvider } from "./muse-code";
import { minimaxCodeUsageProvider } from "./minimax-code";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./ollama";
import { codexRankingStrategy, openaiCodexUsageProvider } from "./openai-codex";
import { opencodeGoRankingStrategy, opencodeGoUsageProvider } from "./opencode-go";
import { syntheticUsageProvider } from "./synthetic";
import { umansUsageProvider } from "./umans";
import { veniceUsageProvider } from "./venice";
import { xaiOauthRankingStrategy, xaiOauthUsageProvider } from "./xai-oauth";
import { zaiRankingStrategy, zaiUsageProvider } from "./zai";

/** Resolves the usage-based ranking strategy for a provider. */
export type RankingStrategyResolver = (provider: Provider) => CredentialRankingStrategy | undefined;

/** Built-in usage providers, in probe order. */
export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] = [
	alibabaTokenPlanUsageProvider,
	openaiCodexUsageProvider,
	kimiUsageProvider,
	kimiGlobalUsageProvider,
	minimaxCodeUsageProvider,
	museCodeUsageProvider,
	ollamaUsageProvider,
	factoryDroidUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	clinePassUsageProvider,
	zaiUsageProvider,
	umansUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	cursorUsageProvider,
	syntheticUsageProvider,
	veniceUsageProvider,
	xaiOauthUsageProvider,
	devinUsageProvider,
	charmHyperUsageProvider,
	commandCodeUsageProvider,
	kiroUsageProvider,
	bifrostUsageProvider,
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
	["cursor", cursorRankingStrategy],
	["factory-droid", factoryDroidRankingStrategy],
	["kimi-code", kimiRankingStrategy],
	["kimi-code-global", kimiRankingStrategy],
	["zai", zaiRankingStrategy],
	["opencode-go", opencodeGoRankingStrategy],
	["xai-oauth", xaiOauthRankingStrategy],
	["commandcode", commandCodeRankingStrategy],
	["kiro", kiroRankingStrategy],
	["devin", devinRankingStrategy],
	["bifrost", bifrostRankingStrategy],
]);

/** Built-in ranking strategy for `provider`. */
export function defaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}
