import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";

describe("Tool argument whitespace normalization", () => {
	it("trims trailing whitespace from enum strings before validation", () => {
		const tool: Tool = {
			name: "todo",
			description: "",
			parameters: type({
				op: type.enumeration(["append", "done", "drop", "init", "rm", "start", "view"]),
				items: type("string").array().optional(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-todo-op-newline",
			name: "todo",
			arguments: { op: "init\n", items: ["Fix RNG divergence"] },
		});

		expect(result).toEqual({ op: "init", items: ["Fix RNG divergence"] });
	});

	it("trims trailing whitespace from enum and const strings behind local JSON Schema refs", () => {
		const tool: Tool = {
			name: "todo",
			description: "",
			parameters: {
				type: "object",
				properties: {
					op: { $ref: "#/$defs/Op" },
					view: { $ref: "#/definitions/View" },
				},
				required: ["op", "view"],
				additionalProperties: false,
				$defs: {
					Op: { enum: ["init", "done"] },
				},
				definitions: {
					View: { const: "summary" },
				},
			},
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-json-schema-ref-enum-newline",
			name: "todo",
			arguments: { op: "init\n", view: "summary\n" },
		});

		expect(result).toEqual({ op: "init", view: "summary" });
	});

	it("trims enum strings inside tuple prefix items", () => {
		const tool: Tool = {
			name: "tuple-op",
			description: "",
			parameters: type({
				args: type.tuple([type.enumeration(["init"])]),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-tuple-enum-newline",
			name: "tuple-op",
			arguments: { args: ["init\n"] },
		});

		expect(result).toEqual({ args: ["init"] });
	});

	it("strips trailing newlines from path fields on read-like tools", () => {
		const tool: Tool = {
			name: "read",
			description: "",
			parameters: type({
				path: type("string"),
				offset: type("number").optional(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-read-path-newline",
			name: "read",
			arguments: { path: "examples/multi_observation.py:36-55\n" },
		});

		expect(result).toEqual({ path: "examples/multi_observation.py:36-55" });
	});

	it("strips trailing line terminators but preserves ordinary spaces in path arrays", () => {
		const tool: Tool = {
			name: "search",
			description: "",
			parameters: type({
				pattern: type("string"),
				paths: type("string").array(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-search-paths-newline",
			name: "search",
			arguments: {
				pattern: "TODO",
				paths: ["src/foo.ts\n", "src/bar.ts "],
			},
		});

		expect(result).toEqual({
			pattern: "TODO",
			paths: ["src/foo.ts", "src/bar.ts "],
		});
	});

	it("trims path line terminators after stringified array coercion", () => {
		const tool: Tool = {
			name: "search",
			description: "",
			parameters: type({
				paths: type.union([type("string"), type("string").array()]),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-search-stringified-paths-newline",
			name: "search",
			arguments: {
				paths: JSON.stringify(["src/foo.ts\n", "src/bar.ts "]),
			},
		});

		expect(result).toEqual({ paths: ["src/foo.ts", "src/bar.ts "] });
	});

	it("leaves trailing newlines on content-carrying fields intact", () => {
		const tool: Tool = {
			name: "write",
			description: "",
			parameters: type({
				path: type("string"),
				content: type("string"),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-write-content-newline",
			name: "write",
			arguments: { path: "docs/foo.md\n", content: "hello\n" },
		});

		expect(result).toEqual({ path: "docs/foo.md", content: "hello\n" });
	});

	it("does not trim identifier-looking fields nested under content payloads", () => {
		const tool: Tool = {
			name: "http",
			description: "",
			parameters: type({
				body: type({
					title: type("string"),
				}),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-body-title-space",
			name: "http",
			arguments: { body: { title: "Draft \n" } },
		});

		expect(result).toEqual({ body: { title: "Draft \n" } });
	});

	it("trims trailing whitespace from title fields while keeping code content", () => {
		const tool: Tool = {
			name: "eval",
			description: "",
			parameters: type({
				language: type.enumeration(["py", "js", "rb", "jl"]),
				code: type("string"),
				title: type("string").optional(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-eval-title-newline",
			name: "eval",
			arguments: {
				language: "js\n",
				title: "read multi_observation lines 36-100\n",
				code: "console.log('hi')\n",
			},
		});

		expect(result).toEqual({
			language: "js",
			title: "read multi_observation lines 36-100",
			code: "console.log('hi')\n",
		});
	});
});
