/**
 * Alt+Up restores one queued message into the current composer. A follow-up
 * returns as `=>` queue shorthand so Enter queues it again instead of steering
 * it into the running turn. A focused view must leave the main session's
 * steering and compaction queues untouched.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { splitQueuedMessages } from "@oh-my-pi/pi-coding-agent/modes/view-model/prompt/queue-input";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { DequeuedMessage, RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Composer } from "../src/ui/composer/composer";
import { initTheme } from "../src/ui/theme/service";

beforeAll(() => {
	initTheme();
});

type QueueContextOptions = {
	queue?: DequeuedMessage[];
	focusedQueue?: DequeuedMessage[];
	compaction?: CompactionQueuedMessage[];
	draft?: string;
};

function makeCtx(opts: QueueContextOptions = {}) {
	const queue = [...(opts.queue ?? [])];
	const focusedQueue = [...(opts.focusedQueue ?? [])];
	const composer = new Composer({ text: opts.draft ?? "" });
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
		composer,
		locallySubmittedUserSignatures: new Set<string>(),
		skillCommands: new Map([["skill:review", []]]),
		updatePendingMessagesDisplay: () => {},
		showStatus: (msg: string) => {
			statuses.push(msg);
		},
		showError: () => {},
	} as unknown as InteractiveModeContext;

	return { ctx, session, queue, focusedQueue, clearQueue, statuses, getText: () => composer.text() };
}

describe("InputController.handleDequeue (Alt+Up)", () => {
	test("pops only the last queued message and leaves the rest queued", () => {
		const { ctx, queue, clearQueue, getText } = makeCtx({
			queue: [
				{ text: "first message", queue: "steering" },
				{ text: "second message", queue: "steering" },
			],
		});

		new InputController(ctx).handleDequeue();

		expect(getText()).toBe("second message");
		expect(queue.map(m => m.text)).toEqual(["first message"]);
		expect(clearQueue).not.toHaveBeenCalled();
	});

	test("recalls the focused subagent's last steering message without touching main", () => {
		const { ctx, queue, focusedQueue, getText } = makeCtx({
			queue: [{ text: "main steering", queue: "steering" }],
			focusedQueue: [
				{ text: "subagent first", queue: "followUp" },
				{ text: "subagent last", queue: "followUp" },
			],
		});

		new InputController(ctx).handleDequeue();

		// The focused composer steers the subagent without parsing `=>`, so a follow-up returns bare.
		expect(getText()).toBe("subagent last");
		expect(focusedQueue.map(m => m.text)).toEqual(["subagent first"]);
		expect(queue.map(m => m.text)).toEqual(["main steering"]);
	});

	test("does not restore main compaction messages while focused on an empty subagent queue", () => {
		const { ctx, queue, statuses, getText } = makeCtx({
			queue: [{ text: "main steering", queue: "steering" }],
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
		const { ctx, getText } = makeCtx({
			queue: [
				{ text: "first", queue: "steering" },
				{ text: "second", queue: "steering" },
			],
		});
		const controller = new InputController(ctx);

		controller.handleDequeue();
		expect(getText()).toBe("second");

		controller.handleDequeue();
		// Popped message merges ahead of the draft the first pop restored.
		expect(getText()).toBe("first\n\nsecond");
	});

	test("restores follow-ups as queue shorthand that queues them again in order", () => {
		const { ctx, getText } = makeCtx({
			queue: [
				{ text: "first", queue: "followUp" },
				{ text: "second", queue: "followUp" },
			],
		});
		const controller = new InputController(ctx);

		controller.handleDequeue();
		expect(getText()).toBe("=> second");

		controller.handleDequeue();
		expect(getText()).toBe("=>\n1. first\n2. second");
		expect(splitQueuedMessages(getText().slice(2))).toEqual(["first", "second"]);
	});

	test("keeps the plain merge for a follow-up dequeued into an ordinary draft", () => {
		const { ctx, getText } = makeCtx({ queue: [{ text: "queued", queue: "followUp" }], draft: "my draft" });

		new InputController(ctx).handleDequeue();

		// Prefixing `=>` would queue the user's own draft along with it.
		expect(getText()).toBe("queued\n\nmy draft");
	});

	test("restores a queued skill invocation as typed", () => {
		const { ctx, getText } = makeCtx({ queue: [{ text: "/skill:review the parser", queue: "followUp" }] });

		new InputController(ctx).handleDequeue();

		// The queue shorthand would deliver `/skill:review` as literal text instead of running the skill.
		expect(getText()).toBe("/skill:review the parser");
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

		expect(getText()).toBe("=> compaction two");
		expect((ctx.compactionQueuedMessages as CompactionQueuedMessage[]).map(m => m.text)).toEqual(["compaction one"]);
	});
});
