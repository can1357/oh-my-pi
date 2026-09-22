import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { stepfunCnModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

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
	await storage.reload();
	await storage.login("stepfun-cn", { onAuth: () => {}, onPrompt: async () => PLAN_KEY, fetch: respond });
	return store;
}

describe("stepfun-cn Step Plan provider", () => {
	it("reads only the Step Plan key variable, never the pay-as-you-go STEP_API_KEY", () => {
		withEnv("STEPFUN_CN_API_KEY", undefined, () => {
			withEnv("STEP_API_KEY", "pay-as-you-go-key", () => {
				expect(getEnvApiKey("stepfun-cn")).toBeUndefined();
			});
		});
		withEnv("STEPFUN_CN_API_KEY", PLAN_KEY, () => {
			expect(getEnvApiKey("stepfun-cn")).toBe(PLAN_KEY);
		});
	});

	it("validates a pasted key with a one-token chat call on the Step Plan path", async () => {
		const probes: { url: string; body: unknown }[] = [];
		const store = await loginWithProbe(
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				probes.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return Response.json({ choices: [] });
			}),
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
		const refused = loginWithProbe(vi.fn(async () => Response.json({ error: "invalid key" }, { status: 401 })));
		await expect(refused).rejects.toThrow("401");

		const unjudged = await loginWithProbe(
			vi.fn(async () => Response.json({ error: "unsupported parameter" }, { status: 400 })),
		);
		expect(unjudged.getApiKey("stepfun-cn")).toBe(PLAN_KEY);
	});

	it("offers only low and high on the step-3.5 pair, where the family ladder has medium", () => {
		expect(getSupportedEfforts(stepPlanModel("step-3.5-flash"))).toEqual([Effort.Low, Effort.High]);
		expect(getSupportedEfforts(stepPlanModel("step-3.5-flash-2603"))).toEqual([Effort.Low, Effort.High]);
		expect(getSupportedEfforts(stepPlanModel("step-3.7-flash"))).toEqual([Effort.Low, Effort.Medium, Effort.High]);
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

	it("keeps reviewed rows for known ids, reads a new id's own metadata, and drops speech SKUs", async () => {
		const requested: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			requested.push(url);
			if (url !== `${STEP_PLAN_BASE_URL}/models`) return new Response("not found", { status: 404 });
			return Response.json({
				object: "list",
				data: [
					// A listing that claims medium must not widen the documented ladder.
					{
						id: "step-3.5-flash",
						enable_reason: true,
						max_input_tokens: 262_144,
						reasoning_effort_support_list: ["low", "medium", "high"],
					},
					{
						id: "step-6-flash",
						enable_reason: true,
						max_input_tokens: 512_000,
						reasoning_effort_support_list: ["low", "high"],
					},
					{ id: "step-new-chat" },
					{ id: "stepaudio-2.5-chat" },
					{ id: "stepaudio-2.5-realtime" },
					{ id: "stepaudio-2.5-tts" },
					{ id: "stepaudio-2.5-asr" },
				],
			});
		});

		const discovered = await stepfunCnModelManagerOptions({
			apiKey: PLAN_KEY,
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		const byId = new Map(discovered?.map(model => [model.id, model]));

		expect(requested).toContain(`${STEP_PLAN_BASE_URL}/models`);
		expect([...byId.keys()].sort()).toEqual(["step-3.5-flash", "step-6-flash", "step-new-chat"]);
		expect(byId.get("step-3.5-flash")?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
		expect(byId.get("step-3.5-flash")?.contextWindow).toBe(256_000);
		expect(byId.get("step-6-flash")).toMatchObject({
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			contextWindow: 512_000,
			baseUrl: STEP_PLAN_BASE_URL,
		});
		expect(byId.get("step-new-chat")).toMatchObject({ reasoning: false, contextWindow: null });
	});
});
