import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { PromptCachePrefixTracker } from "@oh-my-pi/pi-agent-core/prompt-cache-prefix";
import type { StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

const MODEL = "model-a";

/** Observe and accept a payload, as a successful request does. */
function send(tracker: PromptCachePrefixTracker, payload: unknown, model = MODEL) {
	const observation = tracker.observe(payload, model);
	if (observation) tracker.accept(observation);
	return observation?.result;
}

const user = (text: string, marked = false) => ({
	role: "user",
	content: [{ type: "text", text, ...(marked ? { cache_control: { type: "ephemeral" } } : {}) }],
});
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

function anthropicPayload(messages: unknown[], system = "sys", toolChoice?: unknown) {
	return {
		model: MODEL,
		max_tokens: 1000,
		system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
		tools: [{ name: "read", input_schema: {} }],
		...(toolChoice ? { tool_choice: toolChoice } : {}),
		messages,
	};
}

describe("PromptCachePrefixTracker", () => {
	it("treats an appended turn as intact even though cache markers moved", () => {
		const tracker = new PromptCachePrefixTracker();
		expect(send(tracker, anthropicPayload([user("a", true)]))).toEqual({ status: "first" });
		// The marker moves from the old last message to the new one; max_tokens changes too.
		const next = { ...anthropicPayload([user("a"), assistant("b"), user("c", true)]), max_tokens: 500 };
		expect(send(tracker, next)).toEqual({ status: "intact" });
	});

	it("reports which part omp changed", () => {
		const base = [user("a"), assistant("b")];
		const cases: [unknown, unknown][] = [
			[anthropicPayload([...base, user("c")], "sys v2"), { status: "changed", part: "system" }],
			[
				{ ...anthropicPayload([...base, user("c")]), tools: [{ name: "grep", input_schema: {} }] },
				{ status: "changed", part: "tools" },
			],
			[anthropicPayload([...base, user("c")], "sys", { type: "any" }), { status: "changed", part: "options" }],
			[anthropicPayload([user("a"), assistant("B"), user("c")]), { status: "changed", part: "messages", index: 1 }],
		];
		for (const [payload, expected] of cases) {
			const tracker = new PromptCachePrefixTracker();
			send(tracker, anthropicPayload(base));
			expect(send(tracker, payload)).toEqual(expected as never);
		}
	});

	it("attributes a changed in-list system message to the system prompt", () => {
		const tracker = new PromptCachePrefixTracker();
		send(tracker, { messages: [{ role: "system", content: "now: 10:00" }, user("a")] });
		expect(send(tracker, { messages: [{ role: "system", content: "now: 10:01" }, user("a"), user("b")] })).toEqual({
			status: "changed",
			part: "system",
			index: 0,
		});
	});

	it("ignores moving Bedrock cachePoint blocks", () => {
		const tracker = new PromptCachePrefixTracker();
		const point = { cachePoint: { type: "default" } };
		send(tracker, {
			system: [{ text: "sys" }, point],
			messages: [{ role: "user", content: [{ text: "a" }, point] }],
		});
		const next = {
			system: [{ text: "sys" }, point],
			messages: [
				{ role: "user", content: [{ text: "a" }] },
				{ role: "assistant", content: [{ text: "b" }] },
				{ role: "user", content: [{ text: "c" }, point] },
			],
		};
		expect(send(tracker, next)).toEqual({ status: "intact" });
	});

	it("compares against the last request the provider processed", () => {
		const tracker = new PromptCachePrefixTracker();
		send(tracker, anthropicPayload([user("a")]));
		// Observed but never accepted: the request failed.
		tracker.observe(anthropicPayload([user("a"), assistant("x"), user("retry")], "other"), MODEL);
		expect(send(tracker, anthropicPayload([user("a"), assistant("b")]))).toEqual({ status: "intact" });
	});

	it("restarts the comparison after a model switch or a server-chained delta", () => {
		const tracker = new PromptCachePrefixTracker();
		send(tracker, { input: [user("a")] });
		expect(send(tracker, { input: [user("a"), user("b")] }, "model-b")).toEqual({ status: "first" });
		expect(send(tracker, { previous_response_id: "resp_1", input: [user("c")] }, "model-b")).toEqual({
			status: "intact",
		});
		expect(send(tracker, { input: [user("a"), user("b"), user("c")] }, "model-b")).toEqual({ status: "first" });
	});

	it("skips payloads with no conversation list", () => {
		expect(new PromptCachePrefixTracker().observe({ prompt: "hi" }, MODEL)).toBeUndefined();
	});
});

describe("Agent prompt-cache prefix stamping", () => {
	it("stamps each assistant message with its request's prefix status", async () => {
		const mock = createMockModel({ responses: [{ content: ["one"] }, { content: ["two"] }, { content: ["three"] }] });
		let system = "sys";
		// Providers hand their final wire payload to onPayload before sending.
		const streamFn: StreamFn = async (model, context, options) => {
			await options?.onPayload?.({ system, tools: context.tools ?? [], messages: context.messages }, model);
			return mock.stream(model, context, options);
		};
		const agent = new Agent({ streamFn });

		await agent.prompt("first");
		await agent.prompt("second");
		system = "sys v2";
		await agent.prompt("third");

		const stamps = agent.state.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.map(message => message.promptCachePrefix);
		expect(stamps).toEqual([{ status: "first" }, { status: "intact" }, { status: "changed", part: "system" }]);
	});
});
