/**
 * Focus rebuilds replay `AgentSession.activeToolExecutionUpdates()` to restore a
 * live task board (#10446). Snapshots stay cached until the overall call ends:
 * mixed blocking+async calls can report a settled async subset while blocking
 * work continues, while an already-returned background call uses that same
 * settled update as its terminal frame. Logical session transitions must clear
 * every snapshot.
 */
import { isRope, memoryUsage } from "bun:jsc";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import {
	ActiveToolExecutionUpdateCache,
	MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES,
} from "@oh-my-pi/pi-coding-agent/session/active-tool-updates";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { collectGarbage } from "../../tui/test/gc";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { MainThreadLink, WorkerThreadLink } from "@oh-my-pi/pi-coding-agent/thread/protocol";
import { type RpcEndpoint, type RpcFrame, RpcLink } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import type { WorkerPeer } from "@oh-my-pi/pi-coding-agent/thread/services";
import { type AgentsThreadGlobals, agentsThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/agents";
import type { SessionBridgeClient } from "@oh-my-pi/pi-coding-agent/thread/session-mirror";
import { SessionPublisher } from "@oh-my-pi/pi-coding-agent/thread/session-publisher";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

function taskUpdate(state: "running" | "completed" | "failed", toolCallId = "task-1"): AgentEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName: "task",
		args: {},
		partialResult: {
			content: [{ type: "text", text: `Task ${state}` }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 5,
				progress: [],
				async: { state, jobId: "job-1", type: "task" },
			},
		},
	} satisfies AgentEvent;
}

function taskEnd(state: "running" | "completed" | "failed", toolCallId = "task-1"): AgentEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "task",
		result: {
			content: [{ type: "text", text: `Task ${state}` }],
			details: { async: { state, jobId: "job-1", type: "task" } },
		},
	} satisfies AgentEvent;
}

describe("AgentSession.activeToolExecutionUpdates cache lifecycle", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];
	const tempDirs: string[] = [];
	const asyncManagers: AsyncJobManager[] = [];
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		if (session) await session.dispose();
		for (const manager of asyncManagers.splice(0)) await manager.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	});

	async function makeSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
	}

	it("retains a settled async subset until its mixed task call ends", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running"));
		session.agent.emitExternalEvent(taskUpdate("completed"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["task-1"]);

		session.agent.emitExternalEvent(taskEnd("completed"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);
	});

	it("retains a terminal background snapshot after the original task call returned", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskEnd("running"));
		session.agent.emitExternalEvent(taskUpdate("completed"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["task-1"]);
	});

	it("clears snapshots across a new session", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running", "cached-call"));
		session.agent.emitExternalEvent(taskEnd("running", "returned-call"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(1);

		expect(await session.newSession()).toBe(true);
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);

		session.agent.emitExternalEvent(taskUpdate("completed", "returned-call"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["returned-call"]);
	});

	it("releases foreground tool updates on completion and ignores late post-end updates", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "fg-bash-1",
			toolName: "bash",
			args: { command: "echo hi" },
		});
		session.agent.emitExternalEvent({
			type: "tool_execution_update",
			toolCallId: "fg-bash-1",
			toolName: "bash",
			args: { command: "echo hi" },
			partialResult: {
				content: [{ type: "text", text: "streaming output" }],
				details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
			},
		});
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["fg-bash-1"]);

		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "fg-bash-1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "hi" }],
				details: { exitCode: 0 },
			},
		});
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);

		// A late async progress callback from the finished foreground job must not
		// repopulate the cache after tool_execution_end persisted the terminal result.
		session.agent.emitExternalEvent({
			type: "tool_execution_update",
			toolCallId: "fg-bash-1",
			toolName: "bash",
			args: { command: "echo hi" },
			partialResult: {
				content: [{ type: "text", text: "hi" }],
				details: { exitCode: 0, async: { state: "completed", jobId: "bg_1", type: "bash" } },
			},
		});
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);

		if (process.platform !== "win32") {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fg-bash-updates-"));
			tempDirs.push(cwd);
			const manager = new AsyncJobManager({});
			asyncManagers.push(manager);
			const toolSession: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionId: () => session.sessionId,
				getSessionSpawns: () => "*",
				asyncJobManager: manager,
				settings: session.settings,
			};
			const bash = new BashTool(toolSession);
			session.agent.emitExternalEvent({
				type: "tool_execution_start",
				toolCallId: "real-bash-1",
				toolName: "bash",
				args: { command: "printf 'done\\n'" },
			});
			const result = await bash.execute("real-bash-1", { command: "printf 'done\\n'" }, undefined, partialResult => {
				session.agent.emitExternalEvent({
					type: "tool_execution_update",
					toolCallId: "real-bash-1",
					toolName: "bash",
					args: { command: "printf 'done\\n'" },
					partialResult,
				});
			});
			session.agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId: "real-bash-1",
				toolName: "bash",
				result,
			});
			await manager.waitForAll();
			expect(session.activeToolExecutionUpdates()).toHaveLength(0);
		}
	});

	it("preserves returned background terminal updates across focus rebuilds and compacts older retired entries", async () => {
		await initTheme();
		session = await makeSession();

		session.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "inflight-fg",
			toolName: "task",
			args: {},
		});
		session.agent.emitExternalEvent(taskUpdate("running", "inflight-fg"));

		session.agent.emitExternalEvent(taskEnd("running", "running-bg"));
		session.agent.emitExternalEvent(taskUpdate("running", "running-bg"));

		const totalRetired = MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES + 5;
		const oldestId = "retired-bg-0";
		const latestId = `retired-bg-${totalRetired - 1}`;
		const largePrefix = "x".repeat(8_000);
		for (let i = 0; i < totalRetired; i++) {
			const callId = `retired-bg-${i}`;
			const failed = i === 0;
			session.agent.emitExternalEvent(taskEnd("running", callId));
			session.agent.emitExternalEvent({
				type: "tool_execution_update",
				toolCallId: callId,
				toolName: "task",
				args: { task: "y".repeat(4_000) },
				partialResult: {
					content: [
						{
							type: "text",
							text: failed ? `${largePrefix}\nWorker crashed on step 1` : `${largePrefix}\nTask completed`,
						},
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
					details: {
						projectAgentsDir: null,
						results: [],
						totalDurationMs: 12,
						trace: { seq: 9, events: ["heavy-trace"] },
						images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
						progress: [
							{
								index: 0,
								id: `Worker-${i}`,
								agent: "task",
								agentSource: "bundled",
								status: failed ? "failed" : "completed",
								task: "z".repeat(2_000),
								recentTools: [{ tool: "bash", args: "echo heavy", endMs: 1 }],
								recentOutput: ["line ".repeat(500)],
								extractedToolData: { yield: [{ data: { notes: "heavy".repeat(200) } }] },
								retryFailure: failed ? { attempt: 2, errorMessage: "upstream rate limit" } : undefined,
								toolCount: 3,
								requests: 2,
								tokens: 100,
								cost: 0.01,
								durationMs: 12,
							},
						],
						async: { state: failed ? "failed" : "completed", jobId: `job-${i}`, type: "task" },
					},
				},
			});
		}

		const updates = session.activeToolExecutionUpdates();
		const cachedIds = updates.map(event => event.toolCallId);
		expect(cachedIds).toHaveLength(totalRetired + 2);
		expect(cachedIds).toContain("inflight-fg");
		expect(cachedIds).toContain("running-bg");

		const mirroredCache = new ActiveToolExecutionUpdateCache();
		mirroredCache.replaceSnapshot(updates, new Set(["inflight-fg"]));
		const oldestCompacted = mirroredCache.get(oldestId);
		expect(oldestCompacted).toBeDefined();
		expect(oldestCompacted?.args).toEqual({});
		expect(oldestCompacted?.partialResult.content).toHaveLength(1);
		const oldestText =
			oldestCompacted?.partialResult.content[0]?.type === "text"
				? oldestCompacted.partialResult.content[0].text
				: "";
		expect(oldestText.length).toBeLessThanOrEqual(1024);
		expect(oldestText).toContain("Worker crashed on step 1");
		const oldestDetails = oldestCompacted?.partialResult.details as Record<string, unknown>;
		expect(oldestDetails.trace).toBeUndefined();
		expect(oldestDetails.images).toBeUndefined();
		expect(oldestDetails.async).toEqual({ state: "failed", jobId: "job-0", type: "task" });
		const oldestProgress = (oldestDetails.progress as Array<Record<string, unknown>>)[0];
		expect(oldestProgress?.status).toBe("failed");
		expect(oldestProgress?.recentOutput).toEqual([]);
		expect(oldestProgress?.extractedToolData).toBeUndefined();

		const newestFull = mirroredCache.get(latestId);
		expect(newestFull).toBeDefined();
		expect(newestFull?.partialResult.content).toHaveLength(2);
		const newestDetails = newestFull?.partialResult.details as Record<string, unknown>;
		const newestProgress = (newestDetails.progress as Array<Record<string, unknown>>)[0];
		expect(newestProgress?.extractedToolData).toBeDefined();

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const makeCallAndRunningResult = (callId: string, jobId: string): [AssistantMessage, ToolResultMessage] => [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: callId,
						name: "task",
						arguments: { tasks: [{ name: `Worker-${callId}`, agent: "task", task: "Run check" }] },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "task",
				content: [{ type: "text", text: "Spawned background task" }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 5,
					progress: [
						{
							index: 0,
							id: `Worker-${callId}`,
							agent: "task",
							agentSource: "bundled",
							status: "running",
							task: "Run check",
							recentTools: [],
							recentOutput: [],
							toolCount: 0,
							requests: 0,
							tokens: 0,
							cost: 0,
							durationMs: 0,
						},
					],
					async: { state: "running", jobId, type: "task" },
				},
				isError: false,
				timestamp: Date.now(),
			},
		];

		const [oldestCall, oldestRunningResult] = makeCallAndRunningResult(oldestId, "job-0");
		const [latestCall, latestRunningResult] = makeCallAndRunningResult(latestId, `job-${totalRetired - 1}`);
		const ctx = createInteractiveModeContext({
			settings: session.settings,
			viewSession: {
				isStreaming: false,
				activeToolExecutionUpdates: () => session.activeToolExecutionUpdates(),
			},
		});
		const uiHelpers = new UiHelpers(ctx);
		await uiHelpers.renderSessionContext({
			messages: [oldestCall, oldestRunningResult, latestCall, latestRunningResult],
			thinkingLevel: undefined,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});

		const rebuiltCards = ctx.chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		expect(rebuiltCards).toHaveLength(2);
		expect(ctx.pendingTools.has(oldestId)).toBe(false);
		expect(ctx.pendingTools.has(latestId)).toBe(false);
		expect(rebuiltCards[0]?.isTranscriptBlockFinalized()).toBe(true);
		expect(rebuiltCards[1]?.isTranscriptBlockFinalized()).toBe(true);
		const oldestRendered = Bun.stripANSI(rebuiltCards[0]!.render(120).join("\n"));
		const latestRendered = Bun.stripANSI(rebuiltCards[1]!.render(120).join("\n"));
		expect(oldestRendered).not.toContain("Spawned background task");
		expect(oldestRendered).not.toContain(`Worker-${oldestId}`);
		expect(oldestRendered).toContain("Worker-0");
		expect(oldestRendered).toContain("upstream rate limit");
		expect(latestRendered).toContain(`Worker-${totalRetired - 1}`);
		for (const card of rebuiltCards) card.seal();
	});

	it("materializes independent backing strings so compacted entries release large outputs", async () => {
		const populate = (target: ActiveToolExecutionUpdateCache): void => {
			for (let i = 0; i < 200; i++) {
				const callId = `heavy-bg-${i}`;
				const heavyText = `${"x".repeat(256 * 1024)}\uD83Dtail-${i}`;
				target.recordEnd(callId, { async: { state: "running", jobId: `job-${i}`, type: "bash" } });
				target.recordUpdate({
					type: "tool_execution_update",
					toolCallId: callId,
					toolName: "bash",
					args: { command: heavyText },
					partialResult: {
						content: [{ type: "text", text: heavyText }],
						details: {
							label: heavyText.slice(0, 200),
							async: { state: "completed", jobId: `job-${i}`, type: "bash" },
						},
					},
				});
			}
			for (let i = 0; i < MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES; i++) {
				const callId = `recent-bg-${i}`;
				target.recordEnd(callId, { async: { state: "running", jobId: `recent-${i}`, type: "bash" } });
				target.recordUpdate({
					type: "tool_execution_update",
					toolCallId: callId,
					toolName: "bash",
					args: {},
					partialResult: {
						content: [{ type: "text", text: `ok-${i}` }],
						details: { async: { state: "completed", jobId: `recent-${i}`, type: "bash" } },
					},
				});
			}
		};

		const cache = new ActiveToolExecutionUpdateCache();
		await collectGarbage();
		const baselineBytes = memoryUsage().current;
		populate(cache);
		await collectGarbage();
		const retainedBytes = memoryUsage().current - baselineBytes;

		const firstCompacted = cache.get("heavy-bg-0");
		const firstText =
			firstCompacted?.partialResult.content[0]?.type === "text" ? firstCompacted.partialResult.content[0].text : "";
		const firstLabel = (firstCompacted?.partialResult.details as Record<string, unknown> | undefined)?.label;

		expect(firstText).toHaveLength(1024);
		expect(firstText.endsWith("\uD83Dtail-0")).toBe(true);
		expect(isRope(firstText)).toBe(false);
		expect(typeof firstLabel === "string" && isRope(firstLabel)).toBe(false);
		expect(retainedBytes).toBeLessThan(20 * 1024 * 1024);
	});

	it("compacts pre-watch returned background calls on RemoteAgentSession mid-run while preserving pending foreground calls", async () => {
		session = await makeSession();

		const portEndpoint = (port: MessagePort): RpcEndpoint => ({
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		});

		const pair = new MessageChannel();
		const mainLink: MainThreadLink = new RpcLink(portEndpoint(pair.port1), { name: "main↔w1" });
		const workerLink: WorkerThreadLink = new RpcLink(portEndpoint(pair.port2), { name: "w1↔main" });
		const peer: WorkerPeer = { threadId: "w1", link: mainLink };
		agentsThreadService.installMain?.(peer);
		agentsThreadService.installWorker?.(workerLink);
		cleanups.push(() => {
			agentsThreadService.onWorkerExit?.(peer, "test end");
			mainLink.close();
			workerLink.close();
			pair.port1.close();
			pair.port2.close();
		});

		let workerBridge: SessionBridgeClient | undefined;
		workerLink.handle("boot", globals => {
			const agentsGlobals = globals.agents as { bridge: SessionBridgeClient };
			workerBridge = agentsGlobals.bridge;
		});
		const mainGlobals = agentsThreadService.globals?.(peer) as AgentsThreadGlobals;
		await mainLink.call("boot", { agents: mainGlobals });

		const publisher = new SessionPublisher(session, workerBridge!);
		cleanups.push(() => publisher.close());

		const waitFor = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
			const deadline = Date.now() + timeoutMs;
			while (!check()) {
				if (Date.now() > deadline) throw new Error("Timed out waiting for mirrored state");
				await Bun.sleep(5);
			}
		};

		await waitFor(() => mainGlobals.bridge.session(session.instanceKey) !== undefined);
		const remote = mainGlobals.bridge.session(session.instanceKey)!;

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const emitAssistantToolCalls = (ids: readonly string[]): void => {
			const message: AssistantMessage = {
				role: "assistant",
				content: ids.map(id => ({ type: "toolCall" as const, id, name: "task", arguments: { task: id } })),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage,
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_start", message });
			session.agent.emitExternalEvent({ type: "message_end", message });
		};

		const largePrefix = "p".repeat(6_000);
		const heavySettledUpdate = (toolCallId: string, jobId: string): AgentEvent => ({
			type: "tool_execution_update",
			toolCallId,
			toolName: "task",
			args: { task: "a".repeat(3_000) },
			partialResult: {
				content: [
					{ type: "text", text: `${largePrefix}\nFinished ${toolCallId}` },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 9,
					trace: { seq: 1, events: ["heavy-trace"] },
					images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
					progress: [],
					async: { state: "completed", jobId, type: "task" },
				},
			},
		});

		const batchSize = MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES;
		const preWatchIds = Array.from({ length: batchSize }, (_, i) => `pre-bg-${i}`);
		const pendingFgId = "pending-fg";

		// Start a single active run so `session.runToolCallIds` retains every returned pre-watch call.
		session.agent.emitExternalEvent({ type: "agent_start" });
		emitAssistantToolCalls([...preWatchIds, pendingFgId]);

		for (let i = 0; i < batchSize; i++) {
			const callId = preWatchIds[i]!;
			session.agent.emitExternalEvent({
				type: "tool_execution_start",
				toolCallId: callId,
				toolName: "task",
				args: { task: callId },
			});
			session.agent.emitExternalEvent(taskEnd("running", callId));
			session.agent.emitExternalEvent(heavySettledUpdate(callId, `pre-job-${i}`));
		}

		// Genuinely pending foreground call (mixed task call whose async subset settled while still executing).
		session.agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: pendingFgId,
			toolName: "task",
			args: { task: "still-running-foreground" },
		});
		session.agent.emitExternalEvent(heavySettledUpdate(pendingFgId, "fg-subset-job"));

		expect(session.runToolCallIds.has("pre-bg-0")).toBe(true);
		expect(session.agent.state.pendingToolCalls.has("pre-bg-0")).toBe(false);
		expect(session.agent.state.pendingToolCalls.has(pendingFgId)).toBe(true);

		const unsubscribeWatch = remote.subscribe(() => {});
		cleanups.push(unsubscribeWatch);
		await waitFor(() => remote.activeToolExecutionUpdates().length === batchSize + 1);

		const postWatchIds = Array.from({ length: batchSize }, (_, i) => `post-bg-${i}`);
		emitAssistantToolCalls(postWatchIds);
		for (let i = 0; i < batchSize; i++) {
			const callId = postWatchIds[i]!;
			session.agent.emitExternalEvent({
				type: "tool_execution_start",
				toolCallId: callId,
				toolName: "task",
				args: { task: callId },
			});
			session.agent.emitExternalEvent(taskEnd("running", callId));
			session.agent.emitExternalEvent(heavySettledUpdate(callId, `post-job-${i}`));
		}

		await waitFor(() =>
			remote.activeToolExecutionUpdates().some(event => event.toolCallId === `post-bg-${batchSize - 1}`),
		);

		expect(session.runToolCallIds.size).toBe(batchSize * 2 + 1);

		const isUncompacted = (event: Extract<AgentEvent, { type: "tool_execution_update" }>): boolean =>
			Object.keys(event.args as Record<string, unknown>).length > 0 && event.partialResult.content.length === 2;

		const ownerUpdates = new Map(session.activeToolExecutionUpdates().map(event => [event.toolCallId, event]));
		const remoteUpdates = new Map(remote.activeToolExecutionUpdates().map(event => [event.toolCallId, event]));
		expect(remoteUpdates.size).toBe(ownerUpdates.size);

		for (const callId of preWatchIds) {
			const mirrored = remoteUpdates.get(callId);
			expect(mirrored).toBeDefined();
			expect(isUncompacted(mirrored!)).toBe(false);
			expect(mirrored?.args).toEqual({});
			expect(mirrored?.partialResult.content).toHaveLength(1);
			const text = mirrored?.partialResult.content[0]?.type === "text" ? mirrored.partialResult.content[0].text : "";
			expect(text.length).toBeLessThanOrEqual(1024);
			expect(text).toContain(`Finished ${callId}`);
			const details = mirrored?.partialResult.details as Record<string, unknown>;
			expect(details.trace).toBeUndefined();
			expect(details.images).toBeUndefined();
		}

		for (const callId of postWatchIds) {
			expect(isUncompacted(remoteUpdates.get(callId)!)).toBe(true);
		}
		const pendingMirrored = remoteUpdates.get(pendingFgId);
		expect(pendingMirrored).toBeDefined();
		expect(isUncompacted(pendingMirrored!)).toBe(true);

		const uncompactedRetiredInRemote = [...remoteUpdates.entries()].filter(
			([id, event]) => id !== pendingFgId && isUncompacted(event),
		);
		expect(uncompactedRetiredInRemote).toHaveLength(MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES);

		session.agent.emitExternalEvent(taskEnd("completed", pendingFgId));
		await waitFor(() => !remote.activeToolExecutionUpdates().some(event => event.toolCallId === pendingFgId));
		expect(session.activeToolExecutionUpdates().some(event => event.toolCallId === pendingFgId)).toBe(false);
	});
});
