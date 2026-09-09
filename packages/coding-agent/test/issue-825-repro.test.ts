/**
 * Regression test for issue #825: steer preview stuck after compaction.
 *
 * Scenario: user types a steer message during compaction; it is queued to
 * `compactionQueuedMessages`. When compaction ends, `flushCompactionQueue`
 * fires `session.prompt(text)` (no streamingBehavior). If the session is
 * still streaming at that moment, `prompt()` throws `AgentBusyError`.
 * Currently the catch handler dumps the message back into
 * `compactionQueuedMessages`. Nothing drains that array except a future
 * compaction-end event, so the preview shows the message but the user has no
 * way to actually deliver it (Alt+Up restores from the session queue, not
 * from compactionQueuedMessages; normal submit doesn't pick them up either).
 *
 * The contract this test defends:
 *   - After a busy-flush, the queued message must be findable in the session
 *     steer/follow-up queues — the queues every other code path drains. That
 *     keeps the preview honest (it reflects what is actually queued) AND
 *     makes the message deliverable on the next user turn.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";

beforeAll(() => {
	initTheme();
});

type PromptOpts = { streamingBehavior?: "steer" | "followUp" } | undefined;

function makeFakeSession() {
	const steering: { text: string }[] = [];
	const followUp: { text: string }[] = [];
	const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];

	const prompt = mock(async (text: string, opts?: PromptOpts): Promise<void> => {
		promptCalls.push({ text, opts });
		// Mirror real agent-session behaviour: when the session is busy and the
		// caller did not supply streamingBehavior, throw AgentBusyError.
		if (!opts?.streamingBehavior) {
			throw new AgentBusyError();
		}
		if (opts.streamingBehavior === "followUp") {
			followUp.push({ text });
		} else {
			steering.push({ text });
		}
	});

	const steer = mock(async (text: string): Promise<void> => {
		steering.push({ text });
	});

	const followUpFn = mock(async (text: string): Promise<void> => {
		followUp.push({ text });
	});

	const session = {
		isStreaming: true,
		isCompacting: false,
		extensionRunner: undefined,
		customCommands: [] as Array<{ command: { name: string } }>,
		getQueuedMessages: () => ({ steering: steering.map(e => e.text), followUp: followUp.map(e => e.text) }),
		clearQueue: () => {
			const s = [...steering];
			const f = [...followUp];
			steering.length = 0;
			followUp.length = 0;
			return { steering: s, followUp: f };
		},
		prompt,
		steer,
		followUp: followUpFn,
	};

	return { session, steering, followUp, promptCalls };
}

function makeCtx(initialQueue: CompactionQueuedMessage[]) {
	const fake = makeFakeSession();
	const showError = mock((_msg: string) => {});
	const showStatus = mock((_msg: string) => {});
	const updatePendingMessagesDisplay = mock(() => {});

	const locallySubmittedUserSignatures = new Set<string>();
	const isKnownSlashCommand = (text: string) => text.startsWith("/");
	const ctx = {
		session: fake.session,
		compactionQueuedMessages: [...initialQueue],
		pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
		editor: { addToHistory: () => {}, setText: () => {}, getText: () => "" },
		keybindings: { getDisplayString: () => "Alt+Up" },
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures,
		isKnownSlashCommand,
		recordLocalSubmission(text: string, imageCount = 0) {
			if (isKnownSlashCommand(text)) return () => {};
			const sig = `${text}\u0000${imageCount}`;
			locallySubmittedUserSignatures.add(sig);
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(text: string, fn: () => Promise<T>, options?: { imageCount?: number }): Promise<T> {
			const dispose = ctx.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		updatePendingMessagesDisplay,
		showError,
		showStatus,
	} as unknown as InteractiveModeContext;

	return { ctx, fake, showError, showStatus, updatePendingMessagesDisplay };
}

describe("issue #825: steer preview stuck after compaction", () => {
	test("AgentBusyError on flush leaves the steer message in the session queue (submittable on next turn)", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "address review feedback", mode: "steer" }];
		const { ctx, fake } = makeCtx(queued);

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });
		// Drain microtasks so the .catch on the fire-and-forget prompt resolves.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// Contract: the message must end up in the session steering queue —
		// that is what `restoreQueuedMessagesToEditor` (Alt+Up) and the
		// post-stream drain consult. Otherwise it is stranded in
		// compactionQueuedMessages with no consumer.
		expect(fake.steering).toContainEqual({ text: "address review feedback" });

		// And it must not also remain duplicated in compactionQueuedMessages.
		const remaining = (ctx as unknown as { compactionQueuedMessages: CompactionQueuedMessage[] })
			.compactionQueuedMessages;
		expect(remaining.find(m => m.text === "address review feedback")).toBeUndefined();
	});

	test("marks flushed compaction messages as local submissions before delivery", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "draft-safe queued message", mode: "steer" }];
		const { ctx, fake } = makeCtx(queued);
		fake.session.isStreaming = false;
		fake.session.prompt = mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			fake.promptCalls.push({ text, opts });
		});

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });

		expect(ctx.locallySubmittedUserSignatures.has("draft-safe queued message\u00000")).toBe(true);
	});
	test("when the agent is genuinely idle, flush issues a fresh prompt as before", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "ship it", mode: "steer" }];
		const { ctx, fake } = makeCtx(queued);
		// Agent is idle now: prompt must succeed (real agent-session ignores
		// streamingBehavior when not streaming, so passing it must not break
		// the happy path).
		fake.session.isStreaming = false;
		// Override prompt to record + succeed regardless of streamingBehavior.
		const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];
		fake.session.prompt = mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			promptCalls.push({ text, opts });
		});

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(promptCalls.length).toBe(1);
		expect(promptCalls[0].text).toBe("ship it");
	});
	test("removes the local-submission signature when willRetry delivery rejects", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "willRetry boom", mode: "followUp" }];
		const { ctx, fake } = makeCtx(queued);
		fake.session.followUp = mock(async () => {
			throw new Error("delivery failed");
		});

		const helpers = new UiHelpers(ctx);
		// flushCompactionQueue funnels rejections through restoreQueue, so it
		// resolves rather than rethrowing — but the signature must still be
		// cleared so the restored queue can be re-flushed without stale state.
		await helpers.flushCompactionQueue({ willRetry: true });

		expect(ctx.locallySubmittedUserSignatures.has("willRetry boom\u00000")).toBe(false);
		// And the message is restored to compactionQueuedMessages for retry.
		const remaining = (ctx as unknown as { compactionQueuedMessages: CompactionQueuedMessage[] })
			.compactionQueuedMessages;
		expect(remaining.find(m => m.text === "willRetry boom")).toBeDefined();
	});

	test("removes the local-submission signature when the fire-and-forget firstPrompt rejects", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "fire and forget", mode: "steer" }];
		const { ctx, fake } = makeCtx(queued);
		// Force the firstPrompt path (not willRetry, no slash commands) to reject.
		fake.session.prompt = mock(async () => {
			throw new Error("queue closed");
		});

		const helpers = new UiHelpers(ctx);
		await helpers.flushCompactionQueue({ willRetry: false });
		// Drain microtasks so the .catch on the fire-and-forget prompt resolves.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(ctx.locallySubmittedUserSignatures.has("fire and forget\u00000")).toBe(false);
	});
});
