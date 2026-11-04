import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { Context, Tool, ToolResultMessage } from "../src/types";
import { type CapturedRequest, captureFetch, factoryModel, responsesChunks, workosJwt } from "./helpers/factory-droid";

/**
 * Responses-wire request facts the native parity projection cannot see: the
 * OpenAI-Platform header, session-derived identifiers and caller overrides.
 */

const readTool: Tool = {
	name: "Read",
	description: "Read a file",
	parameters: type({ path: "string" }),
};

/** Credential carrying the WorkOS user id (`sub`) and org claims. */
const WORKOS_TOKEN_WITH_USER = workosJwt({ sub: "user_123", external_org_id: "org-1" });

function context() {
	return {
		systemPrompt: ["OMP prompt"],
		messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
		tools: [readTool],
	};
}

async function capture(id: string, options: Parameters<typeof streamFactoryDroid>[2] = {}, upstream?: string) {
	const captured: CapturedRequest[] = [];
	await streamFactoryDroid(factoryModel(id, upstream ? [upstream] : undefined), context(), {
		apiKey: WORKOS_TOKEN_WITH_USER,
		fetch: captureFetch(captured, responsesChunks("GPT_OK")),
		sessionId: "sess-1",
		reasoning: Effort.Medium,
		...options,
	}).result();
	return captured[0];
}

describe("Factory Droid responses wire", () => {
	it.each([
		["gpt-5.2", "openai", "org-bHuLtG1fGmYk5YaOihAAXFBw"],
		["gpt-5.6-sol", "azure_openai", "org-bHuLtG1fGmYk5YaOihAAXFBw"],
		["gpt-5.6-terra", "bedrock_openai", undefined],
		["grok-4.7", "xai", undefined],
	] as const)("%s via %s sends OpenAI-Platform %s", async (id, upstream, platform) => {
		const request = await capture(id, {}, upstream);
		expect(request.headers["x-api-provider"]).toBe(upstream);
		expect(request.headers["openai-platform"] as string | undefined).toBe(platform);
	});

	it("derives safety_identifier from the session, never the token's user or org claims", async () => {
		const request = await capture("gpt-5.6-sol", {}, "openai");
		// Native computes userId ?? sessionId but never passes userId — the wire value is the session id,
		// deterministically mapped to a v4-shaped uuid (shape pinned; exact bytes are algorithm-internal).
		expect(request.body.safety_identifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(request.body.safety_identifier).toBe(request.body.prompt_cache_key);
	});

	it("an explicit caller toolChoice is forwarded as-is", async () => {
		const request = await capture("gpt-5.2", { toolChoice: "none" });
		expect(request.body.tool_choice).toBe("none");
	});

	it("never forwards caller temperature on this wire", async () => {
		const request = await capture("gpt-5.2", { temperature: 0.3 });
		expect(request.body.temperature).toBeUndefined();
	});

	it.each([
		["gpt-5.2", "openai"],
		["gpt-5.2", "azure_openai"],
		["gpt-5.6-sol", "azure_openai"],
		["gpt-6-luna", "openai"],
	] as const)("%s via %s sends the literal none tier when reasoning is off", async (id, upstream) => {
		const request = await capture(id, { reasoning: undefined, disableReasoning: true }, upstream);
		expect(request.body.reasoning).toEqual({ effort: "none" });
		expect(request.body.include).toBeUndefined();
	});
});

/** A Responses turn that reasons (with encrypted content) and then calls Read. */
function reasoningToolCallChunks(): string[] {
	const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read" };
	return [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENCRYPTED" },
		},
		{ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: '{"path":"a.txt"}' },
		{
			type: "response.output_item.done",
			output_index: 1,
			item: { ...call, arguments: '{"path":"a.txt"}', status: "completed" },
		},
		{
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
			},
		},
	].map(chunk => JSON.stringify(chunk));
}

describe("Factory Droid Muse Spark 1.3 on Vertex Responses", () => {
	it("sends native's Responses body to the google upstream", async () => {
		const request = await capture("muse-spark-1.3", { reasoning: Effort.XHigh });
		expect(request.url).toEndWith("/api/llm/o/v1/responses");
		expect(request.headers["x-api-provider"]).toBe("google");
		expect(request.headers["openai-platform"] as string | undefined).toBeUndefined();
		expect(request.body).toMatchObject({
			model: "muse-spark-1.3",
			store: false,
			stream: true,
			reasoning: { effort: "xhigh", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			parallel_tool_calls: true,
			max_output_tokens: 131072,
		});
		expect(request.body.prompt_cache_key).toEqual(expect.any(String));
		// Native configures none of the OpenAI-family request extras for this model.
		for (const field of ["text", "tool_choice", "safety_identifier", "service_tier", "prompt_cache_retention"]) {
			expect(request.body[field]).toBeUndefined();
		}
		// Vertex rejects `custom` tools; every tool is a non-strict function.
		expect(request.body.tools).toEqual([expect.objectContaining({ type: "function", name: "Read", strict: false })]);
	});

	it("drops its encrypted reasoning from the replayed tool turn, as native does", async () => {
		const model = factoryModel("muse-spark-1.3");
		const options = { apiKey: WORKOS_TOKEN_WITH_USER, sessionId: "sess-1", reasoning: Effort.High };
		const captured: CapturedRequest[] = [];
		const first = await streamFactoryDroid(model, context(), {
			...options,
			fetch: captureFetch(captured, reasoningToolCallChunks()),
		}).result();
		const call = first.content.find(block => block.type === "toolCall");
		expect(first.content.some(block => block.type === "thinking")).toBe(true);
		if (call?.type !== "toolCall") throw new Error("turn 1 made no tool call");

		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.id,
			toolName: "Read",
			content: [{ type: "text", text: "amber=1729" }],
			isError: false,
			timestamp: 3,
		};
		const followUp: Context = { ...context(), messages: [...context().messages, first, result] };
		await streamFactoryDroid(model, followUp, {
			...options,
			fetch: captureFetch(captured, responsesChunks("SUM=1729")),
		}).result();

		const input = captured[1]?.body.input as { type?: string }[];
		expect(input.map(item => item.type)).toContain("function_call");
		expect(input.map(item => item.type)).toContain("function_call_output");
		expect(input.filter(item => item.type === "reasoning")).toEqual([]);
		expect(JSON.stringify(input)).not.toContain("ENCRYPTED");
	});
});
