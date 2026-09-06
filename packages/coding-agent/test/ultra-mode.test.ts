import { describe, expect, it } from "bun:test";
import { Agent, ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Effort, THINKING_EFFORTS } from "@pk-nerdsaver-ai/pi-catalog/effort";
import {
	clampThinkingLevelForModel,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	requireSupportedEffort,
} from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { parseArgs } from "@pk-nerdsaver-ai/pi-coding-agent/cli/args";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { parseModelString } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-resolver";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import {
	getThinkingLevelMetadata,
	parseCliThinkingLevel,
	parseConfiguredThinkingLevel,
	parseEffort,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
	toReasoningEffort,
} from "@pk-nerdsaver-ai/pi-coding-agent/thinking";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

const MOCK_REASONING_MODEL: Model<"openai-responses"> = buildModel({
	id: "mock-reasoning-model",
	name: "Mock Reasoning Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	},
});

const MOCK_ULTRA_NATIVE_MODEL: Model<"openai-codex-responses"> = buildModel({
	id: "mock-codex-model",
	name: "Mock Codex Model",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Ultra],
	},
});

describe("Ultra mode — CLI parsing", () => {
	it("parses --ultra flag as Ultra thinking level", () => {
		const result = parseArgs(["--ultra"]);
		expect(result.ultra).toBe(true);
		expect(result.thinking).toBe(ThinkingLevel.Ultra);
	});

	it("parses --mode ultra as Ultra thinking level", () => {
		const result = parseArgs(["--mode", "ultra"]);
		expect(result.ultra).toBe(true);
		expect(result.thinking).toBe(ThinkingLevel.Ultra);
	});

	it("parses --thinking ultra as Ultra thinking level", () => {
		const result = parseArgs(["--thinking", "ultra"]);
		expect(result.thinking).toBe(ThinkingLevel.Ultra);
	});

	it("parses model selector suffix :ultra", () => {
		const parsed = parseModelString("openai/gpt-5:ultra");
		expect(parsed?.id).toBe("gpt-5");
		expect(parsed?.thinkingLevel).toBe(ThinkingLevel.Ultra);
	});
});

describe("Ultra mode — Thinking level utilities", () => {
	it("includes Effort.Ultra in THINKING_EFFORTS", () => {
		expect(THINKING_EFFORTS).toContain(Effort.Ultra);
	});

	it("parses effort and thinking level strings", () => {
		expect(parseEffort("ultra")).toBe(Effort.Ultra);
		expect(parseThinkingLevel("ultra")).toBe(ThinkingLevel.Ultra);
		expect(parseConfiguredThinkingLevel("ultra")).toBe(ThinkingLevel.Ultra);
		expect(parseCliThinkingLevel("ultra")).toBe(ThinkingLevel.Ultra);
	});

	it("converts ThinkingLevel.Ultra to Effort.Ultra", () => {
		expect(toReasoningEffort(ThinkingLevel.Ultra)).toBe(Effort.Ultra);
	});

	it("provides correct metadata for Ultra mode", () => {
		const metadata = getThinkingLevelMetadata(ThinkingLevel.Ultra);
		expect(metadata.value).toBe(ThinkingLevel.Ultra);
		expect(metadata.label).toBe("ultra");
		expect(metadata.description).toBe("Maximum reasoning with automatic task delegation");
	});

	it("resolves ThinkingLevel.Ultra for reasoning models", () => {
		expect(resolveThinkingLevelForModel(MOCK_REASONING_MODEL, ThinkingLevel.Ultra)).toBe(ThinkingLevel.Ultra);
	});

	it("resolves undefined for non-reasoning models", () => {
		const nonReasoningModel = { ...MOCK_REASONING_MODEL, reasoning: false };
		expect(resolveThinkingLevelForModel(nonReasoningModel, ThinkingLevel.Ultra)).toBeUndefined();
	});
});

describe("Ultra mode — Model effort resolution & wire mapping", () => {
	it("requireSupportedEffort falls back to highest supported level when model lacks explicit ultra", () => {
		const resolved = requireSupportedEffort(MOCK_REASONING_MODEL, Effort.Ultra);
		expect(resolved).toBe(Effort.XHigh);
	});

	it("requireSupportedEffort keeps Effort.Ultra when model natively supports it", () => {
		const resolved = requireSupportedEffort(MOCK_ULTRA_NATIVE_MODEL, Effort.Ultra);
		expect(resolved).toBe(Effort.Ultra);
	});

	it("clampThinkingLevelForModel clamps Ultra to highest available", () => {
		expect(clampThinkingLevelForModel(MOCK_REASONING_MODEL, Effort.Ultra)).toBe(Effort.XHigh);
		expect(clampThinkingLevelForModel(MOCK_ULTRA_NATIVE_MODEL, Effort.Ultra)).toBe(Effort.Ultra);
	});

	it("mapEffortToGoogleThinkingLevel maps Ultra to HIGH", () => {
		expect(mapEffortToGoogleThinkingLevel(Effort.Ultra)).toBe("HIGH");
	});

	it("mapEffortToAnthropicAdaptiveEffort maps Ultra to max", () => {
		expect(mapEffortToAnthropicAdaptiveEffort(MOCK_ULTRA_NATIVE_MODEL, Effort.Ultra)).toBe("max");
	});
});

describe("Ultra mode — System prompt proactive delegation", () => {
	it("renders proactive multi-agent delegation instructions when ultraMode is true", async () => {
		const result = await buildSystemPrompt({
			ultraMode: true,
			toolNames: ["task"],
		});

		const promptText = result.systemPrompt.join("\n");
		expect(promptText).toContain("Proactive Delegation (Ultra Mode)");
		expect(promptText).toContain("Proactive multi-agent delegation is active.");
		expect(promptText).toContain(
			"Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies.",
		);
		expect(promptText).toContain("Use `task` when parallel work would materially improve speed or quality.");
	});

	it("renders standard delegation when ultraMode is false and eagerTasks is false", async () => {
		const result = await buildSystemPrompt({
			ultraMode: false,
			eagerTasks: false,
			toolNames: ["task"],
		});
		const promptText = result.systemPrompt.join("\n");
		expect(promptText).not.toContain("Proactive Delegation (Ultra Mode)");
		expect(promptText).not.toContain("Proactive multi-agent delegation is active");
	});
});

describe("Ultra mode — AgentSession behavior", () => {
	it("tracks isUltraMode when setThinkingLevel is called with Ultra", async () => {
		const tempDir = TempDir.createSync("@pi-ultra-session-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			initialState: {
				model: MOCK_REASONING_MODEL,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});

		expect(session.isUltraMode()).toBe(false);
		session.setThinkingLevel(ThinkingLevel.Ultra);
		expect(session.isUltraMode()).toBe(true);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Ultra);
		expect(agent.state.thinkingLevel).toBe(Effort.Ultra);
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("cycleThinkingLevel includes Ultra in available cycle", async () => {
		const tempDir = TempDir.createSync("@pi-ultra-cycle-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({
			initialState: {
				model: MOCK_REASONING_MODEL,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.XHigh,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			thinkingLevel: Effort.XHigh,
		});

		const next = session.cycleThinkingLevel();
		expect(next).toBe(ThinkingLevel.Ultra);
		expect(session.isUltraMode()).toBe(true);
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
});
