import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	isStepfunCnChatModelId,
	stepfunCnModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";

const STEP_PLAN_BASE_URL = "https://api.stepfun.com/step_plan/v1";
const PLAN_KEY = "step-plan-test-key";

afterEach(() => {
	vi.restoreAllMocks();
});

function withEnv(key: string, value: string | undefined, run: () => void): void {
	const previous = Bun.env[key];
	if (value === undefined) {
		delete Bun.env[key];
	} else {
		Bun.env[key] = value;
	}
	try {
		run();
	} finally {
		if (previous === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = previous;
		}
	}
}

/** A Step Plan row as discovery hands it to `buildModel`: no authored thinking or compat. */
function stepPlanModel(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "stepfun-cn",
		baseUrl: STEP_PLAN_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: null,
	});
}

function assistantTurn(model: Model<"openai-completions">, content: AssistantMessage["content"]): AssistantMessage {
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

function readToolCall(id: string): ToolCall {
	return { type: "toolCall", id, name: "read", arguments: { path: "README.md" } };
}

function replayedReasoning(model: Model<"openai-completions">, content: AssistantMessage["content"]): unknown {
	const messages = convertMessages(model, { messages: [assistantTurn(model, content)] }, model.compat);
	const assistant: object | undefined = messages.find(message => message.role === "assistant");
	return assistant && "reasoning_content" in assistant ? assistant.reasoning_content : undefined;
}

async function loginWithProbe(respond: FetchImpl): Promise<SqliteAuthCredentialStore> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	await storage.credentials.reload();
	await storage.oauth.login("stepfun-cn", { onAuth: () => {}, onPrompt: async () => PLAN_KEY, fetch: respond });
	return store;
}

describe("stepfun-cn Step Plan provider", () => {
	it("reads only STEPFUN_CN_API_KEY", () => {
		withEnv("STEPFUN_CN_API_KEY", undefined, () => {
			withEnv("STEP_API_KEY", "pay-as-you-go-key", () => {
				withEnv("STEPFUN_API_KEY", "ai-platform-key", () => {
					expect(getEnvApiKey("stepfun-cn")).toBeUndefined();
				});
			});
		});
		withEnv("STEPFUN_CN_API_KEY", PLAN_KEY, () => {
			expect(getEnvApiKey("stepfun-cn")).toBe(PLAN_KEY);
		});
	});

	it("bundles the Step Plan roster with credit prices and the replay contract", () => {
		const byId = new Map(getBundledModels("stepfun-cn").map(model => [model.id, model]));
		expect([...byId.keys()].sort()).toEqual([
			"step-3.5-flash",
			"step-3.5-flash-2603",
			"step-3.7-flash",
			"step-5-preview",
			"step-router-v1",
		]);

		const preview = byId.get("step-5-preview");
		expect(preview?.baseUrl).toBe(STEP_PLAN_BASE_URL);
		expect(preview?.contextWindow).toBe(1_000_000);
		expect(preview?.maxTokens).toBe(64_000);
		expect(preview?.input).toEqual(["text", "image"]);
		expect(preview?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(preview?.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);

		expect(byId.get("step-3.7-flash")?.input).toEqual(["text", "image"]);
		expect(byId.get("step-3.7-flash")?.contextWindow).toBe(256_000);
		expect(byId.get("step-3.5-flash")?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(byId.get("step-3.5-flash-2603")?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(byId.get("step-3.5-flash")?.input).toEqual(["text"]);
		expect(byId.get("step-router-v1")?.contextWindow).toBe(256_000);
		expect(byId.get("step-router-v1")?.input).toEqual(["text"]);

		expect(providerEntry("stepfun-cn")?.skipCrossProviderReferenceFills).toBe(true);
		for (const model of byId.values()) {
			const compat = model.compat as ResolvedOpenAICompat;
			expect(compat.maxTokensField).toBe("max_tokens");
			expect(compat.requiresReasoningContentForToolCalls).toBe(true);
			expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("validates a pasted key with a one-token chat call on the Step Plan path", async () => {
		const probes: { url: string; body: unknown }[] = [];
		const store = await loginWithProbe(
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				probes.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return Response.json({ choices: [] });
			}) as unknown as FetchImpl,
		);

		expect(probes).toEqual([
			{
				url: `${STEP_PLAN_BASE_URL}/chat/completions`,
				body: expect.objectContaining({ model: "step-3.5-flash", max_tokens: 1 }),
			},
		]);
		expect(probes[0]?.body).not.toHaveProperty("max_completion_tokens");
		expect(store.getApiKey("stepfun-cn")).toBe(PLAN_KEY);
	});

	it("rejects a key only when the probe reports an auth failure", async () => {
		const refused = loginWithProbe(
			vi.fn(async () => Response.json({ error: "invalid key" }, { status: 401 })) as unknown as FetchImpl,
		);
		await expect(refused).rejects.toThrow("401");

		const unjudged = await loginWithProbe(
			vi.fn(async () => Response.json({ error: "unsupported parameter" }, { status: 400 })) as unknown as FetchImpl,
		);
		expect(unjudged.getApiKey("stepfun-cn")).toBe(PLAN_KEY);
	});

	it("offers only low and high on the step-3.5 pair, where the family ladder has medium", () => {
		expect(getSupportedEfforts(stepPlanModel("step-3.5-flash"))).toEqual([Effort.Low, Effort.High]);
		expect(getSupportedEfforts(stepPlanModel("step-3.5-flash-2603"))).toEqual([Effort.Low, Effort.High]);
		expect(getSupportedEfforts(stepPlanModel("step-3.7-flash"))).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(getSupportedEfforts(stepPlanModel("step-router-v1"))).toEqual([Effort.Low, Effort.Medium, Effort.High]);
	});

	it("replays reasoning_content on tool-call turns and never sends a synthetic placeholder", () => {
		// step-router-v1 can route tool work to deepseek-v4-pro, which needs the
		// prior reasoning back and rejects a made-up placeholder.
		const model = stepPlanModel("step-router-v1");
		const thinking: ThinkingContent = {
			type: "thinking",
			thinking: "Read the file before answering.",
			thinkingSignature: "reasoning_content",
		};

		expect(replayedReasoning(model, [thinking, readToolCall("call_read")])).toBe("Read the file before answering.");
		expect(replayedReasoning(model, [readToolCall("call_bare")])).toBe("");
	});

	it("keeps seeded rows for known ids, reads a new id's advertised ladder, and drops speech SKUs", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				object: "list",
				data: [
					// Listing ceilings and a wider effort ladder must not rewrite the seed.
					{
						id: "step-3.5-flash",
						context_length: 12_345,
						max_completion_tokens: 2,
						max_input_tokens: 262_144,
						reasoning_effort_support_list: ["low", "medium", "high"],
					},
					{
						id: "step-6-flash",
						max_input_tokens: 512_000,
						reasoning_effort_support_list: ["low", "high"],
					},
					{ id: "step-new-chat" },
					{ id: "stepaudio-2.5-chat" },
					{ id: "stepaudio-2.5-realtime" },
					{ id: "step-image-edit-2" },
					{ id: "step-tts-2" },
				],
			}),
		) as unknown as FetchImpl;

		const options = stepfunCnModelManagerOptions({ apiKey: PLAN_KEY, fetch: fetchMock });
		const discovered = await options.fetchDynamicModels?.();
		const byId = new Map(discovered?.map(model => [model.id, model]));

		expect(fetchMock).toHaveBeenCalledWith(
			`${STEP_PLAN_BASE_URL}/models`,
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: `Bearer ${PLAN_KEY}` }),
			}),
		);
		expect([...byId.keys()].sort()).toEqual(["step-3.5-flash", "step-6-flash", "step-new-chat"]);
		expect(byId.get("step-3.5-flash")?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(byId.get("step-3.5-flash")?.contextWindow).toBe(256_000);
		expect(byId.get("step-3.5-flash")?.maxTokens).toBeNull();
		expect(byId.get("step-6-flash")).toMatchObject({
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			// `max_input_tokens` is not a generic `/models` field. An id the seed
			// does not know yet keeps the generic null window until it is seeded.
			contextWindow: null,
			baseUrl: STEP_PLAN_BASE_URL,
		});
		expect(byId.get("step-new-chat")).toMatchObject({ reasoning: false, contextWindow: null });
		expect(byId.get("step-new-chat")?.thinking).toBeUndefined();
	});

	it("drops a retired seed id through the manager, not only the authoritative flag", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-stepfun-cn-prune-"));
		const dbPath = path.join(tempDir, "models.db");
		const liveRoster = getBundledModels("stepfun-cn").filter(model => model.id !== "step-3.5-flash");
		const options = {
			...stepfunCnModelManagerOptions({
				apiKey: PLAN_KEY,
				fetch: (async () =>
					new Response(JSON.stringify({ data: liveRoster.map(model => ({ id: model.id })) }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})) as unknown as FetchImpl,
			}),
			staticModels: getBundledModels("stepfun-cn"),
			cacheDbPath: dbPath,
		};

		try {
			expect(options.dynamicModelsAuthoritative).toBe(true);
			const result = await resolveProviderModels(options, "online");
			expect(result.models.map(model => model.id)).not.toContain("step-3.5-flash");
			expect(result.models.map(model => model.id)).toContain("step-5-preview");
			expect(result.stale).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("classifies Step Plan non-chat SKUs without touching chat ids", () => {
		expect(isStepfunCnChatModelId("step-5-preview")).toBe(true);
		expect(isStepfunCnChatModelId("step-router-v1")).toBe(true);
		expect(isStepfunCnChatModelId("STEP-5-PREVIEW")).toBe(true);
		expect(isStepfunCnChatModelId("stepaudio-2.5-chat")).toBe(false);
		expect(isStepfunCnChatModelId("step-image-edit-2")).toBe(false);
		expect(isStepfunCnChatModelId("step-tts-2")).toBe(false);
		expect(isStepfunCnChatModelId("   ")).toBe(false);
	});
});
