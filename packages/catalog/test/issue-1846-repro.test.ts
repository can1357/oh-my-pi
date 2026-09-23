import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";

import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { AssistantMessage, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { xiaomiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const TP_KEY = "tp-ci1p8t1w4e1sbxgyc8v65tnrjbzro287igmvyf25van9mt76";
const SGP_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";

const MIMO_V26_IDS: readonly string[] = ["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"];

function expectMimoV26Contract(model: Model | undefined): void {
	expect(model).toMatchObject({
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		reasoning: true,
		thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] },
		input: ["text", "image"],
	});
}

interface MessageWithReasoningContent {
	reasoning_content?: unknown;
}

function isMessageWithReasoningContent(value: unknown): value is MessageWithReasoningContent {
	return value !== null && typeof value === "object";
}

afterEach(() => {
	vi.restoreAllMocks();
});

function mimoModel(): Model<"openai-completions"> {
	return buildModel({
		id: "mimo-v2.5-pro",
		name: "MiMo V2.5 Pro",
		api: "openai-completions",
		provider: "xiaomi-token-plan-sgp",
		baseUrl: SGP_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	});
}

function assistantToolCall(model: Model<"openai-completions">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1_700_000_000_000,
	};
}

describe("issue #1846: Xiaomi Token Plan provider support", () => {
	it("registers regional Xiaomi Token Plan login providers", () => {
		const providers = getOAuthProviders();

		expect(providers.some(provider => provider.id === "xiaomi-token-plan-sgp")).toBe(true);
		expect(providers.some(provider => provider.id === "xiaomi-token-plan-ams")).toBe(true);
		expect(providers.some(provider => provider.id === "xiaomi-token-plan-cn")).toBe(true);
	});

	it("logs into the selected Token Plan region and stores that provider key", async () => {
		const seen: string[] = [];
		let authUrl = "";
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			seen.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();

		await storage.oauth.login("xiaomi-token-plan-sgp", {
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => TP_KEY,
			fetch: fetchMock,
		});

		expect(seen).toEqual([`${SGP_BASE_URL}/chat/completions`]);
		expect(authUrl).toBe("https://platform.xiaomimimo.com/console/plan-manage");
		expect(store.getApiKey("xiaomi-token-plan-sgp")).toBe(TP_KEY);
		expect(store.getApiKey("xiaomi")).toBeNull();
	});

	it("enriches bare MiMo V2.6 Token Plan discovery rows", async () => {
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request) => {
			return new Response(
				JSON.stringify({
					data: MIMO_V26_IDS.map(id => ({ id, object: "model", owned_by: "xiaomi" })),
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		const opts = xiaomiModelManagerOptions({
			apiKey: TP_KEY,
			providerId: "xiaomi-token-plan-cn",
			tokenPlanRegion: "cn",
			fetch: fetchMock,
		});

		const models = await opts.fetchDynamicModels?.();

		expect(opts.providerId).toBe("xiaomi-token-plan-cn");
		expect(models?.map(model => model.id)).toEqual([...MIMO_V26_IDS]);
		for (const id of MIMO_V26_IDS) {
			const spec = models?.find(model => model.id === id);
			if (!spec) throw new Error(`Missing discovered Xiaomi model ${id}`);
			const model = buildModel(spec);
			expect(model.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1");
			expectMimoV26Contract(model);
			expect(model.compat.requiresReasoningContentForToolCalls).toBe(true);
		}
	});

	it("bundles every curated MiMo V2.6 Token Plan model", () => {
		const bundled = getBundledModels("xiaomi-token-plan-cn");
		for (const id of MIMO_V26_IDS) {
			expectMimoV26Contract(bundled.find(model => model.id === id));
		}
	});

	it("replays MiMo reasoning_content on Token Plan tool-call turns", () => {
		const model = mimoModel();
		const compat = model.compat;
		const thinking: ThinkingContent = {
			type: "thinking",
			thinking: "I need to inspect the file before answering.",
			thinkingSignature: "reasoning_content",
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call_read",
			name: "read",
			arguments: { path: "README.md" },
		};

		const messages = convertMessages(model, { messages: [assistantToolCall(model, [thinking, toolCall])] }, compat);
		const assistant = messages.find(message => message.role === "assistant");

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(isMessageWithReasoningContent(assistant) ? assistant.reasoning_content : undefined).toBe(
			"I need to inspect the file before answering.",
		);
	});
});
