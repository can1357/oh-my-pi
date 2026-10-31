import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgTaskPerCallModel, cfgTaskPerCallModelAllow } from "@oh-my-pi/pi-coding-agent/task/settings";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { isBundledSeance, seanceTaskSchemaFields } from "@oh-my-pi/pi-coding-agent/task/seance";
import * as seanceModule from "@oh-my-pi/pi-coding-agent/task/seance";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

let taskSchemaSessionIndex = 0;

function createSession(
	options: {
		parentSpawns?: string;
		disabledAgents?: string[];
		planMode?: boolean;
		settings?: Record<string, unknown>;
	} = {},
): ToolSession {
	return {
		cwd: `/tmp/task-schema-${taskSchemaSessionIndex++}`,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.enabled": false,
			"task.batch": false,
			"task.disabledAgents": options.disabledAgents ?? [],
			...options.settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.parentSpawns ?? "*",
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

const bundledSeance = loadBundledAgents().find(agent => agent.name === "seance")!;
// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `model`, `outputSchema`, and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout", solutionSpace: "c" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it.each([false, true])("advertises taskFile only while task.file is on (batch=%s)", batchEnabled => {
		// Enabled first: the disabled schema must not reuse the enabled one from the cache.
		for (const file of [true, false]) {
			const schema = getTaskSchema({ batchEnabled, isolationEnabled: false, structured: false, file });
			const item = {
				taskFile: "local://assignment.md",
				model: "mock/file-worker",
				solutionSpace: "one defined change",
			};
			const parsed = schema(batchEnabled ? { context: "shared context", tasks: [item] } : item);
			const wire = schema.toJsonSchema();
			const tasks = isRecord(wire.properties) ? wire.properties.tasks : undefined;
			const itemWire = batchEnabled && isRecord(tasks) ? tasks.items : wire;
			if (!isRecord(itemWire)) throw new Error("Expected an object schema for task input");
			if (file) {
				if (parsed instanceof type.errors) throw new Error(parsed.summary);
				expect(parsed).toMatchObject(
					batchEnabled
						? { tasks: [{ taskFile: item.taskFile, model: item.model }] }
						: { taskFile: item.taskFile, model: item.model },
				);
				expect(itemWire.required).not.toContain("task");
				expect(itemWire.properties).toHaveProperty("model");
			} else {
				expect(parsed instanceof type.errors).toBe(true);
				expect(itemWire.properties).not.toHaveProperty("taskFile");
				expect(itemWire.required).toContain("task");
			}
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

describe("task schema seance fields", () => {
	it("accepts source and model selectors in every flat/batch isolation mode", () => {
		for (const batchEnabled of [false, true]) {
			for (const isolationEnabled of [false, true]) {
				const schema = getTaskSchema({
					batchEnabled,
					isolationEnabled,
					evalToolsEnabled: false,
					seanceFields: seanceTaskSchemaFields,
				});
				const modelSelector = batchEnabled
					? ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]
					: "anthropic/claude-sonnet-4-5";
				const item = {
					agent: "seance",
					task: "Read historical context.",
					solutionSpace: "focused read-only inspection",
					sourceSession: "/sessions/source.jsonl",
					model: modelSelector,
					...(isolationEnabled ? { isolated: false } : {}),
				};
				const parsed = schema(batchEnabled ? { context: "shared context", tasks: [item] } : { ...item });
				expect(parsed instanceof type.errors).toBe(false);
				if (parsed instanceof type.errors) continue;
				if (!parsed || typeof parsed !== "object") {
					expect(parsed).toBeTruthy();
					continue;
				}
				let parsedItem: unknown = parsed;
				if (batchEnabled) {
					if (!("tasks" in parsed) || !Array.isArray(parsed.tasks)) {
						expect(parsed).toHaveProperty("tasks");
						continue;
					}
					parsedItem = parsed.tasks[0];
				}
				expect(parsedItem).toMatchObject({
					sourceSession: "/sessions/source.jsonl",
					model: modelSelector,
				});
			}
		}
	});
	it("omits seance fields when they are not enabled", () => {
		for (const batchEnabled of [false, true]) {
			for (const isolationEnabled of [false, true]) {
				const schema = getTaskSchema({ batchEnabled, isolationEnabled });
				const wireSchema = JSON.stringify(schema.toJsonSchema());
				expect(wireSchema).not.toContain('"sourceSession"');
				// Only the per-call `model` remains: one string, never the seance selector list.
				expect(wireSchema).toContain('"model":{"type":"string"}');
			}
		}
	});

	it("advertises fields only when bundled seance is spawnable", async () => {
		const discovery = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [bundledSeance], projectAgentsDir: null });

		const allowed = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(allowed.parameters.toJsonSchema())).toContain('"sourceSession"');

		const policyDenied = await TaskTool.create(createSession({ parentSpawns: "task" }));
		expect(JSON.stringify(policyDenied.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		const agentDisabled = await TaskTool.create(
			createSession({ parentSpawns: "task,seance", disabledAgents: ["seance"] }),
		);
		expect(JSON.stringify(agentDisabled.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		discovery.mockResolvedValue({ agents: [], projectAgentsDir: null });
		const absentFromCatalogue = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(absentFromCatalogue.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		const customSeance = parseAgent(
			"project-seance.md",
			`---
name: seance
description: Custom historical agent.
---
Custom prompt.`,
			"project",
		);
		expect(isBundledSeance(customSeance)).toBe(false);
		discovery.mockResolvedValue({ agents: [customSeance], projectAgentsDir: null });
		const overridden = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(overridden.parameters.toJsonSchema())).not.toContain('"sourceSession"');
	});

	it("hides seance fields, listing, and guidance in plan mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [bundledSeance],
			projectAgentsDir: null,
		});
		const planMode = await TaskTool.create(createSession({ parentSpawns: "task,seance", planMode: true }));
		const planSchema = JSON.stringify(planMode.parameters.toJsonSchema());
		expect(planSchema).not.toContain('"sourceSession"');
		expect(planSchema).not.toContain("seance");
		expect(planSchema).toContain('"model":{"type":"string"}');
		expect(planMode.description).not.toContain("seance");
		expect(planMode.description).not.toContain("Historical consults");

		const ordinary = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		const ordinarySchema = JSON.stringify(ordinary.parameters.toJsonSchema());
		expect(ordinarySchema).toContain('"sourceSession"');
		expect(ordinarySchema).toContain('"model"');
		expect(ordinary.description).toContain("`seance`");
		expect(ordinary.description).toContain("Historical consults");
	});
	afterEach(() => vi.restoreAllMocks());
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
	it("rejects a model override for an ordinary task while task.perCallModel is off", async () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			seanceFields: seanceTaskSchemaFields,
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
		expect(await executeText(params, [bundledSeance, scout])).toContain("task.perCallModel: off");
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

	it("keys the seance model exemption on the resolved agent, not the raw `agent` value", async () => {
		const seen: unknown[] = [];
		vi.spyOn(seanceModule, "prepareSeance").mockImplementation(async context => {
			seen.push(context.model);
			throw new Error("stop after seance received its selectors");
		});
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [bundledSeance],
			projectAgentsDir: null,
		});
		const selectors = ["anthropic/claude-sonnet-4-5", "openai/gpt-5"];
		const run = async (batch: boolean, params: Record<string, unknown>) => {
			const tool = await TaskTool.create(
				createSession({ parentSpawns: "seance", settings: { "task.perCallModel": "off", "task.batch": batch } }),
			);
			const result = await tool.execute("tool-call", params);
			return result.content.find(part => part.type === "text")?.text ?? "";
		};
		const flat = { task: "What was decided?", sourceSession: "/tmp/source.jsonl", model: selectors };
		const item = { task: "What was decided?", sourceSession: "/tmp/source.jsonl", model: selectors };
		const texts = [
			await run(false, flat),
			await run(false, { ...flat, agent: " seance " }),
			await run(true, { context: "c", tasks: [item] }),
			await run(true, { context: "c", tasks: [{ ...item, agent: " seance " }] }),
		];
		for (const text of texts) expect(text).not.toContain("invalid `model` value");
		expect(seen).toEqual([selectors, selectors, selectors, selectors]);
	});
});
