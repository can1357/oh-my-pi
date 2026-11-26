/**
 * Repeated `wait` calls must not stack "waiting on N jobs" frames in the
 * transcript: a wait whose watched jobs are all still running stays
 * displaceable and the next `wait` call replaces it — one persistent wait.
 *
 * Contracts under test:
 *  - displaceableBy: a waiting-poll result (and a successful todo snapshot) is
 *    displaceable until sealed; anything else is not.
 *  - EventController: a follow-up `wait` call removes the tracked waiting
 *    poll from the transcript; any other tool seals it in place. A todo
 *    snapshot holds no later output out of scrollback, and one whose rows
 *    reached scrollback stays there when the next update lands.
 *  - UiHelpers.renderSessionContext: replay collapses the same runs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext, PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { displaceableBy } from "@oh-my-pi/pi-coding-agent/modes/utils/displaceable";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { isSettled } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";

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

/** A one-phase todo snapshot; `completed` tasks are done by this update (its card strikes them through). */
function todoResult(items = ["investigate", "fix"], completed: readonly string[] = []) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {
			phases: [
				{
					name: "Workflow",
					tasks: items.map((content, index) => ({
						content,
						status: completed.includes(content)
							? ("completed" as const)
							: index === 0
								? ("in_progress" as const)
								: ("pending" as const),
					})),
				},
			],
			storage: "memory" as const,
			...(completed.length > 0
				? { completedTasks: completed.map(content => ({ phase: "Workflow", content })) }
				: {}),
		},
	};
}

const usage = (input: number) => ({
	input,
	output: 7,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + 7,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

interface Fixture {
	readonly ctx: InteractiveModeContext;
	readonly controller: EventController;
	readonly created: PendingTool[];
}

/** Start a tool through the controller and return its card. */
async function start(fixture: Fixture, toolCallId: string, toolName: string, args: unknown): Promise<PendingTool> {
	await fixture.controller.handleEvent({
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	});
	const tool = fixture.ctx.pendingTools.get(toolCallId)!;
	fixture.created.push(tool);
	return tool;
}

async function end(
	fixture: Fixture,
	toolCallId: string,
	toolName: string,
	result: {
		content: { type: "text"; text: string }[];
		details?: unknown;
		isError?: boolean;
	},
): Promise<void> {
	await fixture.controller.handleEvent({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result,
		isError: result.isError === true,
	});
}

async function run(
	fixture: Fixture,
	toolCallId: string,
	toolName: string,
	args: unknown,
	result: Parameters<typeof end>[3],
) {
	const tool = await start(fixture, toolCallId, toolName, args);
	await end(fixture, toolCallId, toolName, result);
	return tool;
}

const shown = (fixture: Fixture, tool: PendingTool) => fixture.ctx.shell.transcript.blocks().includes(tool.block);

/** The plain theme with struck text marked `~text~` (the plain one draws it unstyled). */
const STRIKE_THEME: Theme = {
	...PLAIN_THEME,
	style: (tokens, text) => (tokens?.split(" ").includes("strike") ? `~${text}~` : PLAIN_THEME.style(tokens, text)),
};

/** A 12-row terminal drawing the fixture's transcript; `replays` counts scrollback rewrites. */
function attachTerminal(fixture: Fixture): { readonly term: TestTerminal; readonly replays: () => number } {
	const transcript = fixture.ctx.shell.transcript;
	const term = createTestTerminal(() => ({ main: transcript.nodes }), {
		columns: 80,
		rows: 12,
		theme: STRIKE_THEME,
		separator: transcript.separator,
	});
	let replays = 0;
	transcript.attach({
		retired: node => term.backend.retired(node),
		replayHistory: () => replays++,
		redescribe: () => {},
	});
	return { term, replays: () => replays };
}

/** Run `count` bash calls printing `out-<i>`: more than the 12-row terminal holds. */
async function runOutputs(fixture: Fixture, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		await run(
			fixture,
			`bash-${i}`,
			"bash",
			{ command: `echo ${i}` },
			{ content: [{ type: "text", text: `out-${i}` }] },
		);
	}
}

describe("wait and todo displacement", () => {
	let fixture: Fixture;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const ctx = createInteractiveModeContext();
		fixture = { ctx, controller: new EventController(ctx), created: [] };
	});

	afterEach(() => {
		// Seal everything so displaceable cards' spinners never leak into later files.
		for (const tool of fixture.created.splice(0)) tool.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps an all-running poll displaceable until sealed", async () => {
		const poll = await run(fixture, "t1", "wait", {}, pollResult(["running", "running"]));
		expect(displaceableBy(poll)).toBe("wait");

		poll.seal();
		expect(displaceableBy(poll)).toBeUndefined();
		expect(isSettled(poll.block.node)).toBe(true);
		expect(renderTranscript(fixture.ctx).join("\n")).toContain("waiting on 2 jobs");
	});

	it("does not make a poll that observed a settled job displaceable", async () => {
		const poll = await run(fixture, "t1", "wait", {}, pollResult(["completed", "running"]));
		expect(displaceableBy(poll)).toBeUndefined();
	});

	it("does not make a poll that carried cancel outcomes or an error displaceable", async () => {
		const cancelled = await run(fixture, "t1", "wait", {}, pollResult(["running"], { cancelled: true }));
		expect(displaceableBy(cancelled)).toBeUndefined();

		const errored = await run(fixture, "t2", "wait", {}, pollResult(["running"], { isError: true }));
		expect(displaceableBy(errored)).toBeUndefined();
	});

	it("keeps a successful todo snapshot displaceable until sealed", async () => {
		const todo = await run(fixture, "todo-1", "todo", { op: "view" }, todoResult());
		expect(displaceableBy(todo)).toBe("todo");

		todo.seal();
		expect(displaceableBy(todo)).toBeUndefined();
	});

	it("never makes ordinary tools displaceable", async () => {
		const bash = await run(fixture, "b1", "bash", { command: "ls" }, pollResult(["running"]));
		expect(displaceableBy(bash)).toBeUndefined();
	});

	it("removes the previous waiting poll when the next wait call starts", async () => {
		const first = await run(fixture, "t1", "wait", {}, pollResult(["running", "running"]));
		expect(shown(fixture, first)).toBe(true);

		const second = await run(fixture, "t2", "wait", {}, pollResult(["running", "running"]));

		// The stale "waiting" frame is gone; only the fresh poll remains, and the displaced one is sealed.
		expect(shown(fixture, first)).toBe(false);
		expect(shown(fixture, second)).toBe(true);
		expect(displaceableBy(first)).toBeUndefined();
		expect(renderTranscript(fixture.ctx).join("\n").split("waiting on 2 jobs")).toHaveLength(2);
	});

	it("keeps a waiting poll beside the usage row that landed below it when the next wait starts", async () => {
		cfgDisplayShowTokenUsage.set(settings, true);
		const first = await run(fixture, "t1", "wait", {}, pollResult(["running", "running"]));
		const message = assistantCalls([], 4242);
		await fixture.controller.handleEvent({ type: "message_start", message });
		await fixture.controller.handleEvent({ type: "message_end", message });
		await run(fixture, "t2", "wait", {}, pollResult(["running", "running"]));

		expect(shown(fixture, first)).toBe(true);
		const rows = renderTranscript(fixture.ctx);
		const poll = rows.findIndex(row => row.includes("waiting on"));
		expect(poll).toBeGreaterThanOrEqual(0);
		expect(rows.findIndex(row => row.includes("4.2K"))).toBeGreaterThan(poll);
	});

	it("seals the waiting poll in place when a different tool runs next", async () => {
		const poll = await run(fixture, "t1", "wait", {}, pollResult(["running"]));
		expect(displaceableBy(poll)).toBe("wait");

		await start(fixture, "t2", "bash", { command: "ls" });

		// The poll frame stays as final history, no longer displaceable.
		expect(shown(fixture, poll)).toBe(true);
		expect(displaceableBy(poll)).toBeUndefined();
		expect(isSettled(poll.block.node)).toBe(true);
	});

	it("removes the previous todo snapshot when a later todo update lands in the same turn", async () => {
		const first = await run(fixture, "todo-1", "todo", { op: "view" }, todoResult(["plan", "read"]));
		const bash = await start(fixture, "bash-1", "bash", { command: "true" });
		expect(shown(fixture, first)).toBe(true);
		expect(shown(fixture, bash)).toBe(true);

		const second = await run(fixture, "todo-2", "todo", { op: "view" }, todoResult(["fix", "test"]));

		expect(shown(fixture, first)).toBe(false);
		expect(shown(fixture, bash)).toBe(true);
		expect(shown(fixture, second)).toBe(true);
		expect(displaceableBy(first)).toBeUndefined();
	});

	it("displaces a prior todo snapshot only once a streamed second todo lands a successful result", async () => {
		const first = await start(fixture, "todo-1", "todo", { op: "view" });
		// The second call's card already streamed in before the first one finished.
		const second = fixture.ctx.presentToolCall({
			name: "todo",
			args: { op: "view" },
			tool: undefined,
			id: "todo-2",
			cwd: process.cwd(),
		});
		fixture.ctx.pendingTools.set("todo-2", second);
		fixture.created.push(second);

		await end(fixture, "todo-1", "todo", todoResult(["plan", "read"]));
		expect(displaceableBy(first)).toBe("todo");

		const bash = await start(fixture, "bash-1", "bash", { command: "true" });
		await fixture.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-2",
			toolName: "todo",
			args: { op: "view" },
		});

		// Start alone is not enough: a failed follow-up must not strand the user without a todo panel.
		expect(shown(fixture, first)).toBe(true);
		expect(displaceableBy(first)).toBe("todo");

		await end(fixture, "todo-2", "todo", todoResult(["fix", "test"]));

		expect(shown(fixture, first)).toBe(false);
		expect(shown(fixture, second)).toBe(true);
		expect(shown(fixture, bash)).toBe(true);
	});

	it("keeps the prior todo snapshot when a follow-up todo errors", async () => {
		const first = await run(fixture, "todo-1", "todo", { op: "view" }, todoResult(["plan", "read"]));
		const errored = await run(
			fixture,
			"todo-2",
			"todo",
			{ op: "view" },
			{
				content: [{ type: "text", text: "Phase missing" }],
				isError: true,
			},
		);

		expect(shown(fixture, first)).toBe(true);
		expect(shown(fixture, errored)).toBe(true);
		expect(displaceableBy(first)).toBe("todo");
	});

	it("lets the output after a todo snapshot reach scrollback", async () => {
		const { term } = attachTerminal(fixture);
		try {
			await run(fixture, "todo-1", "todo", { op: "view" }, todoResult(["plan", "read"]));
			// More output than the screen holds: a live snapshot held it all off scrollback, and the
			// screen squeezed it to the todo's row, a clipped card and the newest output.
			await runOutputs(fixture, 8);
			term.render();

			const rows = [...term.history().map(stripEscapes), ...term.screen()].join("\n");
			for (let i = 0; i < 8; i++) expect(rows).toContain(`out-${i}`);
		} finally {
			fixture.ctx.shell.transcript.attach(undefined);
			term.dispose();
		}
	});

	it("keeps a todo snapshot already in scrollback when a later todo update lands", async () => {
		const { term, replays } = attachTerminal(fixture);
		try {
			const first = await run(fixture, "todo-1", "todo", { op: "view" }, todoResult(["plan", "read"]));
			await runOutputs(fixture, 8);
			term.render();
			const second = await run(fixture, "todo-2", "todo", { op: "view" }, todoResult(["fix", "test"]));
			term.render();

			// Removing it would rewrite all of scrollback; it stays as history instead.
			expect(shown(fixture, first)).toBe(true);
			expect(shown(fixture, second)).toBe(true);
			expect(replays()).toBe(0);
			expect(term.history().map(stripEscapes).join("\n")).toContain("plan");
		} finally {
			fixture.ctx.shell.transcript.attach(undefined);
			term.dispose();
		}
	});

	it("plays a live todo card's strike on screen and keeps it out of scrollback until it is over", async () => {
		vi.useFakeTimers();
		const { term } = attachTerminal(fixture);
		try {
			const todo = await run(fixture, "todo-1", "todo", { op: "done" }, todoResult(["plan", "read"], ["plan"]));
			term.render();
			// The completed task starts unstruck and the strike sweeps across it while the card is live.
			expect(term.screen().find(line => line.includes("plan"))).not.toContain("~");
			term.tick(2_000);
			expect(term.screen().find(line => line.includes("plan"))).toContain("~plan~");
			expect(isSettled(todo.block.node)).toBe(false);

			await runOutputs(fixture, 8);
			term.render();
			// In scrollback the card could not have played it.
			expect(term.backend.retired(todo.block.node)).toBe(false);
			vi.advanceTimersByTime(2_000);
			term.render();
			expect(term.history().join("\n")).toContain("~plan~");
		} finally {
			vi.useRealTimers();
			fixture.ctx.shell.transcript.attach(undefined);
			term.dispose();
		}
	});

	it("lets replies after a todo card hidden with tool activity reach scrollback at once", async () => {
		vi.useFakeTimers();
		fixture.ctx.hideToolActivity = true;
		const { term } = attachTerminal(fixture);
		try {
			await run(fixture, "todo-1", "todo", { op: "done" }, todoResult(["plan", "read"], ["plan"]));
			// The hidden card draws no strike: holding it live would keep every reply off scrollback.
			for (let i = 0; i < 12; i++) {
				const message = { ...assistantCalls([]), content: [{ type: "text", text: `reply-${i}` }] } as AgentMessage;
				await fixture.controller.handleEvent({ type: "message_start", message });
				await fixture.controller.handleEvent({ type: "message_end", message });
			}
			term.render();
			expect(term.history().join("\n")).toContain("reply-0");
		} finally {
			vi.useRealTimers();
			fixture.ctx.shell.transcript.attach(undefined);
			term.dispose();
		}
	});

	it("keeps a todo snapshot a later update left in scrollback across a transcript rebuild", async () => {
		const { term } = attachTerminal(fixture);
		const helpers = new UiHelpers(fixture.ctx);
		fixture.ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
		fixture.ctx.eventController = fixture.controller;
		try {
			// Displaced while still on screen: gone live, and gone after the rebuild.
			await run(fixture, "todo-0", "todo", { op: "view" }, todoResult(["draft"]));
			await run(fixture, "todo-1", "todo", { op: "view" }, todoResult(["plan", "read"]));
			await runOutputs(fixture, 8);
			term.render();
			// In scrollback when the next update lands: it stays there.
			await run(fixture, "todo-2", "todo", { op: "view" }, todoResult(["fix", "test"]));

			// An in-place rebuild (`/shake`, a display setting) replays the session's messages.
			fixture.ctx.shell.transcript.retain(new Set());
			helpers.renderSessionContext({
				messages: [
					assistantCalls([{ id: "todo-0", name: "todo", arguments: { op: "view" } }]),
					toolResult("todo-0", "todo", todoResult(["draft"])),
					assistantCalls([{ id: "todo-1", name: "todo", arguments: { op: "view" } }]),
					toolResult("todo-1", "todo", todoResult(["plan", "read"])),
					assistantCalls([{ id: "todo-2", name: "todo", arguments: { op: "view" } }]),
					toolResult("todo-2", "todo", todoResult(["fix", "test"])),
				],
			} as SessionContext);

			const rows = renderTranscript(fixture.ctx).join("\n");
			expect(rows).not.toContain("draft");
			expect(rows).toContain("plan");
			expect(rows).toContain("fix");
		} finally {
			fixture.ctx.shell.transcript.attach(undefined);
			term.dispose();
		}
	});

	it("writes a todo card whose strike never played to scrollback with the tasks struck through", async () => {
		vi.useFakeTimers();
		const { term } = attachTerminal(fixture);
		try {
			await run(fixture, "todo-1", "todo", { op: "done" }, todoResult(["plan", "read"], ["plan"]));
			await runOutputs(fixture, 8);
			// The hold ends with the terminal clock where it was: the strike never advanced (a fullscreen
			// layer covering the transcript, say). Scrollback must still get the finished strike.
			vi.advanceTimersByTime(2_000);
			term.render();
			expect(term.history().join("\n")).toContain("~plan~");
		} finally {
			vi.useRealTimers();
			fixture.ctx.shell.transcript.attach(undefined);
			term.dispose();
		}
	});

	it("does not displace a poll that observed completions", async () => {
		const settled = await run(fixture, "t1", "wait", {}, pollResult(["completed", "running"]));
		const next = await run(fixture, "t2", "wait", {}, pollResult(["running", "running"]));

		// A poll that carried real results is kept as history.
		expect(shown(fixture, settled)).toBe(true);
		expect(shown(fixture, next)).toBe(true);
	});
});

function replayContext(overrides: Parameters<typeof createInteractiveModeContext>[0] = {}) {
	const ctx = createInteractiveModeContext(overrides);
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	return { ctx, helpers };
}

const assistantCalls = (calls: { id: string; name: string; arguments: unknown }[], input = 1): AgentMessage =>
	({
		role: "assistant",
		content: calls.map(call => ({ type: "toolCall", ...call })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: usage(input),
		timestamp: Date.now(),
	}) as AgentMessage;

const toolResult = (toolCallId: string, toolName: string, result: { content: unknown[]; details?: unknown }) =>
	({
		role: "toolResult",
		toolCallId,
		toolName,
		...result,
		isError: false,
		timestamp: Date.now(),
	}) as AgentMessage;

describe("#12248 completed wait turn replay", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => resetSettingsForTest());

	it("retains each wait with its original metrics", () => {
		const messages = [
			assistantCalls([{ id: "w1", name: "wait", arguments: {} }], 4242),
			toolResult("w1", "wait", pollResult(["running"])),
			assistantCalls([{ id: "w2", name: "wait", arguments: {} }], 2121),
			toolResult("w2", "wait", pollResult(["running"])),
		];
		const { ctx, helpers } = replayContext({
			settings: Settings.isolated({ "display.showTokenUsage": true }),
		});
		helpers.renderSessionContext({ messages } as SessionContext);

		const rows = renderTranscript(ctx);
		const polls = rows.flatMap((row, index) => (row.includes("waiting on") ? [index] : []));
		expect(polls).toHaveLength(2);
		for (const [i, label] of ["4.2K", "2.1K"].entries()) {
			const metrics = rows.findIndex(row => row.includes(label));
			expect(metrics).toBeGreaterThan(polls[i]!);
			if (i === 0) expect(metrics).toBeLessThan(polls[1]!);
			expect(rows.filter(row => row.includes(label))).toHaveLength(1);
		}
	});
});

describe("UiHelpers.renderSessionContext collapses repeated todo snapshots", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("removes the earlier todo snapshot when an assistant message replays two todo calls", async () => {
		const { ctx, helpers } = replayContext();
		helpers.renderSessionContext({
			messages: [
				assistantCalls([
					{ id: "todo-1", name: "todo", arguments: { op: "view" } },
					{ id: "todo-2", name: "todo", arguments: { op: "view" } },
				]),
				toolResult("todo-1", "todo", todoResult(["plan", "read"])),
				toolResult("todo-2", "todo", todoResult(["fix", "test"])),
			],
		} as SessionContext);

		const out = renderTranscript(ctx).join("\n");
		expect(out).not.toContain("plan");
		expect(out).toContain("fix");
		// The trailing snapshot is sealed as final history by the end-of-rebuild flush.
		await Promise.resolve();
		expect(ctx.shell.transcript.blocks().every(block => isSettled(block.node))).toBe(true);
	});

	it("hands the trailing todo snapshot to the controller during mid-turn rebuild", () => {
		const { ctx, helpers } = replayContext({ session: { isStreaming: true } });
		const eventController = new EventController(ctx);
		ctx.eventController = eventController;
		const inherit = vi.spyOn(eventController, "inheritDisplaceableTodo");

		helpers.renderSessionContext({
			messages: [
				assistantCalls([{ id: "todo-1", name: "todo", arguments: { op: "view" } }]),
				toolResult("todo-1", "todo", todoResult(["plan", "read"])),
			],
		} as SessionContext);

		// Mid-turn rebuild hands the live tail back so a follow-up `todo` event
		// replaces it instead of stacking another panel.
		expect(inherit).toHaveBeenCalledTimes(1);
		const snapshot = inherit.mock.calls[0]![0]!;
		expect(displaceableBy(snapshot)).toBe("todo");
		snapshot.seal();
	});
});
