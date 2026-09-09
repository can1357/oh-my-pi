import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { applyAnthropicSandToolWire } from "../../src/providers/grokbot/anthropic-sand-wire";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import {
	advertisedSandToolNames,
	applyGrokbotSandToolPolicy,
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
		sandWireModelId?: string;
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
			sandWireModelId: opts.sandWireModelId,
		},
		policy,
	);
	return { policy, applied, names: (applied.tools as Array<{ name: string }>).map(t => t.name) };
}

describe("grokbot family tool mapping", () => {
	test("Anthropic class + auto advertises product Shell/Read/Write on the original requestedModel", () => {
		for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5"]) {
			expect(classifyModel("grokbot", id, { lenient: true }).class).toBe("anthropic");
			const built = buildModel({
				id,
				name: id,
				api: "grokbot-sand",
				provider: "grokbot",
				baseUrl: "https://api2.cursor.sh",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 8_000,
			});
			expect(built.sandToolsWire).toBe("keep-model");
			const { policy, applied, names } = wireFor(id, { sandToolsWire: "keep-model" });
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
			const { policy, applied, names } = wireFor(id, {
				sandToolsWire: "parent-chat",
				sandWireModelId: "sand-default",
			});
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

	test("gemini-3-flash catalog ids stay listed but rewrite requestedModel to bare gemini-3.8-flash", () => {
		for (const id of ["gemini-3-flash", "gemini-3-flash[]"]) {
			const { policy, names } = wireFor(id);
			expect(policy.kind).toBe("native");
			expect(policy.wire).toBe("native");
			expect(names).toEqual(["bash", "read", "write", "edit"]);
			const parameterized = resolveGrokbotRequestedModel(id, {
				effort: "low",
				sandParameterIds: ["effort", "fast"],
				sandVariantStringRepresentation: id.endsWith("[]"),
				sandWireModelId: "gemini-3.8-flash",
				sandWireModelIdWhen: "tools",
				toolCount: 1,
			});
			expect(parameterized).toEqual({ modelId: "gemini-3.8-flash" });
		}
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
		// Explicit values required — discovery without defaults no longer invents
		// thinking/effort/fast/context, so a bare allowlist alone yields no parameters.
		const parameterized = resolveGrokbotRequestedModel("default", {
			sandParameterIds: ["thinking", "context", "effort", "fast"],
			thinking: true,
			context: "300k",
			effort: "high",
			fast: false,
			sandMaxMode: false,
		});
		expect(parameterized.parameters?.length).toBeGreaterThan(0);
		const wired = applyAnthropicSandToolWire(
			{
				requestedModel: parameterized,
				tools: OMP_CORE,
				modelId: "default",
				ompTools: OMP_CORE,
				sandToolsWire: "parent-chat",
				sandWireModelId: "sand-default",
			},
			"parent-chat",
		);
		expect(wired.requestedModel).toEqual({ modelId: "sand-default" });
		const sand = applyAnthropicSandToolWire(
			{
				requestedModel: resolveGrokbotRequestedModel("sand-default", {
					sandParameterIds: ["thinking", "effort"],
					thinking: true,
					effort: "high",
					sandMaxMode: false,
				}),
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
		const requestedModel = resolveGrokbotRequestedModel("sand-automation", {
			sandParameterIds: ["thinking", "context", "effort", "fast"],
			thinking: true,
			context: "300k",
			effort: "high",
			fast: false,
			sandMaxMode: false,
		});
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

	test("classifies opaque variant selectors via requestModelId for tool wire", () => {
		// Opaque legacy/variant ids alone look unknown; the canonical name owns family wire.
		const opaque = resolveGrokbotSandToolPolicy({
			modelId: "opaque-legacy-slug",
			toolCount: OMP_CORE.length,
		});
		expect(opaque.kind).toBe("native");
		expect(opaque.identity.class).not.toBe("anthropic");

		const viaCanonical = resolveGrokbotSandToolPolicy({
			modelId: "opaque-legacy-slug",
			requestModelId: "claude-opus-5",
			toolCount: OMP_CORE.length,
			sandToolsWire: "keep-model",
		});
		expect(viaCanonical.kind).toBe("product");
		expect(viaCanonical.wire).toBe("keep-model");
		expect(viaCanonical.identity.class).toBe("anthropic");
	});

	test("representative slice picks live ids by classifyModel identity buckets plus routers", () => {
		const live = [
			{ id: "claude-opus-5" },
			{ id: "grok-4.6" },
			{ id: "gpt-5.6-sol" },
			{ id: "gpt-5.4-luna" },
			{ id: "gpt-5.3-terra" },
			{ id: "composer-2.5" },
			{ id: "sand-default", sandToolsWire: "parent-chat" },
			{ id: "sand-cua", sandToolsWire: "parent-chat" },
			{ id: "default", sandToolsWire: "parent-chat" },
			{ id: "gemini-3-flash" },
			{ id: "gpt-5-mini" },
			{ id: "unrelated-other" },
			// Non-router sand-* id must not be treated as a router without catalog wire.
			{ id: "sand-not-a-router" },
		];
		const picked = selectGrokbotMatrixIds(live, "representative");
		expect(picked).toContain("sand-default");
		expect(picked).toContain("sand-cua");
		expect(picked).toContain("default");
		expect(picked).toContain("claude-opus-5");
		expect(picked).toContain("grok-4.6");
		expect(picked).toContain("gemini-3-flash");
		// Distinct openai revisions each keep a sample (taxonomy revision, not id tokens).
		expect(picked).toContain("gpt-5.6-sol");
		expect(picked).toContain("gpt-5.4-luna");
		expect(picked).toContain("gpt-5.3-terra");
		expect(picked).toContain("gpt-5-mini");
		expect(picked).toContain("composer-2.5");
		expect(picked).not.toContain("unrelated-other");
		expect(picked).not.toContain("sand-not-a-router");
		expect(selectGrokbotMatrixIds(live, "all")).toEqual(live.map(m => m.id));

		// Without catalog sand-tools-wire, sand-automation is not a router and can
		// be dropped from the unknown bucket — callers must buildModel() first.
		expect(
			selectGrokbotMatrixIds(
				[{ id: "sand-automation" }, { id: "sand-default", sandToolsWire: "parent-chat" }, { id: "noise-aaa" }],
				"representative",
			),
		).not.toContain("sand-automation");
		expect(
			selectGrokbotMatrixIds(
				[
					{ id: "sand-automation", sandToolsWire: "automation" },
					{ id: "sand-default", sandToolsWire: "parent-chat" },
				],
				"representative",
			),
		).toEqual(expect.arrayContaining(["sand-automation", "sand-default"]));

		// Same-revision openai peers collapse to one sample via preferMatrixId.
		const sameRev = selectGrokbotMatrixIds(
			[
				{ id: "gpt-5.6-luna" },
				{ id: "gpt-5.6-sol" },
				{ id: "gpt-5.6-terra" },
				{ id: "sand-default", sandToolsWire: "parent-chat" },
			],
			"representative",
		);
		expect(sameRev.filter(id => id.startsWith("gpt-5.6-"))).toHaveLength(1);

		// Renamed anthropic catalog ids still gate via classifyModel class, not a TypeScript id table.
		// At most one unclassified non-router is kept (composer-like unknowns); extra noise is dropped.
		const renamed = selectGrokbotMatrixIds(
			[
				{ id: "claude-brand-new-9" },
				{ id: "sand-default", sandToolsWire: "parent-chat" },
				{ id: "noise-aaa" },
				{ id: "noise-bbbb" },
			],
			"representative",
		);
		expect(renamed).toEqual(expect.arrayContaining(["claude-brand-new-9", "sand-default"]));
		expect(renamed.filter(id => id.startsWith("noise-"))).toHaveLength(1);
		expect(renamed).toContain("noise-aaa"); // shortest unclassified wins
		expect(renamed).not.toContain("noise-bbbb");
		expect(classifyModel("grokbot", "claude-brand-new-9", { lenient: true }).class).toBe("anthropic");
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
