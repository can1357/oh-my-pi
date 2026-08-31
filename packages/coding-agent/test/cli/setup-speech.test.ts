import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { runSetupCommand } from "@oh-my-pi/pi-coding-agent/cli/setup-cli";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("speech setup", () => {
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("excludes OpenAI Codex from speech dependency checks", async () => {
		settings.set("stt.transcriber", "codex");
		const writes: string[] = [];
		vi.spyOn(console, "log").mockImplementation(value => {
			writes.push(String(value));
		});
		// The TTS model is not cached in the test sandbox; keep the runner alive
		// when --check reports it missing and exits 1.
		vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

		await runSetupCommand({ component: "speech", flags: { check: true } });

		expect(writes.join("\n")).not.toContain("Speech-to-Text transcriber");
	});
});
