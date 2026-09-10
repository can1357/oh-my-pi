import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getLatestTodoPhasesFromEntries,
	type TodoPhase,
	todoToolRenderer,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import { buildSessionContext } from "../src/session/session-context";
import type { SessionEntry } from "../src/session/session-entries";

const TIMESTAMP = "2026-07-25T00:00:00.000Z";

interface Harness {
	handlers: CursorExecHandlers;
	entries: SessionEntry[];
	events: AgentEvent[];
	current: () => TodoPhase[];
	reload: () => TodoPhase[];
	/** Replays `event-controller.ts`'s todo refresh over the emitted events. */
	uiTodos: () => TodoPhase[] | null;
}

function newHarness(initial: TodoPhase[] = []): Harness {
	const entries: SessionEntry[] = [];
	const events: AgentEvent[] = [];
	let phases = initial;
	const handlers = new CursorExecHandlers({
		cwd: "/tmp",
		tools: new Map(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
		persistTodoPhases: next => {
			entries.push({
				type: "custom",
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: next },
			} as SessionEntry);
		},
		emitEvent: event => {
			events.push(event);
		},
	});
	return {
		handlers,
		entries,
		events,
		current: () => phases,
		// Mirrors `AgentSession.#syncTodoPhasesFromBranch`, the reload path.
		reload: () => getLatestTodoPhasesFromEntries(entries),
		uiTodos: () => {
			let todos: TodoPhase[] | null = null;
			for (const event of events) {
				if (event.type !== "tool_execution_end" || event.toolName !== "todo" || event.isError) continue;
				const details = event.result.details as { phases?: TodoPhase[] } | undefined;
				if (details?.phases) todos = details.phases;
			}
			return todos;
		},
	};
}

describe("cursor todo persistence", () => {
	// The replay test drives the real todo renderer, which reads theme + settings.
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("survives a reload, which replays session entries rather than memory", () => {
		// Cursor resolves `update_todos` server-side and emits no local `todo`
		// toolResult, so nothing would otherwise land in the branch and every
		// reload/rewind/compaction would silently drop the list.
		const h = newHarness();
		h.handlers.todoSync(
			{
				merged: false,
				todos: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
			"call-1",
		);

		expect(h.reload()).toEqual(h.current());
		expect(h.reload()).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
		]);
	});

	it("replays the newest snapshot after repeated updates", () => {
		const h = newHarness();
		h.handlers.todoSync({ merged: false, todos: [{ content: "step one", status: "in_progress" }] }, "call-1");
		h.handlers.todoSync(
			{
				merged: false,
				todos: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
			"call-1",
		);

		expect(h.reload()).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
		]);
	});

	it("keeps existing phase grouping for tasks the session already knows", () => {
		const h = newHarness([
			{ name: "Foundation", tasks: [{ content: "scaffold", status: "pending" }] },
			{ name: "Auth", tasks: [{ content: "oauth", status: "pending" }] },
		]);
		h.handlers.todoSync(
			{
				merged: false,
				todos: [
					{ content: "scaffold", status: "completed" },
					{ content: "oauth", status: "in_progress" },
					{ content: "unknown", status: "pending" },
				],
			},
			"call-1",
		);

		expect(h.reload()).toEqual([
			{ name: "Foundation", tasks: [{ content: "scaffold", status: "completed" }] },
			{ name: "Auth", tasks: [{ content: "oauth", status: "in_progress" }] },
			{ name: "Tasks", tasks: [{ content: "unknown", status: "pending" }] },
		]);
	});

	it("never invents an active task for an all-pending remote snapshot", () => {
		const h = newHarness();
		h.handlers.todoSync(
			{
				merged: false,
				todos: [
					{ content: "a", status: "pending" },
					{ content: "b", status: "pending" },
				],
			},
			"call-1",
		);

		expect(h.reload()[0].tasks.every(task => task.status === "pending")).toBe(true);
	});

	it("writes nothing when the session exposes no todo state", () => {
		const entries: SessionEntry[] = [];
		const handlers = new CursorExecHandlers({
			cwd: "/tmp",
			tools: new Map(),
			persistTodoPhases: next => {
				entries.push({
					type: "custom",
					customType: USER_TODO_EDIT_CUSTOM_TYPE,
					data: { phases: next },
				} as SessionEntry);
			},
		});

		handlers.todoSync({ merged: false, todos: [{ content: "a", status: "pending" }] }, "call-1");

		expect(entries).toEqual([]);
	});

	it("refreshes the interactive todo panel, which only reacts to tool_execution_end", () => {
		// Cursor's todo call is resolved server-side and runs no local tool, so
		// without a synthesized event the visible panel stays stale until reload.
		const h = newHarness();
		h.handlers.todoSync(
			{
				merged: false,
				todos: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
			"call-1",
		);

		expect(h.uiTodos()).toEqual(h.current());
		expect(h.uiTodos()).toEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "step one", status: "completed" },
					{ content: "step two", status: "in_progress" },
				],
			},
		]);
	});

	it("keeps the panel, session state, and branch replay in agreement", () => {
		const h = newHarness([{ name: "Auth", tasks: [{ content: "oauth", status: "pending" }] }]);
		h.handlers.todoSync({ merged: false, todos: [{ content: "oauth", status: "completed" }] }, "call-1");

		expect(h.uiTodos()).toEqual(h.current());
		expect(h.reload()).toEqual(h.current());
	});

	it("settles the call without phases when the session exposes no todo state", () => {
		// The visible block exists either way — it is rendered from the stream,
		// not from local state — so it still needs a completion to stop
		// animating. There is just nothing to mirror into `details.phases`.
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: "/tmp",
			tools: new Map(),
			emitEvent: event => {
				events.push(event);
			},
		});

		handlers.todoSync({ merged: false, todos: [{ content: "a", status: "pending" }] }, "call-1");

		expect(events).toHaveLength(1);
		const settled = events[0];
		if (settled?.type !== "tool_execution_end") throw new Error("expected a completion event");
		expect(settled).toMatchObject({ toolCallId: "call-1", toolName: "todo", isError: false });
		expect(settled.result.details).toBeUndefined();
	});

	it("settles a refusal without overwriting the live todo list", () => {
		// `event-controller` feeds `details.phases` straight into `setTodos`, so
		// a refused `read_todos` echoing the current list back would let a call
		// that changed nothing overwrite live UI state.
		const h = newHarness([{ name: "Auth", tasks: [{ content: "oauth", status: "pending" }] }]);
		const before = h.current();

		const result = h.handlers.todoSync(null, "call-1");

		expect(h.current()).toBe(before);
		expect(h.entries).toEqual([]);
		expect(h.uiTodos()).toBeNull();
		expect(result).toMatchObject({ toolCallId: "call-1", isError: false, details: undefined });
		expect(h.events).toHaveLength(1);
		expect(h.events[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "call-1", isError: false });
	});

	it("settles a server error as a failure without touching local state", () => {
		const h = newHarness([{ name: "Auth", tasks: [{ content: "oauth", status: "pending" }] }]);
		const before = h.current();

		const result = h.handlers.todoSync(null, "call-1", "boom");

		expect(h.current()).toBe(before);
		expect(h.entries).toEqual([]);
		expect(result).toMatchObject({
			toolCallId: "call-1",
			isError: true,
			content: [{ type: "text", text: "boom" }],
			details: undefined,
		});
		expect(h.events[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "call-1", isError: true });
	});

	it("returns a result that survives buildSessionContext and rebuilds the list", () => {
		// The persisted result is what a rebuilt transcript renders from. Two
		// independent failure modes: no result at all strips the block as
		// dangling, and a summary-only result (no `details.phases`) survives the
		// strip but replays as `Todo 0 tasks` — `todoToolRenderer.renderResult`
		// reconstructs the list exclusively from `details.phases`.
		const h = newHarness([{ name: "Auth", tasks: [{ content: "oauth", status: "pending" }] }]);
		const result = h.handlers.todoSync(
			{ merged: false, todos: [{ content: "oauth", status: "completed" }] },
			"cursor-call-1",
		);

		if (!result) throw new Error("expected a persisted result");

		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "cursor-call-1", name: "todo", arguments: {} }],
			api: "cursor-agent",
			provider: "cursor",
			model: "cursor-composer-2.5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		};
		const replayEntries = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: TIMESTAMP,
				message: { role: "user", content: [{ type: "text", text: "track it" }], timestamp: 1 },
			},
			{ type: "message", id: "m2", parentId: "m1", timestamp: TIMESTAMP, message: assistant },
			{ type: "message", id: "m3", parentId: "m2", timestamp: TIMESTAMP, message: result },
		] as SessionEntry[];

		const context = buildSessionContext(replayEntries, undefined, undefined, { transcript: true });

		// The block is paired, so the rebuild keeps it.
		const rebuilt = context.messages.find(message => message.role === "assistant");
		expect(rebuilt?.content.some(block => block.type === "toolCall" && block.id === "cursor-call-1")).toBe(true);

		// And the rebuilt result actually renders the list: `renderResult` derives
		// every row from `details.phases`, so a summary-only result would print
		// the `0 tasks` fallback instead of the task.
		const replayed = context.messages.find(
			(message): message is typeof result => message.role === "toolResult" && message.toolCallId === "cursor-call-1",
		);
		if (!replayed) throw new Error("expected the paired result to survive the rebuild");
		const component = todoToolRenderer.renderResult(
			{ content: replayed.content, details: replayed.details as never, isError: replayed.isError },
			{ expanded: true } as Parameters<typeof todoToolRenderer.renderResult>[1],
			theme,
		);
		const rendered = (component.render(120) as readonly string[]).join("\n");

		expect(rendered).toContain("oauth");
		expect(rendered).not.toContain("0 tasks");
	});
});
