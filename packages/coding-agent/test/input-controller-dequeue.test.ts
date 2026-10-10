/**
 * Alt+Up restores one queued message into the current composer. A focused view
 * must leave the main session's steering and compaction queues untouched.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(() => {
	initTheme();
});

type QueueContextOptions = {
	queue?: RestoredQueuedMessage[];
	focusedQueue?: RestoredQueuedMessage[];
	compaction?: CompactionQueuedMessage[];
	draft?: string;
};

function makeCtx(opts: QueueContextOptions = {}) {
	const queue = [...(opts.queue ?? [])];
	const focusedQueue = [...(opts.focusedQueue ?? [])];
	let editorText = opts.draft ?? "";
	const statuses: string[] = [];

	// Faithful stub of AgentSession.popLastQueuedMessage: removes and returns the
	// last queued entry, or undefined when empty. clearQueue is spied so the test
	// proves the dequeue path never drains the whole queue.
	const clearQueue = mock(() => ({ steering: [] as RestoredQueuedMessage[], followUp: queue.splice(0) }));
	const session = {
		popLastQueuedMessage: () => queue.pop(),
		clearQueue,
	};
	const viewSession = opts.focusedQueue ? { popLastQueuedMessage: () => focusedQueue.pop() } : session;

	const ctx = {
		session,
		viewSession,
		focusedAgentId: opts.focusedQueue ? "worker" : undefined,
		compactionQueuedMessages: [...(opts.compaction ?? [])],
		editor: {
			setCollapsedText: (t: string) => {
				editorText = t;
			},
			getText: () => editorText,
			imageLinks: undefined as (string | undefined)[] | undefined,
			pendingImages: [],
			pendingImageLinks: [],
		},
		locallySubmittedUserSignatures: new Set<string>(),
		updatePendingMessagesDisplay: () => {},
		showStatus: (msg: string) => {
			statuses.push(msg);
		},
		showError: () => {},
	} as unknown as InteractiveModeContext;

	return { ctx, session, queue, focusedQueue, clearQueue, statuses, getText: () => editorText };
}

describe("InputController.handleDequeue (Alt+Up)", () => {
	test("pops only the last queued message and leaves the rest queued", () => {
		const { ctx, queue, clearQueue, getText } = makeCtx({
			queue: [{ text: "first message" }, { text: "second message" }],
		});

		new InputController(ctx).handleDequeue();

		expect(getText()).toBe("second message");
		expect(queue.map(m => m.text)).toEqual(["first message"]);
		expect(clearQueue).not.toHaveBeenCalled();
	});

	test("recalls the focused subagent's last steering message without touching main", () => {
		const { ctx, queue, focusedQueue, getText } = makeCtx({
			queue: [{ text: "main steering" }],
			focusedQueue: [{ text: "subagent first" }, { text: "subagent last" }],
		});

		new InputController(ctx).handleDequeue();

		expect(getText()).toBe("subagent last");
		expect(focusedQueue.map(m => m.text)).toEqual(["subagent first"]);
		expect(queue.map(m => m.text)).toEqual(["main steering"]);
	});

	test("does not restore main compaction messages while focused on an empty subagent queue", () => {
		const { ctx, queue, statuses, getText } = makeCtx({
			queue: [{ text: "main steering" }],
			focusedQueue: [],
			compaction: [{ text: "main compaction", mode: "steer" }],
		});

		new InputController(ctx).handleDequeue();

		expect(getText()).toBe("");
		expect(statuses).toEqual(["No queued messages to restore"]);
		expect(queue.map(m => m.text)).toEqual(["main steering"]);
		expect(ctx.compactionQueuedMessages).toEqual([{ text: "main compaction", mode: "steer" }]);
	});

	test("a second Alt+Up pops the next-last message", () => {
		const { ctx, getText } = makeCtx({ queue: [{ text: "first" }, { text: "second" }] });
		const controller = new InputController(ctx);

		controller.handleDequeue();
		expect(getText()).toBe("second");

		controller.handleDequeue();
		// Popped message merges ahead of the draft the first pop restored.
		expect(getText()).toBe("first\n\nsecond");
	});

	test("empty queue reports nothing to restore", () => {
		const { ctx, statuses, getText } = makeCtx();
		new InputController(ctx).handleDequeue();
		expect(statuses).toEqual(["No queued messages to restore"]);
		expect(getText()).toBe("");
	});

	test("falls back to the compaction queue and pops only its last entry", () => {
		const { ctx, getText } = makeCtx({
			compaction: [
				{ text: "compaction one", mode: "followUp", images: undefined },
				{ text: "compaction two", mode: "followUp", images: undefined },
			],
		});

		new InputController(ctx).handleDequeue();

		expect(getText()).toBe("compaction two");
		expect((ctx.compactionQueuedMessages as CompactionQueuedMessage[]).map(m => m.text)).toEqual(["compaction one"]);
	});
});
