import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";

describe("Tool argument coercion", () => {
	it("coerces numeric strings when schema expects number", () => {
		const tool: Tool = {
			name: "t1",
			description: "",
			parameters: type({ timeout: type("number") }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "t1",
			arguments: { timeout: "300" },
		};

		const result = validateToolArguments(tool, toolCall) as { timeout: number };
		expect(result.timeout).toBe(300);
	});

	it("preserves string values when schema expects string", () => {
		const tool: Tool = {
			name: "t2",
			description: "",
			parameters: type({ label: type("string") }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-2",
			name: "t2",
			arguments: { label: "300" },
		};

		const result = validateToolArguments(tool, toolCall) as { label: string };
		expect(result.label).toBe("300");
	});

	it("stringifies object values when schema expects string", () => {
		const tool: Tool = {
			name: "object-string",
			description: "",
			parameters: type({ payload: type("string") }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-object-string",
			name: "object-string",
			arguments: { payload: { a: 1, nested: ["x"] } },
		}) as { payload: string };

		expect(result.payload).toBe('{"a":1,"nested":["x"]}');
	});
	it("stringifies container values when a string union branch matches", () => {
		const tool: Tool = {
			name: "union-string",
			description: "",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					payload: { anyOf: [{ type: "string" }, { type: "number" }] },
				},
				required: ["payload"],
			} as never,
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-union-object",
			name: "union-string",
			arguments: { payload: { a: 1 } },
		}) as { payload: string };

		expect(result.payload).toBe('{"a":1}');
	});

	it("does not delete unrecognized keys diagnosed inside a failed union branch", () => {
		const tool: Tool = {
			name: "union-closed",
			description: "",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					op: {
						anyOf: [
							{
								type: "object",
								additionalProperties: false,
								properties: { kind: { type: "string" }, value: { type: "number" } },
								required: ["kind", "value"],
							},
							{ type: "string" },
						],
					},
				},
				required: ["op"],
			} as never,
		};

		// `extra` fails the closed object variant; deleting it would silently
		// drop payload data on a branch guess. Must surface as a validation error.
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-union-extra-key",
				name: "union-closed",
				arguments: { op: { kind: "set", value: 1, extra: "keep me" } },
			}),
		).toThrow(/op/);
	});

	it("still applies lossless repairs inside union branches", () => {
		const tool: Tool = {
			name: "union-lossless",
			description: "",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					payload: { anyOf: [{ type: "number" }, { type: "boolean" }] },
				},
				required: ["payload"],
			} as never,
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-union-numeric-string",
			name: "union-lossless",
			arguments: { payload: "300" },
		}) as { payload: number };
		expect(result.payload).toBe(300);
	});

	it("stringifies array values when schema expects string", () => {
		const tool: Tool = {
			name: "array-string",
			description: "",
			parameters: type({ payload: type("string") }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-array-string",
			name: "array-string",
			arguments: { payload: ["a", 2, true] },
		}) as { payload: string };

		expect(result.payload).toBe('["a",2,true]');
	});

	it("coerces numeric 0 and 1 to booleans", () => {
		const tool: Tool = {
			name: "numeric-booleans",
			description: "",
			parameters: type({ enabled: type("boolean"), disabled: type("boolean") }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-numeric-booleans",
			name: "numeric-booleans",
			arguments: { enabled: 1, disabled: 0 },
		}) as { enabled: boolean; disabled: boolean };

		expect(result).toEqual({ enabled: true, disabled: false });
	});

	it("coerces booleans to numeric 0 and 1", () => {
		const tool: Tool = {
			name: "boolean-numbers",
			description: "",
			parameters: type({ enabled: type("number"), disabled: type("number.integer") }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-boolean-numbers",
			name: "boolean-numbers",
			arguments: { enabled: true, disabled: false },
		}) as { enabled: number; disabled: number };

		expect(result).toEqual({ enabled: 1, disabled: 0 });
	});

	it("rejects numeric boolean values other than 0 or 1", () => {
		const tool: Tool = {
			name: "invalid-numeric-boolean",
			description: "",
			parameters: type({ enabled: type("boolean") }),
		};

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-invalid-numeric-boolean",
				name: "invalid-numeric-boolean",
				arguments: { enabled: 2 },
			}),
		).toThrow('Validation failed for tool "invalid-numeric-boolean"');
	});

	it("keeps raw in-band blocks out of validation errors", () => {
		const tool: Tool = {
			name: "raw-debug",
			description: "",
			parameters: type({ input: type("string") }),
		};
		const rawBlock = '<|start|>assistant<|channel|>commentary to=functions.edit <|message|>{"input":"x"}}<|call|>';

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-raw-debug",
				name: "raw-debug",
				arguments: {},
				rawBlock,
			}),
		).toThrow('Validation failed for tool "raw-debug"');
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-raw-debug",
				name: "raw-debug",
				arguments: {},
				rawBlock,
			}),
		).not.toThrow(rawBlock);
	});

	it("coerces common string boolean forms", () => {
		const tool: Tool = {
			name: "string-booleans",
			description: "",
			parameters: type({
				t: type("boolean"),
				f: type("boolean"),
				one: type("boolean"),
				zero: type("boolean"),
				yes: type("boolean"),
				no: type("boolean"),
				on: type("boolean"),
				off: type("boolean"),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-string-booleans",
			name: "string-booleans",
			arguments: {
				t: "TRUE",
				f: "false",
				one: "1",
				zero: "0",
				yes: "yes",
				no: "NO",
				on: "on",
				off: "OFF",
			},
		}) as Record<string, boolean>;

		expect(result).toEqual({
			t: true,
			f: false,
			one: true,
			zero: false,
			yes: true,
			no: false,
			on: true,
			off: false,
		});
	});

	it("parses JSON arrays in string values when schema expects array", () => {
		const tool: Tool = {
			name: "t3",
			description: "",
			parameters: type({ items: type("number").array() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-3",
			name: "t3",
			arguments: { items: "[1, 2, 3]" },
		};

		const result = validateToolArguments(tool, toolCall) as { items: number[] };
		expect(result.items).toEqual([1, 2, 3]);
	});

	it("wraps a plain string in a singleton array when schema expects string array", () => {
		const tool: Tool = {
			name: "t3b",
			description: "",
			parameters: type({ paths: type("string").array() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-3b",
			name: "t3b",
			arguments: { paths: "src/**/*.ts" },
		};

		const result = validateToolArguments(tool, toolCall) as { paths: string[] };
		expect(result.paths).toEqual(["src/**/*.ts"]);
	});

	it("wraps bracket and brace glob strings when schema expects string array", () => {
		const tool: Tool = {
			name: "glob_paths",
			description: "",
			parameters: type({ paths: type("string").array() }),
		};

		const bracketResult = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-bracket-glob",
			name: "glob_paths",
			arguments: { paths: "[a-z]*.ts" },
		}) as { paths: string[] };
		const numericBracketResult = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-numeric-bracket-glob",
			name: "glob_paths",
			arguments: { paths: "[0-9]*.ts" },
		}) as { paths: string[] };
		const braceResult = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-brace-glob",
			name: "glob_paths",
			arguments: { paths: "{src,test}/**/*.ts" },
		}) as { paths: string[] };

		expect(bracketResult.paths).toEqual(["[a-z]*.ts"]);
		expect(numericBracketResult.paths).toEqual(["[0-9]*.ts"]);
		expect(braceResult.paths).toEqual(["{src,test}/**/*.ts"]);
	});

	it("wraps a singleton object in an array when schema expects object array", () => {
		const tool: Tool = {
			name: "todo_like",
			description: "",
			parameters: type({
				ops: type.array(
					type({
						op: type.unit("init"),
						list: type.array(
							type({
								phase: type("string"),
								items: type("string").array(),
							}),
						),
					}),
				),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-singleton-object-array",
			name: "todo_like",
			arguments: {
				ops: {
					op: "init",
					list: [{ phase: "Repro", items: ["capture"] }],
				},
			},
		});

		expect(result).toEqual({
			ops: [{ op: "init", list: [{ phase: "Repro", items: ["capture"] }] }],
		});
	});

	it("parses a JSON array string when schema expects object array", () => {
		const tool: Tool = {
			name: "todo_like_json_array",
			description: "",
			parameters: type({
				ops: type.array(
					type({
						op: type.unit("init"),
						list: type.array(
							type({
								phase: type("string"),
								items: type("string").array(),
							}),
						),
					}),
				),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-json-array-object-array",
			name: "todo_like_json_array",
			arguments: {
				ops: JSON.stringify([{ op: "init", list: [{ phase: "Repro", items: ["capture"] }] }]),
			},
		});

		expect(result).toEqual({
			ops: [{ op: "init", list: [{ phase: "Repro", items: ["capture"] }] }],
		});
	});

	it("parses a double-encoded JSON array string when schema expects object array", () => {
		const tool: Tool = {
			name: "todo_like_double_json_array",
			description: "",
			parameters: type({
				ops: type.array(
					type({
						op: type.unit("init"),
						list: type.array(
							type({
								phase: type("string"),
								items: type("string").array(),
							}),
						),
					}),
				),
			}),
		};
		const encodedOps = JSON.stringify([{ op: "init", list: [{ phase: "Repro", items: ["capture"] }] }]);

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-double-json-array-object-array",
			name: "todo_like_double_json_array",
			arguments: {
				ops: JSON.stringify(encodedOps),
			},
		});

		expect(result).toEqual({
			ops: [{ op: "init", list: [{ phase: "Repro", items: ["capture"] }] }],
		});
	});

	it("parses a JSON object string as singleton when schema expects object array", () => {
		const tool: Tool = {
			name: "todo_like_json_object",
			description: "",
			parameters: type({
				ops: type.array(
					type({
						op: type.unit("init"),
						list: type.array(
							type({
								phase: type("string"),
								items: type("string").array(),
							}),
						),
					}),
				),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-json-object-array",
			name: "todo_like_json_object",
			arguments: {
				ops: JSON.stringify({ op: "init", list: [{ phase: "Repro", items: ["capture"] }] }),
			},
		});

		expect(result).toEqual({
			ops: [{ op: "init", list: [{ phase: "Repro", items: ["capture"] }] }],
		});
	});

	it("does not wrap malformed JSON array strings into object arrays", () => {
		const tool: Tool = {
			name: "todo_like_malformed_json_array",
			description: "",
			parameters: type({
				ops: type.array(
					type({
						op: type.unit("init"),
						list: type.array(
							type({
								phase: type("string"),
								items: type("string").array(),
							}),
						),
					}),
				),
			}),
		};

		let thrown: Error | undefined;
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-malformed-json-array",
				name: "todo_like_malformed_json_array",
				arguments: {
					ops: '[{"op":"init","list":[{"phase":"Repro","items":["capture"]}]',
				},
			});
		} catch (error) {
			if (error instanceof Error) thrown = error;
			else throw error;
		}

		expect(thrown?.message).toContain("ops must be an array");
		expect(thrown?.message).not.toContain("ops/0");
		expect(thrown?.message).not.toContain('"normalized"');
	});

	it("wraps a singleton number in an array when schema expects number array", () => {
		const tool: Tool = {
			name: "numeric_list",
			description: "",
			parameters: type({ values: type("number").array() }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-singleton-number-array",
			name: "numeric_list",
			arguments: { values: 7 },
		});

		expect(result).toEqual({ values: [7] });
	});

	it("does not wrap singleton values for array expectations from failed union branches", () => {
		const entry = type({ id: type("number") });
		const tool: Tool = {
			name: "union_shape",
			description: "",
			parameters: type.union([type.array(entry), entry]),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-union-shape",
			name: "union_shape",
			arguments: { id: "1" },
		});

		expect(result).toEqual({ id: 1 });
	});

	it("does not wrap singleton values for JSON Schema anyOf array branches", () => {
		const tool: Tool = {
			name: "json_schema_union",
			description: "",
			parameters: {
				type: "object",
				properties: {
					target: {
						anyOf: [
							{
								type: "array",
								items: {
									type: "object",
									properties: { a: { type: "boolean" } },
									required: ["a"],
									additionalProperties: false,
								},
							},
							{
								type: "object",
								properties: { a: { type: "boolean" } },
								required: ["a"],
								additionalProperties: false,
							},
						],
					},
				},
				required: ["target"],
				additionalProperties: false,
			},
		};

		// The bug would silently coerce `{ a: "true" }` into `[{ a: true }]` by
		// wrapping the object to satisfy the failed `anyOf` array branch and
		// then coercing the inner string into a boolean. Branch tracking keeps
		// the wrap from firing so the wrong shape never makes it through.
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-jsonschema-union",
				name: "json_schema_union",
				arguments: { target: { a: "true" } },
			}),
		).toThrow("Validation failed");
	});

	it("still wraps nested array fields inside a tag-selected Zod union branch", () => {
		const tool: Tool = {
			name: "tagged_union",
			description: "",
			parameters: type.union([
				type({ type: type.unit("indices"), indices: type("number").array() }),
				type({ type: type.unit("all") }),
			]),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-tagged-union",
			name: "tagged_union",
			arguments: { type: "indices", indices: 1 },
		});

		expect(result).toEqual({ type: "indices", indices: [1] });
	});

	it("still wraps nested array fields inside a tag-selected JSON Schema anyOf branch", () => {
		const tool: Tool = {
			name: "tagged_json_union",
			description: "",
			parameters: {
				anyOf: [
					{
						type: "object",
						properties: {
							type: { const: "indices" },
							indices: { type: "array", items: { type: "number" } },
						},
						required: ["type", "indices"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: { type: { const: "all" } },
						required: ["type"],
						additionalProperties: false,
					},
				],
			},
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-tagged-json-union",
			name: "tagged_json_union",
			arguments: { type: "indices", indices: 1 },
		});

		expect(result).toEqual({ type: "indices", indices: [1] });
	});

	it("parses JSON objects in string values when schema expects object", () => {
		const tool: Tool = {
			name: "t4",
			description: "",
			parameters: type({ payload: type({ a: type("number") }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-4",
			name: "t4",
			arguments: { payload: '{"a": 1}' },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.payload).toEqual({ a: 1 });
	});

	it("preserves unknown root fields after Zod validation so tools can reject disabled arguments", () => {
		const tool: Tool = {
			name: "t4b",
			description: "",
			parameters: type({ command: type("string") }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-4b",
			name: "t4b",
			arguments: { command: "echo hi", async: true },
		});

		expect(result).toEqual({ command: "echo hi", async: true });
	});

	it("coerces JSON-stringified records emitted for Zod record fields", () => {
		const tool: Tool = {
			name: "t4c",
			description: "",
			parameters: type({ env: type.record(type("string"), type("string")) }),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-4c",
			name: "t4c",
			arguments: { env: '{"FOO":"bar"}' },
		});

		expect(result).toEqual({ env: { FOO: "bar" } });
	});

	it("upgrades draft-07-shaped JSON Schema without $schema before validation", () => {
		const tool: Tool = {
			name: "json_schema",
			description: "",
			parameters: {
				type: "object",
				properties: {
					item: { $ref: "#/definitions/Item" },
					name: { type: "string", nullable: true },
					pair: {
						type: "array",
						items: [{ type: "string" }, { type: "integer" }],
						additionalItems: false,
					},
				},
				required: ["item", "name", "pair"],
				definitions: {
					Item: { type: "string" },
				},
			},
		};

		const valid = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-json-ok",
			name: "json_schema",
			arguments: { item: "ok", name: null, pair: ["a", 1] },
		});
		expect(valid).toEqual({ item: "ok", name: null, pair: ["a", 1] });

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-json-bad",
				name: "json_schema",
				arguments: { item: "ok", name: null, pair: ["a", "not-an-integer"] },
			}),
		).toThrow("integer");

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-json-extra",
				name: "json_schema",
				arguments: { item: "ok", name: null, pair: ["a", 1, "extra"] },
			}),
		).toThrow("false schema");
	});

	it("parses nested JSON arrays in string values", () => {
		const tool: Tool = {
			name: "t5",
			description: "",
			parameters: type({ payload: type({ items: type("number").array() }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-5",
			name: "t5",
			arguments: { payload: { items: "[4, 5]" } },
		};

		const result = validateToolArguments(tool, toolCall) as { payload: { items: number[] } };
		expect(result.payload.items).toEqual([4, 5]);
	});

	it("coerces JSON-stringified object arrays when schema expects array of objects", () => {
		const tool: Tool = {
			name: "t9",
			description: "",
			parameters: type({
				a: type("string"),
				b: type.array(
					type({
						k: type("string"),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-9",
			name: "t9",
			arguments: {
				a: "hello",
				b: '[{"k":"y"}]',
			},
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.b).toEqual([{ k: "y" }]);
	});

	it("coerces JSON-stringified root arguments containing array-of-object fields", () => {
		const tool: Tool = {
			name: "t10",
			description: "",
			parameters: type({
				a: type("string"),
				b: type.array(
					type({
						k: type("string"),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-10",
			name: "t10",
			arguments: '{"a":"hello","b":"[{\\"k\\":\\"y\\"}]"}' as unknown as Record<string, unknown>,
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			a: "hello",
			b: [{ k: "y" }],
		});
	});

	it("iteratively coerces when both root arguments and nested fields are JSON strings", () => {
		const tool: Tool = {
			name: "t7",
			description: "",
			parameters: type({
				path: type("string"),
				edits: type.array(
					type({
						target: type("string"),
						new_content: type("string"),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-7",
			name: "t7",
			arguments:
				'{"path":"somefile.js","edits":"[{\\"target\\":\\"13#cf\\",\\"new_content\\":\\"...\\"}]"}' as unknown as Record<
					string,
					unknown
				>,
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.path).toBe("somefile.js");
		expect(result.edits).toEqual([{ target: "13#cf", new_content: "..." }]);
	});

	it("coerces quoted edit arrays before stripping optional null fields", () => {
		const textSchema = type.union([type("string").array(), type("string")]);
		const tool: Tool = {
			name: "atom-like-edit",
			description: "",
			parameters: type({
				path: type("string"),
				edits: type.array(
					type({
						loc: type("string"),
						set: textSchema.optional(),
						pre: textSchema.optional(),
						post: textSchema.optional(),
						sub: type.tuple([type("string"), type("string")]).optional(),
					}),
				),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-atom-like-edit",
			name: "atom-like-edit",
			arguments: {
				path: "orcid.ts",
				edits: '[{"loc":"276ka-282vu","pre":null,"set":["line"],"post":null,"sub":null}]',
			},
		};

		const result = validateToolArguments(tool, toolCall) as { edits: Array<Record<string, unknown>> };
		expect(result.edits).toEqual([{ loc: "276ka-282vu", set: ["line"] }]);
	});

	it("coerces array strings with trailing wrapper braces from malformed nested JSON", () => {
		const tool: Tool = {
			name: "t16",
			description: "",
			parameters: type({
				path: type("string"),
				edits: type.array(
					type({
						op: type("string"),
						pos: type("string"),
						end: type("string"),
						lines: type("string").array(),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-16",
			name: "t16",
			arguments: {
				path: "packages/coding-agent/src/prompts/tools/bash.md",
				edits: '[{"op":"replace","pos":"38#BR","end":"39#QY","lines":["line 1","line 2"]}]}\n',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([
			{
				op: "replace",
				pos: "38#BR",
				end: "39#QY",
				lines: ["line 1", "line 2"],
			},
		]);
	});
	it("iteratively coerces nested array items that are JSON-serialized objects", () => {
		const tool: Tool = {
			name: "t8",
			description: "",
			parameters: type({
				path: type("string"),
				edits: type.array(
					type({
						target: type("string"),
						new_content: type("string"),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-8",
			name: "t8",
			arguments: {
				path: "somefile.js",
				edits: '["{\\"target\\":\\"13#cf\\",\\"new_content\\":\\"...\\"}"]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "13#cf", new_content: "..." }]);
	});

	it("accepts null for optional properties by treating them as omitted", () => {
		const tool: Tool = {
			name: "t11",
			description: "",
			parameters: type({
				requiredText: type("string"),
				optionalCount: type("number").optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-11",
			name: "t11",
			arguments: { requiredText: "ok", optionalCount: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ requiredText: "ok" });
	});

	it("strips empty strings from optional properties before schema validation", () => {
		const tool: Tool = {
			name: "mcp-like",
			description: "",
			parameters: {
				type: "object",
				properties: {
					namespace: { type: "string" },
					fieldSelector: { type: "string", pattern: "^.+$" },
					limit: { type: "number" },
				},
				required: ["namespace"],
				additionalProperties: false,
			},
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-empty-optionals",
			name: "mcp-like",
			arguments: { namespace: "kube-system", fieldSelector: "", limit: "" },
		});

		expect(result).toEqual({ namespace: "kube-system" });
	});

	it("preserves schema-valid empty strings on optional properties", () => {
		const tool: Tool = {
			name: "empty-string-tool",
			description: "",
			parameters: type({
				requiredText: type("string"),
				optionalText: type("string").optional(),
				optionalEnum: type.enumeration(["", "clear"]).optional(),
			}),
		};

		const result = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-valid-empty-optionals",
			name: "empty-string-tool",
			arguments: { requiredText: "ok", optionalText: "", optionalEnum: "" },
		});

		expect(result).toEqual({ requiredText: "ok", optionalText: "", optionalEnum: "" });
	});

	it("drops null optional properties nested in array objects", () => {
		const tool: Tool = {
			name: "t12",
			description: "",
			parameters: type({
				edits: type.array(
					type({
						target: type("string"),
						pos: type("string").optional(),
						end: type("string").optional(),
					}),
				),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-12",
			name: "t12",
			arguments: { edits: [{ target: "a", pos: null, end: "e" }] },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ edits: [{ target: "a", end: "e" }] });
	});

	it("drops null while preserving valid empty-string optional properties in anyOf object branches", () => {
		const opSchema = type.union([
			type({
				op: type.unit("add_task"),
				phase: type("string"),
				content: type("string"),
			}),
			type({
				op: type.unit("update"),
				id: type("string"),
				status: type("string").optional(),
				content: type("string").optional(),
				notes: type("string").optional(),
			}),
		]);

		const tool: Tool = {
			name: "t13",
			description: "",
			parameters: type({
				ops: type.array(opSchema),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-13",
			name: "t13",
			arguments: {
				ops: [
					{
						op: "update",
						id: "task-1",
						status: "completed",
						content: null,
						notes: "",
					},
				],
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			ops: [
				{
					op: "update",
					id: "task-1",
					notes: "",
					status: "completed",
				},
			],
		});
	});

	it("parses double-encoded numeric strings when schema expects number", () => {
		const tool: Tool = {
			name: "t6",
			description: "",
			parameters: type({ timeout: type("number") }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-6",
			name: "t6",
			arguments: { timeout: '"300"' },
		};

		const result = validateToolArguments(tool, toolCall) as { timeout: number };
		expect(result.timeout).toBe(300);
	});

	it("coerces numeric string for Optional<number> (anyOf:[number,null])", () => {
		const tool: Tool = {
			name: "t14",
			description: "",
			parameters: type({ tick_size: type("number").optional() }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-14",
			name: "t14",
			arguments: { tick_size: "1.0" },
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.tick_size).toBe(1);
	});

	it("leaves Optional<number> as undefined when absent", () => {
		const tool: Tool = {
			name: "t15",
			description: "",
			parameters: type({ tick_size: type("number").optional() }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-15",
			name: "t15",
			arguments: {},
		};
		const result = validateToolArguments(tool, toolCall);
		expect(result.tick_size).toBeUndefined();
	});

	it("strips string 'null' on optional boolean field", () => {
		const tool: Tool = {
			name: "edit-tool",
			description: "",
			parameters: type({
				path: type("string"),
				delete: type("boolean").optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-edit",
			name: "edit-tool",
			arguments: { path: "file.ts", delete: "null" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "file.ts" });
	});

	it("strips string 'null' on optional string field", () => {
		const tool: Tool = {
			name: "edit-tool",
			description: "",
			parameters: type({
				path: type("string"),
				move: type("string").optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-edit",
			name: "edit-tool",
			arguments: { path: "file.ts", move: "null" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "file.ts" });
	});

	it("errors on string 'null' for required field", () => {
		const tool: Tool = {
			name: "required-tool",
			description: "",
			parameters: type({
				path: type("string"),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-required",
			name: "required-tool",
			arguments: { path: "null" },
		};

		// Should NOT strip - path is required, so validation should pass
		// (the string "null" is a valid string)
		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "null" });
	});

	it("strips string 'null' and actual null on multiple optional fields", () => {
		const tool: Tool = {
			name: "multi-optional",
			description: "",
			parameters: type({
				required: type("string"),
				optBool: type("boolean").optional(),
				optString: type("string").optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-multi",
			name: "multi-optional",
			arguments: { required: "value", optBool: "null", optString: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ required: "value" });
	});

	it("heals stringified array with extra bracket at end", () => {
		const tool: Tool = {
			name: "heal-1",
			description: "",
			parameters: type({
				path: type("string"),
				edits: type.array(
					type({
						target: type("string"),
						content: type("string"),
					}),
				),
			}),
		};

		// Model wrote "]}]" at the end instead of "}]" -- extra ] between " and }
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-1",
			name: "heal-1",
			arguments: {
				path: "foo.ts",
				edits: '[{"target": "fn_foo#ABCD", "content": "code}"}]}]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo#ABCD", content: "code}" }]);
	});

	it("heals stringified array with wrong bracket type at end", () => {
		const tool: Tool = {
			name: "heal-2",
			description: "",
			parameters: type({
				path: type("string"),
				edits: type.array(
					type({
						target: type("string"),
						content: type("string"),
					}),
				),
			}),
		};

		// Model wrote "}}" at the end instead of "}]" -- wrong bracket type
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-2",
			name: "heal-2",
			arguments: {
				path: "bar.ts",
				edits: '[{"target": "fn_bar#1234", "content": "return 1}"}}',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_bar#1234", content: "return 1}" }]);
	});

	it("heals stringified array with literal backslash-n between tokens", () => {
		const tool: Tool = {
			name: "heal-esc-1",
			description: "",
			parameters: type({
				edits: type.array(type({ target: type("string"), content: type("string") })),
			}),
		};

		// LLM emits literal \n between the closing } and ]
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-esc-1",
			name: "heal-esc-1",
			arguments: {
				edits: '[{"target": "fn_foo#ABCD~", "content": "return 1;\\n"}\\n]',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo#ABCD~", content: "return 1;\n" }]);
	});

	it("heals stringified array with trailing junk after balanced container", () => {
		const tool: Tool = {
			name: "heal-trail-1",
			description: "",
			parameters: type({
				edits: type.array(type({ target: type("string"), op: type("string") })),
			}),
		};

		// LLM appends \n</invoke> after the valid JSON
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-trail-1",
			name: "heal-trail-1",
			arguments: {
				edits: '[{"target": "fn_foo", "op": "replace"}]\n</invoke>',
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.edits).toEqual([{ target: "fn_foo", op: "replace" }]);
	});

	it("does not heal deeply broken JSON strings", () => {
		const tool: Tool = {
			name: "heal-3",
			description: "",
			parameters: type({
				edits: type.array(type({ target: type("string") })),
			}),
		};

		// Structural error deep in the middle -- should NOT be healed
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-heal-3",
			name: "heal-3",
			arguments: {
				edits: '[{"target": invalid json here}]',
			},
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
	});
	it("parses JSON-stringified array containing raw newlines inside string values", () => {
		const tool: Tool = {
			name: "todo_like",
			description: "",
			parameters: type({
				phases: type.array(
					type({
						name: type("string"),
						tasks: type.array(
							type({
								content: type("string"),
								details: type("string").optional(),
							}),
						),
					}),
				),
			}),
		};

		// Stringified phases array where one `details` value contains a raw newline,
		// which `JSON.parse` rejects unless the control char is escaped.
		const stringifiedPhases =
			'[{"name":"Investigation","tasks":[{"content":"Locate code","details":"line one\nline two"}]}]';

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-rawnl",
			name: "todo_like",
			arguments: { phases: stringifiedPhases },
		};

		const result = validateToolArguments(tool, toolCall) as {
			phases: Array<{ name: string; tasks: Array<{ content: string; details?: string }> }>;
		};
		expect(result.phases).toEqual([
			{
				name: "Investigation",
				tasks: [{ content: "Locate code", details: "line one\nline two" }],
			},
		]);
	});
	it("substitutes the schema default when a required field arrives as null", () => {
		const tool: Tool = {
			name: "t-defaulted-null",
			description: "",
			parameters: type({
				note: type.union([type("string"), type.unit(null)]),
				tags: type("string")
					.array()
					.default(() => []),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-defaulted-null",
			name: "t-defaulted-null",
			arguments: { note: null, tags: null },
		};

		const result = validateToolArguments(tool, toolCall) as { note: string | null; tags: string[] };
		expect(result).toEqual({ note: null, tags: [] });
	});

	it("clones the substituted default so per-call mutations stay local", () => {
		const tool: Tool = {
			name: "t-defaulted-isolation",
			description: "",
			parameters: type({
				tags: type("string")
					.array()
					.default(() => []),
			}),
		};

		const first = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-iso-1",
			name: "t-defaulted-isolation",
			arguments: { tags: null },
		}) as { tags: string[] };
		first.tags.push("leak");

		const second = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-iso-2",
			name: "t-defaulted-isolation",
			arguments: { tags: null },
		}) as { tags: string[] };

		expect(second.tags).toEqual([]);
	});

	it("strips null from optional properties without defaults", () => {
		const tool: Tool = {
			name: "t-optional-nulls",
			description: "",
			parameters: type({
				path: type("string"),
				offset: type("number").optional(),
				limit: type("number").optional(),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-optional-nulls",
			name: "t-optional-nulls",
			arguments: { path: "foo", offset: null, limit: null },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ path: "foo" });
	});

	it("deserializes a stringified JSON root with null and stringified-array fields together", () => {
		const tool: Tool = {
			name: "t-root-json-null",
			description: "",
			parameters: type({
				note: type.union([type("string"), type.unit(null)]),
				tags: type("string")
					.array()
					.default(() => []),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-root-json-null",
			name: "t-root-json-null",
			arguments: JSON.stringify({ note: null, tags: JSON.stringify(["a", "b"]) }) as unknown as Record<
				string,
				unknown
			>,
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({ note: null, tags: ["a", "b"] });
	});

	it("deserializes nested JSON strings at multiple levels", () => {
		const tool: Tool = {
			name: "t-nested-json",
			description: "",
			parameters: type({
				payload: type({
					flags: type("boolean").array(),
					meta: type({ count: type("number") }),
				}),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-nested-json",
			name: "t-nested-json",
			arguments: {
				payload: JSON.stringify({
					flags: JSON.stringify([true, false]),
					meta: JSON.stringify({ count: 3 }),
				}),
			},
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result).toEqual({
			payload: {
				flags: [true, false],
				meta: { count: 3 },
			},
		});
	});

	it("tolerates extra keys on a rejecting object schema", () => {
		const tool: Tool = {
			name: "t-strict-root",
			description: "",
			parameters: type({
				"+": "reject",
				op: type("string"),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-strict-root",
			name: "t-strict-root",
			arguments: { op: "fix", timeout: "300" },
		};

		// Extras on strict schemas are dropped during validation rather than
		// surfaced as a hard error — equivalent to converting every object to
		// loose semantics for the purposes of tool dispatch.
		const result = validateToolArguments(tool, toolCall) as Record<string, unknown>;
		expect(result.op).toBe("fix");
		expect(result.timeout).toBeUndefined();
	});

	it("tolerates extra keys on nested rejecting object schemas", () => {
		const tool: Tool = {
			name: "t-strict-nested",
			description: "",
			parameters: type({
				"+": "reject",
				config: type({
					"+": "reject",
					host: type("string"),
				}),
			}),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-strict-nested",
			name: "t-strict-nested",
			arguments: { config: { host: "example.com", port: 443 } },
		};

		// Nested strict objects also tolerate extras; the inner key is stripped
		// so validation succeeds against the schema's declared shape.
		const result = validateToolArguments(tool, toolCall) as { config: Record<string, unknown> };
		expect(result.config.host).toBe("example.com");
	});

	it("tolerates extras on JSON Schema parameters with additionalProperties: false", () => {
		const tool: Tool = {
			name: "t-json-strict",
			description: "",
			parameters: {
				type: "object",
				properties: {
					op: { type: "string" },
				},
				required: ["op"],
				additionalProperties: false,
			},
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-json-strict",
			name: "t-json-strict",
			arguments: { op: "fix", timeout: 300 },
		};

		const result = validateToolArguments(tool, toolCall) as Record<string, unknown>;
		expect(result.op).toBe("fix");
	});

	describe("string|array union (regression: #1788)", () => {
		// `search` and `gh` tools declare `paths`/`pr` as `union(string, array<string>)`
		// so the LLM can pass a single path or many. Some providers (Z.AI / GLM)
		// double-serialize array tool-call arguments into JSON strings, which the
		// union accepts as a string — silently feeding the downstream tool a literal
		// `["a","b"]` path string.
		const unionTool: Tool = {
			name: "search",
			description: "",
			parameters: type({
				pattern: type("string"),
				paths: type.union([type("string"), type("string").array().atLeastLength(1)]),
			}),
		};

		it("parses a JSON-encoded single-element array into a real array", () => {
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u1",
				name: "search",
				arguments: { pattern: "name", paths: '["package.json"]' },
			}) as { paths: unknown };
			expect(result.paths).toEqual(["package.json"]);
		});

		it("parses a JSON-encoded multi-element array into a real array", () => {
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u2",
				name: "search",
				arguments: { pattern: "name", paths: '["package.json","App.tsx"]' },
			}) as { paths: unknown };
			expect(result.paths).toEqual(["package.json", "App.tsx"]);
		});

		it("parses a JSON-encoded array containing an absolute path", () => {
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u3",
				name: "search",
				arguments: { pattern: "name", paths: '["/home/user/project/package.json"]' },
			}) as { paths: unknown };
			expect(result.paths).toEqual(["/home/user/project/package.json"]);
		});

		it("preserves a plain string path (no brackets) untouched", () => {
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u4",
				name: "search",
				arguments: { pattern: "name", paths: "package.json" },
			}) as { paths: unknown };
			expect(result.paths).toBe("package.json");
		});

		it("preserves a real array path untouched", () => {
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u5",
				name: "search",
				arguments: { pattern: "name", paths: ["package.json", "App.tsx"] },
			}) as { paths: unknown };
			expect(result.paths).toEqual(["package.json", "App.tsx"]);
		});

		it("leaves a glob-style string with brackets untouched when it does not parse as JSON", () => {
			// `[abc]` is a glob char class; not valid JSON without quoted members.
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u6",
				name: "search",
				arguments: { pattern: "name", paths: "[abc]" },
			}) as { paths: unknown };
			expect(result.paths).toBe("[abc]");
		});

		it("preserves JSON-array-shaped strings that do not satisfy the array branch", () => {
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u7",
				name: "search",
				arguments: { pattern: "name", paths: "[1]" },
			}) as { paths: unknown };
			expect(result.paths).toBe("[1]");
		});

		it("does not coerce JSON-shape strings when the schema only accepts string", () => {
			const stringOnly: Tool = {
				name: "string_only",
				description: "",
				parameters: type({ value: type("string") }),
			};
			const result = validateToolArguments(stringOnly, {
				type: "toolCall",
				id: "u8",
				name: "string_only",
				arguments: { value: '["not-a-list"]' },
			}) as { value: unknown };
			expect(result.value).toBe('["not-a-list"]');
		});

		it("re-runs union coercion after the root arguments object is JSON-parsed", () => {
			// Some providers double-encode the entire arguments object — the call
			// arrives with `arguments` as the JSON string of an object whose own
			// `paths` field is itself a JSON-encoded array. Both layers must
			// unwind for the search bug fix (#1788) to actually take effect.
			const rootStringArgs = JSON.stringify({
				pattern: "name",
				paths: '["package.json"]',
			}) as unknown as Record<string, unknown>;
			const result = validateToolArguments(unionTool, {
				type: "toolCall",
				id: "u9",
				name: "search",
				arguments: rootStringArgs,
			}) as { pattern: string; paths: unknown };
			expect(result.pattern).toBe("name");
			expect(result.paths).toEqual(["package.json"]);
		});

		it("re-runs union coercion after a nested object field is JSON-parsed", () => {
			const nestedTool: Tool = {
				name: "nested_search",
				description: "",
				parameters: type({
					payload: type({
						paths: type.union([type("string"), type("string").array().atLeastLength(1)]),
					}),
				}),
			};
			const result = validateToolArguments(nestedTool, {
				type: "toolCall",
				id: "u10",
				name: "nested_search",
				arguments: {
					payload: JSON.stringify({
						paths: '["package.json"]',
					}),
				},
			}) as { payload: { paths: unknown } };
			expect(result.payload.paths).toEqual(["package.json"]);
		});
	});

	describe("double-JSON-encoded object keys", () => {
		const opsTool: Tool = {
			name: "todo",
			description: "",
			parameters: type({
				ops: type.array(
					type({
						op: type("string"),
						task: type("string").optional(),
					}),
				),
			}),
		};

		it("unwraps keys serialized one extra time (reported case)", () => {
			const result = validateToolArguments(opsTool, {
				type: "toolCall",
				id: "dk1",
				name: "todo",
				arguments: {
					ops: [
						{ '"op"': "done", '"task"': "Resolve failures" },
						{ '"op"': "start", '"task"': "Draft response" },
					],
				},
			}) as { ops: Array<{ op: string; task?: string }> };
			expect(result.ops).toEqual([
				{ op: "done", task: "Resolve failures" },
				{ op: "start", task: "Draft response" },
			]);
		});

		it("unwraps a double-encoded key at the root", () => {
			const tool: Tool = {
				name: "rooted",
				description: "",
				parameters: type({ label: type("string") }),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "dk2",
				name: "rooted",
				arguments: { '"label"': "hi" },
			}) as { label: string };
			expect(result.label).toBe("hi");
		});

		it("peels multiple layers of accidental encoding off a key", () => {
			const tool: Tool = {
				name: "deep",
				description: "",
				parameters: type({ label: type("string") }),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "dk3",
				name: "deep",
				// Key serialized twice: real name `label` -> `"label"` -> `"\"label\""`.
				arguments: { [JSON.stringify(JSON.stringify("label"))]: "hi" },
			}) as { label: string };
			expect(result.label).toBe("hi");
		});

		it("does not clobber an existing decoded sibling key", () => {
			const tool: Tool = {
				name: "clobber",
				description: "",
				parameters: type({ value: type("string") }),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "dk4",
				name: "clobber",
				arguments: { value: "real", '"value"': "encoded" },
			}) as { value: string };
			expect(result.value).toBe("real");
		});

		it("unwraps keys exposed after a JSON-string field is parsed", () => {
			const tool: Tool = {
				name: "wrap",
				description: "",
				parameters: type({
					payload: type({ op: type("string") }),
				}),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "dk5",
				name: "wrap",
				arguments: {
					payload: JSON.stringify({ '"op"': "done" }),
				},
			}) as { payload: { op: string } };
			expect(result.payload.op).toBe("done");
		});

		it("unwraps keys when the entire arguments payload is a JSON string", () => {
			const result = validateToolArguments(opsTool, {
				type: "toolCall",
				id: "dk7",
				name: "todo",
				// Whole arg object stringified, with each op key double-encoded.
				arguments: JSON.stringify({
					ops: [{ '"op"': "done", '"task"': "Resolve failures" }],
				}) as unknown as Record<string, unknown>,
			}) as { ops: Array<{ op: string; task?: string }> };
			expect(result.ops).toEqual([{ op: "done", task: "Resolve failures" }]);
		});

		it("unwraps keys inside a JSON-array string on a string|array union", () => {
			const tool: Tool = {
				name: "union",
				description: "",
				parameters: type({
					items: type.union([type("string"), type.array(type({ op: type("string") }))]),
				}),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "dk8",
				name: "union",
				// Array value double-serialized AND each object key double-encoded.
				arguments: { items: JSON.stringify([{ '"op"': "done" }]) },
			}) as { items: Array<{ op: string }> };
			expect(result.items).toEqual([{ op: "done" }]);
		});

		it("leaves ordinary keys untouched", () => {
			const tool: Tool = {
				name: "plain",
				description: "",
				parameters: type({ op: type("string"), count: type("number") }),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "dk6",
				name: "plain",
				arguments: { op: "done", count: 2 },
			}) as { op: string; count: number };
			expect(result).toEqual({ op: "done", count: 2 });
		});
	});

	describe("single-string-field coercion", () => {
		it("remaps a different string field to the single required string field when target is absent", () => {
			const tool: Tool = {
				name: "single-arg",
				description: "",
				parameters: type({ input: type("string") }),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "c1",
				name: "single-arg",
				arguments: { _input: "hello payload" },
			}) as { input: string };
			expect(result).toEqual({ input: "hello payload" });
		});

		it("leaves arguments alone when the target field is present but has the wrong type", () => {
			const tool: Tool = {
				name: "single-arg",
				description: "",
				parameters: type({ input: type("string") }),
			};
			const result = validateToolArguments(tool, {
				type: "toolCall",
				id: "c2",
				name: "single-arg",
				arguments: { input: 123, _input: "hello" },
			}) as { input: string };
			expect(result.input).toBe("123");
		});

		it("does not remap when the schema has multiple fields", () => {
			const tool: Tool = {
				name: "multi-arg",
				description: "",
				parameters: type({ input: type("string"), path: type("string") }),
			};
			expect(() =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "c3",
					name: "multi-arg",
					arguments: { other: "hello", path: "file.ts" },
				}),
			).toThrow();
		});

		it("does not remap when there is no string candidate", () => {
			const tool: Tool = {
				name: "single-arg",
				description: "",
				parameters: type({ input: type("string") }),
			};
			expect(() =>
				validateToolArguments(tool, {
					type: "toolCall",
					id: "c4",
					name: "single-arg",
					arguments: { other: 123 },
				}),
			).toThrow();
		});
	});
});

describe("In-band arg spill healing", () => {
	const todoTool: Tool = {
		name: "todo",
		description: "",
		parameters: type({
			op: type.enumeration(["append", "done", "drop", "init", "rm", "start", "view"]),
			task: type("string").optional(),
			phase: type("string").optional(),
		}),
	};

	function run(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
		return validateToolArguments(tool, {
			type: "toolCall",
			id: "call-spill",
			name: tool.name,
			arguments: args,
		}) as Record<string, unknown>;
	}

	it("heals the wrong-closer spill delivered via native tool calling", () => {
		// Exact payload observed in the wild: the model closed the value with
		// </arg_key>, so the provider parser swallowed the next pair into `op`.
		const result = run(todoTool, {
			op: "done</arg_key>\n<arg_key>task</arg_key>\n<arg_value>Unify history column property",
		});
		expect(result).toEqual({ op: "done", task: "Unify history column property" });
	});

	it("heals a missing closer before the next inlined pair", () => {
		const result = run(todoTool, {
			op: "done\n<arg_key>task</arg_key>\n<arg_value>Unify history column property</arg_value>",
		});
		expect(result).toEqual({ op: "done", task: "Unify history column property" });
	});

	it("strips a stray wrong closer with a trailing </tool_call>", () => {
		const result = run(todoTool, { op: "view</arg_key>\n</tool_call>" });
		expect(result).toEqual({ op: "view" });
	});

	it("coerces recovered pair values against the schema", () => {
		const tool: Tool = {
			name: "spill-coerce",
			description: "",
			parameters: type({
				op: type.enumeration(["read"]),
				count: type("number").optional(),
			}),
		};
		const result = run(tool, {
			op: "read</arg_key>\n<arg_key>count</arg_key>\n<arg_value>3",
		});
		expect(result).toEqual({ op: "read", count: 3 });
	});

	it("never overwrites an existing argument with a spilled pair", () => {
		const result = run(todoTool, {
			op: "done</arg_key>\n<arg_key>task</arg_key>\n<arg_value>spilled",
			task: "original",
		});
		expect(result).toEqual({ op: "done", task: "original" });
	});

	it("leaves valid calls with tag-like string content untouched", () => {
		const tool: Tool = {
			name: "spill-content",
			description: "",
			parameters: type({ content: type("string") }),
		};
		const content = "docs: emit </arg_key>\n<arg_key>path</arg_key>\n<arg_value>src/a.ts</arg_value> pairs";
		const result = run(tool, { content });
		expect(result).toEqual({ content });
	});
});
