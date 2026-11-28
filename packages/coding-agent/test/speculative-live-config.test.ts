import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSpeculativeToolExecutionConfig } from "@oh-my-pi/pi-coding-agent/speculation/host";
import { cfgTaskSpeculativeLaunch } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// NOTE: `Settings.isolated` seeds the `overrides` layer, which shadows later
// `set` (global layer) in merge order. Keys under test are therefore left at
// schema defaults so `set` — the same layer the live settings UI writes —
// takes effect, matching production.
describe("createSpeculativeToolExecutionConfig", () => {
	it("follows live task.speculativeLaunch toggles after the Agent captured the config", () => {
		const settings = Settings.isolated({});
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		};
		const config = createSpeculativeToolExecutionConfig(session.settings, session, { hasHandlers: () => false });

		expect(config.enabled).toBe(true);

		cfgTaskSpeculativeLaunch.set(settings, false);
		expect(config.enabled).toBe(false);

		cfgTaskSpeculativeLaunch.set(settings, true);
		expect(config.enabled).toBe(true);
	});
});
