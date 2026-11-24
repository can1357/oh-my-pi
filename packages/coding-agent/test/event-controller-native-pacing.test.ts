import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const FULL = "The cache key only hashes package.json, so it keeps hitting while the lockfile drifts.";

/** The text the streaming reply shows after one delta carrying {@link FULL}, before any reveal tick. */
async function drawnAfterOneDelta(native: boolean): Promise<string | undefined> {
	const ctx = createInteractiveModeContext();
	vi.spyOn(ctx.shell, "native").mockReturnValue(native);
	const controller = new EventController(ctx);
	try {
		await controller.handleEvent({ type: "message_start", message: createAssistantMessage("") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		const view = ctx.streaming;
		if (!view) throw new Error("message_start opened no streaming reply");
		await controller.handleEvent({ type: "message_update", message: createAssistantMessage(FULL) } as Extract<
			AgentSessionEvent,
			{ type: "message_update" }
		>);
		const block = view.message.peek()?.content[0];
		return block?.type === "text" ? block.text : undefined;
	} finally {
		controller.dispose();
	}
}

describe("EventController streaming into a terminal that paces text itself", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": true } });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("draws each delta whole only on a native surface, which types streamed text out itself", async () => {
		// A text terminal: omp types the reply out, so the delta waits for reveal ticks.
		expect(await drawnAfterOneDelta(false)).not.toBe(FULL);
		// Tern renders natively and paces streamed `md`: omp hands over the text as it arrives.
		expect(await drawnAfterOneDelta(true)).toBe(FULL);
	});
});
