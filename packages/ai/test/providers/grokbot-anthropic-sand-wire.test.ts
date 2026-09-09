import { describe, expect, test } from "bun:test";
import {
	applyAnthropicSandToolWire,
	isAnthropicSandModelId,
	resolveAnthropicSandToolsWire,
} from "../../src/providers/grokbot/anthropic-sand-wire";
import {
	OMP_TO_SAND_FIELD2,
	augmentToolIndexForProductWire,
	parseSendToUserContent,
	rewriteInferenceMessagesForProductWire,
	toOmpToolName,
	toProductField2Tools,
	wrapToolParameters,
} from "../../src/providers/grokbot/product-wire";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import {
	decodeInferenceStreamRequest,
	encodeInferenceStreamRequest,
	fieldNumbers,
} from "../../src/providers/grokbot/proto";

describe("anthropic sand tool wire", () => {
	test("detects anthropic sand model ids", () => {
		expect(isAnthropicSandModelId("claude-opus-5")).toBe(true);
		expect(isAnthropicSandModelId("claude_sonnet_4")).toBe(true);
		expect(isAnthropicSandModelId("claude-fable-5")).toBe(true);
		expect(isAnthropicSandModelId("claude-haiku-4-5")).toBe(true);
		expect(isAnthropicSandModelId("grok-4.6")).toBe(false);
		expect(isAnthropicSandModelId("sand-automation")).toBe(false);
	});

	test("passes through non-anthropic tool requests", () => {
		const requestedModel = resolveGrokbotRequestedModel("grok-4.6", {
			sandParameterIds: ["effort", "fast"],
		});
		const tools = [{ name: "read" }];
		expect(applyAnthropicSandToolWire({ requestedModel, tools, modelId: "grok-4.6" }, "error")).toEqual({
			requestedModel,
			tools,
			modelId: "grok-4.6",
		});
		expect(applyAnthropicSandToolWire({ requestedModel, tools, modelId: "grok-4.6" }, "native")).toEqual({
			requestedModel,
			tools,
			modelId: "grok-4.6",
			wireMode: "native",
		});
	});

	test("throws on explicit anthropic id with field-2 tools when wire is error", () => {
		const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
			sandParameterIds: ["thinking", "context", "effort", "fast"],
		});
		expect(() =>
			applyAnthropicSandToolWire({ requestedModel, tools: [{ name: "read" }], modelId: "claude-opus-5" }, "error"),
		).toThrow(/HTTP 400/);
	});

	test("automation wire rewrites anthropic model to sand-automation with product tools", () => {
		const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
			effort: "low",
			sandParameterIds: ["thinking", "context", "effort", "fast"],
		});
		const tools = [
			{
				name: "bash",
				description: "run shell",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
			{
				name: "read",
				description: "read file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		];
		const wired = applyAnthropicSandToolWire(
			{ requestedModel, tools, modelId: "claude-opus-5", ompTools: tools },
			"automation",
		);
		expect(wired.wireMode).toBe("automation");
		expect(wired.originalModelId).toBe("claude-opus-5");
		expect(wired.requestedModel.modelId).toBe("sand-automation");
		expect(wired.subagentType).toBe("generalPurpose");
		expect(typeof wired.automationId).toBe("string");
		expect(wired.acceptedUnadvertisedToolNames?.length).toBeGreaterThan(20);
		const names = (wired.tools as Array<{ name: string }>).map(t => t.name);
		expect(names).toContain("Shell");
		expect(names).toContain("Read");
		const shell = (wired.tools as Array<{ name: string; parameters: Record<string, unknown> }>).find(
			t => t.name === "Shell",
		);
		expect(shell?.parameters).toHaveProperty("jsonSchema");
	});

	test("auto resolves anthropic + tools to keep-model", () => {
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "claude-opus-5",
				toolCount: 2,
				sandToolsWire: "keep-model",
			}),
		).toBe("keep-model");
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "claude-fable-5",
				toolCount: 2,
				sandToolsWire: "keep-model",
			}),
		).toBe("keep-model");
		// Without catalog sand-tools-wire, auto does not invent Anthropic policy.
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "claude-opus-5",
				toolCount: 2,
			}),
		).toBe("native");
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "grok-4.6",
				toolCount: 2,
			}),
		).toBe("native");
		// Catalog override wins over the Anthropic-class default (e.g. native).
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "claude-opus-5",
				toolCount: 2,
				sandToolsWire: "native",
			}),
		).toBe("native");
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "claude-opus-5",
				toolCount: 2,
				sandToolsWire: "error",
			}),
		).toBe("error");
		// Router wire mode comes from catalog `sand-tools-wire`, not id compares.
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "sand-default",
				toolCount: 2,
				sandToolsWire: "parent-chat",
			}),
		).toBe("parent-chat");
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "sand-automation",
				toolCount: 2,
				sandToolsWire: "automation",
			}),
		).toBe("automation");
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "sand-default",
				toolCount: 2,
			}),
		).toBe("native");
	});

	test("keep-model keeps anthropic requestedModel and maps product tools", () => {
		const requestedModel = resolveGrokbotRequestedModel("claude-fable-5", {
			effort: "low",
			sandParameterIds: ["thinking", "context", "effort", "fast"],
		});
		const tools = [
			{
				name: "bash",
				description: "run shell",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
			{
				name: "read",
				description: "read file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
			{
				name: "write",
				description: "write file",
				parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
			},
			{
				name: "edit",
				description: "patch file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
			{
				name: "grep",
				description: "search files",
				parameters: { type: "object", properties: { pattern: { type: "string" } } },
			},
			{
				name: "glob",
				description: "find files",
				parameters: { type: "object", properties: { glob: { type: "string" } } },
			},
		];
		const wired = applyAnthropicSandToolWire(
			{ requestedModel, tools, modelId: "claude-fable-5", ompTools: tools },
			"keep-model",
		);
		expect(wired.wireMode).toBe("keep-model");
		expect(wired.requestedModel.modelId).toBe("claude-fable-5");
		expect(wired.requestedModel).toEqual(requestedModel);
		expect(wired.requestedModel.parameters).toEqual(requestedModel.parameters);
		expect(wired.originalModelId).toBe("claude-fable-5");
		expect(wired.subagentType).toBeUndefined();
		expect(wired.automationId).toBeUndefined();
		expect(wired.acceptedUnadvertisedToolNames?.length).toBeGreaterThan(20);
		const names = (wired.tools as Array<{ name: string }>).map(t => t.name);
		expect(names).toEqual(["Shell", "Read", "Write", "Grep", "Glob"]);
		for (const tool of wired.tools as Array<{ parameters: Record<string, unknown> }>) {
			expect(tool.parameters).toHaveProperty("jsonSchema");
		}
	});

	test("keep-model on non-anthropic is a no-op", () => {
		const requestedModel = resolveGrokbotRequestedModel("grok-4.6", {
			sandParameterIds: ["effort", "fast"],
		});
		const tools = [{ name: "read" }];
		const input = { requestedModel, tools, modelId: "grok-4.6" };
		expect(applyAnthropicSandToolWire(input, "keep-model")).toEqual(input);
	});

	test("catalog keep-model on non-anthropic strips parameters but keeps routing flags", () => {
		const requestedModel = resolveGrokbotRequestedModel("gemini-3-flash", {
			sandParameterIds: ["effort", "fast"],
			sandMaxMode: true,
			sandVariantStringRepresentation: true,
			effort: "high",
		});
		expect(requestedModel.maxMode).toBe(true);
		expect(requestedModel.isVariantStringRepresentation).toBe(true);
		expect(requestedModel.parameters?.length).toBeGreaterThan(0);
		const tools = [
			{
				name: "bash",
				description: "shell",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
		];
		const wired = applyAnthropicSandToolWire(
			{
				requestedModel,
				tools,
				modelId: "gemini-3-flash",
				ompTools: tools,
				sandToolsWire: "keep-model",
			},
			"keep-model",
		);
		expect(wired.wireMode).toBe("keep-model");
		expect(wired.requestedModel).toEqual({
			modelId: "gemini-3-flash",
			maxMode: true,
			isVariantStringRepresentation: true,
		});
		expect(wired.requestedModel.parameters).toBeUndefined();
		const names = (wired.tools as Array<{ name: string }>).map(t => t.name);
		expect(names).toContain("Shell");
	});

	test("automation/parent-chat without catalog sandToolsWire is a no-op for non-anthropic ids", () => {
		const automationModel = resolveGrokbotRequestedModel("sand-automation", {
			sandParameterIds: [],
		});
		const parentModel = resolveGrokbotRequestedModel("sand-default", {
			sandParameterIds: [],
		});
		const tools = [{ name: "bash", description: "shell", parameters: { type: "object", properties: {} } }];
		expect(
			applyAnthropicSandToolWire(
				{ requestedModel: automationModel, tools, modelId: "sand-automation" },
				"automation",
			),
		).toEqual({ requestedModel: automationModel, tools, modelId: "sand-automation" });
		expect(
			applyAnthropicSandToolWire({ requestedModel: parentModel, tools, modelId: "sand-default" }, "parent-chat"),
		).toEqual({ requestedModel: parentModel, tools, modelId: "sand-default" });
	});

	test("automation wire keeps sand-automation when catalog owns the wire", () => {
		const requestedModel = resolveGrokbotRequestedModel("sand-automation", {
			sandParameterIds: ["effort"],
		});
		const tools = [
			{
				name: "bash",
				description: "shell",
				parameters: { type: "object", properties: { command: { type: "string" } } },
			},
		];
		const wired = applyAnthropicSandToolWire(
			{
				requestedModel,
				tools,
				modelId: "sand-automation",
				ompTools: tools,
				sandToolsWire: "automation",
			},
			"automation",
		);
		expect(wired.wireMode).toBe("automation");
		expect(wired.requestedModel).toEqual({ modelId: "sand-automation" });
		expect(wired.subagentType).toBe("generalPurpose");
	});

	test("sand-default-fallback rewrites requested model and keeps tools", () => {
		const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
			effort: "low",
			sandParameterIds: ["thinking", "context", "effort", "fast"],
		});
		const tools = [{ name: "read" }, { name: "bash" }];
		const wired = applyAnthropicSandToolWire(
			{ requestedModel, tools, modelId: "claude-opus-5" },
			"sand-default-fallback",
		);
		expect(wired.wireMode).toBe("sand-default-fallback");
		expect(wired.originalModelId).toBe("claude-opus-5");
		expect(wired.requestedModel.modelId).toBe("sand-default");
		expect(wired.requestedModel.parameters).toBeUndefined();
		expect(wired.tools).toBe(tools);
	});

	test("resolveAnthropicSandToolsWire reads env aliases", () => {
		expect(resolveAnthropicSandToolsWire("sand-default-fallback", undefined)).toBe("sand-default-fallback");
		expect(resolveAnthropicSandToolsWire(undefined, "sand-default-fallback")).toBe("sand-default-fallback");
		expect(resolveAnthropicSandToolsWire(undefined, undefined, { modelId: "grok-4.6", toolCount: 0 })).toBe("error");
		expect(resolveAnthropicSandToolsWire("automation", undefined)).toBe("automation");
		expect(resolveAnthropicSandToolsWire("keep-model", undefined)).toBe("keep-model");
		expect(resolveAnthropicSandToolsWire("keep-id", undefined)).toBe("keep-model");
		expect(resolveAnthropicSandToolsWire("keep", undefined)).toBe("keep-model");
		expect(resolveAnthropicSandToolsWire("native", undefined)).toBe("native");
	});
});

describe("product wire helpers", () => {
	test("maps omp bash/read to Shell/Read with jsonSchema envelope", () => {
		expect(OMP_TO_SAND_FIELD2.bash).toBe("Shell");
		const tools = toProductField2Tools(
			[
				{
					name: "bash",
					description: "shell",
					parameters: { type: "object", properties: { command: { type: "string" } } },
				},
			],
			"automation",
		);
		expect(tools[0]?.name).toBe("Shell");
		expect(tools[0]?.parameters).toEqual(
			wrapToolParameters({ type: "object", properties: { command: { type: "string" } } }),
		);
	});

	test("Read schema advertises target_file as an alias of path", () => {
		const tools = toProductField2Tools(
			[
				{
					name: "read",
					description: "read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
			"automation",
		);
		expect(tools[0]?.name).toBe("Read");
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: {
					properties?: Record<string, unknown>;
					required?: string[];
					anyOf?: Array<{ required?: string[] }>;
				};
			}
		).jsonSchema;
		expect(schema?.properties).toHaveProperty("path");
		expect(schema?.properties).toHaveProperty("target_file");
		expect(schema?.required ?? []).not.toContain("path");
		expect(schema?.anyOf).toEqual([{ required: ["path"] }, { required: ["target_file"] }]);
		expect((schema?.properties?.target_file as { description?: string })?.description).toContain("alias of path");
	});

	test("Write schema advertises contents as an alias of content", () => {
		const tools = toProductField2Tools(
			[
				{
					name: "write",
					description: "write file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" }, content: { type: "string" } },
						required: ["path", "content"],
					},
				},
			],
			"automation",
		);
		expect(tools[0]?.name).toBe("Write");
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: {
					properties?: Record<string, unknown>;
					required?: string[];
					anyOf?: Array<{ required?: string[] }>;
				};
			}
		).jsonSchema;
		expect(schema?.properties).toHaveProperty("content");
		expect(schema?.properties).toHaveProperty("contents");
		expect(schema?.required).toEqual(["path"]);
		expect(schema?.anyOf).toEqual([{ required: ["content"] }, { required: ["contents"] }]);
		expect((schema?.properties?.contents as { description?: string })?.description).toContain("alias of content");
	});

	test("Write alias rewrites branch-local required when canonical is only in anyOf", () => {
		const tools = toProductField2Tools(
			[
				{
					name: "write",
					description: "write file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							content: { type: "string" },
						},
						anyOf: [{ required: ["content"] }, { required: ["path"] }],
					},
				},
			],
			"automation",
		);
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: {
					properties?: Record<string, unknown>;
					required?: string[];
					anyOf?: Array<{ required?: string[]; anyOf?: Array<{ required?: string[] }> }>;
				};
			}
		).jsonSchema;
		expect(schema?.properties).toHaveProperty("contents");
		expect(schema?.required).toBeUndefined();
		expect(schema?.anyOf).toEqual([
			{ required: [], anyOf: [{ required: ["content"] }, { required: ["contents"] }] },
			{ required: ["path"] },
		]);
	});

	test("Read alias rewrites branch-local required when canonical is only in oneOf", () => {
		const tools = toProductField2Tools(
			[
				{
					name: "read",
					description: "read file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							offset: { type: "number" },
						},
						oneOf: [{ required: ["path"] }, { required: ["offset"] }],
					},
				},
			],
			"automation",
		);
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: {
					properties?: Record<string, unknown>;
					oneOf?: Array<{ required?: string[]; anyOf?: Array<{ required?: string[] }> }>;
				};
			}
		).jsonSchema;
		expect(schema?.properties).toHaveProperty("target_file");
		expect(schema?.oneOf).toEqual([
			{ required: [], anyOf: [{ required: ["path"] }, { required: ["target_file"] }] },
			{ required: ["offset"] },
		]);
	});

	test("Write contents alias clones canonical property constraints", () => {
		const tools = toProductField2Tools(
			[
				{
					name: "write",
					description: "write file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							content: { type: "string", enum: ["a", "b"], minLength: 1 },
						},
						required: ["path", "content"],
					},
				},
			],
			"automation",
		);
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: { properties?: Record<string, Record<string, unknown>> };
			}
		).jsonSchema;
		const contents = schema?.properties?.contents;
		expect(contents?.enum).toEqual(["a", "b"]);
		expect(contents?.minLength).toBe(1);
		expect(contents?.type).toBe("string");
		expect(String(contents?.description ?? "")).toContain("alias of content");
	});

	test("Read alias preserves preexisting anyOf required groups via allOf", () => {
		const tools = toProductField2Tools(
			[
				{
					name: "read",
					description: "read file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							offset: { type: "number" },
							start_line: { type: "number" },
						},
						required: ["path"],
						anyOf: [{ required: ["offset"] }, { required: ["start_line"] }],
					},
				},
			],
			"automation",
		);
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: {
					properties?: Record<string, unknown>;
					required?: string[];
					anyOf?: unknown;
					allOf?: Array<{ anyOf?: Array<{ required?: string[] }> }>;
				};
			}
		).jsonSchema;
		expect(schema?.properties).toHaveProperty("target_file");
		expect(schema?.required ?? []).not.toContain("path");
		expect(schema?.anyOf).toBeUndefined();
		expect(schema?.allOf).toEqual([
			{ anyOf: [{ required: ["offset"] }, { required: ["start_line"] }] },
			{ anyOf: [{ required: ["path"] }, { required: ["target_file"] }] },
		]);
	});

	test("Read alias retains preexisting allOf when combining with anyOf", () => {
		const tools = toProductField2Tools(
			[
				{
					name: "read",
					description: "read file",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							offset: { type: "number" },
							start_line: { type: "number" },
						},
						required: ["path"],
						anyOf: [{ required: ["offset"] }, { required: ["start_line"] }],
						allOf: [{ not: { required: ["forbidden"] } }],
					},
				},
			],
			"automation",
		);
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: {
					anyOf?: unknown;
					allOf?: unknown[];
				};
			}
		).jsonSchema;
		expect(schema?.anyOf).toBeUndefined();
		expect(schema?.allOf).toEqual([
			{ not: { required: ["forbidden"] } },
			{ anyOf: [{ required: ["offset"] }, { required: ["start_line"] }] },
			{ anyOf: [{ required: ["path"] }, { required: ["target_file"] }] },
		]);
	});

	test("parent profile injects SendToUser", () => {
		const tools = toProductField2Tools([], "parent-chat");
		expect(tools[0]?.name).toBe("SendToUser");
		const schema = (
			tools[0]?.parameters as {
				jsonSchema?: {
					properties?: Record<string, { type?: string; enum?: string[] }>;
					required?: string[];
				};
			}
		).jsonSchema;
		expect(schema?.properties).toHaveProperty("type");
		expect(schema?.properties).toHaveProperty("content");
		expect(schema?.properties?.type?.enum).toEqual(["text"]);
		expect(schema?.properties?.content?.type).toBe("string");
		expect(schema?.required).toEqual(["type", "content"]);
	});

	test("parent profile still injects SendToUser when an extension only aliases away from it", () => {
		// Internal name SendToUser + customWireName Other occupies Other, not the
		// synthetic SendToUser wire slot — parent-chat must still inject the helper.
		const product = toProductField2Tools(
			[
				{
					name: "SendToUser",
					description: "extension other",
					parameters: { type: "object", properties: {} },
					customWireName: "Other",
				},
			] as never,
			"parent-chat",
		);
		expect(product.map(t => t.name)).toEqual(["SendToUser", "Other"]);
	});

	test("prefers write over edit for the shared Write wire slot", () => {
		const editSchema = {
			type: "object",
			properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
			required: ["path", "old", "new"],
		};
		const writeSchema = {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		};
		const tools = [
			{ name: "edit", description: "patch file", parameters: editSchema },
			{ name: "write", description: "write file", parameters: writeSchema },
		];
		const product = toProductField2Tools(tools, "automation");
		const writes = product.filter(t => t.name === "Write");
		expect(writes).toHaveLength(1);
		expect(writes[0]?.description).toBe("write file");
		const schema = (writes[0]?.parameters as { jsonSchema?: { properties?: Record<string, unknown> } }).jsonSchema;
		expect(schema?.properties).toHaveProperty("content");
		expect(schema?.properties).toHaveProperty("contents");
		// Original tool schema must stay unmutated for later native-wire reuse.
		expect(writeSchema.properties).not.toHaveProperty("contents");

		const index = new Map<
			string,
			{ name: string; customWireName?: string; productWireName?: string; isGrammar: boolean }
		>([
			["edit", { name: "edit", isGrammar: false }],
			["write", { name: "write", isGrammar: false }],
		]);
		augmentToolIndexForProductWire(index, tools);
		expect(index.get("Write")?.name).toBe("write");
		expect(index.get("Write")?.productWireName).toBe("Write");
		expect(index.get("Write")?.customWireName).toBeUndefined();
		expect(index.get("write")?.customWireName).toBeUndefined();
		expect(toOmpToolName("Write")).toBe("write");
	});

	test("keeps product aliases off customWireName for ordinary JSON tools", () => {
		const tools = [
			{ name: "bash", description: "shell", parameters: { type: "object", properties: {} } },
			{ name: "read", description: "read", parameters: { type: "object", properties: {} } },
		];
		const index = new Map<
			string,
			{ name: string; customWireName?: string; productWireName?: string; isGrammar: boolean }
		>([
			["bash", { name: "bash", isGrammar: false }],
			["read", { name: "read", isGrammar: false }],
		]);
		augmentToolIndexForProductWire(index, tools);
		expect(index.get("Shell")).toEqual({ name: "bash", productWireName: "Shell", isGrammar: false });
		expect(index.get("Read")).toEqual({ name: "read", productWireName: "Read", isGrammar: false });
		expect(index.get("bash")?.customWireName).toBeUndefined();
		expect(index.get("read")?.customWireName).toBeUndefined();
	});

	test("prefers built-in omp owner when customWireName collides with product alias", () => {
		const tools = [
			{
				name: "extension_shell",
				description: "ext",
				parameters: { type: "object", properties: {} },
				customWireName: "Shell",
			},
			{ name: "bash", description: "bash", parameters: { type: "object", properties: {} } },
		];
		const product = toProductField2Tools(tools as never, "automation");
		const shells = product.filter(tool => tool.name === "Shell");
		expect(shells).toHaveLength(1);
		expect(shells[0]?.description).toBe("bash");

		const index = new Map<
			string,
			{ name: string; customWireName?: string; productWireName?: string; isGrammar: boolean }
		>([
			["extension_shell", { name: "extension_shell", isGrammar: false }],
			["bash", { name: "bash", isGrammar: false }],
		]);
		augmentToolIndexForProductWire(index, tools as never);
		expect(index.get("Shell")).toEqual({ name: "bash", productWireName: "Shell", isGrammar: false });
	});

	test("keeps the same first owner for generic customWireName collisions", () => {
		// foo advertised first; bar aliases as foo — advertise and decode must both
		// keep foo, or a call against foo's schema is dispatched as bar.
		const tools = [
			{ name: "foo", description: "first", parameters: { type: "object", properties: { a: { type: "string" } } } },
			{
				name: "bar",
				description: "second",
				parameters: { type: "object", properties: { b: { type: "number" } } },
				customWireName: "foo",
			},
		];
		const product = toProductField2Tools(tools as never, "automation");
		const foos = product.filter(tool => tool.name === "foo");
		expect(foos).toHaveLength(1);
		expect(foos[0]?.description).toBe("first");

		const index = new Map<
			string,
			{ name: string; customWireName?: string; productWireName?: string; isGrammar: boolean }
		>([
			["foo", { name: "foo", isGrammar: false }],
			["bar", { name: "bar", customWireName: "foo", isGrammar: false }],
		]);
		// Simulate buildGrammarToolIndex first-wins on the shared wire name.
		index.set("foo", { name: "foo", isGrammar: false });
		augmentToolIndexForProductWire(index, tools as never);
		expect(index.get("foo")?.name).toBe("foo");

		const reversed = [
			{
				name: "bar",
				description: "second",
				parameters: { type: "object", properties: { b: { type: "number" } } },
				customWireName: "foo",
			},
			{ name: "foo", description: "first", parameters: { type: "object", properties: { a: { type: "string" } } } },
		];
		const productReversed = toProductField2Tools(reversed as never, "automation");
		expect(productReversed.filter(tool => tool.name === "foo")).toEqual([
			expect.objectContaining({ name: "foo", description: "second" }),
		]);
		const indexReversed = new Map<
			string,
			{ name: string; customWireName?: string; productWireName?: string; isGrammar: boolean }
		>([
			["bar", { name: "bar", customWireName: "foo", isGrammar: false }],
			["foo", { name: "bar", customWireName: "foo", isGrammar: false }],
		]);
		augmentToolIndexForProductWire(indexReversed, reversed as never);
		expect(indexReversed.get("foo")?.name).toBe("bar");
	});

	test("maps edit to Write when write is absent", () => {
		const product = toProductField2Tools(
			[{ name: "edit", description: "patch only", parameters: { type: "object", properties: {} } }],
			"automation",
		);
		expect(product).toEqual([
			{
				name: "Write",
				description: "patch only",
				parameters: wrapToolParameters({ type: "object", properties: {} }),
			},
		]);
	});

	test("parseSendToUserContent extracts text content", () => {
		expect(parseSendToUserContent('{"type":"text","content":"hello-capture-42"}')).toBe("hello-capture-42");
	});

	test("rewrites replayed omp tool names to product field-2 aliases", () => {
		const rewritten = rewriteInferenceMessagesForProductWire([
			{
				role: 2,
				toolCalls: [
					{ toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
					{ toolCallId: "c2", toolName: "read", args: { path: "a.ts" } },
					{ toolCallId: "c3", toolName: "write", args: { path: "b.ts", content: "x" } },
					{ toolCallId: "c4", toolName: "edit", args: { path: "c.ts" } },
				],
			},
			{
				role: 3,
				toolContent: {
					parts: [
						{ toolCallId: "c1", toolName: "bash", result: "ok" },
						{ toolCallId: "c2", toolName: "read", result: "src" },
					],
				},
			},
		]);
		expect(rewritten[0]).toEqual({
			role: 2,
			toolCalls: [
				{ toolCallId: "c1", toolName: "Shell", args: { command: "ls" } },
				{ toolCallId: "c2", toolName: "Read", args: { path: "a.ts" } },
				{ toolCallId: "c3", toolName: "Write", args: { path: "b.ts", content: "x" } },
				{ toolCallId: "c4", toolName: "Write", args: { path: "c.ts" } },
			],
		});
		expect(rewritten[1]).toEqual({
			role: 3,
			toolContent: {
				parts: [
					{ toolCallId: "c1", toolName: "Shell", result: "ok" },
					{ toolCallId: "c2", toolName: "Read", result: "src" },
				],
			},
		});
	});

	test("keeps historical edit when write owns the Write sand slot", () => {
		const tools = [
			{ name: "edit", description: "patch", parameters: { type: "object", properties: {} } },
			{ name: "write", description: "create", parameters: { type: "object", properties: {} } },
		];
		const rewritten = rewriteInferenceMessagesForProductWire(
			[
				{
					role: 2,
					toolCalls: [
						{ toolCallId: "c1", toolName: "edit", args: { path: "c.ts" } },
						{ toolCallId: "c2", toolName: "write", args: { path: "b.ts", content: "x" } },
					],
				},
				{
					role: 3,
					toolContent: {
						parts: [
							{ toolCallId: "c1", toolName: "edit", result: "patched" },
							{ toolCallId: "c2", toolName: "write", result: "wrote" },
						],
					},
				},
			],
			tools as never,
		);
		expect(rewritten[0]).toEqual({
			role: 2,
			toolCalls: [
				{ toolCallId: "c1", toolName: "edit", args: { path: "c.ts" } },
				{ toolCallId: "c2", toolName: "Write", args: { path: "b.ts", content: "x" } },
			],
		});
		expect(rewritten[1]).toEqual({
			role: 3,
			toolContent: {
				parts: [
					{ toolCallId: "c1", toolName: "edit", result: "patched" },
					{ toolCallId: "c2", toolName: "Write", result: "wrote" },
				],
			},
		});
	});
});

describe("grokbot proto harness fields", () => {
	test("round-trips field 3 providerDefinedTools", () => {
		const encoded = encodeInferenceStreamRequest({
			messages: [{ role: 1, text: "ping" }],
			requestedModel: { modelId: "claude-opus-5" },
			tools: [],
			providerDefinedTools: [
				{
					name: "Computer",
					id: "anthropic.computer_20250124",
					type: "anthropic.computer_20250124",
					options: { displayWidthPx: 1920, displayHeightPx: 1080, displayNumber: 1 },
				},
			],
			subagentType: "computerUse",
		});
		const decoded = decodeInferenceStreamRequest(encoded) as {
			providerDefinedTools?: Array<{ name: string; id: string; type: string; options?: Record<string, unknown> }>;
			subagentType?: string;
		};
		expect(decoded.providerDefinedTools).toEqual([
			{
				name: "Computer",
				id: "anthropic.computer_20250124",
				type: "anthropic.computer_20250124",
				options: { displayWidthPx: 1920, displayHeightPx: 1080, displayNumber: 1 },
			},
		]);
		expect(decoded.subagentType).toBe("computerUse");
		expect(fieldNumbers(encoded).sort((a, b) => a - b)).toEqual([1, 3, 7, 16]);
	});

	test("round-trips field 9 tool names, field 10 automationId, and field 16 subagentType", () => {
		const encoded = encodeInferenceStreamRequest({
			messages: [{ role: 1, text: "ping" }],
			requestedModel: { modelId: "sand-automation" },
			acceptedUnadvertisedToolNames: ["read", "Shell"],
			automationId: "auto-uuid-123",
			subagentType: "generalPurpose",
		});
		const decoded = decodeInferenceStreamRequest(encoded) as {
			acceptedUnadvertisedToolNames?: string[];
			automationId?: string;
			subagentType?: string;
		};
		expect(decoded.acceptedUnadvertisedToolNames).toEqual(["read", "Shell"]);
		expect(decoded.automationId).toBe("auto-uuid-123");
		expect(decoded.subagentType).toBe("generalPurpose");
		expect(fieldNumbers(encoded).sort((a, b) => a - b)).toEqual([1, 7, 9, 9, 10, 16]);
	});
});
