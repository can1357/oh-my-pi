import { describe, expect, test } from "bun:test";
import {
	bareModelId,
	hasOpus47ApiRestrictions,
	isClaudeModelId,
	isGeminiModelId,
	isGlm52ReasoningEffortModelId,
	isGlm53ReasoningEffortModelId,
	isGlmVisionModelId,
	isGrokModelId,
	isGrokMultiAgentModelId,
	isGrokReasoningEffortCapable,
	isGrokXHighEffortCapable,
	isKimiK26ModelId,
	isKimiModelId,
	isMinimaxM2FamilyModelId,
	isMinimaxM3FamilyModelId,
	isMuseSparkModelId,
	isOpenAIGptOssModelId,
	isOpenAIModelId,
	isQwen38PlusTemplateEffortModelId,
	isReasoningGlmModelId,
	modelFamilyToken,
	parseAnthropicModel,
	supportsAdaptiveThinkingDisplay,
	supportsHashlineEdits,
	supportsMidConversationSystemMessages,
} from "@oh-my-pi/pi-catalog/identity";

describe("isKimiModelId", () => {
	test("matches Kimi namespace and delimiter forms", () => {
		expect(isKimiModelId("moonshotai/kimi-k2")).toBe(true);
		expect(isKimiModelId("kimi-k2.6")).toBe(true);
		expect(isKimiModelId("vendor/kimi.x")).toBe(true);
		expect(isKimiModelId("akimbo-model")).toBe(false);
	});
});

describe("supportsHashlineEdits", () => {
	test("declines the families that miscount line anchors", () => {
		expect(supportsHashlineEdits("openrouter/moonshotai/Kimi-K2-Instruct")).toBe(false);
		expect(supportsHashlineEdits("xiaomi/MiMo-V2.5-Pro")).toBe(false);
		expect(supportsHashlineEdits("tensormesh/deepseek-ai/DeepSeek-V4-Flash")).toBe(false);
		expect(supportsHashlineEdits("kilo/stepfun/step-3.7-flash:free")).toBe(false);
	});
	test("vouches for structured-edit-capable models", () => {
		expect(supportsHashlineEdits("google/gemini-3.5-flash")).toBe(true);
		expect(supportsHashlineEdits("claude-fable-5")).toBe(true);
		expect(supportsHashlineEdits("moonshot/moonshot-v1-128k")).toBe(true);
	});
});

describe("isQwen38PlusTemplateEffortModelId", () => {
	test("matches Qwen 3.8+ open-weight ids across id shapes and versions", () => {
		expect(isQwen38PlusTemplateEffortModelId("qwen3.8-27b")).toBe(true);
		expect(isQwen38PlusTemplateEffortModelId("qwen3.8-2.4t-a95b")).toBe(true);
		expect(isQwen38PlusTemplateEffortModelId("qwen/qwen3.8-27b")).toBe(true);
		expect(isQwen38PlusTemplateEffortModelId("Qwen3.8-27B-UD-Q6_K_XL")).toBe(true);
		expect(isQwen38PlusTemplateEffortModelId("qwen3.8-27b:thinking")).toBe(true);
		// Component-wise version compare: 3.10 sorts after 3.8.
		expect(isQwen38PlusTemplateEffortModelId("qwen3.10-27b")).toBe(true);
	});
	test("rejects pre-3.8 versions, parameter-count lookalikes, and API-only Max SKUs", () => {
		expect(isQwen38PlusTemplateEffortModelId("qwen3-8b")).toBe(false);
		expect(isQwen38PlusTemplateEffortModelId("qwen-3.6-27b")).toBe(false);
		expect(isQwen38PlusTemplateEffortModelId("qwen3.7-plus")).toBe(false);
		expect(isQwen38PlusTemplateEffortModelId("qwen2.5-coder-7b")).toBe(false);
		expect(isQwen38PlusTemplateEffortModelId("qwen-3.8b")).toBe(false);
		expect(isQwen38PlusTemplateEffortModelId("qwen3.8-max")).toBe(false);
		expect(isQwen38PlusTemplateEffortModelId("qwen3.8-max-preview")).toBe(false);
	});
});

describe("isKimiK26ModelId", () => {
	test("matches Kimi K2.6 without accepting adjacent versions", () => {
		expect(isKimiK26ModelId("kimi-k2.6")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2.6-thinking")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2.61")).toBe(false);
		expect(isKimiK26ModelId("kimi-k2.5")).toBe(false);
		// Router ids spell the version `k2p6` (e.g. Fireworks Fire Pass).
		expect(isKimiK26ModelId("accounts/fireworks/routers/kimi-k2p6-turbo")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2p6")).toBe(true);
		expect(isKimiK26ModelId("kimi-k2p61")).toBe(false);
	});
});

describe("isClaudeModelId", () => {
	test("matches Claude namespace and delimiter forms", () => {
		expect(isClaudeModelId("claude-sonnet-4-6")).toBe(true);
		expect(isClaudeModelId("anthropic/claude.3")).toBe(true);
		expect(isClaudeModelId("my-claudius")).toBe(false);
	});
	test("matches dotted Bedrock cross-region inference profile ids for Claude kinds not enumerated in parseAnthropicModel", () => {
		// `parseAnthropicModel` only classifies opus/sonnet/fable/mythos, so a
		// Haiku Bedrock profile (`us.anthropic.claude-haiku-…`) slips past its
		// regex and MUST still classify as Claude via this fallback so
		// `modelFamilyToken`/`preferredDialect` route it to the Anthropic
		// dialect instead of falling through to XML.
		expect(isClaudeModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
		expect(isClaudeModelId("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
		expect(isClaudeModelId("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
		expect(isClaudeModelId("au.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
		// Non-Claude names that happen to contain "claude" as a substring
		// stay unmatched — no `.` / `/` / start delimiter before `claude-`.
		expect(isClaudeModelId("subclaudian")).toBe(false);
		expect(isClaudeModelId("claudius-5")).toBe(false);
	});
});

describe("parseAnthropicModel", () => {
	test("parses SAP hai-proxy version-first Claude ids without accepting Haiku", () => {
		expect(parseAnthropicModel("anthropic--claude-4.8-opus")).toEqual({
			family: "anthropic",
			kind: "opus",
			version: { major: 4, minor: 8, patch: 0 },
		});
		expect(parseAnthropicModel("anthropic--claude-4.6-opus")).toEqual({
			family: "anthropic",
			kind: "opus",
			version: { major: 4, minor: 6, patch: 0 },
		});
		expect(parseAnthropicModel("anthropic--claude-4.8-haiku")).toBeNull();
	});

	test("parses versions past the precompute table instead of classifying the model unknown", () => {
		// The semver precompute table gates parsing; a too-small bound silently
		// downgraded `claude-opus-5-11`-shaped ids to unknown (#8256 class).
		expect(parseAnthropicModel("claude-opus-5-11")).toEqual({
			family: "anthropic",
			kind: "opus",
			version: { major: 5, minor: 11, patch: 0 },
		});
		expect(parseAnthropicModel("claude-sonnet-4.25")).toEqual({
			family: "anthropic",
			kind: "sonnet",
			version: { major: 4, minor: 25, patch: 0 },
		});
	});
});

describe("supportsAdaptiveThinkingDisplay", () => {
	test("allows Claude Fable 5, Opus 4.7 or newer, and Sonnet 5 or newer only", () => {
		expect(supportsAdaptiveThinkingDisplay("claude-fable-5")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4-7")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-5-0")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("claude-sonnet-5")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("us.anthropic.claude-sonnet-5")).toBe(true);
		// Dotted and dashed version separators are equivalent.
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4.7")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("anthropic/claude-opus-4.8")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("anthropic--claude-4.8-opus")).toBe(true);
		expect(supportsAdaptiveThinkingDisplay("anthropic--claude-4.6-opus")).toBe(false);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4-6")).toBe(false);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4.6")).toBe(false);
		expect(supportsAdaptiveThinkingDisplay("claude-opus-4-20250514")).toBe(false);
		expect(supportsAdaptiveThinkingDisplay("claude-sonnet-4-6")).toBe(false);
	});
});

describe("hasOpus47ApiRestrictions", () => {
	test("allows Claude Fable 5, Opus 4.7 or newer, and Sonnet 5 or newer only", () => {
		expect(hasOpus47ApiRestrictions("claude-fable-5")).toBe(true);
		expect(hasOpus47ApiRestrictions("claude-opus-4-7")).toBe(true);
		expect(hasOpus47ApiRestrictions("claude-opus-4.8")).toBe(true);
		expect(hasOpus47ApiRestrictions("anthropic--claude-4.7-opus")).toBe(true);
		expect(hasOpus47ApiRestrictions("claude-sonnet-5")).toBe(true);
		expect(hasOpus47ApiRestrictions("us.anthropic.claude-sonnet-5")).toBe(true);
		expect(hasOpus47ApiRestrictions("claude-opus-4-6")).toBe(false);
		expect(hasOpus47ApiRestrictions("claude-sonnet-4-6")).toBe(false);
		expect(hasOpus47ApiRestrictions("claude-sonnet-4-5")).toBe(false);
	});
});

describe("supportsMidConversationSystemMessages", () => {
	test("allows Claude Fable 5, Opus 4.8 or newer, and Sonnet 5 or newer only", () => {
		expect(supportsMidConversationSystemMessages("claude-fable-5")).toBe(true);
		expect(supportsMidConversationSystemMessages("claude-opus-4-8")).toBe(true);
		expect(supportsMidConversationSystemMessages("claude-sonnet-5")).toBe(true);
		expect(supportsMidConversationSystemMessages("us.anthropic.claude-sonnet-5")).toBe(true);
		expect(supportsMidConversationSystemMessages("anthropic--claude-4.8-opus")).toBe(true);
		expect(supportsMidConversationSystemMessages("anthropic--claude-4.7-opus")).toBe(false);
		expect(supportsMidConversationSystemMessages("claude-opus-4-7")).toBe(false);
		expect(supportsMidConversationSystemMessages("claude-sonnet-4-6")).toBe(false);
	});
});

describe("isMinimaxM2FamilyModelId", () => {
	test("matches every M2-generation id shape served by aggregator/native hosts", () => {
		// Fireworks/OpenCode/openrouter direct ids and `-highspeed`/`-lightning` variants.
		expect(isMinimaxM2FamilyModelId("minimax-m2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("MiniMax-M2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("MiniMax-M2.7-highspeed")).toBe(true);
		expect(isMinimaxM2FamilyModelId("MiniMax-M2.1-lightning")).toBe(true);
		// Vendor-namespaced ids on aggregators.
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m2")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m2.5:free")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimaxai/minimax-m2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m2-her")).toBe(true);
		// Bedrock-shaped id and aimlapi short form.
		expect(isMinimaxM2FamilyModelId("minimax.minimax-m2.7")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/m2")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax/m2-7-highspeed")).toBe(true);
		// Venice's dotless aliases.
		expect(isMinimaxM2FamilyModelId("minimax-m21")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax-m25")).toBe(true);
		expect(isMinimaxM2FamilyModelId("minimax-m27")).toBe(true);
	});

	test("excludes non-M2 MiniMax SKUs and unrelated families", () => {
		expect(isMinimaxM2FamilyModelId("minimax/m1")).toBe(false);
		expect(isMinimaxM2FamilyModelId("MiniMax-M1")).toBe(false);
		expect(isMinimaxM2FamilyModelId("MiniMax-M3")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax/minimax-m3")).toBe(false);
		expect(isMinimaxM2FamilyModelId("MiniMax-Text-01")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax-music")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax/hailuo-02")).toBe(false);
		expect(isMinimaxM2FamilyModelId("minimax/music-2.0")).toBe(false);
		// Lone "m2" string with no MiniMax context does not match.
		expect(isMinimaxM2FamilyModelId("kimi-m2")).toBe(false);
		expect(isMinimaxM2FamilyModelId("gpt-oss-120b")).toBe(false);
	});
});

describe("isMinimaxM3FamilyModelId", () => {
	test("matches MiniMax M3 ids without broadening the M2 effort predicate", () => {
		expect(isMinimaxM3FamilyModelId("MiniMax-M3")).toBe(true);
		expect(isMinimaxM3FamilyModelId("minimax-m3")).toBe(true);
		expect(isMinimaxM3FamilyModelId("minimax/minimax-m3")).toBe(true);
		expect(isMinimaxM3FamilyModelId("minimax-m3-free")).toBe(true);
		expect(isMinimaxM3FamilyModelId("minimax/m3")).toBe(true);

		expect(isMinimaxM3FamilyModelId("MiniMax-M2.7")).toBe(false);
		expect(isMinimaxM3FamilyModelId("MiniMax-Text-01")).toBe(false);
		expect(isMinimaxM3FamilyModelId("minimax-music")).toBe(false);
		expect(isMinimaxM3FamilyModelId("kimi-m3")).toBe(false);
	});
});

describe("isMuseSparkModelId", () => {
	test("matches Muse Spark ids across namespaces and contributor SKUs", () => {
		expect(isMuseSparkModelId("muse-spark-1.1")).toBe(true);
		expect(isMuseSparkModelId("muse-spark-1.2")).toBe(true);
		expect(isMuseSparkModelId("muse-spark-1.2-contributor")).toBe(true);
		expect(isMuseSparkModelId("meta/muse-spark-1.2")).toBe(true);
	});

	test("rejects adjacent spark or muse names", () => {
		expect(isMuseSparkModelId("spark-1.2")).toBe(false);
		expect(isMuseSparkModelId("muse-1.2")).toBe(false);
		expect(isMuseSparkModelId("amuse-spark-1.2")).toBe(false);
		expect(isMuseSparkModelId("gpt-5.3-codex-spark")).toBe(false);
	});
});

describe("isOpenAIGptOssModelId", () => {
	test("matches gpt-oss across catalog id shapes", () => {
		expect(isOpenAIGptOssModelId("gpt-oss-120b")).toBe(true);
		expect(isOpenAIGptOssModelId("gpt-oss-20b")).toBe(true);
		expect(isOpenAIGptOssModelId("gpt-oss:120b")).toBe(true);
		expect(isOpenAIGptOssModelId("openai/gpt-oss-120b")).toBe(true);
		expect(isOpenAIGptOssModelId("gpt-oss-120b-medium")).toBe(true);
	});

	test("excludes unrelated `gpt-*` and `oss` models", () => {
		expect(isOpenAIGptOssModelId("gpt-4o")).toBe(false);
		expect(isOpenAIGptOssModelId("gpt-4.1-mini")).toBe(false);
		expect(isOpenAIGptOssModelId("oss-llm")).toBe(false);
		expect(isOpenAIGptOssModelId("MiniMax-M2.7")).toBe(false);
	});
});

describe("isOpenAIModelId", () => {
	test("matches current OpenAI ids across GPT, o-series, ChatGPT, and Codex aliases", () => {
		for (const id of ["gpt-4o", "o3", "o4-mini", "chatgpt-4o-latest", "codex-mini-latest"]) {
			expect(isOpenAIModelId(id)).toBe(true);
		}
	});
});

describe("isReasoningGlmModelId", () => {
	test("matches the glm-4.5+ base / air / turbo reasoning lines", () => {
		expect(isReasoningGlmModelId("glm-4.5")).toBe(true);
		expect(isReasoningGlmModelId("glm-4.5-air")).toBe(true);
		expect(isReasoningGlmModelId("glm-4.6")).toBe(true);
		expect(isReasoningGlmModelId("glm-4.7")).toBe(true);
		expect(isReasoningGlmModelId("glm-5")).toBe(true);
		expect(isReasoningGlmModelId("glm-5-turbo")).toBe(true);
		expect(isReasoningGlmModelId("glm-5.1")).toBe(true);
		expect(isReasoningGlmModelId("glm-5.2")).toBe(true);
		// Family match is future-proof: new integers need no allowlist entry.
		expect(isReasoningGlmModelId("glm-5.3")).toBe(true);
		expect(isReasoningGlmModelId("glm-6")).toBe(true);
		// GLM-5.3-Flash is the first `-flash` SKU with mandatory thinking.
		expect(isReasoningGlmModelId("glm-5.3-flash")).toBe(true);
		// Namespaced ids are stripped before classification.
		expect(isReasoningGlmModelId("z-ai/glm-5-turbo")).toBe(true);
	});

	test("excludes pre-4.5, vision, pre-5.3 flash, flashx, and preview SKUs", () => {
		expect(isReasoningGlmModelId("glm-4")).toBe(false);
		expect(isReasoningGlmModelId("glm-4.4")).toBe(false);
		expect(isReasoningGlmModelId("glm-5-preview")).toBe(false);
		expect(isReasoningGlmModelId("glm-4.5-flash")).toBe(false);
		expect(isReasoningGlmModelId("glm-4.7-flash")).toBe(false);
		expect(isReasoningGlmModelId("glm-5.2-flash")).toBe(false);
		expect(isReasoningGlmModelId("glm-4.7-flashx")).toBe(false);
		expect(isReasoningGlmModelId("glm-4.5v")).toBe(false);
		expect(isReasoningGlmModelId("qwen3.5")).toBe(false);
	});

	test("matches uppercase provider-prefixed GLM ids", () => {
		// Baseten, CoreWeave, HuggingFace, etc. serve GLM under uppercase ids.
		expect(isReasoningGlmModelId("zai-org/GLM-5.2")).toBe(true);
		expect(isReasoningGlmModelId("zai-org/GLM-5.2-Fast")).toBe(true);
		expect(isReasoningGlmModelId("zai-org/GLM-4.7")).toBe(true);
		expect(isReasoningGlmModelId("zai-org/GLM-4.5-Air")).toBe(true);
		expect(isReasoningGlmModelId("zai-org/GLM-5-Turbo")).toBe(true);
		// Vision SKUs are still excluded even in uppercase.
		expect(isReasoningGlmModelId("zai-org/GLM-4.5V")).toBe(false);
	});
});

describe("isGlm52ReasoningEffortModelId", () => {
	test("matches GLM-5.2+ reasoning SKUs including the 5.3 flash line", () => {
		expect(isGlm52ReasoningEffortModelId("glm-5.2")).toBe(true);
		expect(isGlm52ReasoningEffortModelId("zai-org/GLM-5.2-Fast")).toBe(true);
		// The 5.3 flash SKU accepts reasoning_effort like the rest of 5.3+.
		expect(isGlm52ReasoningEffortModelId("glm-5.3-flash")).toBe(true);
		expect(isGlm52ReasoningEffortModelId("zai-org/GLM-5.3-Flash")).toBe(true);
	});

	test("excludes pre-5.2 SKUs, pre-5.3 flash, and non-reasoning variants", () => {
		expect(isGlm52ReasoningEffortModelId("glm-5.1")).toBe(false);
		expect(isGlm52ReasoningEffortModelId("glm-5.2-flash")).toBe(false);
		expect(isGlm52ReasoningEffortModelId("glm-4.7-flashx")).toBe(false);
		expect(isGlm52ReasoningEffortModelId("glm-5-preview")).toBe(false);
		expect(isGlm52ReasoningEffortModelId("glm-4.5v")).toBe(false);
	});
});

describe("isGlm53ReasoningEffortModelId", () => {
	test("matches GLM-5.3+ SKUs across variants, including Flash", () => {
		expect(isGlm53ReasoningEffortModelId("glm-5.3")).toBe(true);
		expect(isGlm53ReasoningEffortModelId("glm-5.3-air")).toBe(true);
		expect(isGlm53ReasoningEffortModelId("glm-5.3-turbo")).toBe(true);
		expect(isGlm53ReasoningEffortModelId("glm-5.3-flash")).toBe(true);
		expect(isGlm53ReasoningEffortModelId("zai-org/GLM-5.3-Flash")).toBe(true);
		// Future bumps inherit the ladder without a new entry.
		expect(isGlm53ReasoningEffortModelId("glm-6")).toBe(true);
	});

	test("excludes pre-5.3 SKUs and non-reasoning variants", () => {
		expect(isGlm53ReasoningEffortModelId("glm-5.2")).toBe(false);
		expect(isGlm53ReasoningEffortModelId("glm-5.2-flash")).toBe(false);
		expect(isGlm53ReasoningEffortModelId("glm-5.3-flashx")).toBe(false);
		expect(isGlm53ReasoningEffortModelId("glm-5.3-preview")).toBe(false);
		expect(isGlm53ReasoningEffortModelId("glm-5.3v")).toBe(false);
	});
});
describe("isGlmVisionModelId", () => {
	test("matches the `v` vision shape across versions and variants", () => {
		expect(isGlmVisionModelId("glm-4v")).toBe(true);
		expect(isGlmVisionModelId("glm-4.5v")).toBe(true);
		expect(isGlmVisionModelId("glm-4v-plus")).toBe(true);
	});

	test("matches the natively multimodal flash line from GLM-5.3-Flash on", () => {
		// GLM-5.3-Flash accepts image blocks without carrying a `v` marker.
		expect(isGlmVisionModelId("glm-5.3-flash")).toBe(true);
		expect(isGlmVisionModelId("zai-org/GLM-5.3-Flash")).toBe(true);
		// Earlier flash SKUs stay text-only.
		expect(isGlmVisionModelId("glm-4.5-flash")).toBe(false);
		expect(isGlmVisionModelId("glm-4.7-flash")).toBe(false);
		// The text-only base line is unaffected.
		expect(isGlmVisionModelId("glm-5.3")).toBe(false);
	});

	test("excludes non-vision GLM ids (the old `includes('v')` false positives)", () => {
		expect(isGlmVisionModelId("glm-5-preview")).toBe(false);
		expect(isGlmVisionModelId("glm-4.5")).toBe(false);
		expect(isGlmVisionModelId("glm-5-turbo")).toBe(false);
	});
});
describe("modelFamilyToken", () => {
	test("groups point releases within a vendor and separates across vendors", () => {
		expect(modelFamilyToken("claude-opus-4-7")).toBe("anthropic");
		expect(modelFamilyToken("claude-opus-4-8")).toBe("anthropic");
		expect(modelFamilyToken("claude-opus-4-7")).toBe(modelFamilyToken("claude-opus-4-8"));
		expect(modelFamilyToken("gpt-5.4")).toBe("openai");
		expect(modelFamilyToken("gemini-3-pro")).toBe("gemini");
		expect(modelFamilyToken("claude-opus-4-8")).not.toBe(modelFamilyToken("gpt-5.4"));
	});

	test("folds aggregator mirrors and namespace prefixes onto the lineage", () => {
		expect(modelFamilyToken("anthropic/claude-opus-4.8")).toBe("anthropic");
		expect(modelFamilyToken("openrouter/anthropic/claude-opus-4-8")).toBe("anthropic");
	});

	test("classifies Bedrock cross-region profile ids for Claude kinds not enumerated in parseAnthropicModel", () => {
		// `parseAnthropicModel` doesn't know `haiku`, so this exercises the
		// isClaudeModelId fallback specifically for dotted Bedrock profiles.
		expect(modelFamilyToken("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
		expect(modelFamilyToken("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
		expect(modelFamilyToken("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("anthropic");
	});

	test("classifies non-first-party families", () => {
		expect(modelFamilyToken("moonshotai/kimi-k2")).toBe("kimi");
		expect(modelFamilyToken("qwen/qwen3-coder")).toBe("qwen");
		expect(modelFamilyToken("google/gemini-2.5-flash")).toBe("gemini");
		expect(modelFamilyToken("xai/grok-4.6")).toBe("grok");
		expect(modelFamilyToken("openai/gemini-pro")).toBe("gemini");
		expect(modelFamilyToken("openai/deepseek-r1")).toBe("deepseek");
		expect(modelFamilyToken("openai/grok-4.6")).toBe("grok");
	});
	test("classifies GLM across provider mirrors so same-lineage SKUs fold together", () => {
		expect(modelFamilyToken("glm-5.2")).toBe("glm");
		expect(modelFamilyToken("zai/glm-5.2")).toBe(modelFamilyToken("zhipu-coding-plan/glm-5.2"));
		expect(modelFamilyToken("zai/glm-5.2")).toBe("glm");
	});

	test("returns an empty token for unclassifiable ids so callers fall back to provider", () => {
		expect(modelFamilyToken("some-unknown-model")).toBe("");
	});
});
describe("isGeminiModelId", () => {
	test("matches gemini ids across namespaces", () => {
		expect(isGeminiModelId("gemini-3.5-flash")).toBe(true);
		expect(isGeminiModelId("google/gemini-3-pro")).toBe(true);
		expect(isGeminiModelId("openrouter/google/gemini-2.5-flash")).toBe(true);
		expect(isGeminiModelId("gpt-4o")).toBe(false);
	});
});

describe("isGrokModelId", () => {
	test("matches grok ids across namespaces and delimiters", () => {
		expect(isGrokModelId("grok-4-6")).toBe(true);
		expect(isGrokModelId("xai/grok-3")).toBe(true);
		expect(isGrokModelId("venice/grok-4.5")).toBe(true);
		expect(isGrokModelId("cursor-grok-4.5-high")).toBe(true);
		expect(isGrokModelId("notgrok-4.6")).toBe(false);
		expect(isGrokModelId("gpt-4o")).toBe(false);
	});
});

describe("isGrokReasoningEffortCapable", () => {
	test("matches effort-capable Grok SKUs across namespaces", () => {
		expect(isGrokReasoningEffortCapable("grok-4.3")).toBe(true);
		expect(isGrokReasoningEffortCapable("grok-3-mini")).toBe(true);
		expect(isGrokReasoningEffortCapable("grok-4.20-multi-agent")).toBe(true);
		expect(isGrokReasoningEffortCapable("xai-oauth/grok-4.3")).toBe(true);
		expect(isGrokReasoningEffortCapable("xai-oauth/grok-4.5")).toBe(true);
		expect(isGrokReasoningEffortCapable("xai-oauth/grok-4.6")).toBe(true);
		expect(isGrokReasoningEffortCapable("grok-4.6")).toBe(true);
		expect(isGrokReasoningEffortCapable("openrouter/xai/grok-3-mini")).toBe(true);
	});

	test("rejects effort-dial-less Grok SKUs and non-Grok ids", () => {
		expect(isGrokReasoningEffortCapable("grok-build")).toBe(false);
		expect(isGrokReasoningEffortCapable("grok-4.20-0309-reasoning")).toBe(false);
		expect(isGrokReasoningEffortCapable("gpt-5")).toBe(false);
		expect(isGrokReasoningEffortCapable("")).toBe(false);
	});
});

describe("isGrokMultiAgentModelId", () => {
	test("matches grok-4.20-multi-agent SKUs across namespaces", () => {
		expect(isGrokMultiAgentModelId("grok-4.20-multi-agent")).toBe(true);
		expect(isGrokMultiAgentModelId("grok-4.20-multi-agent-0309")).toBe(true);
		expect(isGrokMultiAgentModelId("xai/grok-4.20-multi-agent-beta-latest")).toBe(true);
	});

	test("rejects other Grok ids", () => {
		expect(isGrokMultiAgentModelId("grok-4.5")).toBe(false);
		expect(isGrokMultiAgentModelId("grok-4.6")).toBe(false);
		expect(isGrokMultiAgentModelId("grok-4.20-0309-reasoning")).toBe(false);
		expect(isGrokMultiAgentModelId("")).toBe(false);
	});
});

describe("isGrokXHighEffortCapable", () => {
	test("matches grok-4.6 and multi-agent SKUs across namespaces", () => {
		expect(isGrokXHighEffortCapable("grok-4.6")).toBe(true);
		expect(isGrokXHighEffortCapable("xai/grok-4.6")).toBe(true);
		expect(isGrokXHighEffortCapable("xai-oauth/grok-4.6")).toBe(true);
		expect(isGrokXHighEffortCapable("grok-4.20-multi-agent-0309")).toBe(true);
	});

	test("rejects Grok SKUs that clamp leftover xhigh to high", () => {
		expect(isGrokXHighEffortCapable("grok-4.5")).toBe(false);
		expect(isGrokXHighEffortCapable("grok-4.3")).toBe(false);
		expect(isGrokXHighEffortCapable("grok-3-mini")).toBe(false);
		expect(isGrokXHighEffortCapable("grok-build")).toBe(false);
		expect(isGrokXHighEffortCapable("")).toBe(false);
	});
});

describe("bareModelId", () => {
	test("strips only the provider namespace and preserves colon-delimited identity", () => {
		expect(bareModelId("ollama-cloud/gemma3:12b")).toBe("gemma3:12b");
		expect(bareModelId("synthetic/syn:large:text")).toBe("syn:large:text");
		expect(bareModelId("custom:happyhorse-1.0")).toBe("custom:happyhorse-1.0");
	});

	test("keeps ids without a colon suffix untouched", () => {
		expect(bareModelId("anthropic/claude-opus-5")).toBe("claude-opus-5");
		expect(bareModelId("gpt-5.6-luna")).toBe("gpt-5.6-luna");
		expect(bareModelId("")).toBe("");
	});
});
