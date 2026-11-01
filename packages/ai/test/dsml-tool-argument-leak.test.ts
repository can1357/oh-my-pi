import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai/types";
import { removeDsmlToolMarkupLeak } from "@oh-my-pi/pi-ai/utils/dsml-leak";

const FULLWIDTH = "\uFF5C";
const SEP = "\u2581";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openrouter",
		provider: "openrouter",
		model: "deepseek/deepseek-v4.1-flash-1017",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolCall(args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: "call-1", name: "write", arguments: args };
}

function callAt(message: AssistantMessage, index: number): ToolCall {
	const block = message.content[index];
	if (block?.type !== "toolCall") throw new Error("expected a tool call");
	return block;
}

describe("removeDsmlToolMarkupLeak on tool-call arguments", () => {
	it("strips a re-spelled parameter closer from write content", () => {
		const message = assistant([toolCall({ path: "/tmp/a.txt", content: "hello</parameter_name>" })]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(true);
		expect(callAt(message, 0).arguments).toEqual({ path: "/tmp/a.txt", content: "hello" });
	});

	it("strips canonical fullwidth and ASCII DSML closers", () => {
		const parameterClose = `</${FULLWIDTH}DSML${FULLWIDTH}parameter>`;
		const message = assistant([
			toolCall({ content: `alpha${parameterClose}` }),
			toolCall({ content: "beta</\u007cDSML\u007cinvoke>" }),
		]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(true);
		expect(callAt(message, 0).arguments).toEqual({ content: "alpha" });
		expect(callAt(message, 1).arguments).toEqual({ content: "beta" });
	});

	it("strips re-spelled closers and a full DeepSeek template token", () => {
		const toolCallBegin = `<${FULLWIDTH}tool${SEP}call${SEP}begin${FULLWIDTH}>`;
		const message = assistant([
			toolCall({ cwd: "></cwd></target</parameter_name>b</invoke_param>oops" }),
			toolCall({ content: `ok${toolCallBegin}bash` }),
		]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(true);
		expect(callAt(message, 0).arguments).toEqual({ cwd: "></cwd></targetboops" });
		expect(callAt(message, 1).arguments).toEqual({ content: "ok\n\nbash" });
	});

	it("sanitizes nested objects and arrays without touching non-strings", () => {
		const message = assistant([
			toolCall({
				options: { body: "ok</invoke_param>", retries: 3 },
				list: ["a</parameter_name>", true, null],
			}),
		]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(true);
		expect(callAt(message, 0).arguments).toEqual({
			options: { body: "ok", retries: 3 },
			list: ["a", true, null],
		});
	});

	it("keeps payload lines before a canonical closer", () => {
		const parameterClose = `</${FULLWIDTH}DSML${FULLWIDTH}parameter>`;
		const message = assistant([toolCall({ content: `first\nlast\n${parameterClose}` })]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(true);
		expect(callAt(message, 0).arguments).toEqual({ content: "first\nlast" });
	});

	it("leaves literal XML and chat-template closers in payloads untouched", () => {
		const payload = "<parameter>value</parameter\u003e <tool_call>{{ m }}</tool_call\u003e <invoke>x</invoke\u003e";
		const message = assistant([toolCall({ content: payload })]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(false);
		expect(callAt(message, 0).arguments).toEqual({ content: payload });
	});

	it("preserves an own __proto__ argument key", () => {
		const args = JSON.parse('{"__proto__":{"admin":true},"text":"x</parameter_name>"}') as Record<string, unknown>;
		const message = assistant([toolCall(args)]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(true);
		const result = callAt(message, 0).arguments;
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(result.text).toBe("x");
	});

	it("leaves clean arguments and unrelated blocks untouched", () => {
		const message = assistant([toolCall({ path: "/tmp/a.txt", content: "hello " }), { type: "text", text: "done" }]);
		expect(removeDsmlToolMarkupLeak(message)).toBe(false);
		expect(callAt(message, 0).arguments).toEqual({ path: "/tmp/a.txt", content: "hello " });
	});
});
