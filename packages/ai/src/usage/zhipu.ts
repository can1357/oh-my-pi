import { createGlmCodingPlanUsageProvider } from "./zai";

const DEFAULT_ENDPOINT = "https://open.bigmodel.cn";

const zhipu = createGlmCodingPlanUsageProvider({
	provider: "zhipu-coding-plan",
	defaultEndpoint: DEFAULT_ENDPOINT,
	brandKey: "zhipu",
	brandLabel: "Zhipu",
});

export const zhipuUsageProvider = zhipu.usageProvider;
export const zhipuRankingStrategy = zhipu.rankingStrategy;
