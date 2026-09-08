import { beforeAll, describe, expect, mock, test } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";

beforeAll(() => {
	initTheme();
});

function makeCtx(
	initialQueue: CompactionQueuedMessage[],
	loopPrompt: string | undefined,
	promptBehavior: "forward" | "consume" | "throw" = "consume",
) {
	let currentLoopPrompt = loopPrompt;
	const pauseLoop = mock(() => {
		currentLoopPrompt = undefined;
	});
	// Mirror AgentSession.prompt: a void custom command is consumed locally
	// (false) instead of starting a turn (true).
	const prompt = mock(async (text: string): Promise<boolean> => {
		if (promptBehavior === "throw") throw new Error("attachment too large");
		if (promptBehavior === "forward") return true;
		return text !== "/void-cmd";
	});
	const ctx = {
		session: {
			prompt,
			promptCustomMessage: mock(async () => true),
			clearQueue: () => ({ steering: [], followUp: [] }),
		},
		compactionQueuedMessages: [...initialQueue],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: (text: string) => text === "/void-cmd",
		recordLocalSubmission: () => () => {},
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
		updatePendingMessagesDisplay: mock(() => {}),
		showError: mock((_msg: string) => {}),
		showStatus: mock((_msg: string) => {}),
		get loopPrompt() {
			return currentLoopPrompt;
		},
		set loopPrompt(value: string | undefined) {
			currentLoopPrompt = value;
		},
		pauseLoop,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		prompt,
		pauseLoop,
		getLoopPrompt: () => currentLoopPrompt,
	};
}

describe("flushCompactionQueue loop parking", () => {
	test("all-slash drain parks the loop when the body is consumed locally", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "/void-cmd", mode: "steer" }];
		const { ctx, prompt, pauseLoop, getLoopPrompt } = makeCtx(queued, "/void-cmd");

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });

		expect(prompt).toHaveBeenCalledWith("/void-cmd");
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
	});

	test("pre-command drain parks the loop when the body is consumed locally", async () => {
		const queued: CompactionQueuedMessage[] = [
			{ text: "/void-cmd", mode: "steer" },
			{ text: "plain follow-up", mode: "followUp" },
		];
		const { ctx, pauseLoop, getLoopPrompt } = makeCtx(queued, "/void-cmd");

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
	});

	test("drain keeps the loop armed when the body starts a turn", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "plain body", mode: "steer" }];
		const { ctx, pauseLoop, getLoopPrompt } = makeCtx(queued, "plain body");

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("plain body");
	});

	test("failed drain restores the queue and leaves loop state alone", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "queued body", mode: "steer" }];
		const { ctx, pauseLoop, getLoopPrompt } = makeCtx(queued, "queued body", "throw");

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		// The message stays queued for retry; loop parking happens when the
		// main turn later observes the rejection, not in the drain.
		expect(ctx.compactionQueuedMessages).toEqual(queued);
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("queued body");
	});
});
