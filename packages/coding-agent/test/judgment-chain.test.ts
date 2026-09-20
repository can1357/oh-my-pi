import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, ChoiceQuestion, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const JEV_PREVIEW = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

const LOCAL = getBundledModel("local", "qwen2.5-1.5b");
const ONLINE = getBundledModel("anthropic", "claude-sonnet-4-6");
const JEV = getBundledModel("typesafe", "jev-latest");
const JEV_VIA_OPENROUTER = getBundledModel("openrouter", "typesafe/jev-1.13");
if (!LOCAL || !ONLINE || !JEV || !JEV_VIA_OPENROUTER) throw new Error("Expected bundled judge models");

const ONLINE_BACKUP = { ...ONLINE, id: "claude-sonnet-judge-backup", name: "Judge Backup" } as Model<Api>;

const BUCKET_QUESTION: ChoiceQuestion<"trivial" | "moderate" | "hard"> = {
	type: "choice",
	instructions: "Choose a coarse task bucket.",
	criteria: { trivial: "mechanical", moderate: "localized", hard: "deep" },
};

const TIER_QUESTION: ChoiceQuestion<"low" | "high"> = {
	type: "choice",
	instructions: "Choose the reasoning tier.",
	criteria: { low: "simple", high: "complex" },
};

function makeRegistry(models: Model<Api>[], keys: Record<string, string> = {}): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.setRuntimeApiKey(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/judgment-chain-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

function reply(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ChainJudge", () => {
	it("falls from TypeSafe to a coarse local question, then to a tiered online question", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": {
				judge: [`${LOCAL.provider}/${LOCAL.id}`, `${ONLINE.provider}/${ONLINE.id}`],
			},
		});
		const registry = makeRegistry([JEV_PREVIEW, LOCAL, ONLINE], {
			typesafe: "ts-key",
			[ONLINE.provider]: "online-key",
		});
		const kinds: string[] = [];
		let localPrompt = "";
		let onlinePrompt = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				expect(String(url)).toBe("https://judge.example.test/v1/systemone");
				const body = JSON.parse(String(init?.body)) as { model: string };
				expect(body.model).toBe("jev-preview");
				return new Response("rejected", { status: 400 });
			}),
		);
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_model, promptText) => {
			localPrompt = promptText;
			return "not a bucket";
		});
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
			onlinePrompt = context.systemPrompt?.join("\n") ?? "";
			const response = reply(model, "level: high");
			options?.onAttempt?.(response);
			return response;
		});
		const onUsage = vi.fn();
		const judge = new ChainJudge({ settings, registry, onUsage });

		const answer = await judge.withCandidate(async (candidate, kind) => {
			kinds.push(kind);
			if (kind === "local") {
				const result = await candidate.judge({
					state: "refactor the scheduler",
					questions: { bucket: BUCKET_QUESTION },
				});
				return result.answers.bucket.choice;
			}
			const result = await candidate.judge({
				state: "refactor the scheduler",
				questions: { level: TIER_QUESTION },
			});
			return result.answers.level.choice;
		});

		expect(answer).toBe("high");
		expect(kinds).toEqual(["typesafe", "local", "online"]);
		expect(localPrompt).toContain("trivial");
		expect(localPrompt).toContain("moderate");
		expect(localPrompt).toContain("hard");
		expect(onlinePrompt).toContain("low");
		expect(onlinePrompt).toContain("high");
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "judge", provider: ONLINE.provider, model: ONLINE.id }),
		);
	});

	it("sends the selected TypeSafe model and base URL and attributes its usage", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = makeRegistry([JEV_PREVIEW], { typesafe: "ts-key" });
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				expect(String(url)).toBe("https://judge.example.test/v1/systemone");
				const body = JSON.parse(String(init?.body)) as { model: string };
				expect(body.model).toBe("jev-preview");
				return Response.json({
					model: "jev-1.13.0",
					answers: {
						level: { type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.9 }, confidence: 0.8 },
					},
					usage: { input_tokens: 8, output_tokens: 2 },
				});
			}),
		);
		const onUsage = vi.fn();

		const result = await new ChainJudge({ settings, registry, onUsage }).judge({
			state: "redesign the scheduler",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("high");
		expect(result.model).toBe("jev-1.13.0");
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "typesafe", provider: "typesafe", model: "jev-preview" }),
		);
	});

	it("skips a candidate whose account rejected the previous judgment instead of re-paying it every call", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": { judge: [`${ONLINE.provider}/${ONLINE.id}`] },
		});
		const registry = makeRegistry([JEV_PREVIEW, ONLINE], { typesafe: "ts-key", [ONLINE.provider]: "online-key" });
		const typesafeCalls = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(
				asGlobalFetch(async () => Response.json({ detail: { error_type: "billing_error" } }, { status: 402 })),
			);
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => reply(model, "level: low"));
		const request = { state: "rename a local", questions: { level: TIER_QUESTION } };

		const first = await new ChainJudge({ settings, registry }).judge(request);
		const second = await new ChainJudge({ settings, registry }).judge(request);

		expect(first.answers.level.choice).toBe("low");
		expect(second.answers.level.choice).toBe("low");
		expect(typesafeCalls).toHaveBeenCalledTimes(1);
	});

	it("reaches Jev through OpenRouter's Decisions API when only an OpenRouter key is stored", async () => {
		// No judge role configured: the built-in chain is TypeSafe, then Jev via
		// OpenRouter, then the chat roles. Without a TypeSafe key the native
		// candidate is skipped, not attempted.
		const settings = Settings.isolated({});
		const registry = makeRegistry([JEV, JEV_VIA_OPENROUTER, ONLINE], {
			openrouter: "or-key",
			[ONLINE.provider]: "online-key",
		});
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				urls.push(String(url));
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer or-key");
				const body = JSON.parse(String(init?.body)) as { model: string };
				expect(body.model).toBe("typesafe/jev-1.13");
				return Response.json({
					model: "typesafe/jev-1.13",
					answers: {
						level: { type: "choice", choice: "low", probabilities: { low: 0.9, high: 0.1 }, confidence: 0.8 },
					},
					usage: { input_tokens: 8, output_tokens: 2 },
				});
			}),
		);
		const online = vi.spyOn(ai, "completeSimple");
		const onUsage = vi.fn();

		const result = await new ChainJudge({ settings, registry, onUsage }).judge({
			state: "rename a variable",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("low");
		expect(result.provider).toBe("openrouter");
		expect(urls).toEqual(["https://openrouter.ai/api/alpha/decisions"]);
		expect(online).not.toHaveBeenCalled();
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "typesafe", provider: "openrouter", model: "typesafe/jev-1.13" }),
		);
	});

	it("prefers TypeSafe's own API over the OpenRouter route when both keys are stored", async () => {
		const settings = Settings.isolated({});
		const registry = makeRegistry([JEV, JEV_VIA_OPENROUTER], { typesafe: "ts-key", openrouter: "or-key" });
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async url => {
				urls.push(String(url));
				return Response.json({
					model: "jev-1.13.0",
					answers: {
						level: { type: "choice", choice: "high", probabilities: { low: 0.2, high: 0.8 }, confidence: 0.7 },
					},
					usage: { input_tokens: 8, output_tokens: 2 },
				});
			}),
		);

		const result = await new ChainJudge({ settings, registry }).judge({
			state: "redesign the scheduler",
			questions: { level: TIER_QUESTION },
		});

		expect(result.provider).toBe("typesafe");
		expect(urls).toEqual(["https://api.typesafe.ai/v1/systemone"]);
	});
	it("propagates caller abort without attempting a fallback", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` },
			"retry.fallbackChains": { judge: [`${LOCAL.provider}/${LOCAL.id}`] },
		});
		const registry = makeRegistry([ONLINE, LOCAL], { [ONLINE.provider]: "online-key" });
		const controller = new AbortController();
		vi.spyOn(registry, "getApiKey").mockImplementation(async () => {
			controller.abort(new Error("caller stopped"));
			throw new Error("credential refresh interrupted");
		});
		const local = vi.spyOn(tinyModelClient, "complete");

		await expect(
			new ChainJudge({ settings, registry }).judge(
				{ state: "x", questions: { level: TIER_QUESTION } },
				{ signal: controller.signal },
			),
		).rejects.toThrow("caller stopped");
		expect(local).not.toHaveBeenCalled();
	});

	it("does not append a session model already present in the configured chain", async () => {
		const settings = Settings.isolated({
			modelRoles: { judge: `${ONLINE.provider}/${ONLINE.id}` },
			"retry.fallbackChains": { judge: [`${ONLINE_BACKUP.provider}/${ONLINE_BACKUP.id}`] },
		});
		const registry = makeRegistry([ONLINE, ONLINE_BACKUP], { [ONLINE.provider]: "online-key" });
		const attempted: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
			attempted.push(model.id);
			if (model.id === ONLINE.id) return reply(model, "unparseable");
			return reply(model, "level: low");
		});

		const result = await new ChainJudge({ settings, registry, sessionModel: ONLINE }).judge({
			state: "rename a local",
			questions: { level: TIER_QUESTION },
		});

		expect(result.answers.level.choice).toBe("low");
		// The primary's three entries are its initial completion plus two format
		// corrections. A duplicated session fallback would add another three.
		expect(attempted).toEqual([ONLINE.id, ONLINE.id, ONLINE.id, ONLINE_BACKUP.id]);
	});
});
