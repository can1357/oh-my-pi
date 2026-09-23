import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	classifyUnexpectedStop,
	isUnexpectedStopCandidate,
} from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

function makeAssistantMessage(options: {
	stopReason: AssistantMessage["stopReason"];
	content: AssistantMessage["content"];
}): AssistantMessage {
	return {
		role: "assistant",
		provider: "mock",
		model: "mock/mock",
		api: "mock" as unknown as AssistantMessage["api"],
		content: options.content,
		stopReason: options.stopReason,
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

afterEach(() => {
	vi.restoreAllMocks();
});

function makeRegistry(models: Model<Api>[], keys: Record<string, string> = {}): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/unexpected-stop-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

describe("isUnexpectedStopCandidate", () => {
	it("returns true for a text-only stop", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "text", text: "I should do the same for the JS eval worker." }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(true);
	});

	it("returns false when stopReason is not stop", () => {
		const length = makeAssistantMessage({
			stopReason: "length",
			content: [{ type: "text", text: "I should continue." }],
		});
		expect(isUnexpectedStopCandidate(length)).toBe(false);

		const aborted = makeAssistantMessage({
			stopReason: "aborted",
			content: [{ type: "text", text: "I should continue." }],
		});
		expect(isUnexpectedStopCandidate(aborted)).toBe(false);
	});

	it("returns false when the message contains a toolCall", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [
				{ type: "text", text: "I will run the tests now." },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
			],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});

	it("returns false when the text is only whitespace", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "text", text: "   \n\t  " }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});

	it("returns false for an empty stop", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});

	// The signature is replay metadata, not delivery: reasoning-only stops belong
	// to the empty-stop path with or without one. This detector must not claim a
	// turn that handler already owns — on a capped empty stop the handler FALLS
	// THROUGH to here, so claiming it would schedule a recovery after the budget
	// is spent and break "one terminal failure and stops".
	it("returns false for a signed thinking-only stop (empty-stop path owns reasoning-only)", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "thinking", thinking: " 响应", thinkingSignature: "reasoning_content" }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});

	it("returns false for an unsigned thinking-only stop (empty-stop path owns it)", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "responseAll four reviewers complete." }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});

	it("returns false when the thinking block is only whitespace", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "   \n\t  ", thinkingSignature: "reasoning_content" }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(false);
	});
});

describe("classifyUnexpectedStop", () => {
	it("uses a reasoning-safe online classifier budget when the catalog disables reasoning", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const model = { ...baseModel, reasoning: false };
		const settings = Settings.isolated({ modelRoles: { judge: `${model.provider}/${model.id}` } });
		const registry = makeRegistry([model], { [model.provider]: "test-key" });
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "YES" }],
		} as never);

		const result = await classifyUnexpectedStop("I will continue with the next command.", {
			settings,
			registry,
			sessionId: "session-1",
		});
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { disableReasoning?: boolean; maxTokens?: number }
			| undefined;

		expect(result).toBe(true);
		// Must exceed Anthropic's 1024-token minimum thinking budget so a LiteLLM/Vertex
		// Anthropic route (which downgrades the disabled request to the lowest reasoning
		// effort) still satisfies `max_tokens > thinking.budget_tokens` (issue #8610).
		expect(options?.disableReasoning).toBe(true);
		expect(options?.maxTokens).toBe(4096);
		expect(options?.maxTokens).toBeGreaterThan(1024);
	});

	it("uses the selected TypeSafe judge and thresholds the yes-probability", async () => {
		const jev = {
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
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = makeRegistry([jev], { typesafe: "ts-key" });
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (url, init) => {
				expect(String(url)).toBe("https://judge.example.test/v1/systemone");
				const body = JSON.parse(String(init?.body)) as {
					model: string;
					questions: Record<string, { type: string }>;
				};
				expect(body.model).toBe("jev-preview");
				expect(body.questions.stopped.type).toBe("noul");
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ts-key");
				return Response.json({
					model: "jev-latest",
					answers: { stopped: { type: "noul", noul: 0.31 } },
					usage: { input_tokens: 10, output_tokens: 1 },
				});
			}),
		);

		const result = await classifyUnexpectedStop("Let me run the tests next.", {
			settings,
			registry,
			sessionId: "session-1",
		});

		expect(result).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("returns undefined instead of throwing when every judge fails", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "missing/judge" } });
		const registry = makeRegistry([]);

		expect(await classifyUnexpectedStop("Doing that now.", { settings, registry, sessionId: "s" })).toBeUndefined();
	});
});
