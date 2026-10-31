import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const refresh = { phase: "idle", provider: "anthropic", model: "claude-sonnet-4-5" } as const;

describe("EventController cache warming events", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it.each<AgentSessionEvent>([
		{ type: "cache_warming_start", ...refresh },
		{ type: "cache_warming_end", ...refresh, outcome: "hit" },
	])("repaints the status line on $type, so the cache details follow the refresh", async event => {
		const ctx = createInteractiveModeContext({});
		await new EventController(ctx).handleEvent(event);

		expect(ctx.statusLine.invalidate).toHaveBeenCalledTimes(1);
		expect(ctx.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
