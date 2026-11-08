import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const deliveryGuidance = "Results auto-deliver; NEVER poll.";
const sessions: AgentSession[] = [];
const roots: TempDir[] = [];
const stores: ModelRegistry[] = [];
const releases: Array<() => void> = [];

const taskWrapper: ExtensionFactory = pi => {
	const parameters = type({ name: "string", task: "string" });
	pi.registerTool({
		name: "task",
		label: "Delegated inspection",
		description: "Inspect the named target through a native worker.",
		parameters,
		async execute(_id, args, _signal, _onUpdate, ctx) {
			if (!ctx.invokeTool) throw new Error("Native Task delegation is unavailable");
			return ctx.invokeTool(parameters.assert(args));
		},
	});
};

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const session of sessions.splice(0)) {
		await Promise.all(session.asyncJobManager?.getAllJobs().map(job => job.promise) ?? []);
		await session.dispose();
	}
	vi.restoreAllMocks();
	for (const registry of stores.splice(0)) registry.authStorage.close();
	for (const root of roots.splice(0)) root.removeSync();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

function text(message: Pick<ToolResultMessage, "content">): string {
	return message.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

function taskResults(messages: AgentMessage[]): ToolResultMessage[] {
	return messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "task",
	);
}

async function harness(options: Partial<CreateAgentSessionOptions> = {}, inline = "off") {
	const root = TempDir.createSync("@pi-task-guidance-");
	roots.push(root);
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(auth);
	stores.push(modelRegistry);
	const gate = Promise.withResolvers<void>();
	releases.push(gate.resolve);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Task worker", systemPrompt: "Worker", source: "bundled" }],
		projectAgentsDir: null,
	});
	const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		await gate.promise;
		return {
			index: 0,
			id: options.id ?? "worker",
			agent: "task",
			agentSource: "bundled",
			task: "Inspect",
			assignment: "Inspect",
			exitCode: 0,
			output: "Finished",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		} satisfies SingleResult;
	});
	const mock = createMockModel({
		responses: [
			{
				content: ["first", "second"].map(id => ({
					type: "toolCall" as const,
					id,
					name: "task",
					arguments: { agent: "task", name: id, task: "Inspect" },
				})),
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "Spawned" }], stopReason: "stop" },
		],
	});
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry,
		model: mock,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated({
			"async.enabled": true,
			"task.batch": false,
			inlineToolDescriptors: inline,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["task", "wait"],
		...options,
	});
	sessions.push(session);
	const requests: Array<Pick<Context, "messages" | "systemPrompt"> & { taskDescription: string }> = [];
	session.agent.streamFn = (model, context, streamOptions) => {
		requests.push({
			messages: structuredClone(context.messages),
			systemPrompt: context.systemPrompt?.slice(),
			taskDescription: context.tools?.find(tool => tool.name === "task")?.description ?? "",
		});
		return mock.stream(model, context, streamOptions);
	};
	return { session, requests, mock, runSubprocess };
}

describe("SDK async task guidance", () => {
	it.each([false, true])("reports atomic preflight rejection through the SDK (batch=%s)", async batch => {
		const { session } = await harness({
			settings: Settings.isolated({ "async.enabled": true, "task.batch": batch }),
		});
		const task = session.getToolByName("task")!;
		const register = vi.spyOn(session.asyncJobManager!, "register");
		const result = await task.execute(
			"sdk-rejected",
			batch
				? {
						context: "Shared",
						tasks: [
							{ agent: "task", name: "valid", task: "Work" },
							{ agent: "missing", name: "invalid", task: "Work" },
						],
					}
				: { agent: "missing", name: "invalid", task: "Work" },
		);
		expect(result.isError).toBe(true);
		expect((result.details as TaskToolDetails).dispatchOutcome).toBe("rejected-before-dispatch");
		expect(register).not.toHaveBeenCalled();
		expect(executorModule.runSubprocess).not.toHaveBeenCalled();
	});

	it("leaves a successfully scheduled task unclassified", async () => {
		const { session } = await harness();
		const result = await session.getToolByName("task")!.execute("sdk-accepted", {
			agent: "task",
			name: "worker",
			task: "Work",
		});
		expect((result.details as TaskToolDetails).dispatchOutcome).toBeUndefined();
		expect((result.details as TaskToolDetails).async?.state).toBe("running");
	});

	it("keeps reused non-speculative call IDs unknown after another dispatch", async () => {
		const { session } = await harness();
		const task = session.getToolByName("task")!;
		await task.execute("reused", { agent: "task", name: "worker", task: "Work" });
		const rejected = await task.execute("reused", { agent: "missing", name: "invalid", task: "Work" });
		expect(rejected.isError).toBe(true);
		expect((rejected.details as TaskToolDetails).dispatchOutcome).toBeUndefined();
	});

	it("keeps concurrent executions with the same call ID unknown", async () => {
		const { session } = await harness();
		const task = session.getToolByName("task")!;
		const running = task.execute("concurrent", { agent: "task", name: "worker", task: "Work" });
		const rejected = await task.execute("concurrent", { agent: "missing", name: "invalid", task: "Work" });
		expect(rejected.isError).toBe(true);
		expect((rejected.details as TaskToolDetails).dispatchOutcome).toBeUndefined();
		await running;
	});

	it("does not classify a job registration failure as a pre-dispatch rejection", async () => {
		const { session } = await harness();
		vi.spyOn(session.asyncJobManager!, "register").mockImplementation(() => {
			throw new Error("registration failed");
		});
		const result = await session.getToolByName("task")!.execute("sdk-registration-error", {
			agent: "task",
			name: "worker",
			task: "Work",
		});
		expect((result.details as TaskToolDetails).dispatchOutcome).toBeUndefined();
		expect(result.content.some(part => part.type === "text" && part.text.includes("registration failed"))).toBe(true);
	});

	it("does not classify a settled child failure as a pre-dispatch rejection", async () => {
		const { session, runSubprocess } = await harness({
			settings: Settings.isolated({ "async.enabled": false, "task.batch": false }),
		});
		runSubprocess.mockResolvedValue({
			index: 0,
			id: "worker",
			agent: "task",
			agentSource: "bundled",
			task: "Work",
			assignment: "Work",
			exitCode: 1,
			error: "child failed",
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		});
		const result = await session.getToolByName("task")!.execute("sdk-child-error", {
			agent: "task",
			name: "worker",
			task: "Work",
		});
		expect((result.details as TaskToolDetails).dispatchOutcome).toBeUndefined();
		expect((result.details as TaskToolDetails).results[0]?.error).toBe("child failed");
	});

	it("preserves the native lifecycle contract through a wrapper with its own input schema", async () => {
		const { session, requests } = await harness({
			systemPrompt: "Inspect the requested files.",
			extensions: [taskWrapper],
		});
		await session.prompt("Delegate two independent inspections");
		expect(taskResults(requests[1].messages).map(text)).toEqual([
			"Spawned agent `first` (job `first`).",
			"Spawned agent `second` (job `second`).",
		]);
		const description = requests[1].taskDescription;
		expect(description).toContain("Inspect the named target");
		expect(description).toContain(deliveryGuidance);
		expect(description).toContain("without consuming delivery");
		expect(description).toContain("proc://<id>/kill");
		expect(description).not.toContain("`solutionSpace`");
	});

	it.each(["off", "on"])(
		"sends guidance once through descriptors without repeating it in results (inline=%s)",
		async inline => {
			const { session, requests, mock } = await harness({}, inline);
			await session.prompt("Delegate two independent inspections");
			const sent = taskResults(requests[1].messages);
			expect(sent.map(text)).toEqual([
				"Spawned agent `first` (job `first`).",
				"Spawned agent `second` (job `second`).",
			]);
			for (const request of requests) {
				const instructions = inline === "on" ? request.systemPrompt?.join("\n") : request.taskDescription;
				expect(instructions?.split(deliveryGuidance).length).toBe(2);
			}
			mock.push(() => ({
				content: [{ type: "toolCall", id: "third", name: "task", arguments: { name: "third", task: "Inspect" } }],
				stopReason: "toolUse",
			}));
			mock.push(() => ({ content: [{ type: "text", text: "Spawned" }], stopReason: "stop" }));
			await session.prompt("Inspect one more file");
			expect(taskResults(requests[3].messages).map(text)).toEqual([
				...sent.map(text),
				"Spawned agent `third` (job `third`).",
			]);
		},
	);
});
