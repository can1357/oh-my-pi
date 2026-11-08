import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { planStableOpenAITools, resolveOpenAIToolControlState } from "@oh-my-pi/pi-ai/providers/openai-tool-additions";
import type { Context, ProviderSessionState, Tool } from "@oh-my-pi/pi-ai/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";

/** Loose wire item for planner tests. */
interface TestItem {
	type?: string;
	role?: string;
	[key: string]: unknown;
}

const fn = (name: string, description = name) => ({
	type: "function",
	name,
	description,
	parameters: { type: "object" },
});
const user = (text: string): TestItem => ({ role: "user", content: [{ type: "input_text", text }] });
const call = (id: string, name: string): TestItem => ({ type: "function_call", call_id: id, name, arguments: "{}" });
const output = (id: string): TestItem => ({ type: "function_call_output", call_id: id, output: "ok" });
const kinds = (input: TestItem[]) => input.map(item => item.type ?? item.role);
const fresh = () => resolveOpenAIToolControlState(new Map(), id => id, "session", undefined);

describe("planStableOpenAITools", () => {
	it("keeps the first declaration and adds a later tool before the user turn it is for", () => {
		const state = fresh();
		const first = [user("hi")];
		expect(planStableOpenAITools(state, first, [fn("read"), fn("write")]).map(tool => tool.name)).toEqual([
			"read",
			"write",
		]);
		expect(first).toEqual([user("hi")]);

		const second = [user("hi"), call("c1", "read"), output("c1"), user("now search")];
		const declared = planStableOpenAITools(state, second, [fn("read"), fn("search"), fn("write")]);
		expect(declared.map(tool => tool.name)).toEqual(["read", "write"]);
		expect(kinds(second)).toEqual(["user", "function_call", "function_call_output", "additional_tools", "user"]);
		expect(second[3]).toEqual({ type: "additional_tools", role: "developer", tools: [fn("search")] });

		const third = [...second.filter(item => item.type !== "additional_tools"), call("c2", "search"), output("c2")];
		planStableOpenAITools(state, third, [fn("read"), fn("search"), fn("write")]);
		expect(kinds(third)).toEqual([
			"user",
			"function_call",
			"function_call_output",
			"additional_tools",
			"user",
			"function_call",
			"function_call_output",
		]);
	});

	it("adds a tool inside a tool loop after the latest result", () => {
		const state = fresh();
		planStableOpenAITools(state, [user("go")], [fn("help")]);
		const input = [user("go"), call("c1", "help"), output("c1")];
		planStableOpenAITools(state, input, [fn("help"), fn("config_edit")]);
		expect(input.at(-1)?.type).toBe("additional_tools");
	});

	it("re-declares the request's own tools when a tool is dropped or the history is rewritten", () => {
		const state = fresh();
		planStableOpenAITools(state, [user("a")], [fn("read"), fn("write")]);
		planStableOpenAITools(
			state,
			[user("a"), call("c1", "read"), output("c1"), user("b")],
			[fn("read"), fn("write"), fn("search")],
		);
		const dropped = [user("a"), call("c1", "read"), output("c1"), user("b"), user("c")];
		expect(planStableOpenAITools(state, dropped, [fn("read"), fn("search")]).map(tool => tool.name)).toEqual([
			"read",
			"search",
		]);
		expect(dropped.some(item => item.type === "additional_tools")).toBe(false);

		planStableOpenAITools(state, [user("x"), user("y")], [fn("read"), fn("search"), fn("edit")]);
		const rewritten = [user("summary"), user("y")];
		planStableOpenAITools(state, rewritten, [fn("read"), fn("search"), fn("edit")]);
		expect(rewritten.some(item => item.type === "additional_tools")).toBe(false);
	});

	it("sends current definitions, and a side request never changes its parent's state", () => {
		const states = new Map();
		const parent = resolveOpenAIToolControlState(states, id => id, "parent", undefined);
		planStableOpenAITools(parent, [user("a")], [fn("read")]);
		const side = resolveOpenAIToolControlState(states, id => id, "side", "parent");
		const input = [user("a"), user("b")];
		expect(planStableOpenAITools(side, input, [fn("read", "new text"), fn("search")])[0]?.description).toBe(
			"new text",
		);
		expect(input.some(item => item.type === "additional_tools")).toBe(true);
		expect(parent.additions).toEqual([]);
	});
});

describe("openai-codex mid-conversation tools", () => {
	const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const tool = (name: string): Tool => ({
		name,
		description: name,
		parameters: { type: "object", properties: {} } as Tool["parameters"],
	});
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
	const context = (messages: Context["messages"], tools: Tool[]): Context => ({
		systemPrompt: ["You are a helpful assistant."],
		messages,
		tools,
	});
	/** Declared tool names (the leading Responses Lite item or top-level `tools`) and the mid-conversation additions. */
	const tools = (body: Awaited<ReturnType<typeof buildTransformedCodexRequestBody>>) => {
		const input = (body.input ?? []) as TestItem[];
		const lead = input[0]?.type === "additional_tools" ? input[0] : undefined;
		const named = (list: unknown) => (list as { name?: string }[]).map(item => item.name);
		return {
			declared: named(lead ? lead.tools : (body.tools ?? [])),
			added: input
				.slice(lead ? 1 : 0)
				.flatMap(item => (item.type === "additional_tools" ? [named(item.tools)] : [])),
		};
	};

	it("keeps the declaration for gpt-6-astra and adds the new tool before the new user turn", async () => {
		const model = createCodexModel("gpt-6-astra");
		const options = {
			apiKey: "token",
			sessionId: "astra-tools",
			providerSessionState: new Map<string, ProviderSessionState>(),
		};
		const first = await buildTransformedCodexRequestBody(model, context([firstUser], [tool("read")]), options);
		expect(tools(first)).toEqual({ declared: ["read"], added: [] });

		const second = await buildTransformedCodexRequestBody(
			model,
			context([firstUser, firstAssistant, secondUser], [tool("read"), tool("search")]),
			options,
		);
		expect(tools(second)).toEqual({ declared: ["read"], added: [["search"]] });
		const input = (second.input ?? []) as TestItem[];
		const added = input.findLastIndex(item => item.type === "additional_tools");
		expect(input[added + 1]?.role).toBe("user");
	});

	it("re-declares the current tools for models without mid-conversation tool changes", async () => {
		const model = createCodexModel("gpt-5.6-luna");
		const options = {
			apiKey: "token",
			sessionId: "luna-tools",
			providerSessionState: new Map<string, ProviderSessionState>(),
		};
		await buildTransformedCodexRequestBody(model, context([firstUser], [tool("read")]), options);
		const second = await buildTransformedCodexRequestBody(
			model,
			context([firstUser, firstAssistant, secondUser], [tool("read"), tool("search")]),
			options,
		);
		expect(tools(second)).toEqual({ declared: ["read", "search"], added: [] });
	});
});
