import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	classifyUnexpectedStop,
	isUnexpectedStopCandidate,
} from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
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

	it("returns true for a signed thinking-only stop", () => {
		const message = makeAssistantMessage({
			stopReason: "stop",
			content: [{ type: "thinking", thinking: " 响应", thinkingSignature: "reasoning_content" }],
		});
		expect(isUnexpectedStopCandidate(message)).toBe(true);
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
		const settings = {
			get(path: string) {
				if (path === "providers.unexpectedStopModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				return role === "smol" ? `${model.provider}/${model.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			authStorage: { hasAuth: () => false },
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
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

	it("routes to TypeSafe when a credential exists and thresholds the yes-probability", async () => {
		const settings = {
			get(path: string) {
				if (path === "providers.unexpectedStopModel") return "online";
				return undefined;
			},
			getModelRole() {
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			authStorage: { hasAuth: (provider: string) => provider === "typesafe", resolver: () => "ts-key" },
			getAvailable: () => [],
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
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
		const settings = {
			get(path: string) {
				if (path === "providers.unexpectedStopModel") return "online";
				return undefined;
			},
			getModelRole() {
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = { authStorage: { hasAuth: () => false }, getAvailable: () => [] } as never;

		expect(await classifyUnexpectedStop("Doing that now.", { settings, registry, sessionId: "s" })).toBeUndefined();
	});
});
