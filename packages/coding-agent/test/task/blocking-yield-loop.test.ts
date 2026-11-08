/**
 * Contract: a message delivered while a blocking call runs reaches the model
 * as soon as `wait` would deliver it, not when the call returns.
 *
 * Driven through the real agent loop: a queued aside (the delivery path peer
 * messages such as envoy use) arrives while a `task` call waits on a child
 * whose agent declares `blocking: true`, or while an `ask` dialog is open.
 * The model's next request must carry the aside while the child still runs /
 * the question is still unanswered, and the work must keep going as a
 * background job whose result arrives on its own. Before the fix the call
 * held the aside until the child finished or the user answered, so the
 * safety deadline below fired first.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type AgentMessage, type AgentTool, type AgentToolContext, agentLoop } from "@oh-my-pi/pi-agent-core";
import type { AgentLoopConfig } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAskDialogResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const ASIDE = "peer: the schema changed, re-plan";

const blockingAgent: AgentDefinition = {
	name: "slowworker",
	description: "Blocking worker",
	systemPrompt: "You are a worker.",
	source: "project",
	blocking: true,
};

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "slowworker",
		agentSource: "project",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

/** A queued aside that the loop peeks while tools run and injects at the next boundary. */
function asideQueue(): Pick<AgentLoopConfig, "hasQueuedAsides" | "getAsideMessages"> & { queue: () => void } {
	let queued = false;
	return {
		queue: () => {
			queued = true;
		},
		hasQueuedAsides: () => queued,
		getAsideMessages: async () => {
			if (!queued) return [];
			queued = false;
			const message: AgentMessage = { role: "user", content: ASIDE, timestamp: Date.now() };
			return [() => message];
		},
	};
}

describe("blocking calls yield to a delivered message", () => {
	const managers: AsyncJobManager[] = [];

	// The ask dialog's fallback renderer reads the active theme.
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("delivers an aside during a blocking task call while the child keeps running as a job", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingAgent],
			projectAgentsDir: null,
		});
		const childStarted = Promise.withResolvers<void>();
		const releaseChild = Promise.withResolvers<void>();
		let childFinished = false;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			childStarted.resolve();
			await releaseChild.promise;
			childFinished = true;
			return makeResult(options.id ?? "?");
		});
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, text) => {
				deliveries.push(text);
			},
		});
		managers.push(manager);
		const session = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => null,
			asyncJobManager: manager,
		} as unknown as ToolSession;
		const tool = await TaskTool.create(session);
		const aside = asideQueue();
		void childStarted.promise.then(aside.queue);

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "task-1",
							name: "task",
							arguments: { context: "ctx", tasks: [{ name: "SlowOne", agent: "slowworker", task: "Work." }] },
						},
					],
				},
				{ content: ["Handling the peer message first."] },
			],
		});
		const controller = new AbortController();
		// Safety deadline only (no fake clock: the red case is a call that never
		// returns); the aside must reach the model long before this fires.
		const timer = setTimeout(() => controller.abort("blocking task held the message"), 3000);
		let asideSeenWhileChildRan = false;
		try {
			for await (const event of agentLoop(
				[{ role: "user", content: "Do the work", timestamp: Date.now() }],
				// The loop only calls execute(); TaskTool's TUI renderer types its theme.
				{ systemPrompt: ["Test"], messages: [], tools: [tool as unknown as AgentTool] },
				{
					model: mock.model,
					convertToLlm: messages => messages as Message[],
					interruptMode: "immediate",
					getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
					hasQueuedAsides: aside.hasQueuedAsides,
					getAsideMessages: aside.getAsideMessages,
				},
				controller.signal,
				mock.stream,
			)) {
				if (event.type === "message_start" && event.message.role === "user" && event.message.content === ASIDE) {
					asideSeenWhileChildRan = !childFinished;
				}
			}
		} finally {
			clearTimeout(timer);
		}

		expect(controller.signal.aborted).toBe(false);
		expect(asideSeenWhileChildRan).toBe(true);
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[1]?.context.messages.some(message => message.content === ASIDE)).toBe(true);
		// The child kept running past the call and its result arrives on its own, once.
		expect(manager.getJob("SlowOne")?.status).toBe("running");
		releaseChild.resolve();
		await manager.getJob("SlowOne")?.promise;
		await manager.drainDeliveries({ timeoutMs: 1000 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toContain("SlowOne output.");
	});

	it("delivers an aside while an ask dialog is open and delivers the later answer as a job result", async () => {
		const answer = Promise.withResolvers<ExtensionAskDialogResult>();
		const dialogOpen = Promise.withResolvers<void>();
		let answered = false;
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, text) => {
				deliveries.push(text);
			},
		});
		managers.push(manager);
		const abort = vi.fn();
		const uiContext = {
			hasUI: true,
			ui: {
				select: async () => undefined,
				editor: async () => undefined,
				askDialog: async () => {
					dialogOpen.resolve();
					const result = await answer.promise;
					answered = true;
					return result;
				},
			},
			abort,
		};
		const tool = new AskTool({
			cwd: "/tmp/test",
			hasUI: true,
			canPromptUser: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "async.enabled": true }),
			asyncJobManager: manager,
		} as unknown as ToolSession);
		const aside = asideQueue();
		void dialogOpen.promise.then(aside.queue);
		const question = { id: "choice", question: "Which database?", options: [{ label: "SQLite" }] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: { questions: [question] } }] },
				{ content: ["Handling the peer message while the question stays open."] },
			],
		});
		const controller = new AbortController();
		// Safety deadline only, as above.
		const timer = setTimeout(() => controller.abort("ask held the message"), 3000);
		let asideSeenBeforeAnswer = false;
		let askResult = "";
		try {
			for await (const event of agentLoop(
				[{ role: "user", content: "Choose a database", timestamp: Date.now() }],
				{ systemPrompt: ["Test"], messages: [], tools: [tool] },
				{
					model: mock.model,
					convertToLlm: messages => messages as Message[],
					interruptMode: "immediate",
					getToolContext: toolCall => ({ ...uiContext, toolCall }) as unknown as AgentToolContext,
					hasQueuedAsides: aside.hasQueuedAsides,
					getAsideMessages: aside.getAsideMessages,
				},
				controller.signal,
				mock.stream,
			)) {
				if (event.type === "message_start" && event.message.role === "user" && event.message.content === ASIDE) {
					asideSeenBeforeAnswer = !answered;
				}
				if (event.type === "tool_execution_end") askResult = JSON.stringify(event.result.content);
			}
		} finally {
			clearTimeout(timer);
		}

		expect(controller.signal.aborted).toBe(false);
		expect(askResult).toContain("question stays open");
		expect(asideSeenBeforeAnswer).toBe(true);
		expect(mock.calls[1]?.context.messages.some(message => message.content === ASIDE)).toBe(true);
		expect(abort).not.toHaveBeenCalled();
		// The question is still open; the user's later answer arrives as the job's result.
		const job = manager.getRunningJobs()[0];
		expect(job?.type).toBe("ask");
		answer.resolve({
			kind: "submit",
			results: [
				{
					id: "choice",
					question: "Which database?",
					options: ["SQLite"],
					multi: false,
					selectedOptions: ["SQLite"],
				},
			],
		});
		await job?.promise;
		await manager.drainDeliveries({ timeoutMs: 1000 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toContain("User selected: SQLite");
	});
});
