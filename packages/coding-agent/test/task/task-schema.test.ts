import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { isBundledSeance, seanceTaskSchemaFields } from "@oh-my-pi/pi-coding-agent/task/seance";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

let taskSchemaSessionIndex = 0;

function createSession(
	options: { parentSpawns?: string; disabledAgents?: string[]; planMode?: boolean } = {},
): ToolSession {
	return {
		cwd: `/tmp/task-schema-${taskSchemaSessionIndex++}`,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.enabled": false,
			"task.batch": false,
			"task.disabledAgents": options.disabledAgents ?? [],
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
			const item = { taskFile: "local://assignment.md", solutionSpace: "one defined change" };
			const parsed = schema(batchEnabled ? { context: "shared context", tasks: [item] } : item);
			const wire = schema.toJsonSchema();
			const tasks = isRecord(wire.properties) ? wire.properties.tasks : undefined;
			const itemWire = batchEnabled && isRecord(tasks) ? tasks.items : wire;
			if (!isRecord(itemWire)) throw new Error("Expected an object schema for task input");
			if (file) {
				if (parsed instanceof type.errors) throw new Error(parsed.summary);
				expect(parsed).toMatchObject(
					batchEnabled ? { tasks: [{ taskFile: item.taskFile }] } : { taskFile: item.taskFile },
				);
				expect(itemWire.required).not.toContain("task");
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
				expect(wireSchema).not.toContain('"model"');
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
		expect(planSchema).not.toContain('"model"');
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
	it("rejects a model override for an ordinary task after the enabled schema accepts it", async () => {
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
		expect(await executeText(params, [bundledSeance])).toContain("`model` is only accepted for the `seance` agent.");
	});
});
