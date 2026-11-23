import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setNativePacing, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const FULL = "The cache key only hashes package.json, so it keeps hitting while the lockfile drifts.";

/** The text the streaming reply last drew after one delta carrying {@link FULL}, before any reveal tick. */
async function drawnAfterOneDelta(): Promise<string | undefined> {
	const ctx = createInteractiveModeContext();
	const controller = new EventController(ctx);
	await controller.handleEvent({ type: "message_start", message: createAssistantMessage("") } as Extract<
		AgentSessionEvent,
		{ type: "message_start" }
	>);
	const component = ctx.streamingComponent;
	if (!component) throw new Error("message_start opened no streaming reply");
	const draws = vi.spyOn(component, "updateContent");
	await controller.handleEvent({ type: "message_update", message: createAssistantMessage(FULL) } as Extract<
		AgentSessionEvent,
		{ type: "message_update" }
	>);
	const block = draws.mock.calls.at(-1)?.[0].content[0];
	return block?.type === "text" ? block.text : undefined;
}

describe("EventController streaming into a terminal that paces text itself", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": true } });
		vi.useFakeTimers();
	});

	afterEach(() => {
		setNativePacing(false);
		setNativeRendering(false);
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("draws each delta whole only while the live terminal paces streamed text", async () => {
		// omp types the reply out itself: the delta waits for reveal ticks.
		expect(await drawnAfterOneDelta()).not.toBe(FULL);
		// A native surface whose terminal does not pace still gets omp's reveal.
		setNativeRendering(true);
		expect(await drawnAfterOneDelta()).not.toBe(FULL);
		// Tern types it out: omp hands over the text as it arrives.
		setNativePacing(true);
		expect(await drawnAfterOneDelta()).toBe(FULL);
	});
});
