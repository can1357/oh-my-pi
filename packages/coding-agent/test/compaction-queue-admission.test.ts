import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";

beforeAll(() => initTheme());

function makeContext(queue: CompactionQueuedMessage[]) {
	const order: string[] = [];
	const listeners = new Set<(event: { type: "agent_start" }) => void>();
	const preflight = Promise.withResolvers<void>();
	const turn = Promise.withResolvers<boolean>();
	const session = {
		subscribe(listener: (event: { type: "agent_start" }) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text: string, options?: { onPromptAdmitted?: () => void }) {
			order.push(`preflight:${text}`);
			await preflight.promise;
			options?.onPromptAdmitted?.();
			order.push(`admit:${text}`);
			for (const listener of listeners) listener({ type: "agent_start" });
			return turn.promise;
		},
		async steer(text: string) {
			order.push(`steer:${text}`);
		},
		async followUp(text: string) {
			order.push(`followUp:${text}`);
		},
		clearQueue() {},
	};
	const ctx = {
		session,
		compactionQueuedMessages: queue,
		updatePendingMessagesDisplay() {},
		showError(error: string) {
			throw new Error(error);
		},
		isKnownSlashCommand: () => false,
		recordLocalSubmission: () => () => {},
		async withLocalSubmission<T>(_text: string, fn: () => Promise<T>) {
			return fn();
		},
	} as unknown as InteractiveModeContext;
	return { ctx, order, preflight, turn, listeners };
}

describe("after-compaction queue admission", () => {
	test("holds following steers and follow-ups until the first prompt enters the turn", async () => {
		const { ctx, order, preflight, turn, listeners } = makeContext([
			{ text: "first", mode: "steer" },
			{ text: "second", mode: "steer" },
			{ text: "third", mode: "followUp" },
		]);
		const flush = new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		expect(order).toEqual(["preflight:first"]);
		preflight.resolve();
		await flush;
		expect(order).toEqual(["preflight:first", "admit:first", "steer:second", "followUp:third"]);
		expect(listeners.size).toBe(0);
		turn.resolve(true);
	});
});
