import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { type TodoPhase, TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function createTool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function createSchemaTool(name: string, parameters: Record<string, unknown>): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters,
		concurrency: "parallel",
		execute: async (_id: string, args: unknown) => ({
			content: [
				{
					type: "text" as const,
					text: `${typeof (args as Record<string, unknown>)[INTENT_FIELD]}:${String((args as Record<string, unknown>)[INTENT_FIELD])}`,
				},
			],
		}),
	} as unknown as AgentTool;
}

function createSession(tools: AgentTool[]): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => registry.get(name),
	};
}

describe("callSessionTool", () => {
	it("injects js intent and summarizes text results", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});
		const session = createSession([createTool("read", execute)]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"read",
			{ path: "/tmp/demo.txt" },
			{
				session,
				emitStatus: event => {
					statuses.push(event);
				},
			},
		);

		expect(result).toBe("hello");
		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-read-/),
			{ path: "/tmp/demo.txt", [INTENT_FIELD]: "js prelude" },
			undefined,
			undefined,
			undefined,
		);
		expect(statuses).toEqual([expect.objectContaining({ op: "read", path: "/tmp/demo.txt", chars: 5 })]);
	});

	it("passes the session tool context to bridged executions", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const context = { settings: Settings.isolated() } as AgentToolContext;
		const session = {
			...createSession([createTool("bash", execute)]),
			getToolContext: () => context,
		};

		await callSessionTool("bash", { command: "true" }, { session });

		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-bash-/),
			{ command: "true", [INTENT_FIELD]: "js prelude" },
			undefined,
			undefined,
			context,
		);
	});

	it("validates optional nulls before executing a real todo tool", async () => {
		let phases: TodoPhase[] = [
			{
				name: "Regression",
				tasks: [{ content: "Exercise bridge", status: "in_progress" }],
			},
		];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		const result = await callSessionTool(
			"todo",
			{
				op: "done",
				phase: "Regression",
				list: null,
				task: null,
				items: null,
				reason: null,
			},
			{ session },
		);

		expect(result).not.toEqual(expect.objectContaining({ hasError: true }));
		expect(phases[0]?.tasks.map(task => task.status)).toEqual(["completed"]);
	});

	it("rejects null for a required field before executing a strict tool", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "unexpected" }] });
		const tool: AgentTool = {
			name: "strict",
			label: "strict",
			description: "strict tool",
			parameters: type({ value: "string" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;
		await expect(callSessionTool("strict", { value: null }, { session: createSession([tool]) })).rejects.toThrow(
			"Validation failed",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves caller intent through closed-schema validation", async () => {
		const tool: AgentTool = {
			name: "intent",
			label: "intent",
			description: "intent tool",
			parameters: type({ "value?": "string" }).onUndeclaredKey("reject"),
			concurrency: "shared",
			execute: async (_id: string, args: unknown) => ({
				content: [{ type: "text", text: String((args as Record<string, unknown>)[INTENT_FIELD]) }],
			}),
		} as unknown as AgentTool;
		const result = await callSessionTool(
			"intent",
			{ value: "x", [INTENT_FIELD]: "caller intent" },
			{ session: createSession([tool]) },
		);
		expect(result).toBe("caller intent");
	});

	it("validates and preserves a schema-declared intent field", async () => {
		const execute = async (_id: string, args: unknown) => ({
			content: [
				{
					type: "text" as const,
					text: `${typeof (args as Record<string, unknown>)[INTENT_FIELD]}:${String((args as Record<string, unknown>)[INTENT_FIELD])}`,
				},
			],
		});
		const tool: AgentTool = {
			name: "required-intent",
			label: "required intent",
			description: "required intent tool",
			parameters: type({ [INTENT_FIELD]: "number" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;

		const result = await callSessionTool(
			"required-intent",
			{ [INTENT_FIELD]: "5" },
			{ session: createSession([tool]) },
		);

		expect(result).toBe("number:5");
	});

	it("preserves a required-only intent field", async () => {
		const tool = createSchemaTool("required-only-intent", {
			type: "object",
			required: [INTENT_FIELD],
		});

		expect(
			await callSessionTool(
				"required-only-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("preserves intent required by a dependent property", async () => {
		const tool = createSchemaTool("dependent-required-intent", {
			type: "object",
			properties: { mode: { type: "string" } },
			dependentRequired: { mode: [INTENT_FIELD] },
		});

		expect(
			await callSessionTool(
				"dependent-required-intent",
				{ mode: "active", [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("rejects a missing field required by supplied intent", async () => {
		const tool = createSchemaTool("intent-dependent-trigger", {
			type: "object",
			dependentRequired: { [INTENT_FIELD]: ["value"] },
		});
		const execute = vi.fn(tool.execute);
		tool.execute = execute;

		await expect(
			callSessionTool(
				"intent-dependent-trigger",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves harness intent when propertyNames does not open a closed schema", async () => {
		const tool = createSchemaTool("closed-property-names", {
			type: "object",
			properties: { value: {} },
			propertyNames: { type: "string" },
			additionalProperties: false,
		});
		expect(
			await callSessionTool(
				"closed-property-names",
				{ value: "x", i: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it.each(["const", "enum"] as const)("preserves intent in object-valued %s", async keyword => {
		const tool = createSchemaTool("object-constraint", {
			type: "object",
			[keyword]: keyword === "const" ? { i: "token" } : [{ i: "token" }],
		});
		expect(await callSessionTool("object-constraint", { i: "token" }, { session: createSession([tool]) })).toBe(
			"string:token",
		);
	});

	it("preserves intent admitted by propertyNames", async () => {
		const tool = createSchemaTool("property-name-intent", {
			type: "object",
			propertyNames: { const: INTENT_FIELD },
			minProperties: 1,
		});

		expect(
			await callSessionTool(
				"property-name-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("preserves intent admitted by referenced propertyNames", async () => {
		const tool = createSchemaTool("referenced-property-name-intent", {
			type: "object",
			propertyNames: { $ref: "#/$defs/intentName" },
			minProperties: 1,
			$defs: { intentName: { const: INTENT_FIELD } },
		});

		expect(
			await callSessionTool(
				"referenced-property-name-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("does not claim intent excluded by propertyNames", async () => {
		const tool = createSchemaTool("excluded-property-name-intent", {
			type: "object",
			propertyNames: { not: { const: INTENT_FIELD } },
		});

		expect(
			await callSessionTool(
				"excluded-property-name-intent",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("rejects invalid intent matched by patternProperties", async () => {
		const tool = createSchemaTool("pattern-intent", {
			type: "object",
			patternProperties: { "^i$": { type: "number" } },
		});
		const execute = vi.fn(tool.execute);
		tool.execute = execute;

		await expect(
			callSessionTool("pattern-intent", { [INTENT_FIELD]: "invalid" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves and coerces intent consumed by additionalProperties", async () => {
		const tool = createSchemaTool("additional-intent", {
			type: "object",
			additionalProperties: { type: "number" },
		});

		expect(
			await callSessionTool("additional-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) }),
		).toBe("number:5");
	});

	it("treats intent ownership as schema-wide across anyOf branches", async () => {
		const tool = createSchemaTool("schema-wide-intent", {
			anyOf: [
				{
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			],
		});
		const execute = vi.fn(tool.execute);
		tool.execute = execute;
		const session = createSession([tool]);

		await expect(
			callSessionTool("schema-wide-intent", { value: "x", [INTENT_FIELD]: "invalid" }, { session }),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
		expect(await callSessionTool("schema-wide-intent", { value: "x" }, { session })).toBe("undefined:undefined");
	});

	it("preserves and coerces a required intent field declared by an anyOf branch", async () => {
		const tool = createSchemaTool("any-of-intent", {
			anyOf: [
				{
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			],
		});

		expect(await callSessionTool("any-of-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) })).toBe(
			"number:5",
		);
	});

	it("preserves and coerces an intent field declared by a oneOf branch", async () => {
		const tool = createSchemaTool("one-of-intent", {
			oneOf: [
				{
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			],
		});

		expect(await callSessionTool("one-of-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) })).toBe(
			"number:5",
		);
	});

	it("preserves and coerces an intent field constrained by allOf", async () => {
		const tool = createSchemaTool("all-of-intent", {
			type: "object",
			allOf: [
				{
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
				},
			],
		});

		expect(await callSessionTool("all-of-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) })).toBe(
			"number:5",
		);
	});

	it("preserves and coerces intent declared by a selected conditional branch", async () => {
		const tool = createSchemaTool("conditional-intent", {
			type: "object",
			properties: { mode: { type: "string" } },
			required: ["mode"],
			if: {
				properties: { mode: { const: "intent" } },
				required: ["mode"],
			},
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema if/then/else keyword
			then: {
				properties: { [INTENT_FIELD]: { type: "number" } },
				required: [INTENT_FIELD],
			},
		});

		expect(
			await callSessionTool(
				"conditional-intent",
				{ mode: "intent", [INTENT_FIELD]: "5" },
				{ session: createSession([tool]) },
			),
		).toBe("number:5");
	});

	it("preserves and coerces intent declared by an activated dependent schema", async () => {
		const tool = createSchemaTool("dependent-intent", {
			type: "object",
			properties: { enabled: { type: "boolean" } },
			required: ["enabled"],
			dependentSchemas: {
				enabled: {
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
				},
			},
		});

		expect(
			await callSessionTool(
				"dependent-intent",
				{ enabled: true, [INTENT_FIELD]: "5" },
				{ session: createSession([tool]) },
			),
		).toBe("number:5");
	});

	it("keeps intent predicates from bypassing conditional validation", async () => {
		const tool = createSchemaTool("intent-predicate", {
			type: "object",
			if: { properties: { i: { const: "strict" } }, required: ["i"] },
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema if/then/else keyword
			then: { properties: { value: { type: "number" } }, required: ["value"] },
		});
		await expect(
			callSessionTool("intent-predicate", { i: "strict", value: "invalid" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
	});

	it.each(["direct", "annotated", "reference"] as const)(
		"keeps harness intent out of a presence prohibition (%s)",
		async shape => {
			const presence =
				shape === "annotated"
					? { type: "object", required: ["i"], description: "Reserved name" }
					: { required: ["i"] };
			const tool = createSchemaTool("forbidden-presence", {
				type: "object",
				not: shape === "reference" ? { $ref: "#/$defs/presence" } : presence,
				$defs: { presence },
			});
			expect(
				await callSessionTool("forbidden-presence", { i: "caller intent" }, { session: createSession([tool]) }),
			).toBe("string:caller intent");
		},
	);

	it("keeps harness intent out of a false property schema", async () => {
		const tool = createSchemaTool("false-intent", { type: "object", properties: { i: false } });
		expect(await callSessionTool("false-intent", { i: "caller intent" }, { session: createSession([tool]) })).toBe(
			"string:caller intent",
		);
	});

	it("strips intent prohibited by a false pattern schema", async () => {
		const tool = createSchemaTool("false-pattern-intent", {
			type: "object",
			patternProperties: { "^i$": false },
		});
		expect(
			await callSessionTool("false-pattern-intent", { i: "caller intent" }, { session: createSession([tool]) }),
		).toBe("string:caller intent");
	});

	it("preserves intent constrained by unevaluatedProperties", async () => {
		const tool = createSchemaTool("unevaluated-intent", {
			type: "object",
			unevaluatedProperties: { type: "string" },
			minProperties: 1,
		});
		expect(
			await callSessionTool("unevaluated-intent", { i: "caller intent" }, { session: createSession([tool]) }),
		).toBe("string:caller intent");
	});

	it("preserves data required by negating a false property schema", async () => {
		const tool = createSchemaTool("not-false-intent", { type: "object", not: { properties: { i: false } } });
		expect(await callSessionTool("not-false-intent", { i: "data" }, { session: createSession([tool]) })).toBe(
			"string:data",
		);
	});

	it("preserves false-property predicates as decision inputs", async () => {
		const tool = createSchemaTool("false-intent-predicate", {
			type: "object",
			if: { properties: { i: false } },
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema if/then/else keyword
			then: false,
			else: true,
		});
		expect(await callSessionTool("false-intent-predicate", { i: "data" }, { session: createSession([tool]) })).toBe(
			"string:data",
		);
	});

	it("preserves intent required by double negation", async () => {
		const tool = createSchemaTool("double-not-intent", { type: "object", not: { not: { required: ["i"] } } });
		expect(await callSessionTool("double-not-intent", { i: "data" }, { session: createSession([tool]) })).toBe(
			"string:data",
		);
	});

	it("visits a shared reference under both negation polarities", async () => {
		const tool = createSchemaTool("shared-polarity", {
			type: "object",
			anyOf: [{ $ref: "#/$defs/absent" }, { not: { $ref: "#/$defs/absent" } }],
			$defs: { absent: { not: { required: ["i"] } } },
		});
		expect(await callSessionTool("shared-polarity", {}, { session: createSession([tool]) })).toBe(
			"undefined:undefined",
		);
	});

	it("validates intent constraints inside a negated schema", async () => {
		const tool = createSchemaTool("negated-intent", {
			type: "object",
			not: { properties: { i: { const: "forbidden" } }, required: ["i"] },
		});
		await expect(
			callSessionTool("negated-intent", { i: "forbidden" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
	});

	it("preserves and coerces intent through an escaped local reference", async () => {
		const tool = createSchemaTool("referenced-intent", {
			$ref: "#/$defs/intent~1property~0schema",
			$defs: {
				"intent/property~schema": {
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
					required: [INTENT_FIELD],
					additionalProperties: false,
				},
			},
		});

		expect(
			await callSessionTool("referenced-intent", { [INTENT_FIELD]: "5" }, { session: createSession([tool]) }),
		).toBe("number:5");
	});

	it("terminates cyclic local references without claiming intent ownership", async () => {
		const tool = createSchemaTool("cyclic-schema", {
			$ref: "#/$defs/cycle",
			$defs: { cycle: { $ref: "#/$defs/cycle" } },
		});

		expect(
			await callSessionTool(
				"cyclic-schema",
				{ [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("does not treat a nested intent property as a root tool parameter", async () => {
		const tool = createSchemaTool("nested-intent", {
			type: "object",
			properties: {
				wrapper: {
					type: "object",
					properties: { [INTENT_FIELD]: { type: "number" } },
				},
			},
			additionalProperties: false,
		});

		expect(
			await callSessionTool(
				"nested-intent",
				{ wrapper: {}, [INTENT_FIELD]: "caller intent" },
				{ session: createSession([tool]) },
			),
		).toBe("string:caller intent");
	});

	it("validates constrained tool-owned intent without supplying a missing optional value", async () => {
		const execute = vi.fn(async (_id: string, args: unknown) => ({
			content: [{ type: "text" as const, text: String((args as Record<string, unknown>)[INTENT_FIELD]) }],
		}));
		const tool: AgentTool = {
			name: "constrained-intent",
			label: "constrained intent",
			description: "constrained intent tool",
			parameters: type({ [`${INTENT_FIELD}?`]: "'allowed'" }),
			concurrency: "parallel",
			execute,
		} as unknown as AgentTool;

		await expect(
			callSessionTool("constrained-intent", { [INTENT_FIELD]: "disallowed" }, { session: createSession([tool]) }),
		).rejects.toThrow("Validation failed");
		expect(execute).not.toHaveBeenCalled();
		expect(await callSessionTool("constrained-intent", {}, { session: createSession([tool]) })).toBe("undefined");
	});

	it("recovers a missing todo operation from raw parse metadata", async () => {
		let phases: TodoPhase[] = [];
		const session: ToolSession = {
			...createSession([]),
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
			getToolByName: name => (name === "todo" ? (todoTool as unknown as AgentTool) : undefined),
		};
		const todoTool = new TodoTool(session);

		const result = await callSessionTool(
			"todo",
			{
				list: [{ phase: "Recovered", items: ["From malformed JSON"] }],
				__parseError: "Unexpected token",
				__rawJson: '{"list": [broken}',
			},
			{ session },
		);

		expect(result).not.toEqual(expect.objectContaining({ hasError: true }));
		expect(phases).toEqual([
			{ name: "Recovered", tasks: [{ content: "From malformed JSON", status: "in_progress" }] },
		]);
	});

	it("returns structured tool results when details or images are present", async () => {
		const session = createSession([
			createTool("custom", async () => ({
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "abc123" },
				],
				details: { ok: true },
			})),
		]);

		const result = await callSessionTool("custom", {}, { session });

		expect(result).toEqual({
			text: "done",
			details: { ok: true },
			images: [{ mimeType: "image/png", data: "abc123" }],
		});
	});

	it("marks structured results when the underlying tool reports an error", async () => {
		const session = createSession([
			createTool("mcp__demo_fail", async () => ({
				content: [{ type: "text", text: "Error: bad input" }],
				details: { serverName: "demo", mcpToolName: "fail", isError: true },
			})),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"mcp__demo_fail",
			{},
			{ session, emitStatus: event => statuses.push(event) },
		);

		expect(result).toEqual({
			text: "Error: bad input",
			details: { serverName: "demo", mcpToolName: "fail", isError: true },
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "mcp__demo_fail",
				chars: 16,
				hasError: true,
				error: "Error: bad input",
			}),
		]);
	});

	it("marks results with top-level isError", async () => {
		const session = createSession([
			createTool(
				"custom",
				async () =>
					({
						content: [{ type: "text", text: "preview mismatch" }],
						isError: true,
					}) as AgentToolResult,
			),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool("custom", {}, { session, emitStatus: event => statuses.push(event) });

		expect(result).toEqual({
			text: "preview mismatch",
			details: undefined,
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "custom",
				chars: 16,
				hasError: true,
				error: "preview mismatch",
			}),
		]);
	});

	it("throws when the requested tool is not available in the session registry", async () => {
		const session = createSession([]);

		await expect(callSessionTool("missing", {}, { session })).rejects.toThrow("Unknown tool from js runtime");
	});

	it("executes the bridge-authorized tool instead of the raw registry tool", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const authorizedExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "authorized" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => createTool("write", authorizedExecute),
		};

		const result = await callSessionTool("write", { path: "out.txt", content: "data" }, { session });

		expect(result).toBe("authorized");
		expect(authorizedExecute).toHaveBeenCalledTimes(1);
		expect(rawExecute).not.toHaveBeenCalled();
	});

	it("rejects checkpoint and rewind before reaching the registry", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const session = createSession([createTool("checkpoint", execute), createTool("rewind", execute)]);

		await expect(callSessionTool("checkpoint", { goal: "g" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		await expect(callSessionTool("rewind", { report: "r" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a registry tool excluded from the eval bridge", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => undefined,
		};

		await expect(callSessionTool("write", { path: "out.txt", content: "data" }, { session })).rejects.toThrow(
			"Unknown tool from js runtime",
		);
		expect(rawExecute).not.toHaveBeenCalled();
	});
});
