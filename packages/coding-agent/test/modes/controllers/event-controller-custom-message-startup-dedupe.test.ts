import { beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

function idleCustomMessage(): CustomMessage {
	return {
		role: "custom",
		customType: "idle-status",
		content: "IDLE_DISPLAY_BODY",
		display: true,
		attribution: "agent",
		timestamp: 1000,
	};
}

describe("EventController custom message startup dedupe", () => {
	it("suppresses the live paint for an idle custom append delivered before the initial render", async () => {
		// The window between subscribeToAgent() and renderInitialMessages: initialChatRendered
		// is still false and the session is idle. The entry is already persisted, so the
		// preserved-chat replay paints it; a live paint here would duplicate it.
		const ctx = createInteractiveModeContext({ initialChatRendered: false });
		const addMessageToChat = vi.spyOn(ctx, "addMessageToChat");
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message: idleCustomMessage() });

		expect(addMessageToChat).not.toHaveBeenCalled();
	});

	it("paints an idle custom append immediately once the initial render has completed", async () => {
		const ctx = createInteractiveModeContext({ initialChatRendered: true });
		const addMessageToChat = vi.spyOn(ctx, "addMessageToChat");
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message: idleCustomMessage() });

		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledWith(expect.objectContaining({ customType: "idle-status" }));
	});
});
