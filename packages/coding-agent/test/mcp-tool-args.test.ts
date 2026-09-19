import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { DeferredMCPTool, MCPTool, type MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

const unusedContext = {} as CustomToolContext;

function createSearchToolDefinition(): MCPToolDefinition {
	return {
		name: "search",
		description: "Search symbols or file locations",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string" },
				language: { type: "string" },
				file: { type: "string" },
				line: { type: "number" },
				column: { type: "number" },
				filters: { type: "object" },
				exact: { type: "boolean" },
			},
			required: ["symbol", "language"],
		},
	};
}

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

function createHistoryToolDefinition(keyword: "anyOf" | "oneOf"): MCPToolDefinition {
	return {
		name: "preview_history",
		inputSchema: {
			type: "object",
			properties: {
				source_row_id: { type: ["string", "null"] },
				expected_source_revision: { type: ["string", "null"] },
				values: {
					[keyword]: [
						{
							type: "object",
							additionalProperties: false,
							properties: {
								form: { const: "salary" },
								amount: { type: "string" },
								currency: { enum: ["COP", "USD"] },
								effectiveFrom: { type: "string" },
							},
							required: ["form", "amount", "currency", "effectiveFrom"],
						},
						{
							type: "object",
							additionalProperties: false,
							properties: {
								form: { const: "work" },
								clientId: { type: "string" },
								startDate: { type: "string" },
								endDate: { type: ["string", "null"] },
								staffingDiscountUntil: { type: ["string", "null"] },
								staffingDiscountPercent: { type: ["string", "null"] },
							},
							required: [
								"form",
								"clientId",
								"startDate",
								"endDate",
								"staffingDiscountUntil",
								"staffingDiscountPercent",
							],
						},
					],
				},
			},
			required: ["source_row_id", "expected_source_revision", "values"],
		},
	};
}

function workHistoryArgs(): Record<string, unknown> {
	return {
		source_row_id: null,
		expected_source_revision: null,
		values: {
			form: "work",
			clientId: "synthetic-client",
			startDate: "2026-09-14",
			endDate: null,
			staffingDiscountUntil: null,
			staffingDiscountPercent: null,
		},
	};
}

async function dispatchValidated(tool: MCPTool, args: Record<string, unknown>): Promise<void> {
	const validated = validateToolArguments(tool, {
		type: "toolCall",
		id: "history-preview",
		name: tool.name,
		arguments: args,
	});
	await tool.execute("history-preview", validated, undefined, unusedContext);
}

const imageToolDefinition: MCPToolDefinition = {
	name: "read_image_with_model",
	description: "Read an image from a local filesystem path",
	inputSchema: {
		type: "object",
		properties: {
			image_path: { type: "string" },
		},
		required: ["image_path"],
	},
};

async function createLocalImageContext(
	tempDir: TempDir,
): Promise<{ context: CustomToolContext; expectedPath: string }> {
	const artifactsDir = tempDir.join("artifacts");
	const writtenPath = path.join(artifactsDir, "local", "image-issue.png");
	await Bun.write(writtenPath, "png bytes");
	const expectedPath = await fs.realpath(writtenPath);
	return {
		context: {
			localProtocolOptions: {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-id",
			},
		} as CustomToolContext,
		expectedPath,
	};
}

describe("MCP tool arguments", () => {
	it.each(["anyOf", "oneOf"] as const)(
		"retains required nested nulls through %s normalization and MCP dispatch",
		async keyword => {
			const calls: CapturedRequest[] = [];
			const tool = new MCPTool(createCapturedConnection(calls), createHistoryToolDefinition(keyword));
			const args = workHistoryArgs();

			await dispatchValidated(tool, args);

			expect(calls).toEqual([
				{ method: "tools/call", params: { name: "preview_history", arguments: workHistoryArgs() } },
			]);
		},
	);

	it("does not lose nested nulls while a later pass repairs the union discriminator", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createHistoryToolDefinition("anyOf"));
		const args = workHistoryArgs();
		args.values = { ...(args.values as Record<string, unknown>), form: " work " };

		await dispatchValidated(tool, args);

		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "preview_history", arguments: workHistoryArgs() } },
		]);
	});

	it.each(["anyOf", "oneOf"] as const)(
		"composes null cleanup and discriminator repair within a valid %s branch before dispatch",
		async keyword => {
			const calls: CapturedRequest[] = [];
			const tool = new MCPTool(createCapturedConnection(calls), {
				name: "repair_union",
				inputSchema: {
					type: "object",
					properties: {
						values: {
							[keyword]: ["a", "b"].map(op => ({
								type: "object",
								additionalProperties: false,
								properties: {
									op: { const: op },
									note: { type: "string" },
									label: { type: "string", default: "untitled" },
								},
								required: ["op", "label"],
							})),
						},
					},
					required: ["values"],
				},
			});

			await dispatchValidated(tool, { values: { op: " a ", note: null, label: null } });

			expect(calls).toEqual([
				{
					method: "tools/call",
					params: { name: "repair_union", arguments: { values: { op: "a", label: "untitled" } } },
				},
			]);
			calls.length = 0;
			await expect(dispatchValidated(tool, { values: { op: "unknown", note: null, label: null } })).rejects.toThrow(
				"Validation failed",
			);
			expect(calls).toEqual([]);
		},
	);

	it.each(["anyOf", "oneOf"] as const)(
		"composes default discriminators and boolean coercion inside a %s candidate before dispatch",
		async keyword => {
			const calls: CapturedRequest[] = [];
			const tool = new MCPTool(createCapturedConnection(calls), {
				name: "repair_default_discriminator",
				inputSchema: {
					type: "object",
					properties: {
						values: {
							[keyword]: [
								{
									type: "object",
									additionalProperties: false,
									properties: { op: { const: "a" } },
									required: ["op"],
								},
								{
									type: "object",
									additionalProperties: false,
									properties: {
										op: { const: "b", default: "b" },
										enabled: { type: "boolean" },
									},
									required: ["op", "enabled"],
								},
							],
						},
					},
					required: ["values"],
				},
			});
			// The default selects b, authorizing its existing unknown-key repair.
			const args = { values: { op: null, enabled: "true", extra: "discard only after selection" } };
			await dispatchValidated(tool, args);
			expect(calls).toEqual([
				{
					method: "tools/call",
					params: {
						name: "repair_default_discriminator",
						arguments: { values: { op: "b", enabled: true } },
					},
				},
			]);
			expect(args).toEqual({ values: { op: null, enabled: "true", extra: "discard only after selection" } });
			calls.length = 0;
			await expect(dispatchValidated(tool, { values: { op: null, enabled: "unknown" } })).rejects.toThrow(
				"Validation failed",
			);
			expect(calls).toEqual([]);
		},
	);

	it.each(["anyOf", "oneOf"] as const)(
		"reconsiders null cleanup after identifier repair makes a %s branch viable",
		async keyword => {
			const calls: CapturedRequest[] = [];
			const tool = new MCPTool(createCapturedConnection(calls), {
				name: "repair_identifier",
				inputSchema: {
					type: "object",
					properties: {
						values: {
							[keyword]: ["a", "b"].map(op => ({
								type: "object",
								properties: {
									op: { const: op },
									path: { type: "string", maxLength: 7 },
									note: { type: "string" },
								},
								required: ["op", "path"],
							})),
						},
					},
					required: ["values"],
				},
			});
			await dispatchValidated(tool, { values: { op: "a", path: "file.ts\n", note: null } });
			expect(calls).toEqual([
				{
					method: "tools/call",
					params: { name: "repair_identifier", arguments: { values: { op: "a", path: "file.ts" } } },
				},
			]);
		},
	);

	it("still rejects ambiguous oneOf matches before MCP dispatch", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), {
			name: "ambiguous",
			inputSchema: {
				type: "object",
				properties: { values: { oneOf: [{ type: "object" }, { type: "object" }] } },
				required: ["values"],
			},
		});
		await expect(dispatchValidated(tool, { values: { endDate: null } })).rejects.toThrow("Validation failed");
		expect(calls).toEqual([]);
	});

	it("keeps the salary branch payload intact through normalization and MCP dispatch", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createHistoryToolDefinition("anyOf"));
		const args = {
			source_row_id: null,
			expected_source_revision: null,
			values: { form: "salary", amount: "100", currency: "USD", effectiveFrom: "2026-09-14" },
		};

		await dispatchValidated(tool, args);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "preview_history", arguments: args } }]);
	});

	it("rejects missing, non-nullable, and wrong-branch values before MCP dispatch", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createHistoryToolDefinition("anyOf"));
		const work = workHistoryArgs().values as Record<string, unknown>;
		const missing = { ...work };
		delete missing.endDate;
		const invalidValues = [
			missing,
			{ ...work, clientId: null },
			{ ...work, form: "salary" },
			{ form: "salary", amount: "100", currency: "EUR", effectiveFrom: "2026-09-14" },
		];
		for (const values of invalidValues) {
			await expect(dispatchValidated(tool, { ...workHistoryArgs(), values })).rejects.toThrow("Validation failed");
		}
		expect(calls).toEqual([]);
	});

	it("omits optional empty placeholders before tools/call", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "", file: "", line: 0, filters: {}, exact: false },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "", line: 0, exact: false },
				},
			},
		]);
	});

	it("omits optional empty placeholders for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "TypeScript", file: "", column: "", filters: {} },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "TypeScript" },
				},
			},
		]);
	});

	it("strips the harness intent field before tools/call", async () => {
		// Regression: the harness injects `i` into every tool's wire schema and
		// the eval `tool.*` bridge forwards it verbatim. Strict-schema MCP
		// servers (e.g. Linear) reject every such call with
		// `unrecognized_keys: ["i"]`. The MCP boundary owns the contract; `i`
		// must never reach `tools/call`.
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "looking up Foo", symbol: "Foo", language: "TypeScript", file: "" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Foo", language: "TypeScript" } },
			},
		]);
	});

	it("strips the harness intent field for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "deferred lookup", symbol: "Bar", language: "TypeScript" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Bar", language: "TypeScript" } },
			},
		]);
	});

	it("preserves `i` when the server's own schema declares it", async () => {
		// A server that legitimately exposes `i` as one of its parameters
		// must receive the caller-supplied value untouched. The boundary
		// guard checks the server's schema and steps aside.
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "echo",
			description: "Echo a single token",
			inputSchema: {
				type: "object",
				properties: { i: { type: "string" } },
				required: ["i"],
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute("call-1", { i: "hello" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "echo", arguments: { i: "hello" } } }]);
	});

	it("strips harness intent when propertyNames cannot admit an additional property", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "closed-property-names",
			inputSchema: {
				type: "object",
				properties: { value: {} },
				propertyNames: { type: "string" },
				additionalProperties: false,
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);
		await tool.execute("closed", { value: "x", i: "caller intent" }, undefined, unusedContext, undefined);
		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "closed-property-names", arguments: { value: "x" } } },
		]);
	});

	it.each(["const", "enum"] as const)("forwards intent owned by an object-valued %s", async keyword => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "object-constraint",
			inputSchema: {
				type: "object",
				[keyword]: keyword === "const" ? { i: "token" } : [{ i: "token" }],
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);
		await tool.execute("object", { i: "token" }, undefined, unusedContext, undefined);
		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "object-constraint", arguments: { i: "token" } } },
		]);
	});

	it("strips harness intent prohibited by a false property schema", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), {
			name: "false-intent",
			inputSchema: { type: "object", properties: { i: false } },
		});
		await tool.execute("false", { i: "caller intent" }, undefined, unusedContext, undefined);
		expect(calls).toEqual([{ method: "tools/call", params: { name: "false-intent", arguments: {} } }]);
	});

	it("strips intent prohibited by a false pattern schema", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), {
			name: "false-pattern-intent",
			inputSchema: { type: "object", patternProperties: { "^i$": false } },
		});
		await tool.execute("false-pattern", { i: "caller intent" }, undefined, unusedContext, undefined);
		expect(calls).toEqual([{ method: "tools/call", params: { name: "false-pattern-intent", arguments: {} } }]);
	});

	it("forwards intent constrained by unevaluatedProperties", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), {
			name: "unevaluated-intent",
			inputSchema: { type: "object", unevaluatedProperties: { type: "string" }, minProperties: 1 },
		});
		await tool.execute("unevaluated", { i: "caller intent" }, undefined, unusedContext, undefined);
		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "unevaluated-intent", arguments: { i: "caller intent" } } },
		]);
	});

	it("strips harness intent explicitly prohibited by not-required", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), {
			name: "forbidden-presence",
			inputSchema: { type: "object", not: { required: ["i"] } },
		});
		await tool.execute("not-required", { i: "caller intent" }, undefined, unusedContext, undefined);
		expect(calls).toEqual([{ method: "tools/call", params: { name: "forbidden-presence", arguments: {} } }]);
	});

	it("forwards intent admitted by propertyNames", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "property-name-input",
			description: "Echo property-name input",
			inputSchema: {
				type: "object",
				propertyNames: { const: INTENT_FIELD },
				minProperties: 1,
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute("call-property-name", { [INTENT_FIELD]: "server data" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "property-name-input", arguments: { [INTENT_FIELD]: "server data" } },
			},
		]);
	});

	it("strips intent excluded by propertyNames", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "excluded-property-name-input",
			description: "Echo ordinary input",
			inputSchema: {
				type: "object",
				properties: { value: { type: "string" } },
				propertyNames: { not: { const: INTENT_FIELD } },
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute(
			"call-excluded-property-name",
			{ value: "ordinary", [INTENT_FIELD]: "harness intent" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "excluded-property-name-input", arguments: { value: "ordinary" } },
			},
		]);
	});

	it("forwards schema-owned intent through a referenced MCP schema", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "referenced-input",
			inputSchema: {
				type: "object",
				$ref: "#/$defs/input",
				$defs: { input: { type: "object", properties: { i: { type: "string" } }, required: ["i"] } },
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);
		await tool.execute("call-ref", { i: "server data" }, undefined, unusedContext, undefined);
		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "referenced-input", arguments: { i: "server data" } } },
		]);
	});

	it("preserves intent declared by legacy dependencies", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "legacy-dependent-input",
			description: "Echo legacy dependent input",
			inputSchema: {
				type: "object",
				properties: { mode: { type: "string" } },
				dependencies: { mode: [INTENT_FIELD] },
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute(
			"call-legacy",
			{ mode: "active", [INTENT_FIELD]: "server data" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "legacy-dependent-input", arguments: { mode: "active", [INTENT_FIELD]: "server data" } },
			},
		]);
	});

	it("does not claim intent from an unused MCP schema definition", async () => {
		const calls: CapturedRequest[] = [];
		const definition = createSearchToolDefinition();
		definition.inputSchema.$defs = {
			unused: { type: "object", properties: { i: { type: "string" } }, required: ["i"] },
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);
		await tool.execute(
			"call-unused",
			{ i: "harness intent", symbol: "Foo", language: "TypeScript" },
			undefined,
			unusedContext,
			undefined,
		);
		expect(calls).toEqual([
			{ method: "tools/call", params: { name: "search", arguments: { symbol: "Foo", language: "TypeScript" } } },
		]);
	});

	it("resolves local image arguments before forwarding tools/call", async () => {
		using tempDir = TempDir.createSync("@pi-mcp-local-image-");
		const calls: CapturedRequest[] = [];
		const { context, expectedPath } = await createLocalImageContext(tempDir);
		const tool = new MCPTool(createCapturedConnection(calls), imageToolDefinition);

		await tool.execute("call-1", { image_path: "local://image-issue.png" }, undefined, context, undefined);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "read_image_with_model", arguments: { image_path: expectedPath } },
			},
		]);
	});
});
