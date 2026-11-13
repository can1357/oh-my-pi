import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory, RegisteredTaskObservation } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type CreateAgentSessionOptions, type CustomTool } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
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

async function harness(
	options: Partial<CreateAgentSessionOptions> = {},
	inline = "off",
	callName = "task",
	callArgs: Record<string, unknown> = { agent: "task", task: "Inspect" },
) {
	const root = TempDir.createSync("@pi-task-guidance-");
	roots.push(root);
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(auth);
	stores.push(modelRegistry);
	const gate = Promise.withResolvers<void>();
	releases.push(gate.resolve);
	const assignments: Array<string | undefined> = [];
	const started = Promise.withResolvers<void>();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [{ name: "task", description: "Task worker", systemPrompt: "Worker", source: "bundled" }],
		projectAgentsDir: null,
	});
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		assignments.push(options.assignment);
		if (assignments.length === 2) started.resolve();
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
					name: callName,
					arguments: { ...callArgs, name: id },
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
		sessionManager: SessionManager.create(root.path(), root.path()),
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
	const requests: Array<
		Pick<Context, "messages" | "systemPrompt"> & { taskDescription: string; toolNames: string[] }
	> = [];
	session.agent.streamFn = (model, context, streamOptions) => {
		requests.push({
			messages: structuredClone(context.messages),
			systemPrompt: context.systemPrompt?.slice(),
			taskDescription: context.tools?.find(tool => tool.name === "task")?.description ?? "",
			toolNames: context.tools?.map(tool => tool.name) ?? [],
		});
		return mock.stream(model, context, streamOptions);
	};
	return { session, requests, mock, assignments, started: started.promise, release: gate.resolve };
}

describe("SDK async task guidance", () => {
	it("grants only one named SDK tool a hidden native task in a restricted nine-tool session", async () => {
		const receipts: unknown[] = [];
		let untrustedCapability: boolean | undefined;
		const manager: CustomTool = {
			name: "manager_test",
			label: "Manager",
			description: "Delegate an inspection.",
			parameters: type({ agent: "string", name: "string", task: "string" }),
			async execute(_id, args, _onUpdate, ctx) {
				if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
				const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
				receipts.push(receipt.result.details);
				return receipt.result;
			},
		};
		const other: CustomTool = {
			name: "manager_untrusted",
			label: "Other",
			description: "Inspect authorization.",
			parameters: type({}),
			async execute(_id, _args, _onUpdate, ctx) {
				untrustedCapability = typeof ctx.invokeRegisteredTask === "function";
				return { content: [{ type: "text", text: "checked" }], details: {} };
			},
		};
		const extras: CustomTool[] = Array.from({ length: 7 }, (_, index) => ({
			name: `other_${index}`,
			label: `Other ${index}`,
			description: "Restricted test tool.",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "checked" }], details: {} };
			},
		}));
		const customTools = [manager, other, ...extras];
		const { session, requests } = await harness(
			{
				restrictToolNames: true,
				allowRestrictedCustomTools: true,
				toolNames: customTools.map(tool => tool.name),
				customTools,
				trustedTaskDelegationTools: ["manager_test"],
			},
			"off",
			"manager_test",
		);
		expect(session.getAllToolNames()).not.toContain("task");
		await session.setActiveToolsByName([...customTools.map(tool => tool.name), "Task"]);
		await session.setActiveToolPresentation([...customTools.map(tool => tool.name), "TASK"], []);
		expect(session.getEnabledToolNames()).not.toContain("task");
		expect(session.getToolForEvalBridge("Task")).toBeUndefined();
		await session.prompt("Delegate two inspections");
		expect(receipts).toHaveLength(2);
		expect(receipts).toEqual([
			expect.objectContaining({ async: expect.objectContaining({ state: "running" }) }),
			expect.objectContaining({ async: expect.objectContaining({ state: "running" }) }),
		]);
		expect(requests[0]?.toolNames).toHaveLength(9);
		expect(requests[0]?.toolNames).not.toContain("task");
		expect(session.getToolForEvalBridge("task")).toBeUndefined();
		await session.getToolForEvalBridge("manager_untrusted")?.execute("other", {});
		expect(untrustedCapability).toBe(false);
	});

	it.each(["task", "Task", "TASK"])("rejects a restricted SDK grant if %s is exposed to the model", async alias => {
		const manager: CustomTool = {
			name: "manager_test",
			label: "Manager",
			description: "Delegate an inspection.",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "checked" }], details: {} };
			},
		};
		await expect(
			harness({
				restrictToolNames: true,
				allowRestrictedCustomTools: true,
				toolNames: ["manager_test", alias],
				customTools: [manager],
				trustedTaskDelegationTools: ["manager_test"],
			}),
		).rejects.toThrow("不得暴露原生 task");
	});

	it.each(["not granted", "denied"])("keeps restricted SDK task %s", async mode => {
		let outcome = "";
		const manager: CustomTool = {
			name: "manager_test",
			label: "Manager",
			description: "Delegate an inspection.",
			parameters: type({ agent: "string", name: "string", task: "string" }),
			async execute(_id, args, _onUpdate, ctx) {
				try {
					if (!ctx.invokeRegisteredTask) throw new Error("not granted");
					await ctx.invokeRegisteredTask(args as Record<string, unknown>);
				} catch (error) {
					outcome = String(error);
				}
				return { content: [{ type: "text", text: "checked" }], details: {} };
			},
		};
		const { session } = await harness({
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			toolNames: ["manager_test"],
			customTools: [manager],
			...(mode === "denied" ? { trustedTaskDelegationTools: ["manager_test"] } : {}),
			settings: Settings.isolated({
				"async.enabled": true,
				"tools.approval": { task: "deny" },
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
		});
		await session.getToolForEvalBridge("manager_test")?.execute("outer", {
			agent: "task",
			name: "denied",
			task: "Inspect",
		});
		expect(outcome).toMatch(mode === "denied" ? /blocked by user policy/ : /not granted/);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(0);
	});

	it("rejects ungranted extensions before a native task is submitted", async () => {
		let capabilityPresent: boolean | undefined;
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Test manager task authorization.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, _args, _signal, _onUpdate, ctx) {
					capabilityPresent = typeof ctx.invokeRegisteredTask === "function";
					return {
						content: [{ type: "text", text: capabilityPresent ? "unexpected grant" : "not granted" }],
						details: {},
					};
				},
			});
		};
		const { session } = await harness(
			{ extensions: [manager], systemPrompt: "Test authorization." },
			"off",
			"manager_test",
		);
		await session.prompt("Check manager authorization");
		expect(capabilityPresent).toBe(false);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(0);
	});

	it("returns native background receipts to an explicitly granted extension", async () => {
		const receipts: Array<{ toolCallId: string; details: unknown }> = [];
		const observations: RegisteredTaskObservation[][] = [];
		const repeated: string[] = [];
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
					const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					receipts.push({ toolCallId: receipt.toolCallId, details: receipt.result.details });
					if (!ctx.queryRegisteredTask) throw new Error("missing task query");
					observations.push(ctx.queryRegisteredTask(_id));
					try {
						await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					} catch (error) {
						repeated.push(String(error));
					}
					return receipt.result;
				},
			});
		};
		const { session } = await harness(
			{
				extensions: [manager],
				trustedTaskDelegationExtensions: ["<inline-0>"],
				systemPrompt: "Test task dispatch.",
			},
			"off",
			"manager_test",
		);
		await session.prompt("Delegate two inspections");
		expect(receipts).toHaveLength(2);
		expect(repeated).toHaveLength(2);
		expect(repeated.every(message => message.includes("has already been used or ended"))).toBe(true);
		expect(receipts[0]?.toolCallId).not.toBe(receipts[1]?.toolCallId);
		expect(observations).toHaveLength(2);
		expect(
			observations.every(
				(items, index) =>
					items.length === 1 &&
					items[0]?.state === "observed" &&
					items[0]?.toolCallId === receipts[index]?.toolCallId &&
					items[0]?.jobs[0]?.status === "running",
			),
		).toBe(true);
		expect(receipts.map(receipt => receipt.details)).toEqual([
			expect.objectContaining({ async: expect.objectContaining({ state: "running", jobId: "first" }) }),
			expect.objectContaining({ async: expect.objectContaining({ state: "running", jobId: "second" }) }),
		]);
	});

	it.each(["volatile", "flush failure", "binding flush failure"])(
		"refuses dispatch on %s session storage",
		async mode => {
			const root = TempDir.createSync("@pi-task-storage-");
			roots.push(root);
			let failure = "";
			const manager: ExtensionFactory = pi => {
				pi.registerTool({
					name: "manager_test",
					label: "Manager",
					description: "Delegate an inspection.",
					parameters: type({ agent: "string", name: "string", task: "string" }),
					async execute(_id, args, _signal, _onUpdate, ctx) {
						try {
							if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
							await ctx.invokeRegisteredTask(args as Record<string, unknown>);
						} catch (error) {
							failure = String(error);
						}
						return { content: [{ type: "text", text: "checked" }], details: {} };
					},
				});
			};
			const { session } = await harness({
				extensions: [manager],
				trustedTaskDelegationExtensions: ["<inline-0>"],
				...(mode === "volatile" ? { sessionManager: SessionManager.inMemory(root.path()) } : {}),
			});
			if (mode !== "volatile") {
				const originalFlush = session.sessionManager.flush.bind(session.sessionManager);
				let calls = 0;
				vi.spyOn(session.sessionManager, "flush").mockImplementation(async () => {
					calls++;
					if (calls === (mode === "flush failure" ? 1 : 2)) throw new Error("disk failed");
					await originalFlush();
				});
			}
			const tool = session.getToolForEvalBridge("manager_test");
			expect(tool).toBeDefined();
			await tool?.execute("outer", { agent: "task", name: "storage", task: "Inspect" });
			expect(failure).toMatch(mode === "volatile" ? /可持久化/ : /disk failed/);
			expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(0);
		},
	);

	it("persists original identity before an outer tool returns without awaiting", async () => {
		let observations: RegisteredTaskObservation[] = [];
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
					void ctx.invokeRegisteredTask(args as Record<string, unknown>);
					return { content: [{ type: "text", text: "returned early" }], details: {} };
				},
			});
			pi.registerTool({
				name: "manager_query",
				label: "Query",
				description: "Query the original call.",
				parameters: type({ outer: "string" }),
				async execute(_id, _args, _signal, _onUpdate, ctx) {
					if (!ctx.queryRegisteredTask) throw new Error("missing query grant");
					observations = ctx.queryRegisteredTask("outer-early");
					return { content: [{ type: "text", text: "queried" }], details: {} };
				},
			});
		};
		const { session } = await harness({ extensions: [manager], trustedTaskDelegationExtensions: ["<inline-0>"] });
		const tool = session.getToolForEvalBridge("manager_test");
		const query = session.getToolForEvalBridge("manager_query");
		expect(tool).toBeDefined();
		expect(query).toBeDefined();
		let failure: unknown;
		try {
			await tool?.execute("outer-early", { agent: "task", name: "early", task: "Inspect" });
		} catch (error) {
			failure = error;
		}
		await query?.execute("query", { outer: "outer-early" });
		expect(observations).toHaveLength(1);
		if (failure instanceof Error) expect(failure.message).toContain(observations[0]?.toolCallId ?? "missing");
		expect(["unknown", "observed"]).toContain(observations[0]?.state);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(observations[0]?.state === "observed" ? 1 : 0);
		const originalCallId = observations[0]?.toolCallId;
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await session.dispose();
		sessions.splice(sessions.indexOf(session), 1);
		const reopened = await SessionManager.open(sessionFile);
		const restored = await harness({
			sessionManager: reopened,
			extensions: [manager],
			trustedTaskDelegationExtensions: ["<inline-0>"],
		});
		observations = [];
		await restored.session
			.getToolForEvalBridge("manager_query")
			?.execute("query-after-restart", { outer: "outer-early" });
		expect(observations).toEqual([expect.objectContaining({ toolCallId: originalCallId, state: "unknown" })]);
	});

	it("preserves the native call identity when a later batch job registration fails", async () => {
		let failure: unknown;
		let observations: RegisteredTaskObservation[] = [];
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate a batch inspection.",
				parameters: type({
					context: "string",
					tasks: type({ name: "string", task: "string" }).array(),
				}),
				async execute(id, args, _signal, _onUpdate, ctx) {
					try {
						if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
						await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					} catch (error) {
						failure = error;
					}
					if (!ctx.queryRegisteredTask) throw new Error("missing task query");
					observations = ctx.queryRegisteredTask(id);
					return { content: [{ type: "text", text: "checked" }], details: {} };
				},
			});
		};
		const { session, release } = await harness({
			extensions: [manager],
			trustedTaskDelegationExtensions: ["<inline-0>"],
			settings: Settings.isolated({
				"async.enabled": true,
				"task.batch": true,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
			}),
		});
		const asyncManager = session.asyncJobManager;
		if (!asyncManager) throw new Error("missing async job manager");
		const originalRegister = asyncManager.register.bind(asyncManager);
		let registrationCount = 0;
		vi.spyOn(asyncManager, "register").mockImplementation((...args) => {
			registrationCount++;
			if (registrationCount === 2) throw new Error("second registration failed");
			return originalRegister(...args);
		});
		await session.getToolForEvalBridge("manager_test")?.execute("outer-partial", {
			context: "Inspect both targets",
			tasks: [
				{ name: "first", task: "Inspect one" },
				{ name: "second", task: "Inspect two" },
			],
		});
		expect(failure).toBeDefined();
		if (
			!failure ||
			typeof failure !== "object" ||
			!("toolCallId" in failure) ||
			typeof failure.toolCallId !== "string"
		) {
			throw new Error("missing original call ID");
		}
		const failureToolCallId = failure.toolCallId;
		expect(failureToolCallId).toMatch(/^extension-task-/);
		expect(observations).toEqual([
			expect.objectContaining({
				toolCallId: failureToolCallId,
				jobIds: ["first", "second"],
				state: "unknown",
				jobs: [
					{ id: "first", status: expect.not.stringMatching(/^unknown$/) },
					{ id: "second", status: "unknown" },
				],
			}),
		]);
		release();
	});

	it("reserves distinct final job IDs when an existing job and parallel calls share a name", async () => {
		const receipts: Array<{ toolCallId: string; details: unknown; observations: RegisteredTaskObservation[] }> = [];
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(id, args, _signal, _onUpdate, ctx) {
					if (!ctx.invokeRegisteredTask || !ctx.queryRegisteredTask) throw new Error("missing task grant");
					const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					receipts.push({
						toolCallId: receipt.toolCallId,
						details: receipt.result.details,
						observations: ctx.queryRegisteredTask(id),
					});
					return receipt.result;
				},
			});
		};
		const { session } = await harness({ extensions: [manager], trustedTaskDelegationExtensions: ["<inline-0>"] });
		const occupied = Promise.withResolvers<void>();
		releases.push(occupied.resolve);
		session.asyncJobManager?.register(
			"bash",
			"occupied",
			async () => {
				await occupied.promise;
				return "finished";
			},
			{ id: "same" },
		);
		const tool = session.getToolForEvalBridge("manager_test");
		if (!tool) throw new Error("manager tool unavailable");
		await Promise.all([
			tool.execute("outer-a", { agent: "task", name: "same", task: "Inspect" }),
			tool.execute("outer-b", { agent: "task", name: "same", task: "Inspect" }),
		]);
		expect(receipts).toHaveLength(2);
		const ids = receipts.map(receipt => receipt.observations[0]?.jobIds[0]);
		expect(new Set(ids).size).toBe(2);
		expect(ids).not.toContain("same");
		for (const receipt of receipts) {
			const observation = receipt.observations[0];
			expect(observation?.state).toBe("observed");
			expect(observation?.jobs[0]?.status).toBe("running");
			expect(receipt.details).toEqual(
				expect.objectContaining({
					async: expect.objectContaining({ jobId: observation?.jobIds[0] }),
				}),
			);
		}
	});

	it("recovers the persisted call-to-job binding without inferring state after restart", async () => {
		let observations: RegisteredTaskObservation[] = [];
		let originalCallId = "";
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
					const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					originalCallId = receipt.toolCallId;
					return receipt.result;
				},
			});
			pi.registerTool({
				name: "manager_query",
				label: "Query",
				description: "Query the original call.",
				parameters: type({ outer: "string" }),
				async execute(_id, _args, _signal, _onUpdate, ctx) {
					if (!ctx.queryRegisteredTask) throw new Error("missing query grant");
					observations = ctx.queryRegisteredTask("outer-started");
					return { content: [{ type: "text", text: "queried" }], details: {} };
				},
			});
		};
		const first = await harness({ extensions: [manager], trustedTaskDelegationExtensions: ["<inline-0>"] });
		const sessionFile = first.session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("missing session file");
		await first.session.getToolForEvalBridge("manager_test")?.execute("outer-started", {
			agent: "task",
			name: "before-restart",
			task: "Inspect",
		});
		expect(originalCallId).toMatch(/^extension-task-/);
		first.release();
		await Promise.all(first.session.asyncJobManager?.getAllJobs().map(job => job.promise) ?? []);
		await first.session.dispose();
		sessions.splice(sessions.indexOf(first.session), 1);
		const reopened = await SessionManager.open(sessionFile);
		const restored = await harness({
			sessionManager: reopened,
			extensions: [manager],
			trustedTaskDelegationExtensions: ["<inline-0>"],
		});
		await restored.session
			.getToolForEvalBridge("manager_query")
			?.execute("query-restarted", { outer: "outer-started" });
		expect(observations).toEqual([
			expect.objectContaining({
				toolCallId: originalCallId,
				state: "unknown",
				jobIds: ["before-restart"],
				jobs: [{ id: "before-restart", status: "unknown" }],
			}),
		]);
	});

	it.each(["before", "after"])(
		"keeps the original identity unknown after a process crash %s registration",
		async stage => {
			let observations: RegisteredTaskObservation[] = [];
			const root = TempDir.createSync("@pi-task-crash-");
			roots.push(root);
			const child = Bun.spawn(
				[process.execPath, "test", `${import.meta.dir}/fixtures/registered-task-crash-probe.ts`],
				{
					cwd: import.meta.dir,
					env: {
						...process.env,
						OMP_REGISTERED_TASK_PROBE_ROOT: root.path(),
						OMP_REGISTERED_TASK_PROBE_STAGE: stage,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			let sessionFile = "";
			try {
				const reader = child.stdout.getReader();
				const waitForMarker = async () => {
					let received = "";
					for (;;) {
						const next = await reader.read();
						if (next.done) throw new Error("隔离宿主未报告崩溃锚点");
						received += new TextDecoder().decode(next.value);
						const match = /PROBE_READY:([^\r\n]+)/.exec(received);
						if (match) return match[1]!;
					}
				};
				sessionFile = await Promise.race([
					waitForMarker(),
					// 子进程崩溃前可能无法发送锚点，真实超时负责终止并回收该进程。
					Bun.sleep(15_000).then(() => {
						throw new Error("隔离宿主等待锚点超时");
					}),
				]);
			} finally {
				child.kill("SIGKILL");
				await child.exited;
			}
			if (stage === "after") {
				const probeState = (await Bun.file(`${root.path()}/probe-state.json`).json()) as {
					parentSessionFile: string;
					sessionFiles: string[];
				};
				expect(probeState.parentSessionFile).toBe(sessionFile);
				expect(probeState.sessionFiles).toEqual([sessionFile]);
			}
			const manager: ExtensionFactory = pi => {
				pi.registerTool({
					name: "manager_query",
					label: "Query",
					description: "Query the original call.",
					parameters: type({}),
					async execute(_id, _args, _signal, _onUpdate, ctx) {
						if (!ctx.queryRegisteredTask) throw new Error("missing query grant");
						observations = ctx.queryRegisteredTask("outer-crash");
						return { content: [{ type: "text", text: "queried" }], details: {} };
					},
				});
			};
			const reopened = await SessionManager.open(sessionFile);
			const restored = await harness({
				sessionManager: reopened,
				extensions: [manager],
				trustedTaskDelegationExtensions: ["<inline-0>"],
			});
			await restored.session.getToolForEvalBridge("manager_query")?.execute("query-crashed", {});
			expect(observations).toHaveLength(1);
			expect(observations[0]?.toolCallId).toMatch(/^extension-task-/);
			expect(observations[0]?.state).toBe("unknown");
			// The candidate contract persists the call-to-job binding before
			// AsyncJobManager.register (task/index.ts reserveTaskJobIds path), so the
			// before-register crash window leaves the binding reconcilable; live job
			// state stays unknown either way.
			expect(observations[0]?.jobIds).toEqual(["crash-job"]);
		},
	);

	it("reconciles a started job by the original call when a result hook replaces its receipt", async () => {
		let failure: unknown;
		let observations: RegisteredTaskObservation[] = [];
		const manager: ExtensionFactory = pi => {
			pi.on("tool_result", event =>
				event.toolName === "task" ? { content: [{ type: "text", text: "rewritten" }] } : undefined,
			);
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(id, args, _signal, _onUpdate, ctx) {
					try {
						if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
						await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					} catch (error) {
						failure = error;
					}
					if (!ctx.queryRegisteredTask) throw new Error("missing query grant");
					observations = ctx.queryRegisteredTask(id);
					return { content: [{ type: "text", text: "checked" }], details: {} };
				},
			});
		};
		const { session } = await harness({ extensions: [manager], trustedTaskDelegationExtensions: ["<inline-0>"] });
		await session.getToolForEvalBridge("manager_test")?.execute("outer-hook", {
			agent: "task",
			name: "hook-job",
			task: "Inspect",
		});
		if (!failure || typeof failure !== "object" || !("toolCallId" in failure))
			throw new Error("missing original call ID");
		expect(observations).toEqual([
			expect.objectContaining({
				toolCallId: failure.toolCallId,
				state: "observed",
				jobIds: ["hook-job"],
				jobs: [{ id: "hook-job", status: "running" }],
			}),
		]);
	});

	it("propagates cancellation before a delegated task can spawn", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					controller.abort();
					try {
						if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
						await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					} catch {
						cancelled = true;
					}
					return { content: [{ type: "text", text: "checked" }], details: {} };
				},
			});
		};
		const { session } = await harness({
			extensions: [manager],
			trustedTaskDelegationExtensions: ["<inline-0>"],
		});
		const tool = session.getToolForEvalBridge("manager_test");
		expect(tool).toBeDefined();
		await tool?.execute("outer", { agent: "task", name: "cancelled", task: "Inspect" }, controller.signal);
		expect(cancelled).toBe(true);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(0);
	});

	it("retains the native call identity if cancellation races task dispatch", async () => {
		const controller = new AbortController();
		let observedCallId = "";
		let settledCallId = "";
		const manager: ExtensionFactory = pi => {
			pi.on("tool_call", event => {
				if (event.toolName === "task") {
					observedCallId = event.toolCallId;
					controller.abort();
				}
			});
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					try {
						if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
						const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
						settledCallId = receipt.toolCallId;
					} catch (error) {
						if (error && typeof error === "object" && "toolCallId" in error) {
							settledCallId = String(error.toolCallId);
						}
					}
					return { content: [{ type: "text", text: "checked" }], details: {} };
				},
			});
		};
		const { session } = await harness({
			extensions: [manager],
			trustedTaskDelegationExtensions: ["<inline-0>"],
		});
		const tool = session.getToolForEvalBridge("manager_test");
		expect(tool).toBeDefined();
		await tool?.execute("outer", { agent: "task", name: "cancel-race", task: "Inspect" }, controller.signal);
		expect(observedCallId).toMatch(/^extension-task-/);
		expect(settledCallId).toBe(observedCallId);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(0);
	});

	it("keeps the running receipt when cancellation arrives after task registration", async () => {
		const controller = new AbortController();
		let observedCallId = "";
		let receiptCallId = "";
		let receiptDetails: unknown;
		const manager: ExtensionFactory = pi => {
			pi.on("tool_result", event => {
				if (event.toolName === "task") {
					observedCallId = event.toolCallId;
					controller.abort();
				}
			});
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
					const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					receiptCallId = receipt.toolCallId;
					receiptDetails = receipt.result.details;
					return receipt.result;
				},
			});
		};
		const { session } = await harness({
			extensions: [manager],
			trustedTaskDelegationExtensions: ["<inline-0>"],
		});
		const tool = session.getToolForEvalBridge("manager_test");
		expect(tool).toBeDefined();
		await tool?.execute("outer", { agent: "task", name: "cancel-after", task: "Inspect" }, controller.signal);
		expect(observedCallId).toMatch(/^extension-task-/);
		expect(receiptCallId).toBe(observedCallId);
		expect(receiptDetails).toEqual(
			expect.objectContaining({
				async: expect.objectContaining({ state: "running", jobId: "cancel-after" }),
			}),
		);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(1);
	});

	it.each(["deny", "disabled", "rewritten", "mutated"])("does not spawn when native task is %s", async condition => {
		const failures: string[] = [];
		const manager: ExtensionFactory = pi => {
			if (condition === "rewritten") {
				pi.on("tool_call", event =>
					event.toolName === "task" ? { input: { ...event.input, task: "unapproved replacement" } } : undefined,
				);
			}
			if (condition === "mutated") {
				pi.on("tool_call", event => {
					if (event.toolName !== "task") return;
					event.input.task = "unapproved replacement";
					return { input: event.input };
				});
			}
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					try {
						if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
						await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					} catch (error) {
						failures.push(String(error));
					}
					return { content: [{ type: "text", text: "checked" }], details: {} };
				},
			});
		};
		const settings = Settings.isolated({
			"async.enabled": true,
			"tools.approval": condition === "deny" ? { task: "deny" } : {},
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const { session } = await harness(
			{
				extensions: [manager],
				trustedTaskDelegationExtensions: ["<inline-0>"],
				toolNames: condition === "disabled" ? ["wait"] : ["task", "wait"],
				settings,
			},
			"off",
			"manager_test",
		);
		await session.prompt("Attempt task dispatch");
		expect(failures).toHaveLength(2);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(0);
	});

	it("fails closed without creating jobs when delegated input misses the native task contract", async () => {
		const root = TempDir.createSync("@pi-task-restricted-");
		roots.push(root);
		const restrictedFile = `${root.path()}/restricted/brief.md`;
		await Bun.write(restrictedFile, "restricted assignment");
		const receipts: unknown[] = [];
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate a file-backed inspection.",
				parameters: type({ agent: "string", name: "string", taskFile: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
					const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					receipts.push(receipt.result);
					return receipt.result;
				},
			});
		};
		const { session } = await harness(
			{
				extensions: [manager],
				trustedTaskDelegationExtensions: ["<inline-0>"],
				settings: Settings.isolated({
					"async.enabled": true,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
				}),
			},
			"off",
			"manager_test",
			{ agent: "task", taskFile: restrictedFile },
		);
		await session.prompt("Attempt restricted task file");
		expect(receipts).toHaveLength(2);
		expect(
			receipts.every(receipt => {
				const result = receipt as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
				return (
					result.isError === true &&
					(result.content ?? []).some(part => part.type === "text" && /Missing `tasks?`/.test(part.text ?? ""))
				);
			}),
		).toBe(true);
		expect(session.asyncJobManager?.getAllJobs() ?? []).toHaveLength(0);
	});

	it("delivers inline instructions through the native approval binding", async () => {
		const receipts: unknown[] = [];
		const manager: ExtensionFactory = pi => {
			pi.registerTool({
				name: "manager_test",
				label: "Manager",
				description: "Delegate an inline inspection.",
				parameters: type({ agent: "string", name: "string", task: "string" }),
				async execute(_id, args, _signal, _onUpdate, ctx) {
					if (!ctx.invokeRegisteredTask) throw new Error("missing task grant");
					const receipt = await ctx.invokeRegisteredTask(args as Record<string, unknown>);
					receipts.push(receipt.result.details);
					return receipt.result;
				},
			});
		};
		const { session, assignments, started } = await harness(
			{
				extensions: [manager],
				trustedTaskDelegationExtensions: ["<inline-0>"],
				settings: Settings.isolated({
					"async.enabled": true,
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
				}),
			},
			"off",
			"manager_test",
			{ agent: "task", task: "file-backed assignment" },
		);
		await session.prompt("Delegate file-backed inspections");
		await started;
		expect(receipts).toHaveLength(2);
		expect(receipts).toEqual([
			expect.objectContaining({ async: expect.objectContaining({ state: "running" }) }),
			expect.objectContaining({ async: expect.objectContaining({ state: "running" }) }),
		]);
		expect(assignments).toEqual(["file-backed assignment", "file-backed assignment"]);
	});
	it("preserves the native lifecycle contract through a wrapper with its own input schema", async () => {
		const { session, requests } = await harness({
			systemPrompt: "Inspect the requested files.",
			extensions: [taskWrapper],
		});
		await session.prompt("Delegate two independent inspections");
		const [first, second] = taskResults(requests[1].messages).map(text);
		expect(first).toStartWith("Spawned agent `first` (job `first`).");
		expect(first).toContain("proc://<id>/kill");
		expect(second).toBe("Spawned agent `second` (job `second`).");
		const description = requests[1].taskDescription;
		expect(description).toContain("Inspect the named target");
		expect(description).toContain(deliveryGuidance);
		expect(description).not.toContain("proc://");
		expect(description).not.toContain("`solutionSpace`");
	});

	it.each(["off", "on"])(
		"sends the delivery rule once through descriptors and the job lifecycle with the first spawn result (inline=%s)",
		async inline => {
			const { session, requests, mock } = await harness({}, inline);
			await session.prompt("Delegate two independent inspections");
			const sent = taskResults(requests[1].messages);
			expect(sent.map(text).filter(result => result.includes("without consuming delivery"))).toHaveLength(1);
			expect(sent.map(text)[1]).toBe("Spawned agent `second` (job `second`).");
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
