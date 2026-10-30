import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop, agentPauseGate, type AgentTool, TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { SpeculativeOperationCoordinator } from "@oh-my-pi/pi-agent-core/speculative-execution";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AsideMessage } from "@oh-my-pi/pi-agent-core/types";
import type { Message, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applyToolProxy } from "@oh-my-pi/pi-coding-agent/extensibility/tool-proxy";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const sources = ["background", "peer", "parent"] as const;
type Source = (typeof sources)[number];
const stages = ["queued at admission", "queued before execute", "during service refresh", "in flight"] as const;
type Stage = (typeof stages)[number];

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("agent-loop wait wake delivery", () => {
	let manager: AsyncJobManager;
	let releaseJob: PromiseWithResolvers<string>;
	let deliveryReceipt: PromiseWithResolvers<void>;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		manager = new AsyncJobManager({});
		releaseJob = Promise.withResolvers<string>();
		deliveryReceipt = Promise.withResolvers<void>();
	});

	afterEach(async () => {
		agentPauseGate.resume();
		releaseJob.resolve("released");
		deliveryReceipt.resolve();
		await manager.dispose();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	async function run(
		source: Source,
		stage: Stage,
		options: {
			ordinaryTool?: boolean;
			alias?: boolean;
			cancel?: "external" | "after interrupt" | "transform" | "claim" | "context" | "stream discard";
			settledJob?: boolean;
		} = {},
	) {
		const registry = AgentRegistry.global();
		const inbox: IrcMessage[] = [];
		// The host owns the inbox and boundary injection; the real WaitTool
		// drains this same inbox before it registers a future bus waiter.
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			status: "running",
			session: {
				drainPendingIrcInboxMessages: () => inbox.splice(0, 1),
				deliverIrcMessage: async (message: IrcMessage) => {
					inbox.push(message);
					return "queued";
				},
			} as unknown as AgentSession,
		});
		const payload = `${source} wake payload`;
		const queuedCompletion = Promise.withResolvers<void>();
		let completionPending = false;
		manager.registerDeliverySink("Main", async () => {
			completionPending = true;
			queuedCompletion.resolve();
			await deliveryReceipt.promise;
		});
		const jobId = manager.register("bash", "owned job", async () => releaseJob.promise, { ownerId: "Main" });
		const foreignId = manager.publishCompleted(
			"bash",
			"another owner's job",
			{ text: "foreign result" },
			{
				ownerId: "Other",
			},
		);
		const consumed = vi.spyOn(manager, "consumeJobResults");
		const wait = new WaitTool({
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "launch.enabled": stage === "during service refresh" }),
			agentRegistry: registry,
			asyncJobManager: manager,
			getAgentId: () => "Main",
		} satisfies ToolSession);
		const execute = vi.spyOn(wait, "execute");
		let parentPending = false;
		let wakeRequested = false;
		const queueWake = async () => {
			if (wakeRequested) return;
			wakeRequested = true;
			if (source === "background") {
				releaseJob.resolve(payload);
				await manager.getJob(jobId)?.promise;
				// In-flight waits watch their jobs, suppressing the push. Every
				// earlier stage instead parks the accepted push on the host queue.
				if (stage !== "in flight") await queuedCompletion.promise;
			} else if (source === "peer") {
				await IrcBus.global().send({ from: "Peer", to: "Main", body: payload }, { suppressRelay: true });
			} else {
				if (options.settledJob) {
					releaseJob.resolve("settled owned output");
					await manager.getJob(jobId)?.promise;
				}
				parentPending = true;
			}
		};
		if (stage === "during service refresh") {
			const broker = {
				request: async (_operation: unknown, signal?: AbortSignal) => {
					await queueWake();
					const aborted = Promise.withResolvers<void>();
					if (signal?.aborted) aborted.resolve();
					else signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					await aborted.promise;
					throw new Error("Daemon broker request aborted");
				},
				onCompletion: () => () => {},
			} as unknown as DaemonBrokerClient;
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker);
		}
		const schema = type({});
		const barrier: AgentTool<typeof schema> = {
			name: "barrier",
			label: "Barrier",
			description: "Queues a wake before the following tool is admitted",
			parameters: schema,
			concurrency: "exclusive",
			async execute() {
				await queueWake();
				return { content: [], details: {} };
			},
		};
		const ordinaryExecute = vi.fn(async () => ({ content: [], details: {} }));
		const ordinary: AgentTool<typeof schema> = {
			name: "ordinary",
			label: "Ordinary",
			description: "An interruptible tool without a wake-drain capability",
			parameters: schema,
			interruptible: true,
			execute: ordinaryExecute,
		};
		const alias = { name: "receive" };
		applyToolProxy(wait, alias);
		const receiver = options.alias ? (alias as AgentTool) : wait;
		const target = options.ordinaryTool ? ordinary : receiver;
		const controller = new AbortController();
		let cancellationReached = false;
		const cancelBeforeExecute = () => {
			expect(parentPending).toBe(true);
			cancellationReached = true;
			controller.abort("cancelled by user");
		};
		const needsCoordinator = options.cancel === "claim" || options.cancel === "stream discard";
		const marker: AgentTool<typeof schema> = {
			name: "marker",
			label: "Marker",
			description: "Keeps a real speculative coordinator attached to this batch",
			parameters: schema,
			speculation: {
				finalized: {
					assess: () => ({ eligible: true, effect: { kind: "pure" } }),
					async execute() {
						return { kind: "result", result: { content: [], details: {} }, isError: false };
					},
				},
			},
			async execute() {
				throw new Error("The marker must use its speculative result");
			},
		};
		if (needsCoordinator) {
			const claim = SpeculativeOperationCoordinator.prototype.claim;
			vi.spyOn(SpeculativeOperationCoordinator.prototype, "claim").mockImplementation(
				async function (this: SpeculativeOperationCoordinator, tool, toolCall, args) {
					const outcome = await claim.call(this, tool, toolCall, args);
					if (tool !== wait) return outcome;
					if (options.cancel === "claim") {
						cancelBeforeExecute();
					} else {
						this.registerStreamSession(toolCall.id, {
							update() {},
							finalize() {},
							commit() {},
							async discard() {
								await Promise.resolve();
								cancelBeforeExecute();
							},
						});
					}
					return outcome;
				},
			);
		}
		let pausedBeforeExecute = false;
		const mock = createMockModel({
			responses: [
				() => {
					if (stage === "queued before execute") agentPauseGate.pause();
					return {
						content: [
							...(needsCoordinator ? [{ type: "toolCall" as const, name: marker.name, arguments: {} }] : []),
							...(stage === "queued at admission"
								? [{ type: "toolCall" as const, name: "barrier", arguments: {} }]
								: []),
							{ type: "toolCall" as const, name: target.name, arguments: {} },
						],
					};
				},
				{ content: ["Done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => messages as Message[],
			speculativeToolExecution: needsCoordinator ? { enabled: true } : undefined,
			transformToolCallArguments:
				options.cancel === "transform"
					? (args, toolName) => {
							if (toolName === wait.name) cancelBeforeExecute();
							return args;
						}
					: undefined,
			getToolContext: () => {
				if (options.cancel === "context" && parentPending) cancelBeforeExecute();
				return undefined;
			},
			hasBackgroundCompletions: () =>
				source === "background" && completionPending && !manager.isDeliverySuppressed(jobId),
			hasIrcInterrupts: () => source === "peer" && inbox.length > 0,
			hasSteeringMessages: () => ({ queued: parentPending, source: "agent" }),
			getSteeringMessages: async () => {
				if (!parentPending) return [];
				parentPending = false;
				return [userMessage(payload)];
			},
			getAsideMessages: async (): Promise<AsideMessage[]> => {
				const messages: AsideMessage[] = inbox.splice(0).map(message => userMessage(message.body));
				if (completionPending) {
					completionPending = false;
					if (!manager.isDeliverySuppressed(jobId)) messages.push(userMessage(payload));
					deliveryReceipt.resolve();
				}
				return messages;
			},
			onPauseChange: paused => {
				if (paused) {
					pausedBeforeExecute = true;
					if (options.cancel === "external") controller.abort("cancelled by user");
					else void queueWake();
				} else if (pausedBeforeExecute) {
					if (options.cancel === "after interrupt") controller.abort("cancelled by user");
					agentPauseGate.resume();
				}
			},
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[userMessage("Wait for the next event")],
			{ systemPrompt: ["Test"], messages: [], tools: [marker, barrier, target] },
			config,
			controller.signal,
			mock.stream,
		);
		for await (const event of stream) {
			events.push(event);
			if (stage === "in flight" && event.type === "tool_execution_update") await queueWake();
		}
		const messages = await stream.result();
		const results = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolName === target.name,
		);
		expect(results).toHaveLength(1);
		expect(manager.isJobResultConsumed(foreignId)).toBe(false);
		if (stage === "queued before execute") expect(pausedBeforeExecute).toBe(true);
		return { result: results[0], messages, payload, jobId, consumed, execute, ordinaryExecute, cancellationReached };
	}

	for (const source of sources) {
		for (const stage of stages) {
			it(`delivers a ${source} wake exactly once when ${stage}`, async () => {
				const { result, messages, payload, jobId, consumed, execute } = await run(source, stage);
				expect(result.isError).toBe(false);
				expect(execute).toHaveBeenCalledTimes(1);
				expect(result.result.details).not.toHaveProperty("__synthetic");
				expect(messages.filter(message => messageText(message).includes(payload))).toHaveLength(1);
				if (stage === "queued at admission" || stage === "queued before execute") {
					expect(execute.mock.calls[0][2]?.reason).toBe(TOOL_INTERRUPT_ABORT_REASON);
				}
				if (source === "background") {
					expect(manager.isJobResultConsumed(jobId)).toBe(true);
					expect(consumed.mock.calls.filter(([ids]) => ids.includes(jobId))).toHaveLength(1);
				} else if (source === "parent") {
					expect(result.result.details).toMatchObject({ interrupted: true });
				} else {
					expect(result.result.details).toMatchObject({ waited: { from: "Peer", body: payload } });
				}
			});
		}

		it(`still skips another interruptible tool for a queued ${source} wake`, async () => {
			const { result, ordinaryExecute, execute } = await run(source, "queued at admission", { ordinaryTool: true });
			expect(result.isError).toBe(true);
			expect(result.result.details).toMatchObject({ __synthetic: true, executed: false });
			expect(ordinaryExecute).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
		});

		it(`honors an external cancellation after a queued ${source} interrupt`, async () => {
			const { result, execute, jobId } = await run(source, "queued before execute", { cancel: "after interrupt" });
			expect(result.isError).toBe(true);
			expect(result.result.content).toContainEqual({
				type: "text",
				text: expect.stringContaining("cancelled by user"),
			});
			expect(execute).not.toHaveBeenCalled();
			expect(manager.isJobResultConsumed(jobId)).toBe(false);
		});
	}

	it("honors external cancellation before wait starts without a queued wake", async () => {
		const { result, execute } = await run("background", "queued before execute", { cancel: "external" });
		expect(result.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	for (const cancel of ["transform", "claim", "context", "stream discard"] as const) {
		it(`does not consume a settled job when externally cancelled during ${cancel} after a queued steer`, async () => {
			const { result, execute, jobId, consumed, cancellationReached } = await run("parent", "queued at admission", {
				cancel,
				settledJob: true,
			});
			expect(cancellationReached).toBe(true);
			expect(result.isError).toBe(true);
			expect(result.result.content).toContainEqual({
				type: "text",
				text: expect.stringContaining("cancelled by user"),
			});
			expect(execute).not.toHaveBeenCalled();
			expect(consumed).not.toHaveBeenCalled();
			expect(manager.isJobResultConsumed(jobId)).toBe(false);
		});
	}

	it("drains queued wakes through a renamed proxy rather than recognizing the wait name", async () => {
		const { result, messages, payload, execute } = await run("background", "queued at admission", { alias: true });
		expect(result.isError).toBe(false);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(messages.filter(message => messageText(message).includes(payload))).toHaveLength(1);
	});
});
