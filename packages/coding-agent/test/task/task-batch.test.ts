/**
 * Contracts: task.batch gating (batch spawning + shared context).
 *
 * 1. The wire schema is shape-swapped by `task.batch`: `{ context, tasks[] }`
 *    when on (per-spawn fields — including `model`, `isolated`, `outputSchema`, and
 *    `schemaMode` — live in the items), the flat form exposes those fields
 *    directly. The stale `schema` field is never accepted.
 * 2. Shape validation rejects stale `schema`, `tasks`/`context` while batch
 *    is disabled, top-level `task` in batch calls, empty/invalid items,
 *    duplicate names, and a missing shared `context`.
 * 3. With `async.enabled=true`, a batch call registers one background job per
 *    item; with `async.enabled=false`, it blocks and returns merged results.
 *    Both modes forward the shared `context`; the flat form stays accepted at
 *    runtime for internal callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool, validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { parseToolCallArguments } from "@oh-my-pi/pi-ai/utils/tool-call-arguments";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

import { cfgTaskDisabledAgents, cfgTaskEnableEffort, cfgTaskStructured } from "@oh-my-pi/pi-coding-agent/task/settings";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(
	options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
		agentId?: string;
		planMode?: boolean;
		spawns?: string;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => options.agentId ?? null,
		getPlanModeState: options.planMode ? () => ({ enabled: true }) : undefined,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const properties = toolWireSchema(tool).properties;
	return isRecord(properties) ? properties : {};
}

function getBatchItemProperties(tool: TaskTool): Record<string, unknown> {
	const tasks = getSchemaProperties(tool).tasks;
	if (!isRecord(tasks) || !isRecord(tasks.items) || !isRecord(tasks.items.properties)) return {};
	return tasks.items.properties;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(agent: AgentDefinition | AgentDefinition[] = taskAgent): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: Array.isArray(agent) ? agent : [agent],
		projectAgentsDir: null,
	});
}
describe("task.batch schema gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false, "task.structured": true } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.task).toBeDefined();
		expect(offProperties.name).toBeDefined();
		expect(offProperties.outputSchema).toBeDefined();
		expect(typeof offProperties.outputSchema).toBe("object");
		expect(offProperties.schemaMode).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true, "task.structured": true } }));
		const onProperties = getSchemaProperties(on);
		expect(onProperties.tasks).toBeDefined();
		expect(onProperties.context).toBeDefined();
		// The batch shape is { context, tasks[] } — the per-spawn fields live
		// only inside the task items.
		expect(onProperties.task).toBeUndefined();
		expect(onProperties.name).toBeUndefined();
		expect(onProperties.agent).toBeUndefined();
		expect(onProperties.outputSchema).toBeUndefined();
		expect(onProperties.schemaMode).toBeUndefined();
		const itemProperties = getBatchItemProperties(on);
		expect(itemProperties.task).toBeDefined();
		expect(itemProperties.name).toBeDefined();
		expect(itemProperties.agent).toBeDefined();
		expect(itemProperties.outputSchema).toBeDefined();
		expect(typeof itemProperties.outputSchema).toBe("object");
		expect(itemProperties.schemaMode).toBeDefined();
	});

	it("hides effort by default and exposes it when task.enableEffort is enabled", async () => {
		mockDiscovery();

		const flatSession = createSession({ settings: { "task.batch": false } });
		const flat = await TaskTool.create(flatSession);
		expect(getSchemaProperties(flat).effort).toBeUndefined();
		expect(flat.description).not.toContain("`effort`");

		cfgTaskEnableEffort.override(flatSession.settings, true);
		expect(getSchemaProperties(flat).effort).toBeDefined();
		expect(flat.description).toContain("`effort`");

		const batchSession = createSession({ settings: { "task.batch": true } });
		const batch = await TaskTool.create(batchSession);
		expect(getBatchItemProperties(batch).effort).toBeUndefined();
		expect(batch.description).not.toContain("`effort`");

		cfgTaskEnableEffort.override(batchSession.settings, true);
		expect(getBatchItemProperties(batch).effort).toBeDefined();
		expect(batch.description).toContain("`effort`");
	});

	it("keeps isolation boolean-only in the batch item schema", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.isolation.enabled": true } }),
		);
		const properties = getSchemaProperties(tool);
		expect(properties.isolated).toBeUndefined();
		const itemProperties = getBatchItemProperties(tool);
		const isolatedSchema = itemProperties.isolated;
		if (!isolatedSchema || typeof isolatedSchema !== "object" || !("type" in isolatedSchema)) {
			throw new Error("Expected isolated to be a boolean schema");
		}
		expect(isolatedSchema.type).toBe("boolean");
		expect(itemProperties.apply).toBeUndefined();
	});

	it("hides isolation from the dynamic batch schema in plan mode", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(
			createSession({
				planMode: true,
				settings: { "task.batch": true, "task.isolation.enabled": true },
			}),
		);
		const itemProperties = getBatchItemProperties(tool);
		expect(itemProperties.isolated).toBeUndefined();
		expect(tool.description).not.toContain("`isolated`");
	});

	it("exposes outputSchema but never the stale schema field", async () => {
		mockDiscovery();

		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false, "task.structured": true } }));
		expect(getSchemaProperties(flat).outputSchema).toBeDefined();
		expect(getSchemaProperties(flat).schema).toBeUndefined();

		const batch = await TaskTool.create(createSession({ settings: { "task.batch": true, "task.structured": true } }));
		expect(getSchemaProperties(batch).schema).toBeUndefined();
	});

	it("hides outputSchema and schemaMode from the wire shape and description unless task.structured is on", async () => {
		mockDiscovery();

		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(getSchemaProperties(flat).outputSchema).toBeUndefined();
		expect(getSchemaProperties(flat).schemaMode).toBeUndefined();
		expect(flat.description).not.toContain("outputSchema");

		const batch = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": true } }));
		expect(getBatchItemProperties(batch).outputSchema).toBeUndefined();
		expect(getBatchItemProperties(batch).schemaMode).toBeUndefined();
		expect(batch.description).not.toContain("outputSchema");
	});

	it("explains structured result navigation with task.structured off only while a visible agent opts in", async () => {
		mockDiscovery([
			taskAgent,
			{ ...taskAgent, name: "reporter", description: "Reports a verdict", structured: true },
		]);
		const session = createSession({ settings: { "task.batch": true, "async.enabled": true } });
		const tool = await TaskTool.create(session);
		const navigation = "nested `/reports/0/data`";

		const optedIn = tool.description;
		expect(optedIn).toContain(navigation);
		expect(optedIn).toContain("- `reporter` (STRUCTURED; schema result): Reports a verdict");
		expect(optedIn).not.toContain("outputSchema");
		expect(optedIn).not.toContain("schemaMode");

		cfgTaskDisabledAgents.override(session.settings, ["reporter"]);
		expect(tool.description).not.toContain(navigation);

		cfgTaskDisabledAgents.override(session.settings, []);
		cfgTaskStructured.override(session.settings, true);
		const settingOn = tool.description;
		expect(settingOn).toContain("`outputSchema` parsed payload, even invalid");
		expect(settingOn).not.toContain("STRUCTURED");
	});
});

describe("task.batch validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, settings: Record<string, unknown> = {}): Promise<string> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const result = await tool.execute("tool-call", params);
		return getFirstText(result);
	}

	it("reports missing tasks as a failed tool result instead of a successful refusal", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const result = await tool.execute("missing-tasks", {
			context: "<tasks><task>Inspect the project</task></tasks>",
		});

		expect(getFirstText(result)).toContain("Missing `tasks`");
		expect(result.isError).toBe(true);
	});

	/**
	 * Decode a call the way a provider stream does — raw streamed JSON through
	 * `parseToolCallArguments`, then the shared lenient validation the task
	 * tool runs under — and execute it. The reported failure
	 * (dispatch://INFRA-1270) was believed to be a decode failure, so the
	 * regression has to come through the decode path, not a hand-built object.
	 */
	async function decodeAndExecute(
		rawJson: string,
		settings: Record<string, unknown>,
	): Promise<{ text: string; decoded: unknown }> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const decoded = parseToolCallArguments(rawJson);
		const args = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: "decoded-call",
			name: tool.name,
			arguments: decoded,
		});
		const result = await tool.execute("decoded-call", args as TaskParams);
		return { text: getFirstText(result), decoded };
	}

	it("names the fields a context-only batch call carried instead of only the one it lacks", async () => {
		// The recorded shape: a long multi-paragraph brief with numbered lists,
		// backticks and parentheses written into the shared `context`, no `tasks`.
		const brief = [
			"Review round 10 of `owner/repo` pull request #18122 (head 05a23ac2).",
			"",
			"1. Read the brief at `/tmp/arms/shared.md` FIRST and in full.",
			"2. Drive the real consumers (the `plugin install` command), not a script you find on disk.",
			"3. Report a verdict in the exact shape the brief names.",
		].join("\n");
		const rawJson = JSON.stringify({ i: "Dispatch review pair at head", context: brief });

		const { text, decoded } = await decodeAndExecute(rawJson, { "task.batch": true });

		// The arguments survived decoding intact: the refusal is about shape, not bytes.
		expect(isRecord(decoded) && typeof decoded.context === "string" ? decoded.context : null).toBe(brief);
		// The exact list, so a harness-only field cannot creep into it.
		expect(text).toContain("The call carried `context` and no work to run.");
		expect(text).toContain("tasks[].task");
	});

	it("never tells a call that carried only its intent that its arguments were lost", async () => {
		// Two shapes, because the dispatch step decides which one the tool sees.
		// With intent tracing on — the production default — `agent-loop` strips
		// `i` before validation, so the tool is handed `{}` and the refusal must
		// not blame a lost payload for a field the harness removed on purpose.
		// With tracing off the tool sees `i` itself. Asserting only the second
		// shape is what let the misleading wording ship: the test called
		// `execute` directly and skipped the step that discards the evidence.
		const stripped = await decodeAndExecute("{}", { "task.batch": true });
		expect(stripped.text).toContain("harness strips the `i` intent");
		expect(stripped.text).not.toContain("arguments were lost");
		expect(stripped.text).not.toContain("lost before the tool ran");

		const kept = await decodeAndExecute(JSON.stringify({ i: "Dispatching the pair" }), { "task.batch": true });
		expect(kept.text).toContain("carried its `i` intent and nothing else");
		expect(kept.text).not.toContain("arguments were lost");
	});

	// A non-record root survives lenient validation and reaches dispatch as it
	// arrived. `null` threw a TypeError out of `validateShapeParams`, and a
	// string enumerated its character indices as if they were fields the caller
	// sent — a long one putting a status-like number into the refusal.
	it.each([
		['"work"', "a string"],
		[`"${"x".repeat(600)}"`, "a string"],
		["[]", "an array"],
		["false", "a boolean"],
		["0", "a number"],
		["null", "`null`"],
	])("reports a non-object argument root as its shape, not as fields: %s", async (rawJson, shape) => {
		const { text } = await decodeAndExecute(rawJson, { "task.batch": true });
		expect(text).toContain(`arrived as ${shape}`);
		expect(text).not.toContain("The call carried `0`");
		expect(text).not.toContain("reached the tool");
		expect(text).not.toMatch(/\b(?:401|403|429|500|502|503|504)\b/);
	});

	it("bounds the field list it echoes back, in count and in each name", async () => {
		// Every unknown root key survives lenient validation, so the list is the
		// model's own text and its length is the model's own choice. The long,
		// backticked and newline-bearing keys go FIRST: placed after the count
		// cap they fall outside the rendered prefix, and the assertions below
		// then pass with the per-name protections removed.
		const many: Record<string, unknown> = {
			[`long${"g".repeat(200)}`]: 1,
			"back`tick": 1,
			"two\nlines\nhere": 1,
		};
		for (let i = 0; i < 400; i++) many[`field${i}`] = i;

		const { text } = await decodeAndExecute(JSON.stringify(many), { "task.batch": true });

		expect(text).toContain("and others");
		expect(text.length).toBeLessThan(600);
		expect(text).toContain("`long" + "g".repeat(36) + "…`");
		expect(text).toContain("back'tick");
		expect(text).toContain("`two lines here`");
		expect(text.split("\n")).toHaveLength(1);
	});

	it("judges the root shape before the repair can reshape it", async () => {
		// `repairTaskParams` returns `{ ...params, task, context, tasks }` when it
		// repairs anything, and spreading an ARRAY produces a plain object — so an
		// array carrying a double-encoded `context` reached validation as a record
		// and was described as one.
		const asArray: unknown[] = [];
		// TWO escaped newlines: `repairDoubleEncodedJsonString` deliberately leaves
		// a single non-structural escape alone, so one of them fires no repair at
		// all and `validateShapeParams` rejects the array on its own — the test
		// then passes with the `planSpawns` guard removed, guarding nothing.
		(asArray as unknown as Record<string, unknown>).context = String.raw`Line one\nLine two\nLine three`;
		(asArray as unknown as Record<string, unknown>).tasks = [{ task: "Work.", solutionSpace: "c" }];

		const { text } = await decodeAndExecute(JSON.stringify({ wrapped: 1 }), { "task.batch": true });
		expect(text).not.toContain("arrived as an array");

		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const result = await tool.execute("array-root", asArray as unknown as TaskParams);
		expect(getFirstText(result)).toContain("arrived as an array");
		expect(result.isError).toBe(true);
	});

	it("advises the shape the current setting accepts when the arguments are not an object", async () => {
		// Advising `{ context, tasks }` while task.batch is off walks the caller
		// into "task.batch is disabled, so the task tool does not accept `tasks`
		// or `context`" — the unrecoverable round-trip this whole change removes.
		const off = await decodeAndExecute('"work"', { "task.batch": false });
		expect(off.text).toContain("`{ task, solutionSpace, name?, agent? }`");
		expect(off.text).not.toContain("tasks:");

		const on = await decodeAndExecute('"work"', { "task.batch": true });
		expect(on.text).toContain("tasks: [{ task, solutionSpace, name?, agent? }]");
	});

	it("cuts a long key on a character boundary, not through an astral pair", async () => {
		// 39 ASCII units, so the astral pair STRADDLES the 40-unit cut. At 38 the
		// first pair ends exactly on the boundary and nothing is ever severed.
		const key = `${"a".repeat(39)}🧞🧞`;
		const { text } = await decodeAndExecute(JSON.stringify({ [key]: 1 }), { "task.batch": true });
		expect(text.isWellFormed()).toBe(true);
	});

	it("never names a field the double-encoding repair materialised", async () => {
		// A `context` whose newlines are double-encoded makes `repairTaskParams`
		// rebuild the params as `{ ...params, task, context, tasks }`, so absent
		// `task` and `tasks` become own properties holding `undefined`. The
		// refusal must not report them as fields the caller sent.
		const rawJson = JSON.stringify({ context: String.raw`Line one\nLine two\nLine three` });

		const { text } = await decodeAndExecute(rawJson, { "task.batch": true });

		expect(text).toContain("The call carried `context` and no work to run.");
	});

	it("reports no field reaching the tool as nothing received, not as one absent field", async () => {
		const { text } = await decodeAndExecute("{}", { "task.batch": true });
		expect(text).toContain("No field of this `task` call reached the tool");
		expect(text).not.toContain("no work to run");
	});

	it("builds an approval prompt from a non-record root instead of throwing", async () => {
		// The prompt is built from the RAW arguments, before `planSpawns` judges
		// the root, so `null` threw `TypeError: null is not an object` out of the
		// approval path while `approvalRestrictionPaths` beside it already
		// guarded. Nothing else covers this: deleting the guard leaves the whole
		// task suite green.
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		for (const root of [null, undefined, "work", 0, false, []]) {
			expect(() => tool.formatApprovalDetails(root)).not.toThrow();
			expect(tool.formatApprovalDetails(root)).toEqual([]);
		}
		// A real call still describes itself.
		expect(tool.formatApprovalDetails({ agent: "task", task: "Work." }).join("\n")).toContain("Agent: task");
	});

	it("rejects the stale schema argument regardless of batch mode", async () => {
		for (const batch of [false, true]) {
			const text = await executeText(
				{ agent: "task", task: "Work.", schema: '{"properties":{}}' },
				{ "task.batch": batch },
			);
			expect(text).toContain("uses `outputSchema`");
		}
	});

	it("rejects tasks and context while task.batch is disabled", async () => {
		const disabled = { "task.batch": false };
		const text = await executeText({ agent: "task", tasks: [{ task: "Work." }] }, disabled);
		expect(text).toContain("task.batch is disabled");

		const contextText = await executeText({ agent: "task", task: "Work.", context: "Background." }, disabled);
		expect(contextText).toContain("task.batch is disabled");
	});

	it("rejects top-level task in the batch shape", async () => {
		const text = await executeText({ task: "Work.", tasks: [{ task: "Other." }] }, { "task.batch": true });
		expect(text).toContain("not part of the batch shape");
	});

	it("rejects a misplaced specialist before spawning any agent", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": false } }));
		const result = await tool.execute("misplaced-specialist", {
			context: "Inspect changes without edits",
			agent: "custom-auditor",
			tasks: [{ task: "Inspect the patch" }],
		});
		expect(getFirstText(result)).toContain("tasks[].agent");
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects empty task arrays and items without tasks", async () => {
		const empty = await executeText({ tasks: [] }, { "task.batch": true });
		expect(empty).toContain("Missing `tasks`");

		const missing = await executeText({ tasks: [{ task: "Work." }, { name: "Beta" }] }, { "task.batch": true });
		expect(missing).toContain("Task 2 (`Beta`) is missing `task`");
	});

	it("requires a shared context for batch calls", async () => {
		const text = await executeText({ tasks: [{ task: "Work." }] }, { "task.batch": true });
		expect(text).toContain("Missing `context`");
	});

	it("rejects duplicate provided names case-insensitively", async () => {
		const text = await executeText(
			{
				tasks: [
					{ name: "Anna", task: "A." },
					{ name: "anna", task: "B." },
				],
			},
			{ "task.batch": true },
		);
		expect(text).toContain("Duplicate task name");
	});

	it("marks lenientArgValidation so execute() surfaces the actionable shape error", async () => {
		// Regression (#6039): the flat single-spawn wire schema carries
		// `"+": "delete"`, so a batch `{ context, tasks[] }` payload is stripped
		// by arktype and rejected as `task must be a string (was missing)` in the
		// agent loop — preempting the tool's own actionable message. The lenient
		// flag makes the loop forward the raw args to execute() on that failure.
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(tool.lenientArgValidation).toBe(true);

		// The raw batch payload the loop would forward reaches execute() and
		// yields the actionable reason, never arktype's misleading missing-`task`.
		const text = await executeText(
			{ context: "Background.", tasks: [{ name: "Alpha", task: "Work." }] },
			{ "task.batch": false },
		);
		expect(text).toContain("task.batch is disabled");
		expect(text).not.toContain("was missing");
	});

	it("advertises solutionSpace as required but still spawns a model call that omits it", async () => {
		mockDiscovery();
		const spawned: Array<string | undefined> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			spawned.push(options.assignment);
			return makeResult(options.id ?? "?");
		});
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": true } }));
		const items = getSchemaProperties(tool).tasks;
		expect(isRecord(items) && isRecord(items.items) ? items.items.required : undefined).toContain("solutionSpace");

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tc-no-solution-space",
							name: "task",
							arguments: { context: "# Goal\nX", tasks: [{ name: "Alpha", task: "Do A." }] },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [tool as unknown as AgentTool],
				messages: [],
			},
			streamFn: mock.stream,
		});
		await agent.prompt("go");

		expect(spawned).toEqual(["Do A."]);
		const toolResult = agent.state.messages.find(message => message.role === "toolResult");
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(false);
	});

	// The agent loop validates arguments against the wire schema before execute(),
	// and that schema deletes undeclared keys. With per-call model off, `model` and
	// `sourceSession` on an ordinary agent must still be refused by every call form
	// instead of being dropped, leaving the child on its own model while the caller
	// believes it pinned another.
	// `task.structured` and `task.isolation.enabled` choose between the prebuilt and
	// generated batch schemas, each with and without `isolated`.
	it.each([
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: false, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: false, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: true, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: true, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: false, field: "sourceSession" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: false, field: "sourceSession" },
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: true, field: "sourceSession" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: true, field: "sourceSession" },
		{ form: "batch", seance: "advertised", batch: true, structured: false, isolation: false, field: "model" },
		{ form: "flat", seance: "hidden", batch: false, structured: false, isolation: false, field: "model" },
	])(
		"refuses $field on an ordinary agent in the $form form with seance $seance (structured: $structured, isolation: $isolation)",
		async ({ seance, batch, structured, isolation, field }) => {
			const bundledSeance = loadBundledAgents().find(agent => agent.name === "seance")!;
			mockDiscovery(seance === "advertised" ? [taskAgent, bundledSeance] : taskAgent);
			const run = vi
				.spyOn(executorModule, "runSubprocess")
				.mockImplementation(async options => makeResult(options.id ?? "?"));
			const tool = await TaskTool.create(
				createSession({
					settings: {
						"async.enabled": false,
						"task.batch": batch,
						"task.structured": structured,
						"task.isolation.enabled": isolation,
					},
				}),
			);
			const item = { name: "Alpha", agent: "task", task: "Do A.", solutionSpace: "c", [field]: "stub/model-b" };
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "tc-model-pin",
								name: "task",
								arguments: batch ? { context: "# Goal\nX", tasks: [item] } : item,
							},
						],
					},
					{ content: ["done"] },
				],
			});
			const agent = new Agent({
				initialState: {
					model: mock.model,
					systemPrompt: ["Test"],
					tools: [tool as unknown as AgentTool],
					messages: [],
				},
				streamFn: mock.stream,
			});
			await agent.prompt("go");

			const toolResult = agent.state.messages.find(message => message.role === "toolResult");
			const text = toolResult?.role === "toolResult" ? getFirstText(toolResult) : "";
			// `model` doubles as the per-call selector, whose disabled gate is reported first.
			expect(text).toContain(
				field === "model"
					? "Per-call model is disabled for task calls (task.perCallModel: off)."
					: `\`${field}\` is only accepted for the \`seance\` agent.`,
			);
			expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
			expect(run).not.toHaveBeenCalled();
		},
	);
});

describe("task.batch spawning", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("spawns one background job per task item and forwards independent models and schemas with shared context", async () => {
		mockDiscovery({
			...taskAgent,
			output: { type: "object", properties: { staleAgentOutput: { type: "boolean" } } },
		});
		const seen: Array<{
			id?: string;
			context?: string;
			assignment?: string;
			parentAgentId?: string;
			modelOverride?: string | string[];
			outputSchema?: unknown;
			outputSchemaMode?: "permissive" | "strict";
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				parentAgentId: options.parentAgentId,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				agentId: "ParentA",
				settings: { "async.enabled": true, "task.batch": true, "task.structured": true },
			}),
		);
		const alphaSchema = { type: "object", properties: { alpha: { type: "string" } } };
		const betaSchema = { type: "object", properties: { beta: { type: "number" } } };
		const result = await tool.execute("tc-batch", {
			context: "# Goal\nShared background.",
			tasks: [
				{
					name: "Alpha",
					task: "Do A.",
					outputSchema: alphaSchema,
					schemaMode: "strict",
				},
				{
					name: "Beta",
					task: "Do B.",
					outputSchema: betaSchema,
					schemaMode: "permissive",
				},
			],
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain("Spawned 2 background agents");
		expect(text).toContain("- `Alpha`");
		expect(text).toContain("- `Beta`");
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(result.details?.async?.state).toBe("running");

		const alphaJob = manager.getJob("Alpha");
		const betaJob = manager.getJob("Beta");
		expect(alphaJob).toBeDefined();
		expect(betaJob).toBeDefined();
		await alphaJob!.promise;
		await betaJob!.promise;

		expect(seen).toHaveLength(2);
		for (const spawn of seen) {
			expect(spawn.context).toBe("# Goal\nShared background.");
			expect(spawn.outputSchemaSource).toBe("caller");
			expect(spawn.outputSchemaOverridesAgent).toBe(true);
		}
		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		expect(byId.get("Alpha")?.outputSchema).toEqual(alphaSchema);
		expect(byId.get("Alpha")?.outputSchemaMode).toBe("strict");
		expect(byId.get("Beta")?.outputSchema).toEqual(betaSchema);
		expect(byId.get("Beta")?.outputSchemaMode).toBe("permissive");
		expect(seen.map(spawn => spawn.assignment).sort()).toEqual(["Do A.", "Do B."]);
		for (const spawn of seen) expect(spawn.parentAgentId).toBe("ParentA");
	});

	it("routes each mixed-agent item through its selected definition while preserving caller overrides", async () => {
		const scoutSchema = { type: "object", properties: { findings: { type: "array" } } };
		const reviewerSchema = { type: "object", properties: { verdict: { type: "string" } } };
		const callerSchema = { type: "object", properties: { approved: { type: "boolean" } } };
		const scoutAgent: AgentDefinition = {
			...taskAgent,
			name: "scout",
			description: "Read-only scout",
			systemPrompt: "Investigate the assigned target.",
			tools: ["read"],
			model: ["anthropic/claude-haiku-4-5:low"],
			output: scoutSchema,
		};
		const reviewerAgent: AgentDefinition = {
			...taskAgent,
			name: "reviewer",
			description: "Code review specialist",
			systemPrompt: "Review the assigned target.",
			tools: ["read", "bash"],
			model: ["anthropic/claude-sonnet-4-6:medium"],
			output: reviewerSchema,
		};
		mockDiscovery([scoutAgent, reviewerAgent]);

		const seen: Array<{
			id?: string;
			agent: AgentDefinition;
			modelOverride?: string | string[];
			outputSchema?: unknown;
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				agent: options.agent,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?", { agent: options.agent.name });
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true, "task.structured": true } }),
		);
		const result = await tool.execute("tc-mixed-agents", {
			context: "Shared routing context.",
			tasks: [
				{ name: "Scout", agent: "scout", task: "Investigate." },
				{
					name: "Review",
					agent: "reviewer",
					task: "Review.",
					outputSchema: callerSchema,
				},
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned 2 background agents");
		await Promise.all([manager.getJob("Scout")!.promise, manager.getJob("Review")!.promise]);

		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		const scoutSpawn = byId.get("Scout");
		const reviewerSpawn = byId.get("Review");
		expect(scoutSpawn?.agent).toBe(scoutAgent);
		expect(scoutSpawn?.agent.tools).toEqual(["read"]);
		expect(scoutSpawn?.modelOverride).toEqual(["anthropic/claude-haiku-4-5:low"]);
		expect(scoutSpawn?.outputSchema).toBe(scoutSchema);
		expect(scoutSpawn?.outputSchemaSource).toBe("agent");
		expect(scoutSpawn?.outputSchemaOverridesAgent).toBe(false);
		expect(reviewerSpawn?.agent).toBe(reviewerAgent);
		expect(reviewerSpawn?.agent.tools).toEqual(["read", "bash"]);
		expect(reviewerSpawn?.modelOverride).toEqual(["anthropic/claude-sonnet-4-6:medium"]);
		expect(reviewerSpawn?.outputSchema).toBe(callerSchema);
		expect(reviewerSpawn?.outputSchemaSource).toBe("caller");
		expect(reviewerSpawn?.outputSchemaOverridesAgent).toBe(true);
	});

	it("treats a one-item batch as a single spawn and forwards context", async () => {
		mockDiscovery();
		let capturedContext: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedContext = options.context;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-single", {
			context: "Shared notes.",
			tasks: [{ name: "Solo", task: "Do the thing." }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Solo`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(capturedContext).toBe("Shared notes.");
	});

	it("accepts the flat single-spawn form at runtime under batch mode", async () => {
		// Internal callers (e.g. the commit flow) and stale transcripts use the
		// flat shape directly; the wire schema is batch-only but runtime is not.
		mockDiscovery({
			...taskAgent,
			model: ["anthropic/claude-sonnet-4"],
			output: { type: "object", properties: { agent: { type: "string" } } },
		});
		let captured:
			| {
					modelOverride?: string | string[];
					outputSchema?: unknown;
					outputSchemaMode?: "permissive" | "strict";
					outputSchemaSource?: "caller" | "agent" | "session" | "none";
					outputSchemaOverridesAgent?: boolean;
			  }
			| undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = {
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			};
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"async.enabled": true,
					"task.batch": true,
					"task.structured": true,
					"task.agentModelOverrides": { task: "openai/gpt-4.1-mini" },
				},
			}),
		);

		const callerSchema = { type: "object", properties: { caller: { type: "number" } } };
		const result = await tool.execute("tc-flat", {
			agent: "task",
			name: "Flat",
			task: "Do the thing.",
			outputSchema: callerSchema,
			schemaMode: "strict",
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Flat`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(captured?.modelOverride).toEqual(["openai/gpt-4.1-mini"]);
		expect(captured?.outputSchema).toEqual(callerSchema);
		expect(captured?.outputSchemaMode).toBe("strict");
		expect(captured?.outputSchemaSource).toBe("caller");
		expect(captured?.outputSchemaOverridesAgent).toBe(true);
	});

	it("spawns schema-less, yield-less children by default even with caller and agent schemas", async () => {
		mockDiscovery({ ...taskAgent, output: { type: "object", properties: { agent: { type: "string" } } } });
		let captured: { structured?: boolean; outputSchema?: unknown; outputSchemaSource?: string } | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = {
				structured: options.structured,
				outputSchema: options.outputSchema,
				outputSchemaSource: options.outputSchemaSource,
			};
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);
		const result = await tool.execute("tc-prose", {
			agent: "task",
			name: "Prose",
			task: "Do the thing.",
			outputSchema: { type: "object", properties: { caller: { type: "number" } } },
			schemaMode: "strict",
		} as TaskParams);

		await manager.getJob(result.details!.async!.jobId)!.promise;
		expect(captured).toEqual({ structured: false, outputSchema: undefined, outputSchemaSource: undefined });
	});

	it("blocks batch execution when async.enabled is false even with a job manager", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({ id: options.id, context: options.context, assignment: options.assignment });
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("tc-sync-batch", {
			context: "# Goal\nShared synchronous context.",
			tasks: [
				{ name: "Alpha", task: "Do A." },
				{ name: "Beta", task: "Do B." },
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("All done.");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(item => item.id).sort()).toEqual(["Alpha", "Beta"]);
		expect(manager.getJob("Alpha")).toBeUndefined();
		expect(manager.getJob("Beta")).toBeUndefined();
		expect(seen.map(spawn => spawn.context)).toEqual([
			"# Goal\nShared synchronous context.",
			"# Goal\nShared synchronous context.",
		]);
	});

	it("ignores a caller-supplied effort unless task.enableEffort is on", async () => {
		mockDiscovery();
		const efforts: Array<string | undefined> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			efforts.push(options.effort);
			return makeResult(options.id ?? "?");
		});
		const run = async (settings: Record<string, unknown>, params: TaskParams) => {
			const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, ...settings } }));
			await tool.execute("tc-effort", params);
		};
		const batch = { context: "Shared.", tasks: [{ name: "Solo", task: "Reply OK.", effort: "hi" }] } as TaskParams;

		// Stale or model-invented calls carry the unadvertised field in both shapes.
		await run({ "task.batch": false }, { task: "Reply OK.", solutionSpace: "One exact response.", effort: "hi" });
		await run({ "task.batch": true }, batch);
		await run({ "task.batch": true, "task.enableEffort": true }, batch);

		expect(efforts).toEqual([undefined, undefined, "hi"]);
	});

	it("keeps a long result inline when no readable output artifact exists", async () => {
		mockDiscovery();
		const fullOutput = `REPORT:${"x".repeat(6_000)}:END`;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", {
				output: fullOutput,
				outputMeta: { lineCount: 1, charCount: fullOutput.length },
			}),
		);

		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const result = await tool.execute("tc-missing-artifact", {
			name: "MissingArtifact",
			task: "Return a long report.",
		} as TaskParams);
		const text = getFirstText(result);

		expect(text).not.toContain("agent://MissingArtifact");
		expect(text).toContain(":END");
	});

	it("settles the batch async aggregate when a queued spawn is cancelled mid-flight", async () => {
		mockDiscovery();
		const started: string[] = [];
		const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.set(id, { promise, resolve });
			await promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "async.enabled": true, "task.batch": true, "task.maxConcurrency": 1 },
			}),
		);

		const updates: Array<{ async?: { state?: string }; progress?: Array<{ id: string; status: string }> }> = [];
		const result = await tool.execute(
			"tc-batch-cancel",
			{
				context: "ctx",
				tasks: [
					{ name: "First", task: "Do A." },
					{ name: "Second", task: "Do B." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) {
					updates.push({
						async: update.details.async,
						progress: update.details.progress?.map(p => ({ id: p.id, status: p.status })),
					});
				}
			},
		);

		expect(result.details?.async?.state).toBe("running");

		const firstJob = manager.getJob("First")!;
		const secondJob = manager.getJob("Second")!;
		const deadline = Date.now() + 1_000;
		while (started.length === 0) {
			if (Date.now() > deadline) throw new Error("First spawn never reached the executor");
			await Bun.sleep(5);
		}
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;

		gates.get("First")!.resolve();
		await firstJob.promise;

		expect(secondJob.status).toBe("cancelled");
		const last = updates.at(-1);
		// The acquire-time abort path has to flow through the same `onSettled`
		// the post-acquire abort path uses, otherwise the batch aggregate sticks
		// at "running" forever after the surviving spawn completes.
		expect(last?.async?.state).toBe("failed");
		expect(last?.progress?.find(p => p.id === "Second")?.status).toBe("aborted");
		expect(last?.progress?.find(p => p.id === "First")?.status).toBe("completed");
	});
});

describe("batch model placement", () => {
	afterEach(() => vi.restoreAllMocks());
	it("rejects a top-level model before dispatch even when wire validation is bypassed", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": false } }));
		const result = await tool.execute("batch-model", {
			context: "Shared context",
			model: "p/requested",
			tasks: [{ task: "Do work" }],
		});
		expect(getFirstText(result)).toMatch(/model.*tasks|model.*item/i);
		expect(result.isError).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});

	// `off` and `eval` refuse task calls through the same gate; one mode per shape covers it.
	it.each([
		["off", "batch"],
		["eval", "flat"],
	] as const)(
		"rejects a task call's model before dispatch while task.perCallModel is %s (%s call)",
		async (mode, shape) => {
			const batch = shape === "batch";
			mockDiscovery();
			const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
			const tool = await TaskTool.create(
				createSession({ settings: { "task.batch": batch, "async.enabled": false, "task.perCallModel": mode } }),
			);
			// A role alias is not an exact selector, but the disabled gate is what the caller must hear first.
			const work = { task: "Do work", solutionSpace: "c", model: "@smol" };
			// Through shared argument validation, as a model's tool call arrives: `model` must reach preflight in both shapes.
			const args = validateAgentToolArguments(tool as unknown as AgentTool, {
				type: "toolCall",
				id: "task-model",
				name: tool.name,
				arguments: batch ? { context: "Shared context", tasks: [work] } : work,
			});
			const result = await tool.execute("task-model", args as TaskParams);
			expect(getFirstText(result)).toMatch(/per-call model is disabled/i);
			expect(result.isError).toBe(true);
			expect(run).not.toHaveBeenCalled();
		},
	);
});
