import { describe, expect, test } from "bun:test";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { applyAnthropicSandToolWire } from "../../src/providers/grokbot/anthropic-sand-wire";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import {
	advertisedSandToolNames,
	applyGrokbotSandToolPolicy,
	GROKBOT_MATRIX_REPRESENTATIVE_IDS,
	grokbotToolsSkipReason,
	nativeToolParametersForIdentity,
	resolveGrokbotSandToolPolicy,
	selectGrokbotMatrixIds,
} from "../../src/providers/grokbot/tool-policy";

const OMP_CORE = [
	{
		name: "bash",
		description: "run shell",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
	{
		name: "read",
		description: "read file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	{
		name: "write",
		description: "write file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
	{
		name: "edit",
		description: "patch file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

function requested(id: string, sandParameterIds: string[] = []) {
	return resolveGrokbotRequestedModel(id, { sandParameterIds, sandMaxMode: false });
}

function wireFor(
	id: string,
	opts: {
		sandToolsWire?: "parent-chat" | "automation" | "keep-model";
		supportsTools?: boolean;
		envWire?: string;
	} = {},
) {
	const policy = resolveGrokbotSandToolPolicy({
		modelId: id,
		toolCount: OMP_CORE.length,
		sandToolsWire: opts.sandToolsWire,
		supportsTools: opts.supportsTools,
		envWire: opts.envWire,
	});
	const applied = applyGrokbotSandToolPolicy(
		{
			requestedModel: requested(id),
			tools: OMP_CORE,
			modelId: id,
			ompTools: OMP_CORE,
			sandToolsWire: opts.sandToolsWire,
		},
		policy,
	);
	return { policy, applied, names: (applied.tools as Array<{ name: string }>).map(t => t.name) };
}

describe("grokbot family tool mapping", () => {
	test("Anthropic class + auto advertises product Shell/Read/Write on the original requestedModel", () => {
		for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"]) {
			expect(classifyModel("grokbot", id, { lenient: true }).class).toBe("anthropic");
			const { policy, applied, names } = wireFor(id);
			expect(policy.kind).toBe("product");
			expect(policy.wire).toBe("keep-model");
			expect(applied.requestedModel.modelId).toBe(id);
			expect(applied.wireMode).toBe("keep-model");
			expect(names).toEqual(["Shell", "Read", "Write"]);
			for (const tool of applied.tools as Array<{ parameters: Record<string, unknown> }>) {
				expect(tool.parameters).toHaveProperty("jsonSchema");
			}
			expect(advertisedSandToolNames(["bash", "read", "write", "edit"], policy)).toEqual(["Shell", "Read", "Write"]);
		}
	});

	test("non-Anthropic families keep native omp bash/read/write (sand accepts those names)", () => {
		const rows = [
			{ id: "grok-4.6", class: "xai" },
			{ id: "gpt-5.6-sol", class: "openai" },
			{ id: "gemini-3.7-flash", class: "gemini" },
			{ id: "kimi-k3", class: "kimi" },
			{ id: "glm-5.2", class: "glm" },
			{ id: "composer-2.5", class: "unknown" },
		];
		for (const row of rows) {
			expect(classifyModel("grokbot", row.id, { lenient: true }).class).toBe(row.class);
			const { policy, applied, names } = wireFor(row.id);
			expect(policy.kind).toBe("native");
			expect(policy.wire).toBe("native");
			expect(applied.requestedModel.modelId).toBe(row.id);
			expect(applied.wireMode).toBe("native");
			expect(names).toEqual(["bash", "read", "write", "edit"]);
			expect(advertisedSandToolNames(["bash", "read", "write"], policy)).toEqual(["bash", "read", "write"]);
		}
	});

	test("catalog parent-chat on Auto routers (default / default[] / auto) rewrites to bare sand-default", () => {
		for (const id of ["default", "default[]", "auto", "auto[]"]) {
			const { policy, applied, names } = wireFor(id, { sandToolsWire: "parent-chat" });
			expect(policy.kind).toBe("product");
			expect(policy.wire).toBe("parent-chat");
			expect(applied.requestedModel).toEqual({ modelId: "sand-default" });
			expect(names[0]).toBe("SendToUser");
			expect(names).toContain("Shell");
			expect(names).toContain("Read");
			expect(names).toContain("Write");
		}
	});

	test("catalog parent-chat on sand-default and sand-cua keeps the router id as a bare wire", () => {
		for (const id of ["sand-default", "sand-cua"]) {
			const { policy, applied, names } = wireFor(id, { sandToolsWire: "parent-chat" });
			expect(policy.kind).toBe("product");
			expect(policy.wire).toBe("parent-chat");
			expect(applied.requestedModel).toEqual({ modelId: id });
			expect(applied.subagentType).toBeUndefined();
			expect(names[0]).toBe("SendToUser");
			expect(names).toContain("Shell");
			expect(names).toContain("Read");
			expect(names).toContain("Write");
		}
	});

	test("catalog keep-model on gemini-3-flash advertises product tools on a bare requestedModel", () => {
		for (const id of ["gemini-3-flash", "gemini-3-flash[]"]) {
			const { policy, applied, names } = wireFor(id, { sandToolsWire: "keep-model" });
			expect(policy.kind).toBe("product");
			expect(policy.wire).toBe("keep-model");
			expect(applied.requestedModel).toEqual({ modelId: id });
			expect(applied.subagentType).toBeUndefined();
			expect(names).toEqual(["Shell", "Read", "Write"]);
			for (const tool of applied.tools as Array<{ parameters: Record<string, unknown> }>) {
				expect(tool.parameters).toHaveProperty("jsonSchema");
			}
		}
		const parameterized = requested("gemini-3-flash", ["effort", "fast"]);
		expect(parameterized.parameters?.length).toBeGreaterThan(0);
		const stripped = applyAnthropicSandToolWire(
			{
				requestedModel: parameterized,
				tools: OMP_CORE,
				modelId: "gemini-3-flash",
				ompTools: OMP_CORE,
				sandToolsWire: "keep-model",
			},
			"keep-model",
		);
		expect(stripped.requestedModel).toEqual({ modelId: "gemini-3-flash" });
		expect(stripped.wireMode).toBe("keep-model");
	});

	test("catalog automation on sand-automation advertises product tools and keeps the router id", () => {
		const { policy, applied, names } = wireFor("sand-automation", { sandToolsWire: "automation" });
		expect(policy.kind).toBe("product");
		expect(policy.wire).toBe("automation");
		expect(applied.requestedModel.modelId).toBe("sand-automation");
		expect(applied.requestedModel.parameters).toBeUndefined();
		expect(applied.subagentType).toBe("generalPurpose");
		expect(typeof applied.automationId).toBe("string");
		expect(names).toEqual(["Shell", "Read", "Write"]);
	});

	test("parent-chat strips thinking/effort/fast from parameterized default and sand-default", () => {
		const parameterized = requested("default", ["thinking", "context", "effort", "fast"]);
		expect(parameterized.parameters?.length).toBeGreaterThan(0);
		const wired = applyAnthropicSandToolWire(
			{
				requestedModel: parameterized,
				tools: OMP_CORE,
				modelId: "default",
				ompTools: OMP_CORE,
				sandToolsWire: "parent-chat",
			},
			"parent-chat",
		);
		expect(wired.requestedModel).toEqual({ modelId: "sand-default" });
		const sand = applyAnthropicSandToolWire(
			{
				requestedModel: requested("sand-default", ["thinking", "effort"]),
				tools: OMP_CORE,
				modelId: "sand-default",
				ompTools: OMP_CORE,
				sandToolsWire: "parent-chat",
			},
			"parent-chat",
		);
		expect(sand.requestedModel).toEqual({ modelId: "sand-default" });
	});

	test("automation wire strips thinking/effort/fast from a parameterized sand-automation request", () => {
		const requestedModel = requested("sand-automation", ["thinking", "context", "effort", "fast"]);
		expect(requestedModel.parameters?.length).toBeGreaterThan(0);
		const wired = applyAnthropicSandToolWire(
			{
				requestedModel,
				tools: OMP_CORE,
				modelId: "sand-automation",
				ompTools: OMP_CORE,
				sandToolsWire: "automation",
			},
			"automation",
		);
		expect(wired.requestedModel).toEqual({ modelId: "sand-automation" });
		expect(wired.subagentType).toBe("generalPurpose");
		expect((wired.tools as Array<{ name: string }>).map(t => t.name)).toEqual(["Shell", "Read", "Write"]);
	});

	test("supports-tools=false disables tools (grok-4.5 HTTP 422 ceiling)", () => {
		const skip = grokbotToolsSkipReason({ id: "grok-4.5", supportsTools: false });
		expect(skip).toMatch(/supports-tools=false/);
		const policy = resolveGrokbotSandToolPolicy({
			modelId: "grok-4.5",
			toolCount: 3,
			supportsTools: false,
		});
		expect(policy.kind).toBe("disabled");
		expect(policy.reason).toBe(skip);
	});

	test("explicit keep-model on a non-Anthropic id stays native (no product rewrite)", () => {
		const requestedModel = requested("grok-4.6", ["effort", "fast"]);
		const tools = [{ name: "bash" }, { name: "read" }];
		const wired = applyAnthropicSandToolWire({ requestedModel, tools, modelId: "grok-4.6" }, "keep-model");
		expect(wired.tools).toBe(tools);
		expect(wired.requestedModel).toBe(requestedModel);
		expect(wired.wireMode).toBeUndefined();
	});

	test("representative slice picks listed live ids plus one luna/terra openai row", () => {
		const live = [
			"claude-opus-5",
			"grok-4.6",
			"gpt-5.6-sol",
			"gpt-5.4-luna",
			"gpt-5.3-terra",
			"composer-2.5",
			"sand-default",
			"default",
			"gemini-3-flash",
			"gpt-5-mini",
			"unrelated-other",
		];
		const picked = selectGrokbotMatrixIds(live, "representative");
		expect(picked).toContain("claude-opus-5");
		expect(picked).toContain("grok-4.6");
		expect(picked).toContain("gpt-5.6-sol");
		expect(picked).toContain("composer-2.5");
		expect(picked).toContain("sand-default");
		expect(picked).toContain("default");
		expect(picked).toContain("gemini-3-flash");
		expect(picked).toContain("gpt-5-mini");
		expect(picked).toContain("gpt-5.4-luna");
		expect(picked).toContain("gpt-5.3-terra");
		expect(picked).not.toContain("unrelated-other");
		expect(selectGrokbotMatrixIds(live, "all")).toEqual(live);
		expect(GROKBOT_MATRIX_REPRESENTATIVE_IDS).toContain("sand-cua");
	});

	test("gemini native schema strips Google-unsupported keywords (empty-body regression)", () => {
		const raw = {
			type: "object",
			properties: { command: { type: "string", format: "uri" } },
			required: ["command"],
			additionalProperties: true,
		};
		const gemini = nativeToolParametersForIdentity(raw, { class: "gemini" });
		expect(gemini).not.toHaveProperty("additionalProperties");
		const command = gemini.properties as Record<string, Record<string, unknown>>;
		expect(command.command).not.toHaveProperty("format");
		expect(command.command?.type).toBe("string");
	});

	test("openai native schema enforces additionalProperties false (gpt-5-mini wire)", () => {
		const raw = {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		};
		const openai = nativeToolParametersForIdentity(raw, { class: "openai" });
		expect(openai.additionalProperties).toBe(false);
		expect(openai.required).toEqual(["command"]);
		const xai = nativeToolParametersForIdentity(raw, { class: "xai" });
		expect(xai).not.toHaveProperty("additionalProperties");
		expect(xai).toEqual(raw);
	});
});
