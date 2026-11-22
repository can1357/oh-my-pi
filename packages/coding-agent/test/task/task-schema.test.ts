import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskPerCallModel, cfgTaskPerCallModelAllow } from "@oh-my-pi/pi-coding-agent/task/settings";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

let taskSchemaSessionIndex = 0;

function createSession(
	options: {
		settings?: Record<string, unknown>;
	} = {},
): ToolSession {
	return {
		cwd: `/tmp/task-schema-${taskSchemaSessionIndex++}`,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.enabled": false,
			"task.batch": false,
			...options.settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `outputSchema` and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it.each([false, true])("advertises only the source task.steps selects (batch=%s)", batchEnabled => {
		// Enabled first: the disabled schema must not reuse the enabled one from the cache.
		for (const steps of [true, false]) {
			const schema = getTaskSchema({ batchEnabled, isolationEnabled: false, structured: false, steps });
			const item = steps
				? { steps: ["Add the parser.", "Wire it in."], solutionSpace: "one defined change" }
				: { task: "Add the parser.", solutionSpace: "one defined change" };
			const parsed = schema(batchEnabled ? { context: "shared context", tasks: [item] } : item);
			if (parsed instanceof type.errors) throw new Error(parsed.summary);
			expect(parsed).toMatchObject(batchEnabled ? { tasks: [item] } : item);
			const wire = schema.toJsonSchema();
			const tasks = isRecord(wire.properties) ? wire.properties.tasks : undefined;
			const itemWire = batchEnabled && isRecord(tasks) ? tasks.items : wire;
			if (!isRecord(itemWire)) throw new Error("Expected an object schema for task input");
			expect(itemWire.required).toContain(steps ? "steps" : "task");
			expect(itemWire.properties).not.toHaveProperty(steps ? "task" : "steps");
		}
	});

	it("removes eval tool names from the wire shape when eval.tools.enabled is off", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			evalToolsEnabled: false,
		});
		const parsed = schema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			tools: ["word_count"],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			expect("tools" in parsed).toBe(false);
		}
	});

	it("retains caller outputSchema, schemaMode, and eval tool names while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			outputSchema,
			schemaMode: "strict",
			tools: ["word_count"],
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect(parsed.tools).toEqual(["word_count"]);
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task schema per-call model field", () => {
	it("advertises model only as one string when per-call model is enabled", () => {
		for (const batchEnabled of [false, true]) {
			for (const isolationEnabled of [false, true]) {
				const schema = getTaskSchema({ batchEnabled, isolationEnabled });
				const wireSchema = JSON.stringify(schema.toJsonSchema());
				expect(wireSchema).not.toContain('"model"');
				const perCall = JSON.stringify(
					getTaskSchema({ batchEnabled, isolationEnabled, perCallModel: true }).toJsonSchema(),
				);
				expect(perCall).toContain('"model":{"type":"string"}');
			}
		}
	});

	it.each([
		["off", false],
		["eval", false],
		["on", true],
	] as const)("advertises model only when task.perCallModel allows task calls (%s)", async (mode, advertised) => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession({ settings: { "task.perCallModel": mode } }));
		expect(JSON.stringify(tool.parameters.toJsonSchema()).includes('"model"')).toBe(advertised);
	});

	afterEach(() => vi.restoreAllMocks());
});

describe("task schema workload model role", () => {
	afterEach(() => vi.restoreAllMocks());

	it("declares modelRole as one string on every shape, whatever task.perCallModel says", async () => {
		const shapes = [
			taskSchema,
			...[false, true].flatMap(batchEnabled =>
				[false, true].flatMap(isolationEnabled => [
					getTaskSchema({ batchEnabled, isolationEnabled }),
					getTaskSchema({ batchEnabled, isolationEnabled, perCallModel: true, effortEnabled: true }),
				]),
			),
		];
		for (const schema of shapes) {
			expect(JSON.stringify(schema.toJsonSchema())).toContain('"modelRole":{"type":"string"}');
		}
		for (const mode of ["off", "eval", "on"]) {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
			const tool = await TaskTool.create(createSession({ settings: { "task.perCallModel": mode } }));
			expect(JSON.stringify(tool.parameters.toJsonSchema())).toContain('"modelRole":{"type":"string"}');
			vi.restoreAllMocks();
		}
	});

	it("keeps a flat call's modelRole through wire validation", () => {
		const parsed = taskSchema({ agent: "scout", task: "Map auth.", solutionSpace: "c", modelRole: "smol" });
		if (parsed instanceof type.errors) throw new Error(parsed.summary);
		expect(parsed.modelRole).toBe("smol");
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, agents: AgentDefinition[] = []): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});

	it.each([
		{
			label: "both task and steps",
			params: { agent: "scout", task: "Map auth.", steps: ["Map auth."] },
			refusal: "takes `task` or `steps`, not both",
		},
		{ label: "empty steps", params: { agent: "scout", steps: [] }, refusal: "invalid `steps`" },
		{ label: "a blank step", params: { agent: "scout", steps: ["Map auth.", "  "] }, refusal: "invalid `steps`" },
	])("refuses $label", async ({ params, refusal }) => {
		expect(await executeText({ ...params, solutionSpace: "c" })).toContain(refusal);
	});
	it("rejects a model override for an ordinary task while task.perCallModel is off", async () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
		});
		const params = {
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "focused inspection",
			model: "anthropic/claude-sonnet-4-5",
		};
		expect(schema(params) instanceof type.errors).toBe(false);
		const scout = loadBundledAgents().find(agent => agent.name === "scout");
		if (!scout) throw new Error("Expected the bundled scout agent");
		expect(await executeText(params, [scout])).toContain("task.perCallModel: off");
	});

	it("advertises approved selectors only while task.perCallModel is on", async () => {
		const description = async (mode: string) => {
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
			return (
				await TaskTool.create(
					createSession({
						settings: {
							"task.perCallModel": mode,
							modelRoles: { smol: "anthropic/claude-haiku-4-5", slow: "openai/gpt-5.5" },
							"task.perCallModelAllow": ["openai/gpt-5.5"],
						},
					}),
				)
			).description;
		};
		for (const mode of ["off", "eval"]) {
			const text = await description(mode);
			for (const guidance of ["`model`: one exact", "anthropic/claude-haiku-4-5", "openai/gpt-5.5"]) {
				expect(text).not.toContain(guidance);
			}
		}
		const text = await description("on");
		expect(text).toContain("`model`: one exact");
		// The allowlist admits only slow's model; smol's would be refused at dispatch.
		expect(text).toContain("`openai/gpt-5.5` (slow)");
		expect(text).not.toContain("anthropic/claude-haiku-4-5");
	});

	it("omits kind roles, role aliases, and default/inherit selectors from approved models", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(
			createSession({
				settings: {
					"task.perCallModel": "on",
					modelRoles: {
						smol: "anthropic/claude-haiku-4-5",
						image: "hidden/image",
						judge: "hidden/judge",
						alias: "@smol",
						legacyAlias: "pi/slow",
						wildcardAlias: "*",
						useDefault: "default",
						inherited: "inherit",
						slow: "openai/gpt-5.5",
					},
				},
			}),
		);
		const text = tool.description;
		for (const advertised of ["anthropic/claude-haiku-4-5", "openai/gpt-5.5"]) expect(text).toContain(advertised);
		for (const omitted of ["hidden/image", "hidden/judge", "`@smol`", "`pi/slow`", "`*`", "`default`", "`inherit`"]) {
			expect(text).not.toContain(omitted);
		}
	});

	it("advertises provider-qualified role values as written and omits globs, without consulting the model registry", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const session = createSession({
			settings: {
				"task.perCallModel": "on",
				modelRoles: { review: " mock/second:high, mock/*, mock/first, mock/* " },
			},
		});
		const catalogLookup = vi.fn(() => [{ provider: "mock", id: "registry-expanded" }]);
		Object.assign(session, { modelRegistry: { getAll: catalogLookup, getAvailable: catalogLookup } });
		const text = (await TaskTool.create(session)).description;
		expect(text).toContain("`mock/second:high`, `mock/first` (review)");
		expect(text).not.toContain("mock/*");
		expect(catalogLookup).not.toHaveBeenCalled();
	});

	it("advertises a bare role's resolved exact model selector", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const model = createMockModel({ id: "target" });
		const session = createSession({
			settings: { "task.perCallModel": "on", modelRoles: { review: "target" } },
		});
		Object.assign(session, { modelRegistry: { getAll: () => [model], getAvailable: () => [model] } });
		const text = (await TaskTool.create(session)).description;
		expect(text).toContain("`mock/target` (review)");
		expect(text).not.toContain("`target` (review)");
	});

	it("offers the caller's own model only when one selector can name it", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const ownModel = createMockModel({ id: "own" });
		// Several `only` upstreams: no single selector names this route.
		const multiRouteModel = {
			...ownModel,
			compat: { openRouterRouting: { only: ["anthropic", "google-vertex"] } },
		} as unknown as Model;
		const description = async (activeModel: Model) => {
			// No roles grant a model; the allowlist entry shows the advertisement still renders when the clause is withheld.
			const session = createSession({
				settings: { "task.perCallModel": "on", modelRoles: {}, "task.perCallModelAllow": ["mock/own"] },
			});
			Object.assign(session, { getActiveModel: () => activeModel });
			return (await TaskTool.create(session)).description;
		};
		const offered = await description(ownModel);
		expect(offered).toContain("your own current model");
		expect(offered).toContain("mock/own");
		const withheld = await description(multiRouteModel);
		expect(withheld).not.toContain("your own current model");
		expect(withheld).toContain("mock/own");
	});

	it("refreshes approved selectors and their allowlist from current settings", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		// Distinct role and allowlist text, so each check proves its own refresh.
		const session = createSession({
			settings: {
				"task.perCallModel": "on",
				modelRoles: { smol: "mock/original-role" },
				"task.perCallModelAllow": ["mock/original-role", "mock/original-allowed"],
			},
		});
		const tool = await TaskTool.create(session);
		expect(tool.description).toContain("`mock/original-role` (smol)");
		expect(tool.description).toContain("mock/original-allowed");

		session.settings.overrideModelRoles({ smol: "mock/replacement-role" });
		cfgTaskPerCallModelAllow.override(session.settings, ["mock/replacement-role", "mock/replacement-allowed"]);
		const refreshed = tool.description;
		expect(refreshed).toContain("`mock/replacement-role` (smol)");
		expect(refreshed).toContain("mock/replacement-allowed");
		expect(refreshed).not.toContain("mock/original");

		cfgTaskPerCallModel.override(session.settings, "off");
		expect(tool.description).not.toContain("mock/replacement");
	});
});
