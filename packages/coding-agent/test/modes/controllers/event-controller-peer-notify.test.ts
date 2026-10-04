import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgCompletionNotify } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => vi.restoreAllMocks());

function arrival(timestamp: number, remote: boolean, customType = "irc:incoming"): AgentSessionEvent {
	return {
		type: "irc_message",
		message: {
			role: "custom",
			customType,
			content: "envelope",
			display: true,
			timestamp,
			details: { from: "Worker\u001b]52;c;cGF5bG9hZA==\u0007\nTwo", message: "hello", remote },
		},
	};
}

describe("peer arrival notifications", () => {
	it("notifies once for a remote arrival, never for local traffic or relay observations", async () => {
		const settings = Settings.isolated();
		cfgCompletionNotify.override(settings, "on");
		const ctx = createInteractiveModeContext({ settings, sessionManager: { getSessionName: () => "My session" } });
		const notification = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const controller = new EventController(ctx);
		try {
			const event = arrival(1, true);
			await controller.handleEvent(event);
			await controller.handleEvent(event);
			await controller.handleEvent(arrival(2, false));
			await controller.handleEvent(arrival(3, true, "irc:relay"));
			expect(notification).toHaveBeenCalledTimes(1);
			expect(notification).toHaveBeenCalledWith({
				title: "My session",
				body: "Peer message from Worker Two",
				type: "info",
				actions: "focus",
			});
		} finally {
			controller.dispose();
		}
	});

	it("honors completion.notify off, including later runtime changes, and falls back to omp without a title", async () => {
		const settings = Settings.isolated();
		cfgCompletionNotify.override(settings, "off");
		const ctx = createInteractiveModeContext({ settings, sessionManager: { getSessionName: () => undefined } });
		const notification = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const controller = new EventController(ctx);
		try {
			await controller.handleEvent(arrival(1, true));
			expect(notification).not.toHaveBeenCalled();
			cfgCompletionNotify.override(settings, "on");
			await controller.handleEvent(arrival(2, true));
			expect(notification).toHaveBeenCalledWith({
				title: "omp",
				body: "Peer message from Worker Two",
				type: "info",
				actions: "focus",
			});
			cfgCompletionNotify.override(settings, "off");
			await controller.handleEvent(arrival(3, true));
			expect(notification).toHaveBeenCalledTimes(1);
		} finally {
			controller.dispose();
		}
	});
});
