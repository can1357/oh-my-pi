/**
 * Contracts: async tool snapshots and foreground execution lifecycle.
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
 * 3. An execution that crosses `agent_start` stays live until its own end, so
 *    subsequent progress and the terminal result continue repainting the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CoordinationDetails } from "@oh-my-pi/pi-coding-agent/tools/hub/types";
import type { TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";
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

function hubResult(status: "running" | "completed", durationMs: number): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: `${status} hub wait` }],
		details: {
			op: "wait",
			jobs: [{ id: "Job1", type: "task", status, label: "Long task", durationMs }],
		},
	};
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

	function createFixture() {
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = createInteractiveModeContext({
			pendingTools,
			session: { isStreaming: true },
			viewSession: { isStreaming: false },
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

	it("keeps an executing foreground card live across the next agent turn", async () => {
		const { controller, pendingTools } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "tc-hub",
			toolName: "hub",
			args: { op: "wait" },
		});
		const component = pendingTools.get("tc-hub");
		if (!component) throw new Error("expected pending Hub card");
		sealed.push(component);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-hub",
			toolName: "hub",
			args: { op: "wait" },
			partialResult: hubResult("running", 757_000),
		});
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("12m37s");

		await controller.handleEvent({ type: "agent_start" });
		expect(pendingTools.get("tc-hub")).toBe(component);

		await controller.handleEvent({
			type: "tool_execution_update",
			toolCallId: "tc-hub",
			toolName: "hub",
			args: { op: "wait" },
			partialResult: hubResult("running", 900_000),
		});
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("15m");

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "tc-hub",
			toolName: "hub",
			result: hubResult("completed", 901_000),
			isError: false,
		});
		expect(pendingTools.has("tc-hub")).toBe(false);
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
