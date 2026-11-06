/**
 * Repeated `wait` calls must not stack "waiting on N jobs" frames in the
 * transcript: a wait whose watched jobs are all still running stays live
 * (displaceable) and the next `wait` call replaces it — one persistent wait.
 *
 * Contracts under test:
 *  - ToolExecutionComponent: a waiting-poll result stays displaceable but
 *    finalizes like any other settled result (so it can retire as history
 *    instead of pinning the live viewport); seal() always freezes.
 *  - EventController: a follow-up `wait` call removes the tracked waiting
 *    poll from the transcript; any other tool seals it in place.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent, type ToolExecutionHandle } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

type JobStatus = "running" | "completed" | "failed" | "cancelled";

function pollResult(statuses: JobStatus[], extra: { cancelled?: boolean; isError?: boolean } = {}) {
	return {
		content: [{ type: "text" as const, text: "" }],
		isError: extra.isError,
		details: {
			op: "wait" as const,
			jobs: statuses.map((status, i) => ({
				id: `j${i}`,
				type: "task" as const,
				status,
				label: `job ${i}`,
				durationMs: 1_000,
			})),
			...(extra.cancelled ? { cancelled: [{ id: "j0", status: "cancelled" as const }] } : {}),
		},
	};
}

function todoResult(items = ["investigate", "fix"]) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {
			phases: [
				{
					name: "Workflow",
					tasks: items.map((content, index) => ({
						content,
						status: index === 0 ? ("in_progress" as const) : ("pending" as const),
					})),
				},
			],
			storage: "memory" as const,
		},
	};
}

function trackComponent(components: ToolExecutionComponent[], component: ToolExecutionComponent) {
	components.push(component);
	return component;
}

// Shared across the displacement suites; each suite's afterEach seals and
// drains everything its tests created.
const created: ToolExecutionComponent[] = [];

function createFixture() {
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const ctx = createInteractiveModeContext({ pendingTools });
	const children = ctx.chatContainer.children;
	return { controller: new EventController(ctx), ctx, children, pendingTools };
}

/** Finalized one-row filler block, standing in for the short rows a busy turn streams. */
function addFiller(ctx: { chatContainer: TranscriptContainer }, label: string): void {
	ctx.chatContainer.addChild(new Text(label));
}

/** One retirement frame: commit exactly the settled prefix a `capacity`-row live area loses. */
function pressureRetire(ctx: { chatContainer: TranscriptContainer }, capacity: number): void {
	const batch = ctx.chatContainer.peekFinalizedBatch(80, capacity);
	if (batch !== undefined) ctx.chatContainer.acknowledgeFinalizedBatch(batch.id);
}

async function runPoll(controller: EventController, children: Component[], toolCallId: string) {
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "wait",
		args: {},
	});
	const component = children[children.length - 1] as ToolExecutionComponent;
	trackComponent(created, component);
	await controller.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "wait",
		result: pollResult(["running", "running"]),
		isError: false,
	});
	return component;
}

async function runTodo(controller: EventController, children: Component[], toolCallId: string, items?: string[]) {
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName: "todo",
		args: { op: "view" },
	});
	const component = children[children.length - 1] as ToolExecutionComponent;
	trackComponent(created, component);
	await controller.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName: "todo",
		result: todoResult(items),
		isError: false,
	});
	return component;
}

describe("wait block lifecycle", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		// Seal everything so displaceable blocks' spinner intervals never leak
		// into later test files.
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function makeJobComponent() {
		return trackComponent(created, new ToolExecutionComponent("wait", {}, {}, undefined, uiStub));
	}

	it("keeps an all-running poll displaceable yet finalized until sealed", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["running", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("waiting on 2 jobs");
	});

	it("finalizes a poll that observed a settled job", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["completed", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that carried cancel outcomes or an error", () => {
		const cancelled = makeJobComponent();
		cancelled.updateResult(pollResult(["running"], { cancelled: true }), false);
		expect(cancelled.isDisplaceableBlock()).toBe(false);

		const errored = makeJobComponent();
		errored.updateResult(pollResult(["running"], { isError: true }), false);
		expect(errored.isDisplaceableBlock()).toBe(false);
		expect(errored.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps successful todo snapshots displaceable yet finalized", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("todo", { op: "view" }, {}, undefined, uiStub),
		);
		component.updateResult(todoResult(), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("never marks ordinary non-refresh tools displaceable", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub),
		);
		component.updateResult(pollResult(["running"]), false);
		expect(component.isDisplaceableBlock()).toBe(false);
	});
});

describe("EventController displaces consecutive waiting polls", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("removes the previous waiting poll when the next wait call starts", async () => {
		const { controller, children } = createFixture();

		const first = await runPoll(controller, children, "t1");
		expect(children).toContain(first);

		const second = await runPoll(controller, children, "t2");

		// The stale "waiting" frame is gone; only the fresh poll remains.
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		// The displaced block is sealed so its spinner interval is stopped.
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps a waiting snapshot beside its completed turn's usage when the next wait starts", async () => {
		const { controller, children } = createFixture();
		const first = await runPoll(controller, children, "t1");
		const metrics = createUsageRowBlock({
			input: 4242,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4249,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		children.push(metrics);
		await runPoll(controller, children, "t2");
		expect(children).toContain(first);
		expect(children.indexOf(first)).toBe(children.indexOf(metrics) - 1);
		expect(Bun.stripANSI(first.render(100).join("\n"))).toContain("waiting on");
		expect(Bun.stripANSI(metrics.render(100).join("\n"))).toContain("4.2K");
	});

	it("seals the waiting poll in place when a different tool runs next", async () => {
		const { controller, children } = createFixture();

		const poll = await runPoll(controller, children, "t1");
		expect(poll.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "ls" },
		});
		trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		// The poll frame stays — it is final history now, not displaceable.
		expect(children).toContain(poll);
		expect(poll.isTranscriptBlockFinalized()).toBe(true);
		expect(poll.isDisplaceableBlock()).toBe(false);
	});

	it("removes the previous todo snapshot when a later todo update lands in the same turn", async () => {
		const { controller, children } = createFixture();

		const first = await runTodo(controller, children, "todo-1", ["plan", "read"]);
		expect(children).toContain(first);
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "true" },
		});
		const bash = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		expect(children).toContain(first);
		expect(children).toContain(bash);

		const second = await runTodo(controller, children, "todo-2", ["fix", "test"]);

		expect(children).not.toContain(first);
		expect(children).toContain(bash);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("displaces a prior todo snapshot when a streamed second todo lands a successful result", async () => {
		const { controller, children, pendingTools } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-1",
			toolName: "todo",
			args: { op: "view" },
		});
		const first = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		const second = trackComponent(created, new ToolExecutionComponent("todo", { op: "view" }, {}, undefined, uiStub));
		children.push(second);
		pendingTools.set("todo-2", second);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
			result: todoResult(["plan", "read"]),
			isError: false,
		});
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "true" },
		});
		const bash = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		expect(children).toContain(first);
		expect(children).toContain(second);
		expect(children).toContain(bash);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-2",
			toolName: "todo",
			args: { op: "view" },
		});

		// Start alone is no longer enough — the prior snapshot stays so a failed
		// follow-up cannot strand the user without a current todo panel.
		expect(children).toContain(first);
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-2",
			toolName: "todo",
			result: todoResult(["fix", "test"]),
			isError: false,
		});

		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(children).toContain(bash);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps the prior todo snapshot when a follow-up todo errors", async () => {
		const { controller, children } = createFixture();

		const first = await runTodo(controller, children, "todo-1", ["plan", "read"]);
		expect(children).toContain(first);
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-2",
			toolName: "todo",
			args: { op: "view" },
		});
		const errored = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-2",
			toolName: "todo",
			result: { content: [{ type: "text", text: "Phase missing" }], details: undefined, isError: true },
			isError: true,
		});

		expect(children).toContain(first);
		expect(children).toContain(errored);
		expect(first.isDisplaceableBlock()).toBe(true);
	});

	it("does not displace a poll that observed completions", async () => {
		const { controller, children } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "wait",
			args: {},
		});
		const settled = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "wait",
			result: pollResult(["completed", "running"]),
			isError: false,
		});

		const next = await runPoll(controller, children, "t2");

		// A poll that carried real results is kept as history.
		expect(children).toContain(settled);
		expect(children).toContain(next);
	});
});

describe("#12248 completed wait turn replay", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgDisplayShowTokenUsage.set(settings, true);
		await initTheme();
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	function waitTurn(id: string, input: number): AgentMessage[] {
		return [
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "wait", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input,
					output: 7,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input + 7,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "wait",
				...pollResult(["running"]),
				isError: false,
				timestamp: Date.now(),
			},
		] satisfies AgentMessage[];
	}

	it.each(["session", "transcript"] as const)("retains each wait with its original metrics in %s replay", mode => {
		const messages = [...waitTurn("w1", 4242), ...waitTurn("w2", 2121)];
		let children: Component[];
		if (mode === "session") {
			const ctx = createInteractiveModeContext({ settings: Settings.isolated({ "display.showTokenUsage": true }) });
			const helpers = new UiHelpers(ctx);
			ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
			helpers.renderSessionContext({ messages } as SessionContext);
			children = ctx.chatContainer.children;
		} else {
			const builder = new ChatTranscriptBuilder({ ui: uiStub, cwd: process.cwd(), requestRender() {} });
			builder.rebuild(
				messages.map((message, i) => ({
					type: "message" as const,
					id: `m${i}`,
					parentId: i ? `m${i - 1}` : null,
					timestamp: new Date(0).toISOString(),
					message,
				})),
			);
			children = builder.container.children;
		}
		const polls = children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		for (const poll of polls) poll.seal();
		expect(polls).toHaveLength(2);
		const output = children.map(child => Bun.stripANSI(child.render(120).join("\n")));
		for (const [i, label] of ["4.2K", "2.1K"].entries()) {
			const pollIndex = children.indexOf(polls[i]);
			expect(output[pollIndex]).toContain("waiting on");
			expect(output[pollIndex + 1]).toContain(label);
			expect(output.filter(text => text.includes(label))).toHaveLength(1);
		}
	});
});

/**
 * Transcript-pressure displacement: under a busy transcript the tracked poll /
 * todo snapshot must survive pressure retirement long enough to be displaced.
 * Today the pressure-commit walk sweeps the settled snapshot into committed
 * history while it is still tracked, so the follow-up `wait`/`todo` finds
 * `canDisplaceBlock` refused (committed rows are an immutable tape) and stacks
 * a duplicate card instead.
 */
describe("displacement survives viewport-pressure retirement", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("displaces the tracked poll even when pressure retired the transcript below it", async () => {
		const { controller, ctx, children } = createFixture();
		for (let i = 0; i < 6; i++) addFiller(ctx, `before ${i}`);
		const first = await runPoll(controller, children, "t1");
		for (let i = 0; i < 6; i++) addFiller(ctx, `after ${i}`);

		// The live tail outgrows the viewport; the settled prefix enters scrollback.
		pressureRetire(ctx, 2);
		expect(ctx.chatContainer.blockStates()[0]).toBe("committed");

		const second = await runPoll(controller, children, "t2");
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps the held poll uncommitted while it is the partially visible pressure boundary", async () => {
		const { controller, ctx, children } = createFixture();
		for (let i = 0; i < 6; i++) addFiller(ctx, `before ${i}`);
		const first = await runPoll(controller, children, "t1");

		// Retire the fillers ahead of the poll; the tracked poll becomes the
		// held live frontier.
		pressureRetire(ctx, 1);
		expect(ctx.chatContainer.blockStates().slice(0, 6)).toEqual(Array(6).fill("committed"));
		for (let i = 0; i < 2; i++) addFiller(ctx, `after ${i}`);

		// The held poll is the partially visible boundary (room 5 - tailRows
		// 3 - separator 1 = 1 visible row): pressured frames must decline the
		// retirement instead of freezing the tracked card into the tape —
		// a committed or emitted poll refuses displacement and the follow-up
		// wait stacks a duplicate card.
		pressureRetire(ctx, 5);
		pressureRetire(ctx, 5);
		expect(ctx.chatContainer.blockStates()[children.indexOf(first)]).toBe("settled");

		// The follow-up poll still displaces the snapshot; no duplicate ever
		// reached the committed ledger.
		const second = await runPoll(controller, children, "t2");
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);

		ctx.chatContainer.beginReplay();
		const replay = ctx.chatContainer.peekReplayBatch(80);
		const rows = (replay?.rows ?? []).map(row => Bun.stripANSI(row));
		expect(rows.filter(row => row.includes("waiting on"))).toHaveLength(0);
	});

	it("keeps the held todo snapshot uncommitted while it is the partially visible pressure boundary", async () => {
		const { controller, ctx, children } = createFixture();
		for (let i = 0; i < 4; i++) addFiller(ctx, `before ${i}`);
		const first = await runTodo(controller, children, "todo-1", ["plan", "read", "fix", "land"]);

		// Retire the fillers ahead of the snapshot; the tracked todo becomes
		// the held live frontier.
		pressureRetire(ctx, 1);
		expect(ctx.chatContainer.blockStates().slice(0, 4)).toEqual(Array(4).fill("committed"));

		// The snapshot straddles the viewport top (room 2 leaves visible
		// rows of it on screen): pressured frames must decline the retirement
		// instead of releasing the hold into a split-commit — an emitted or
		// committed snapshot refuses displacement and the follow-up todo
		// stacks a duplicate panel.
		pressureRetire(ctx, 2);
		pressureRetire(ctx, 2);
		expect(ctx.chatContainer.blockStates()[children.indexOf(first)]).toBe("settled");
		expect(ctx.chatContainer.emittedStableRows()[children.indexOf(first)]).toBe(0);

		// The follow-up todo still displaces the snapshot; no duplicate ever
		// reached the committed ledger.
		const second = await runTodo(controller, children, "todo-2", ["fix", "test"]);
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);

		ctx.chatContainer.beginReplay();
		const replay = ctx.chatContainer.peekReplayBatch(80);
		const rows = (replay?.rows ?? []).map(row => Bun.stripANSI(row));
		expect(rows.filter(row => row.includes("Todo") && row.includes("tasks"))).toHaveLength(0);
	});

	it("displaces the tracked todo snapshot under the same pressure", async () => {
		const { controller, ctx, children } = createFixture();
		for (let i = 0; i < 6; i++) addFiller(ctx, `before ${i}`);
		const first = await runTodo(controller, children, "todo-1", ["plan", "read"]);
		for (let i = 0; i < 6; i++) addFiller(ctx, `after ${i}`);

		pressureRetire(ctx, 2);
		expect(ctx.chatContainer.blockStates()[0]).toBe("committed");

		const second = await runTodo(controller, children, "todo-2", ["fix", "test"]);
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("lets a sealed poll retire as history under pressure", async () => {
		const { controller, ctx, children } = createFixture();
		const poll = await runPoll(controller, children, "t1");

		// A different tool seals the poll in place; the tracker releases it, so
		// pressure must be allowed to commit it like any other settled history.
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "b1",
			toolName: "bash",
			args: { command: "ls" },
		});
		expect(poll.isDisplaceableBlock()).toBe(false);

		pressureRetire(ctx, 2);
		expect(ctx.chatContainer.blockStates()[children.indexOf(poll)]).toBe("committed");
	});

	it("keeps ctrl+t-style full replay free of duplicates after pressure displacement", async () => {
		const { controller, ctx, children } = createFixture();
		for (let i = 0; i < 6; i++) addFiller(ctx, `before ${i}`);
		const first = await runPoll(controller, children, "t1");
		for (let i = 0; i < 6; i++) addFiller(ctx, `after ${i}`);
		pressureRetire(ctx, 2);
		await runPoll(controller, children, "t2");
		expect(children).not.toContain(first);

		ctx.chatContainer.beginReplay();
		const replay = ctx.chatContainer.peekReplayBatch(80);
		const rows = (replay?.rows ?? []).map(row => Bun.stripANSI(row));
		// Committed non-poll content replays exactly once (rows are width-padded).
		for (let i = 0; i < 6; i++) expect(rows.filter(row => row.trim() === `before ${i}`)).toHaveLength(1);
		// No displaced poll card leaked into the committed ledger.
		expect(rows.filter(row => row.includes("waiting on"))).toHaveLength(0);
	});
});

/**
 * Held-completion and seal-abandon lifecycle holes: a `wait` completion that
 * outran its card settles through `#settleHeldCompletion`, which previously
 * never tracked the settled poll — the follow-up `wait` stacked beside it. And
 * the agent-start seal sweep sealed a still-tracked poll while leaving it held,
 * so the sealed block could never retire as ordinary history.
 */
describe("held completion settle and seal-abandon release tracked polls", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("tracks a poll settled from a held completion so a follow-up wait displaces it", async () => {
		const { controller, children } = createFixture();

		// The completion outruns the streamed card: no component exists yet, so
		// the result is held in the orphan set instead of being dropped.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "w1",
			toolName: "wait",
			result: pollResult(["running", "running"]),
			isError: false,
		});

		// The card is created after the fact and adopts the held completion.
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "w1",
			toolName: "wait",
			args: {},
		});
		const settled = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		expect(settled.isDisplaceableBlock()).toBe(true);

		const followUp = await runPoll(controller, children, "w2");

		expect(children).not.toContain(settled);
		expect(children).toContain(followUp);
		expect(settled.isTranscriptBlockFinalized()).toBe(true);
	});

	it("releases the tracked poll when the agent-start sweep seals abandoned cards", async () => {
		const { controller, ctx, children } = createFixture();
		for (let i = 0; i < 6; i++) addFiller(ctx, `before ${i}`);
		const poll = await runPoll(controller, children, "t1");
		expect(poll.isDisplaceableBlock()).toBe(true);
		for (let i = 0; i < 6; i++) addFiller(ctx, `after ${i}`);

		// A new agent turn cannot inherit a foreground tool execution: the sweep
		// seals the card — and must release its hold with the tracker, or the
		// sealed block could never retire as ordinary history.
		await controller.handleEvent({ type: "agent_start" });
		expect(poll.isTranscriptBlockFinalized()).toBe(true);
		expect(poll.isDisplaceableBlock()).toBe(false);

		// The live tail outgrows the viewport; the released, sealed poll retires
		// as ordinary history.
		pressureRetire(ctx, 2);
		expect(ctx.chatContainer.blockStates()[children.indexOf(poll)]).toBe("committed");

		const next = await runPoll(controller, children, "t2");
		expect(children).toContain(next);
	});
});

describe("UiHelpers.renderSessionContext collapses repeated todo snapshots", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes the earlier todo snapshot when an assistant message replays two todo calls", () => {
		const ctx = createInteractiveModeContext();
		const chatContainer = ctx.chatContainer;
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } },
				{ type: "toolCall", id: "todo-2", name: "todo", arguments: { op: "view" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const firstResult = {
			role: "toolResult",
			toolCallId: "todo-1",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["plan", "read"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const secondResult = {
			role: "toolResult",
			toolCallId: "todo-2",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["fix", "test"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		helpers.renderSessionContext({ messages: [assistant, firstResult, secondResult] } as SessionContext);

		const todos = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		// Only the latest todo snapshot survives the rebuild; the trailing one is
		// sealed as final history by the end-of-rebuild flush.
		expect(todos).toHaveLength(1);
		expect(todos[0].isTranscriptBlockFinalized()).toBe(true);
	});

	it("hands the trailing todo snapshot to the controller during mid-turn rebuild", () => {
		const ctx = createInteractiveModeContext({ session: { isStreaming: true } });
		const chatContainer = ctx.chatContainer;
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
		const eventController = new EventController(ctx);
		ctx.eventController = eventController;
		const inheritDisplaceableTodo = vi.spyOn(eventController, "inheritDisplaceableTodo");

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const result = {
			role: "toolResult",
			toolCallId: "todo-1",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["plan", "read"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		helpers.renderSessionContext({ messages: [assistant, result] } as SessionContext);

		const todos = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		expect(todos).toHaveLength(1);
		// Mid-turn rebuild hands the live tail back to the controller — the
		// snapshot stays displaceable so a follow-up `todo` event replaces it
		// instead of stacking another panel.
		expect(inheritDisplaceableTodo).toHaveBeenCalledTimes(1);
		expect(inheritDisplaceableTodo).toHaveBeenCalledWith(todos[0]);
		expect(todos[0].canBeDisplacedBy("todo")).toBe(true);
		expect(todos[0].isTranscriptBlockFinalized()).toBe(true);
	});
});
