import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const modelFixtures: TaskModelFixture[] = [];

function createSession(options: {
	manager: AsyncJobManager;
	settings?: Record<string, unknown>;
	spawns?: string | boolean;
	cwd?: string;
}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": true, ...options.settings });
	const fixture = createTaskModelFixture(settings);
	modelFixtures.push(fixture);
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		settings,
		modelRegistry: fixture.modelRegistry,
		getActiveModel: fixture.getActiveModel,
		getActiveModelString: fixture.getActiveModelString,
		getActiveModelSelector: fixture.getActiveModelSelector,
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function resultFor(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agents: AgentDefinition[] = [taskAgent]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

describe("task async preflight", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const fixture of modelFixtures.splice(0)) fixture.close();
	});

	function manager(): AsyncJobManager {
		const result = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(result);
		return result;
	}

	it.each([
		{
			name: "Unknown",
			params: { agent: "missing", name: "Unknown", task: "Work." },
			expectation: 'Unknown agent "missing"',
		},
		{
			name: "Disabled",
			params: { agent: "task", name: "Disabled", task: "Work." },
			settings: { "task.disabledAgents": ["task"] },
			expectation: 'Agent "task" is disabled',
		},
		{
			name: "Disallowed",
			params: { agent: "task", name: "Disallowed", task: "Work." },
			spawns: "scout",
			expectation: "Cannot spawn 'task'",
		},
	])(
		"returns $name policy errors before registering an async job",
		async ({ name, params, settings, spawns, expectation }) => {
			mockDiscovery();
			const jobs = manager();
			const tool = await TaskTool.create(createSession({ manager: jobs, settings, spawns }));

			const result = await tool.execute("preflight", params as TaskParams);

			expect(textOf(result)).toContain(expectation);
			expect(jobs.getJob(name)).toBeUndefined();
		},
	);

	it("rejects an invalid async batch atomically before dispatching any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(createSession({ manager: jobs, settings: { "task.batch": true } }));

		const result = await tool.execute("mixed-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "AlsoInvalid", agent: "also-missing", task: "Do more invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		const text = textOf(result);
		expect(text).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(text).toContain('Task AlsoInvalid failed preflight: Unknown agent "also-missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("AlsoInvalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});

	it("rejects an invalid synchronous batch before running any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(
			createSession({ manager: jobs, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("sync-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		expect(textOf(result)).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});

	it("names the searched agent directories, home-shortened, when the agent is unknown", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unknown-agent-"));
		try {
			const projectDir = path.join(home, "project");
			await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
			vi.spyOn(os, "homedir").mockReturnValue(home);
			const tool = await TaskTool.create(createSession({ manager: manager(), cwd: projectDir }));

			const result = await tool.execute("unknown", {
				agent: "missing",
				name: "Unknown",
				task: "Work.",
			} as TaskParams);

			const text = textOf(result);
			// shortenPath renders home paths as portable `~/…` on every platform.
			expect(text).toContain("Searched: ~/project/.omp/agents");
			expect(text).not.toContain(home);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	});

	it("serves a task item's configured custom role at its fixed requested effort", async () => {
		mockDiscovery();
		const requests: Array<{ model: string; reasoning_effort?: string }> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push((await request.json()) as (typeof requests)[number]);
				return new Response(
					`data: ${JSON.stringify({
						id: "item-result",
						object: "chat.completion.chunk",
						created: 0,
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: "item-yield",
											type: "function",
											function: { name: "yield", arguments: '{"data":{"completed":true}}' },
										},
									],
								},
							},
						],
					})}\n\n` +
						`data: ${JSON.stringify({
							id: "item-result",
							object: "chat.completion.chunk",
							created: 0,
							choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						})}\n\ndata: [DONE]\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		const sessions: AgentSession[] = [];
		try {
			const jobs = manager();
			const session = createSession({
				manager: jobs,
				settings: {
					"async.enabled": false,
					"task.batch": true,
					"compaction.enabled": false,
					"todo.enabled": false,
					enabledModels: ["routing-test/*"],
					modelRoles: { "project-review": "routing-test/primary" },
				},
			});
			const fixture = createTaskModelFixture(session.settings, { baseUrl: `${server.url.origin}/v1` });
			modelFixtures.push(fixture);
			session.modelRegistry = fixture.modelRegistry;
			session.getActiveModel = fixture.getActiveModel;
			session.getActiveModelString = fixture.getActiveModelString;
			session.getActiveModelSelector = fixture.getActiveModelSelector;
			const createAgentSession = sdk.createAgentSession;
			vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
				if (!options) throw new Error("Expected child session options");
				const created = await createAgentSession({
					...options,
					agentDir: options.cwd,
					disableExtensionDiscovery: true,
					extensions: [],
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					preloadedCustomToolPaths: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					toolNames: ["yield"],
					restrictToolNames: true,
				});
				sessions.push(created.session);
				return created;
			});
			const tool = await TaskTool.create(session);
			const result = await tool.execute("per-call-model", {
				context: "Shared context.",
				tasks: [{ name: "Router", agent: "task", task: "Do the work.", model: "@project-review:high" }],
			} as TaskParams);
			expect(result.isError).not.toBe(true);
			expect(requests.map(body => [body.model, body.reasoning_effort])).toEqual([["primary", "high"]]);
		} finally {
			await Promise.all(sessions.map(child => child.dispose()));
			server.stop(true);
		}
	});

	it("rejects an unauthorized batch item atomically without registering otherwise valid siblings", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(createSession({ manager: jobs, settings: { "task.batch": true } }));
		const result = await tool.execute("unauthorized-model", {
			context: "Shared context.",
			tasks: [
				{ name: "Valid", task: "Allowed work.", model: "@default" },
				{ name: "Denied", task: "Unauthorized work.", model: "routing-test/unassigned" },
			],
		} as TaskParams);
		expect(textOf(result)).toContain("not authorized");
		expect(result.isError).toBe(true);
		expect(register).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects an ambiguous per-call model before dispatching the item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const tool = await TaskTool.create(
			createSession({ manager: jobs, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("ambiguous-model", {
			context: "Shared context.",
			tasks: [{ name: "Ambiguous", agent: "task", task: "Do the work.", model: "default" }],
		} as TaskParams);

		expect(textOf(result)).toContain('"@default"');
		expect(runSubprocess).not.toHaveBeenCalled();
	});
});
