import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as sdk from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { TaskTool } from "../../src/task";
import * as discovery from "../../src/task/discovery";
import { finalizeSubagentLifecycle } from "../../src/task/executor";
import { AgentOutputManager } from "../../src/task/output-manager";
import { type AgentDefinition, getTaskSchema } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

// pi/task is a model-role/tool dispatch, not an HTTP endpoint. The runtime
// request contract is evidenceDigest:{paths,question}; digest/receipt result
// shapes are worker prompt guidance, not automatic sanitizers or schemas.
const workerDefinition: AgentDefinition = {
	name: "task",
	description: "Deterministic delegated worker",
	systemPrompt: "Read or write the assigned file, then yield only the requested result.",
	tools: ["read", "write", "yield"],
	source: "bundled",
};
const createRealSession = sdk.createAgentSession;

describe("delegated shunting integration", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let tool: TaskTool;
	let settings: Settings;
	let workerResponses: MockResponse[];
	const children: AgentSession[] = [];
	const models: MockModel[] = [];

	beforeEach(async () => {
		directory = TempDir.createSync("@pi-delegated-shunting-");
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing bundled test model");
		auth.setRuntimeApiKey(model.provider, "test-key");
		const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
		settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.prefetch.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"tools.approvalMode": "yolo",
			modelRoles: { task: `${model.provider}/${model.id}`, smol: `${model.provider}/${model.id}` },
		});
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [workerDefinition], projectAgentsDir: null });
		workerResponses = [];
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			// Keep the executor, SDK session, built-in tools, yield extraction and
			// cleanup real. Only the provider transport is replaced with a script.
			const created = await createRealSession({
				...options,
				agentDir: directory.path(),
				authStorage: auth,
				modelRegistry: registry,
				model,
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				skipPythonPreflight: true,
				disableExtensionDiscovery: true,
				preloadedExtensionPaths: [],
				preloadedCustomToolPaths: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			const scripted = createMockModel({ responses: workerResponses });
			created.session.agent.streamFn = scripted.stream;
			vi.spyOn(created.session, "dispose");
			models.push(scripted);
			children.push(created.session);
			return created;
		});
		tool = await TaskTool.create({
			cwd: directory.path(),
			hasUI: false,
			settings,
			modelRegistry: registry,
			agentOutputManager: new AgentOutputManager(() => null),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
	});

	afterEach(async () => {
		for (const child of children.splice(0)) await child.dispose();
		models.splice(0);
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		auth.close();
		directory.removeSync();
	});

	async function dispatch(assignment: string, evidenceDigest?: { paths: string[]; question: string }) {
		const parentModel = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "delegate",
							name: "task",
							arguments: {
								agent: "task",
								id: "ShuntingWorker",
								assignment,
								model: "pi/task",
								...(evidenceDigest ? { evidenceDigest } : {}),
							},
						},
					],
				},
				{ content: ["Delegated work received."] },
			],
		});
		const parent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: parentModel.model,
				systemPrompt: ["Delegate the assignment."],
				tools: [
					{
						name: tool.name,
						label: tool.label,
						description: tool.description,
						parameters: tool.parameters,
						execute: tool.execute.bind(tool),
					},
				],
				messages: [],
			},
			streamFn: parentModel.stream,
		});
		await parent.prompt("Execute the delegated assignment.");
		const result = parent.state.messages.find(
			message => message.role === "toolResult" && message.toolCallId === "delegate",
		);
		expect(result).toBeDefined();
		if (result?.role !== "toolResult") throw new Error("Missing task result");
		if (result.isError) throw new Error(JSON.stringify(result));
		expect(result.isError).not.toBe(true);
		return { parent, result, parentModel };
	}

	it("deserializes the actual evidence request and rejects missing or malformed fields before allocation", async () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false });
		const base = { agent: "task", assignment: "Inspect the fixture.", model: "pi/task" };
		const valid = schema(
			JSON.parse(
				JSON.stringify({ ...base, evidenceDigest: { paths: ["fixture.txt"], question: "What is present?" } }),
			),
		);
		expect(valid instanceof type.errors).toBe(false);
		for (const evidenceDigest of [
			{ paths: ["fixture.txt"] },
			{ question: "What?" },
			{ paths: [], question: "What?" },
			{ paths: [42], question: "What?" },
			{ paths: ["fixture.txt"], question: "" },
			{ paths: ["fixture.txt"], question: 42 },
		]) {
			const invalid = schema({ ...base, evidenceDigest });
			expect(invalid instanceof type.errors).toBe(true);
			if (!(invalid instanceof type.errors)) throw new Error("Expected explicit schema errors");
			expect(invalid.summary).toContain("evidenceDigest");
		}
		for (const evidenceDigest of [
			{ paths: [], question: "What?" },
			{ paths: [""], question: "What?" },
			{ paths: [" "], question: "What?" },
			{ paths: ["fixture.txt"], question: "" },
			{ paths: ["fixture.txt"], question: " " },
		]) {
			const rejected = await tool.execute("invalid-digest", { ...base, evidenceDigest });
			expect(JSON.stringify(rejected.content)).toContain(
				"evidenceDigest requires non-empty paths and an exact question",
			);
		}
		const incompatible = await tool.execute("fork-digest", {
			...base,
			fork: true,
			evidenceDigest: { paths: ["fixture.txt"], question: "What?" },
		});
		expect(JSON.stringify(incompatible.content)).toContain("evidenceDigest requires a fresh spawn");
		expect(children).toHaveLength(0);
	});

	it("routes pi/task and keeps an actual 450-line worker read out of parent messages and provider context", async () => {
		const fixture = path.join(directory.path(), "fixture.txt");
		const lines = Array.from({ length: 450 }, (_, i) => `FIXTURE_TOKEN_LINE_${i + 1}`);
		await Bun.write(fixture, `${lines.join("\n")}\n`);
		const digest = { facts: ["The fixture contains 450 synthetic lines."], citations: [`${fixture}:50-400`] };
		workerResponses.push(
			{ content: [{ type: "toolCall", name: "read", arguments: { path: `${fixture}:1-450` } }] },
			{ content: [{ type: "toolCall", name: "yield", arguments: { result: { data: digest } } }] },
		);
		const { parent, parentModel, result } = await dispatch("Inspect the fixture and return a concise cited digest.", {
			paths: [fixture],
			question: "How many synthetic lines are present?",
		});
		expect(children).toHaveLength(1);
		expect(sdk.createAgentSession).toHaveBeenCalledWith(
			expect.objectContaining({
				model: expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
			}),
		);
		expect(children[0]!.model?.id).toBe("claude-sonnet-4-5");
		const workerContext = JSON.stringify(children[0]!.state.messages);
		for (const index of [50, 200, 400, 450]) expect(workerContext).toContain(`FIXTURE_TOKEN_LINE_${index}`);
		expect(
			children[0]!.state.messages.some(
				message => message.role === "toolResult" && message.toolName === "read" && !message.isError,
			),
		).toBe(true);
		expect(JSON.stringify(result.content)).toContain(digest.facts[0]);
		const parentContext = JSON.stringify({
			turns: parent.state.messages,
			requests: parentModel.calls.map(call => call.context.messages),
		});
		for (const line of lines.slice(49, 400)) expect(parentContext).not.toContain(line);
		expect(parentContext).not.toContain("FIXTURE_TOKEN_LINE_");
		expect(models[0]!.calls.length).toBeGreaterThanOrEqual(2);
	}, 30_000);

	it("writes a real 100-line generated file and returns the compliant worker receipt without source", async () => {
		const target = path.join(directory.path(), "generated.ts");
		const body = `${Array.from({ length: 100 }, (_, i) => `export function generated_${i}() { return ${i}; }`).join("\n")}\n`;
		const receipt = { files_written: [target], line_count: 100, checks_run: [], unresolved_issues: [] };
		workerResponses.push(
			{ content: [{ type: "toolCall", name: "write", arguments: { path: target, content: body } }] },
			{ content: [{ type: "toolCall", name: "yield", arguments: { result: { data: receipt } } }] },
		);
		const { parent, result } = await dispatch("Write the generated module and yield only its execution receipt.");
		expect(await Bun.file(target).text()).toBe(body);
		const returned = JSON.stringify(result.content);
		for (const key of Object.keys(receipt)) expect(returned).toContain(key);
		expect(returned).not.toContain("```");
		expect(JSON.stringify(parent.state.messages)).not.toContain("export function generated_");
	}, 30_000);

	it("parks and disposes a completed task automatically after its configured idle TTL", async () => {
		settings.set("task.agentIdleTtlMs", 50);
		workerResponses.push({
			content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { facts: ["Completed."] } } } }],
		});
		await dispatch("Return the completion fact.");
		const child = children[0]!;
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		expect(lifecycle.has("ShuntingWorker")).toBe(true);
		const deadline = Date.now() + 5000;
		while (registry.get("ShuntingWorker")?.status !== "parked" && Date.now() < deadline) await Bun.sleep(10);
		expect(child.dispose).toHaveBeenCalledTimes(1);
		expect(child.isStreaming).toBe(false);
		expect(registry.get("ShuntingWorker")?.status).toBe("parked");
		expect(registry.get("ShuntingWorker")?.session).toBeNull();
		expect(lifecycle.isParking("ShuntingWorker")).toBe(false);
	}, 30_000);

	it("disposes a completed in-process helper on explicit keep-alive opt-out", async () => {
		workerResponses.push({
			content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { status: "complete" } } } }],
		});
		await dispatch("Return a completion receipt.");
		const child = children[0]!;
		expect(child.isStreaming).toBe(false);
		expect(AgentRegistry.global().get("ShuntingWorker")?.status).toBe("idle");
		expect(child.dispose).not.toHaveBeenCalled();
		const dispose = vi.spyOn(child, "dispose");
		await finalizeSubagentLifecycle({
			id: "ShuntingWorker",
			session: child,
			aborted: false,
			keepAlive: false,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
		});
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(AgentRegistry.global().get("ShuntingWorker")).toBeUndefined();
	}, 30_000);
});
