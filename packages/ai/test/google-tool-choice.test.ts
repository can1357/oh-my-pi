import { describe, expect, it } from "bun:test";
import { buildGoogleGenerateContentParams } from "@oh-my-pi/pi-ai/providers/google-shared";
import { mapGoogleToolChoice } from "@oh-my-pi/pi-ai/stream";
import type { Context, Tool, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("mapGoogleToolChoice (F7)", () => {
	it("returns string passthrough for auto/none/any", () => {
		expect(mapGoogleToolChoice("auto" as unknown as ToolChoice)).toBe("auto");
		expect(mapGoogleToolChoice("none" as unknown as ToolChoice)).toBe("none");
		expect(mapGoogleToolChoice("any" as unknown as ToolChoice)).toBe("any");
	});

	it("maps 'required' to 'any'", () => {
		expect(mapGoogleToolChoice("required" as unknown as ToolChoice)).toBe("any");
	});

	it("converts {type: 'tool', name} to a named-tool ANY allow-list", () => {
		const out = mapGoogleToolChoice({ type: "tool", name: "search" });
		expect(out).toEqual({ mode: "ANY", allowedFunctionNames: ["search"] });
	});

	it("converts {type: 'function', name} to a named-tool ANY allow-list", () => {
		const out = mapGoogleToolChoice({ type: "function", name: "search" });
		expect(out).toEqual({ mode: "ANY", allowedFunctionNames: ["search"] });
	});

	it("converts {type: 'function', function: {name}} (OpenAI shape) to a named-tool ANY allow-list", () => {
		const out = mapGoogleToolChoice({ type: "function", function: { name: "search" } });
		expect(out).toEqual({ mode: "ANY", allowedFunctionNames: ["search"] });
	});

	it("returns undefined when no choice given", () => {
		expect(mapGoogleToolChoice(undefined)).toBeUndefined();
	});
});

describe("buildGoogleGenerateContentParams toolConfig serialization (F7)", () => {
	const model = getBundledModel<"google-generative-ai">("google", "gemini-1.5-pro");
	if (!model) throw new Error("expected gemini-1.5-pro to be bundled");

	const tool: Tool = {
		name: "search",
		description: "Search the web",
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
	};

	function ctx(): Context {
		return {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [tool],
		};
	}

	it("emits functionCallingConfig.mode for string toolChoice", () => {
		const params = buildGoogleGenerateContentParams(model, ctx(), {
			apiKey: "fake",
			toolChoice: "any",
		});
		expect(params.config!.toolConfig).toEqual({
			functionCallingConfig: { mode: "ANY" },
		});
	});

	it("omits toolConfig for auto toolChoice because Google defaults tools to AUTO", () => {
		const params = buildGoogleGenerateContentParams(model, ctx(), {
			apiKey: "fake",
			toolChoice: "auto",
		});
		expect(params.config!.tools).toBeDefined();
		expect(params.config!.toolConfig).toBeUndefined();
	});

	it("emits allowedFunctionNames for named-tool object toolChoice", () => {
		const params = buildGoogleGenerateContentParams(model, ctx(), {
			apiKey: "fake",
			toolChoice: { mode: "ANY", allowedFunctionNames: ["search"] },
		});
		expect(params.config!.toolConfig).toEqual({
			functionCallingConfig: {
				mode: "ANY",
				allowedFunctionNames: ["search"],
			},
		});
	});

	it("clears toolConfig when no toolChoice is provided", () => {
		const params = buildGoogleGenerateContentParams(model, ctx(), { apiKey: "fake" });
		expect(params.config!.toolConfig).toBeUndefined();
	});
});
