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
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/hub";
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

function bashResult(text: string) {
	const details: BashToolDetails = {
		async: { state: "running", jobId: "bash-1", type: "bash" },
	};
	return { content: [{ type: "text" as const, text }], details };
}

describe("EventController async update finalization", () => {
	const sealed: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of sealed.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture(isStreaming = false) {
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = createInteractiveModeContext({
			pendingTools,
			session: { isStreaming: true },
			viewSession: { isStreaming },
		});
		return { controller: new EventController(ctx), pendingTools, chatContainer: ctx.chatContainer, ctx };
	}

	async function startTask(controller: EventController, pendingTools: Map<string, ToolExecutionComponent>) {
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
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		// The call's own result still lands and finalizes the block.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-task",
			toolName: "task",
			result: taskResult("completed", "Inline results + spawned listing."),
			isError: false,
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
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
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-task",
			toolName: "task",
			args: {},
			partialResult: taskResult("completed", "Background task Job1 complete."),
		});
		expect(pendingTools.has("tc-task")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	for (const arrival of ["early", "replay"] as const) {
		for (const state of ["completed", "failed"] as const) {
			it(`renders the ${state} outcome after a ${arrival} background task result`, async () => {
				const { controller, pendingTools, chatContainer, ctx } = createFixture(true);
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
				const component = chatContainer.children.find(
					(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
				)!;
				sealed.push(component);
				component.setExpanded(true);
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
				expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain(outcome);
				expect(pendingTools.has("tc-task")).toBe(false);
				expect(component.isTranscriptBlockFinalized()).toBe(true);
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
			result: bashResult("Backgrounded as job bash-1; result will be delivered automatically."),
			isError: false,
		});

		expect(pendingTools.has("tc-bash")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("settles an early Hub wait result while another reported job remains running", async () => {
		const { controller, pendingTools, chatContainer } = createFixture();
		const details: CoordinationDetails = {
			op: "wait",
			jobs: [
				{ id: "Job1", type: "task", status: "completed", label: "Finished work", durationMs: 5 },
				{ id: "Job2", type: "task", status: "running", label: "Background work", durationMs: 5 },
			],
		};
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-hub",
			toolName: "hub",
			result: { content: [{ type: "text", text: "Job1 finished; Job2 is still running." }], details },
			isError: false,
		});
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-hub",
			toolName: "hub",
			args: { op: "wait", ids: ["Job1", "Job2"] },
		});
		const component = chatContainer.children.find(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		)!;
		sealed.push(component);
		component.setExpanded(true);
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("Job1 Finished work");
		expect(pendingTools.has("tc-hub")).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("seals a foreground card orphaned before the next agent turn", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-stale",
			toolName: "hub",
			args: { op: "wait", ids: ["job-stale"] },
		});
		const component = chatContainer.children.find(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		if (!component) throw new Error("expected stale Hub card");
		sealed.push(component);
		// Model a dropped live completion: the timeline still owns the card but
		// its pending-map entry is gone, so agent_end cannot find it.
		ctx.pendingTools.delete("tc-stale");
		const later = new ToolExecutionComponent("bash", { command: "echo done" }, {}, undefined, ctx.ui, process.cwd());
		sealed.push(later);
		later.updateResult({ content: [{ type: "text", text: "done" }] });
		chatContainer.addChild(later);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(chatContainer.peekFinalizedBatch(80, 0)).toBeUndefined();
		await controller.handleEvent({ type: "agent_start" });

		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(chatContainer.peekFinalizedBatch(80, 0)?.rows).toBeDefined();
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
