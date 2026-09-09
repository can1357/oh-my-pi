import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";

describe("Eval-tool language whitespace normalization", () => {
	it("trims a trailing newline on the ArkType-emitted language enum", () => {
		const tool: Tool = {
			name: "eval",
			description: "",
			parameters: type({
				language: type("'py' | 'js' | 'rb' | 'jl'").describe(""),
				code: type("string").describe(""),
				"title?": type("string").describe(""),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-eval-language-newline",
			name: "eval",
			arguments: { language: "js\n", code: "console.log('hi')", title: "smoke" },
		}) as { language: string; code: string; title?: string };

		expect(result.language).toBe("js");
		expect(result.code).toBe("console.log('hi')");
		expect(result.title).toBe("smoke");
	});
});
