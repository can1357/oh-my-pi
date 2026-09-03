import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";

// Issue #8886 — some providers (notably Gemini) serialize array arguments as
// flattened property paths (`questions[0].id`) instead of a nested array.

// Mirrors the shape of OMP's `ask` tool (`packages/coding-agent/src/tools/ask.ts`).
const questionItem = type({
	id: type("string"),
	question: type("string"),
	options: type({ label: type("string") }).array(),
	"recommended?": type("number"),
});

const askTool: Tool = {
	name: "ask",
	description: "Ask the user a question",
	parameters: type({ questions: questionItem.array().atLeastLength(1) }),
};

function callWith(
	parameters: Record<string, unknown>,
	tool: Tool = askTool,
): { success: boolean; args: unknown; error?: unknown } {
	try {
		return {
			success: true,
			args: validateToolArguments(tool, {
				type: "toolCall",
				id: "call-1",
				name: tool.name,
				arguments: parameters,
			}),
		};
	} catch (error) {
		return { success: false, args: parameters, error };
	}
}

describe("Flattened array-property normalization (issue #8886)", () => {
	it("rebuilds a nested questions array from flattened property paths", () => {
		const result = callWith({
			"questions[0].id": "doc_structure",
			"questions[0].question": "Which format should we adopt?",
			"questions[0].options[0].label": "Structured Markdown",
			"questions[0].options[1].label": "Plain text",
			"questions[0].recommended": 0,
		});

		expect(result.success).toBe(true);
		expect(result.args).toEqual({
			questions: [
				{
					id: "doc_structure",
					question: "Which format should we adopt?",
					options: [{ label: "Structured Markdown" }, { label: "Plain text" }],
					recommended: 0,
				},
			],
		});
	});

	it("handles multiple array elements across the same property", () => {
		const result = callWith({
			"questions[0].id": "q1",
			"questions[0].question": "First",
			"questions[0].options[0].label": "A",
			"questions[1].id": "q2",
			"questions[1].question": "Second",
			"questions[1].options[0].label": "B",
		});

		expect(result.success).toBe(true);
		expect(result.args).toEqual({
			questions: [
				{ id: "q1", question: "First", options: [{ label: "A" }] },
				{ id: "q2", question: "Second", options: [{ label: "B" }] },
			],
		});
	});

	it("supports bare leaf array elements", () => {
		const tool: Tool = {
			name: "t",
			description: "",
			parameters: type({ tags: type("string").array().atLeastLength(2) }),
		};
		const result = callWith({ "tags[0]": "alpha", "tags[1]": "beta" }, tool);
		expect(result.success).toBe(true);
		expect(result.args).toEqual({ tags: ["alpha", "beta"] });
	});

	it("preserves non-flattened sibling keys", () => {
		const result = callWith({
			title: "Session",
			"questions[0].id": "q",
			"questions[0].question": "Go?",
			"questions[0].options[0].label": "Yes",
		});
		expect(result.success).toBe(true);
		expect(result.args).toEqual({
			title: "Session",
			questions: [{ id: "q", question: "Go?", options: [{ label: "Yes" }] }],
		});
	});

	it("leaves plain nested objects untouched", () => {
		const args = { questions: [{ id: "q", question: "Go?", options: [{ label: "Yes" }] }] };
		const result = callWith(args);
		expect(result.success).toBe(true);
		expect(result.args).toEqual(args);
	});

	it("leaves non-array dotted keys untouched", () => {
		const tool: Tool = { name: "t", description: "", parameters: type({ "a.b": type("number"), c: type("number") }) };
		const args = { "a.b": 1, c: 2 };
		const result = callWith(args, tool);
		expect(result.success).toBe(true);
		expect(result.args).toEqual(args);
	});

	it("leaves malformed indexed keys untouched and surfaces the validation error", () => {
		const result = callWith({ "questions[foo]": "nope" });
		expect(result.success).toBe(false);
	});

	it("leaves non-indexed keys untouched on schema mismatch too", () => {
		const result = callWith({ label: "300" });
		expect(result.success).toBe(false);
	});

	it("bails (does not silently drop data) when a flattened path collides with a plain key", () => {
		const result = callWith({ questions: [5], "questions[0].id": "x" });
		// Ambiguous input must not lose the plain key — fall through to a genuine
		// validation error instead of a partial rebuild.
		expect(result.success).toBe(false);
	});
});
