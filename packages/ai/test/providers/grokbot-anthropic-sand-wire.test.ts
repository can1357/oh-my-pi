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
	toOmpToolName,
	toProductField2Tools,
	wrapToolParameters,
} from "../../src/providers/grokbot/product-wire";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import { decodeInferenceStreamRequest, encodeInferenceStreamRequest, fieldNumbers } from "../../src/providers/grokbot/proto";

describe("anthropic sand tool wire", () => {
	test("detects anthropic sand model ids", () => {
		expect(isAnthropicSandModelId("claude-opus-5")).toBe(true);
		expect(isAnthropicSandModelId("grok-4.6")).toBe(false);
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
	});

	test("throws on explicit anthropic id with field-2 tools when wire is error", () => {
		const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
			sandParameterIds: ["thinking", "context", "effort", "fast"],
		});
		expect(() =>
			applyAnthropicSandToolWire(
				{ requestedModel, tools: [{ name: "read" }], modelId: "claude-opus-5" },
				"error",
			),
		).toThrow(/HTTP 400/);
	});

	test("automation wire rewrites anthropic model to sand-automation with product tools", () => {
		const requestedModel = resolveGrokbotRequestedModel("claude-opus-5", {
			effort: "low",
			sandParameterIds: ["thinking", "context", "effort", "fast"],
		});
		const tools = [
			{ name: "bash", description: "run shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
			{ name: "read", description: "read file", parameters: { type: "object", properties: { path: { type: "string" } } } },
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
		const shell = (wired.tools as Array<{ parameters: Record<string, unknown> }>).find(
			t => (t as { name: string }).name === "Shell",
		);
		expect(shell?.parameters).toHaveProperty("jsonSchema");
	});

	test("auto resolves anthropic + tools to automation", () => {
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "claude-opus-5",
				toolCount: 2,
			}),
		).toBe("automation");
		expect(
			resolveAnthropicSandToolsWire(undefined, undefined, {
				modelId: "grok-4.6",
				toolCount: 2,
			}),
		).toBe("error");
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

	test("parent profile injects SendToUser", () => {
		const tools = toProductField2Tools([], "parent-chat");
		expect(tools[0]?.name).toBe("SendToUser");
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
		expect(writes[0]?.parameters).toEqual(wrapToolParameters(writeSchema));

		const index = new Map<string, { name: string; customWireName?: string; isGrammar: boolean }>([
			["edit", { name: "edit", isGrammar: false }],
			["write", { name: "write", isGrammar: false }],
		]);
		augmentToolIndexForProductWire(index, tools);
		expect(index.get("Write")?.name).toBe("write");
		expect(toOmpToolName("Write")).toBe("write");
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
