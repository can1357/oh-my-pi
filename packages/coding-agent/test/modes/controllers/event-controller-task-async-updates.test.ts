/**
 * Contracts: final async `task` snapshots vs. the tool call's own lifecycle.
 *
 * A `task` call with background jobs streams `tool_execution_update` frames
 * whose `details.async.state` can settle ("completed"/"failed") at any time
 * relative to the call's `tool_execution_end` (mixed blocking+async calls run
 * their jobs while the call is still executing).
 *
 * 1. A final async frame arriving BEFORE the call's end is a partial frame:
 *    the block stays tracked so `tool_execution_end` still delivers the
 *    terminal result (previously the block was dropped from tracking and the
 *    real result never rendered — the "disappearing task call").
 * 2. A final async frame arriving AFTER an end that parked the block as
 *    background ("running") finalizes and untracks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext, PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { isSettled } from "@oh-my-pi/pi-tui";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "../../../src/ui/theme/service";
import { blockText, transcriptText } from "../../helpers/transcript-text";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { type BashToolDetails, formatBackgroundNotice } from "@oh-my-pi/pi-coding-agent/tools/details/bash";
import type { CoordinationDetails } from "@oh-my-pi/pi-coding-agent/tools/details/wait";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function taskResult(asyncState: "running" | "completed" | "failed" | undefined, text: string) {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 5,
		...(asyncState ? { async: { state: asyncState, jobId: "Job1", type: "task" as const } } : {}),
	};
	return { content: [{ type: "text" as const, text }], details };
}

interface BashFrame {
	content: { type: "text"; text: string }[];
	details: BashToolDetails;
}

function bashResult(
	text: string,
	state: "running" | "completed" | "failed" | "cancelled" = "running",
	exitCode?: number,
): BashFrame {
	const details: BashToolDetails = {
		async: { state, jobId: "bash-1", type: "bash" },
		...(exitCode === undefined ? {} : { exitCode }),
	};
	return { content: [{ type: "text" as const, text }], details };
}

function waitResult(status: "running" | "completed", durationMs: number) {
	const details: CoordinationDetails = {
		op: "wait",
		jobs: [{ id: "Job1", type: "task", status, label: "Long task", durationMs }],
	};
	return { content: [{ type: "text" as const, text: `${status} wait` }], details };
}

describe("EventController async update finalization", () => {
	const sealed: PendingTool[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
	});

	afterEach(() => {
		for (const component of sealed.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	let native = false;

	function createFixture(isStreaming = false) {
		const pendingTools = new Map<string, PendingTool>();
		const ctx = createInteractiveModeContext({
			pendingTools,
			session: { isStreaming: true },
			viewSession: { isStreaming },
		});
		vi.spyOn(ctx.shell, "native").mockImplementation(() => native);
		return { controller: new EventController(ctx), pendingTools, ctx };
	}

	/** The first tool card in the transcript. */
	function firstCard(ctx: InteractiveModeContext): PendingTool | undefined {
		for (const block of ctx.shell.transcript.blocks()) {
			const entry = ctx.transcriptEntry(block);
			if (entry?.kind === "tool" && entry.tool.call) return entry.tool;
		}
		return undefined;
	}

	async function startTask(controller: EventController, pendingTools: Map<string, PendingTool>) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-task",
			toolName: "task",
			args: { context: "ctx", tasks: [{ agent: "task", task: "work" }] },
		});
		const component = pendingTools.get("tc-task")!;
		sealed.push(component);
		return component;
	}

	it("keeps the block tracked when a final async frame precedes tool_execution_end", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);

		// The job settled while the call is still executing (mixed call).
		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 complete."),
		});
		expect(pendingTools.get("tc-task")).toBe(component);
		expect(isSettled(component.block.node)).toBe(false);

		// The call's own result still lands and finalizes the block.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("completed", "Inline results + spawned listing."),
			isError: false,
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(isSettled(component.block.node)).toBe(true);
	});

	it("finalizes a parked background block when its jobs settle after the end", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("running", "Spawned agent `Job1` (job `Job1`)."),
			isError: false,
		});
		// Background: kept tracked so later job frames can update it.
		expect(pendingTools.get("tc-task")).toBe(component);
		expect(isSettled(component.block.node)).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 complete."),
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(isSettled(component.block.node)).toBe(true);
	});

	for (const arrival of ["early", "replay"] as const) {
		for (const state of ["completed", "failed"] as const) {
			it(`renders the ${state} outcome after a ${arrival} background task result`, async () => {
				const { controller, pendingTools, ctx } = createFixture(true);
				ctx.eventController = controller;
				const helpers = new UiHelpers(ctx);
				ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
				const running = taskResult("running", "Spawned background worker.");
				if (arrival === "early") {
					await controller.handleEvent({
						type: "tool_execution_end",
						toolCallId: "tc-task",
						toolName: "task",
						result: running,
						isError: false,
					});
					await controller.handleEvent({
						type: "tool_execution_start",
						toolCallId: "tc-task",
						toolName: "task",
						args: { tasks: [{ task: "work" }] },
					});
				} else {
					const result: ToolResultMessage = {
						role: "toolResult",
						toolCallId: "tc-task",
						toolName: "task",
						...running,
						isError: false,
						timestamp: 2,
					};
					ctx.viewSession.agent.getPendingToolResults = () => [result];
					controller.resetTranscriptAnchors();
					const assistant: AssistantMessage = {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "tc-task", name: "task", arguments: { tasks: [{ task: "work" }] } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "test",
						stopReason: "toolUse",
						timestamp: 1,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					helpers.renderSessionContext({ messages: [assistant] } as SessionContext);
					controller.restorePendingToolResults();
					ctx.viewSession.agent.getPendingToolResults = () => [];
				}
				const component = firstCard(ctx)!;
				sealed.push(component);
				ctx.toolOutputExpanded = true;
				await controller.handleEvent({ type: "agent_start" });
				const outcome =
					state === "completed" ? "Worker produced the final report." : "Worker failed to read its input.";
				await controller.handleEvent({
					type: "tool_execution_update",
					toolCallId: "tc-task",
					toolName: "task",
					args: {},
					partialResult: taskResult(state, outcome),
				});
				expect(transcriptText(ctx.shell, 120)).toContain(outcome);
				expect(pendingTools.has("tc-task")).toBe(false);
				expect(isSettled(component.block.node)).toBe(true);
			});
		}
	}

	it("finalizes a backgrounded Bash block without tracking later job updates", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-bash",
			toolName: "bash",
			args: { command: "sleep 30" },
		});
		const component = pendingTools.get("tc-bash")!;
		sealed.push(component);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-bash",
			toolName: "bash",
			result: bashResult(formatBackgroundNotice("bash-1", 300)),
			isError: false,
		});

		expect(pendingTools.has("tc-bash")).toBe(false);
		expect(isSettled(component.block.node)).toBe(true);
	});

	describe("native rendering", () => {
		beforeEach(() => {
			native = true;
		});
		afterEach(() => {
			native = false;
		});

		async function backgroundBash(controller: EventController, pendingTools: Map<string, PendingTool>) {
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: "tc-bash",
				toolName: "bash",
				args: { command: "hyperfine bench" },
			});
			const component = pendingTools.get("tc-bash")!;
			sealed.push(component);
			return component;
		}

		const jobFrame = (partialResult: BashFrame) => ({
			type: "tool_execution_update" as const,
			toolCallId: "tc-bash",
			toolName: "bash",
			args: {},
			partialResult,
		});

		const rendered = (component: PendingTool) => blockText(component.block);

		it("keeps filling a backgrounded Bash card with its job's output until the job settles", async () => {
			const { controller, pendingTools } = createFixture();
			const component = await backgroundBash(controller, pendingTools);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "tc-bash",
				toolName: "bash",
				result: bashResult(`Benchmark 1\n\n${formatBackgroundNotice("bash-1", 300)}`),
				isError: false,
			});
			expect(pendingTools.get("tc-bash")).toBe(component);

			await controller.handleEvent(jobFrame(bashResult("Benchmark 1\nBenchmark 2")));
			expect(rendered(component)).toContain("Benchmark 2");
			expect(pendingTools.get("tc-bash")).toBe(component);

			await controller.handleEvent(jobFrame(bashResult("Benchmark 1\nBenchmark 2\nSummary", "failed", 1)));
			expect(rendered(component)).toContain("Summary");
			// The failed job's frame is the call's result.
			expect(component.call?.status()).toBe("error");
			expect(pendingTools.has("tc-bash")).toBe(false);
			expect(isSettled(component.block.node)).toBe(true);
		});

		it("seals a backgrounded Bash card as cancelled when its job is killed, keeping its output", async () => {
			const { controller, pendingTools } = createFixture();
			const component = await backgroundBash(controller, pendingTools);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "tc-bash",
				toolName: "bash",
				result: bashResult(formatBackgroundNotice("bash-1", 300)),
				isError: false,
			});
			await controller.handleEvent(jobFrame(bashResult("[Command cancelled]\nBenchmark 1", "cancelled")));

			expect(rendered(component)).toContain("Benchmark 1");
			expect(component.call?.status()).toBe("cancelled");
			expect(rendered(component)).not.toContain("In background");
			expect(pendingTools.has("tc-bash")).toBe(false);
			expect(isSettled(component.block.node)).toBe(true);
		});

		it("settles a Bash card whose job finished before the call returned", async () => {
			const { controller, pendingTools } = createFixture();
			const component = await backgroundBash(controller, pendingTools);
			await controller.handleEvent(jobFrame(bashResult("all done", "completed", 0)));
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "tc-bash",
				toolName: "bash",
				result: bashResult(formatBackgroundNotice("bash-1", 300)),
				isError: false,
			});

			expect(rendered(component)).toContain("all done");
			expect(rendered(component)).not.toContain("In background");
			expect(pendingTools.has("tc-bash")).toBe(false);
			expect(isSettled(component.block.node)).toBe(true);
		});
	});

	it("settles an early wait result while another reported job remains running", async () => {
		const { controller, pendingTools, ctx } = createFixture();
		const details: CoordinationDetails = {
			op: "wait",
			jobs: [
				{ id: "Job1", type: "task", status: "completed", label: "Finished work", durationMs: 5 },
				{ id: "Job2", type: "task", status: "running", label: "Background work", durationMs: 5 },
			],
		};
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-wait",
			toolName: "wait",
			result: { content: [{ type: "text", text: "Job1 finished; Job2 is still running." }], details },
			isError: false,
		});
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-wait",
			toolName: "wait",
			args: {},
		});
		const component = firstCard(ctx)!;
		sealed.push(component);
		ctx.toolOutputExpanded = true;
		expect(transcriptText(ctx.shell, 120)).toContain("Job1 Finished work");
		expect(pendingTools.has("tc-wait")).toBe(false);
		expect(isSettled(component.block.node)).toBe(true);
	});

	it("seals a foreground card orphaned before the next agent turn", async () => {
		const { controller, ctx } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-stale",
			toolName: "wait",
			args: {},
		});
		const component = firstCard(ctx);
		if (!component) throw new Error("expected stale wait card");
		sealed.push(component);
		// Model a dropped live completion: the timeline still owns the card but
		// its pending-map entry is gone, so agent_end cannot find it.
		ctx.pendingTools.delete("tc-stale");
		const later = ctx.presentToolCall({
			name: "bash",
			args: { command: "echo done" },
			tool: undefined,
			id: "tc-later",
			cwd: process.cwd(),
		});
		sealed.push(later);
		later.updateResult({ content: [{ type: "text", text: "done" }] }, false, "tc-later");

		// The live card at the frontier pins retirement of everything after it.
		expect(isSettled(component.block.node)).toBe(false);
		await controller.handleEvent({ type: "agent_start" });

		expect(isSettled(component.block.node)).toBe(true);
	});

	it("keeps an executing wait card repainting across a turn boundary", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-wait",
			toolName: "wait",
			args: {},
		});
		const component = pendingTools.get("tc-wait")!;
		sealed.push(component);
		component.call!.setExpanded(true);
		const painted = () => blockText(component.block, 100);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-wait",
			toolName: "wait",
			args: {},
			partialResult: waitResult("running", 757_000),
		});
		expect(painted()).toContain("12m37s");

		// A new turn starts while the wait is still executing.
		await controller.handleEvent({ type: "agent_start" });
		expect(pendingTools.get("tc-wait")).toBe(component);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-wait",
			toolName: "wait",
			args: {},
			partialResult: waitResult("running", 915_000),
		});
		expect(painted()).toContain("15m15s");

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-wait",
			toolName: "wait",
			result: waitResult("completed", 916_000),
			isError: false,
		});
		expect(painted()).toContain("15m16s");
		expect(pendingTools.has("tc-wait")).toBe(false);
		expect(isSettled(component.block.node)).toBe(true);
	});

	it("settles a read group closed before a turn boundary once its in-flight read ends", async () => {
		const { controller, ctx } = createFixture();
		// The streamed call creates the group; its start then marks the read executing.
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: "a.ts" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			stopReason: "toolUse",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		await controller.handleEvent({ type: "message_start", message });
		await controller.handleEvent({ type: "message_update", message } as AgentSessionEvent);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-read",
			toolName: "read",
			args: { path: "a.ts" },
		});
		const group = ctx.pendingTools.get("tc-read")!;
		sealed.push(group);
		// A later non-read call closes the read group to new reads.
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-bash",
			toolName: "bash",
			args: { command: "sleep 9" },
		});
		sealed.push(ctx.pendingTools.get("tc-bash")!);

		// A new turn starts while the read is still executing.
		await controller.handleEvent({ type: "agent_start" });
		expect(ctx.pendingTools.get("tc-read")).toBe(group);
		expect(isSettled(group.block.node)).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-read",
			toolName: "read",
			result: { content: [{ type: "text", text: "x" }], isError: false },
			isError: false,
		});
		expect(isSettled(group.block.node)).toBe(true);
	});

	it("keeps a parked task card available across the next agent turn", async () => {
		const { controller, pendingTools } = createFixture();
		const component = await startTask(controller, pendingTools);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("running", "Spawned agent `Job1` (job `Job1`)."),
			isError: false,
		});

		await controller.handleEvent({ type: "agent_start" });

		expect(pendingTools.get("tc-task")).toBe(component);
	});
});
