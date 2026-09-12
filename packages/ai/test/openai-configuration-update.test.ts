import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	createOpenAIEffortControlState,
	planStableOpenAIEffort,
} from "@oh-my-pi/pi-ai/providers/openai-configuration-update";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";

/** Loose wire item for planner tests: replayed items carry output-only `status`/`id`. */
interface TestItem {
	type?: string;
	role?: string;
	id?: string;
	status?: string;
	[key: string]: unknown;
}

const user = (text: string): TestItem => ({ role: "user", content: [{ type: "input_text", text }] });
const assistant = (id: string, text: string): TestItem => ({
	type: "message",
	id,
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text }],
});
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });

describe("planStableOpenAIEffort", () => {
	it("pins the request-level effort to the baseline and carries changes as configuration_update items", () => {
		const state = createOpenAIEffortControlState<string>();

		const first = [user("one")];
		expect(planStableOpenAIEffort(state, first, "low")).toBe("low");
		expect(first).toEqual([user("one")]);

		// Same effort next turn: nothing is inserted.
		const second = [user("one"), assistant("msg_1", "a"), user("two")];
		expect(planStableOpenAIEffort(state, second, "low")).toBe("low");
		expect(second).toHaveLength(3);

		// Effort changes on a new user turn: request-level stays "low", the
		// update lands before the user message it applies to.
		const third = [user("one"), assistant("msg_1", "a"), user("two"), assistant("msg_2", "b"), user("three")];
		expect(planStableOpenAIEffort(state, third, "high")).toBe("low");
		expect(third.map(item => item.type ?? item.role)).toEqual([
			"user",
			"message",
			"user",
			"message",
			"configuration_update",
			"user",
		]);
		expect(third[4]).toEqual(update("high"));

		// Replayed in position on the next request; the live response item's
		// output-only `status` does not disturb the anchor.
		const fourth = [
			user("one"),
			assistant("msg_1", "a"),
			user("two"),
			{ ...assistant("msg_2", "b"), status: "in_progress" },
			user("three"),
			assistant("msg_3", "c"),
			user("four"),
		];
		expect(planStableOpenAIEffort(state, fourth, "high")).toBe("low");
		expect(fourth[4]).toEqual(update("high"));
		expect(fourth.filter(item => item.type === "configuration_update")).toHaveLength(1);
	});

	it("appends the update after the latest tool result when the level changes inside a tool loop", () => {
		const state = createOpenAIEffortControlState<string>();
		planStableOpenAIEffort(state, [user("one")], "medium");

		const loop: TestItem[] = [
			user("one"),
			{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "contents" },
		];
		expect(planStableOpenAIEffort(state, loop, "xhigh")).toBe("medium");
		expect(loop.at(-1)).toEqual(update("xhigh"));

		// A later change at a different position stays separate — never adjacent.
		const next: TestItem[] = [
			user("one"),
			{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "contents" },
			assistant("msg_1", "done"),
			user("two"),
		];
		expect(planStableOpenAIEffort(state, next, "low")).toBe("medium");
		expect(next.map(item => item.type ?? item.role)).toEqual([
			"user",
			"function_call",
			"function_call_output",
			"configuration_update",
			"message",
			"configuration_update",
			"user",
		]);
	});

	it("drops a change that returns to the effort already in force at that position", () => {
		const state = createOpenAIEffortControlState<string>();
		planStableOpenAIEffort(state, [user("one")], "low");
		const turn = [user("one"), assistant("msg_1", "a"), user("two")];
		planStableOpenAIEffort(state, turn, "high");
		expect(turn).toHaveLength(4);

		// Toggled back before the request went out: the redundant item is gone.
		const again = [user("one"), assistant("msg_1", "a"), user("two")];
		expect(planStableOpenAIEffort(state, again, "low")).toBe("low");
		expect(again).toHaveLength(3);
	});

	it("re-baselines from the requested effort when the history under a transition is rewritten", () => {
		const state = createOpenAIEffortControlState<string>();
		planStableOpenAIEffort(state, [user("one")], "low");
		planStableOpenAIEffort(state, [user("one"), assistant("msg_1", "a"), user("two")], "high");

		// Compaction replaced the transcript: no stale update is replayed and the
		// request-level effort becomes the live one.
		const compacted = [user("summary"), user("three")];
		expect(planStableOpenAIEffort(state, compacted, "high")).toBe("high");
		expect(compacted).toHaveLength(2);
		expect(state.baseEffort).toBe("high");
	});
});

describe("openai-codex configuration_update", () => {
	const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function turnContext(messages: Context["messages"]): Context {
		return { systemPrompt: ["You are a helpful assistant."], messages };
	}

	const firstUser = { role: "user" as const, content: "one", timestamp: 1 };
	const firstAssistant = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "a" }],
		api: "openai-codex-responses" as const,
		provider: "openai-codex",
		model: "gpt-6-astra",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
	const secondUser = { role: "user" as const, content: "two", timestamp: 3 };

	it("keeps reasoning.effort stable for gpt-6-astra and inserts the update before the new user turn", async () => {
		const model = createCodexModel("gpt-6-astra");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = { apiKey: "token", sessionId: "astra-session", providerSessionState };

		const first = await buildTransformedCodexRequestBody(model, turnContext([firstUser]), {
			...options,
			reasoning: "low",
		});
		expect(first.reasoning?.effort).toBe("low");

		const second = await buildTransformedCodexRequestBody(
			model,
			turnContext([firstUser, firstAssistant, secondUser]),
			{ ...options, reasoning: "high" },
		);
		expect(second.reasoning?.effort).toBe("low");
		const input = second.input ?? [];
		const updateIndex = input.findIndex(item => item.type === "configuration_update");
		expect(updateIndex).toBeGreaterThan(0);
		expect(input[updateIndex]).toEqual(update("high"));
		expect(input[updateIndex + 1]?.role).toBe("user");
	});

	it("sends the changed effort at the request level for models without configuration_update", async () => {
		const model = createCodexModel("gpt-5.6-sol");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = { apiKey: "token", sessionId: "sol-session", providerSessionState };

		await buildTransformedCodexRequestBody(model, turnContext([firstUser]), { ...options, reasoning: "low" });
		const second = await buildTransformedCodexRequestBody(
			model,
			turnContext([firstUser, firstAssistant, secondUser]),
			{ ...options, reasoning: "high" },
		);
		expect(second.reasoning?.effort).toBe("high");
		expect(second.input?.some(item => item.type === "configuration_update")).toBe(false);
	});
});

describe("openai-responses configuration_update", () => {
	const model: Model<"openai-responses"> = buildModel({
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	});

	function sse(id: string): Response {
		const events = [
			{ type: "response.created", response: { id, status: "in_progress" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: `msg_${id}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id,
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it("pins the request-level effort and replays the update on the platform Responses endpoint", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const bodies: Array<Record<string, unknown>> = [];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {});
			return sse(`resp_${bodies.length}`);
		});
		const run = (context: Context, reasoning: "low" | "high") =>
			streamOpenAIResponses(model, context, {
				apiKey: "test-key",
				fetch: fetchMock,
				providerSessionState,
				sessionId: "astra-responses-session",
				reasoning,
			}).result();

		const firstUser = { role: "user" as const, content: "first", timestamp: 1 };
		const firstResponse = await run({ systemPrompt: ["stable system"], messages: [firstUser] }, "low");
		await run(
			{
				systemPrompt: ["stable system"],
				messages: [firstUser, firstResponse, { role: "user", content: "second", timestamp: 2 }],
			},
			"high",
		);

		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.reasoning).toEqual({ effort: "low", summary: "auto" });
		expect(bodies[1]?.reasoning).toEqual({ effort: "low", summary: "auto" });
		const input = bodies[1]?.input;
		if (!Array.isArray(input)) throw new Error("expected input array");
		const updateIndex = input.findIndex(item => item.type === "configuration_update");
		expect(input[updateIndex]).toEqual(update("high"));
		expect(input[updateIndex + 1]?.role).toBe("user");
	});
});
