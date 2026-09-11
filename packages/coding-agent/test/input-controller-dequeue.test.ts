/**
 * Regression (#11402): the Alt+Up dequeue key must pop only the single
 * most-recently-queued message back into the composer, leaving the rest queued.
 *
 * Before the fix `handleDequeue()` called `restoreQueuedMessagesToEditor()`,
 * which drains the entire queue via `clearQueue()` — pressing Alt+Up with two
 * messages queued dropped both into the editor and destroyed any composer draft
 * ordering. The session already exposed `popLastQueuedMessage()` ("restore
 * messages to editor one at a time") but nothing wired it to the key.
 *
 * Contracts defended here:
 *   - one Alt+Up restores exactly the last queued message and leaves the others
 *     in the queue (does not call `clearQueue`);
 *   - the restored text is merged ahead of the existing draft;
 *   - an empty queue reports "No queued messages to restore";
 *   - when the agent queues are empty, the compaction queue is the fallback and
 *     only its last entry is popped.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(() => {
	initTheme();
});

function makeCtx(
	opts: { queue?: RestoredQueuedMessage[]; compaction?: CompactionQueuedMessage[]; draft?: string } = {},
) {
	const queue = [...(opts.queue ?? [])];
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

	const ctx = {
		session,
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

	return { ctx, session, queue, clearQueue, statuses, getText: () => editorText };
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

	test("a second Alt+Up pops the next-last message", () => {
		const { ctx, getText } = makeCtx({ queue: [{ text: "first" }, { text: "second" }] });
		const controller = new InputController(ctx);

		controller.handleDequeue();
		expect(getText()).toBe("second");

		controller.handleDequeue();
		// Popped message merges ahead of the draft the first pop restored.
		expect(getText()).toBe("first\n\nsecond");
	});

	test("merges the popped message ahead of an existing draft", () => {
		const { ctx, getText } = makeCtx({ queue: [{ text: "queued" }], draft: "typed draft" });
		new InputController(ctx).handleDequeue();
		expect(getText()).toBe("queued\n\ntyped draft");
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
