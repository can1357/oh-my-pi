import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import { getAgentDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	clearSpeechHardStop,
	enableSpeechHardStop,
	getSpeechHardStopPath,
	isSpeechHardStopped,
} from "../../src/tts/speech-hard-stop";

function createRuntimeHarness(settingsStore: { enabled: boolean }) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const set = vi.fn((key: string, value: unknown) => {
		if (key === "speech.enabled") settingsStore.enabled = Boolean(value);
	});
	const get = vi.fn((key: string) => {
		if (key === "speech.enabled") return settingsStore.enabled;
		return undefined;
	});

	const ctx = {
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		settings: { set, get } as unknown as InteractiveModeContext["settings"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;

	return { runtime: { ctx }, setText, showStatus, showError, set, get };
}

describe("speech hard-stop helpers", () => {
	let agentDir = "";
	let previousLocal: string | undefined;
	let previousAppData: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pk-speak-hard-"));
		previousLocal = process.env.LOCALAPPDATA;
		previousAppData = process.env.APPDATA;
		// Isolate from any machine-level pi-speak voice-disabled sentinel.
		process.env.LOCALAPPDATA = agentDir;
		process.env.APPDATA = agentDir;
	});

	afterEach(() => {
		if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = previousLocal;
		if (previousAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = previousAppData;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("writes and clears the speech-disabled sentinel", () => {
		expect(isSpeechHardStopped(agentDir)).toBe(false);
		enableSpeechHardStop(agentDir);
		expect(existsSync(getSpeechHardStopPath(agentDir))).toBe(true);
		expect(isSpeechHardStopped(agentDir)).toBe(true);
		clearSpeechHardStop(agentDir);
		expect(isSpeechHardStopped(agentDir)).toBe(false);
	});
});

describe("/pk-speak slash command", () => {
	let agentDir = "";
	let previousAgentDir = "";

	beforeEach(() => {
		previousAgentDir = getAgentDir();
		agentDir = mkdtempSync(join(tmpdir(), "pk-speak-cmd-"));
		setAgentDir(agentDir);
		clearSpeechHardStop(agentDir);
	});

	afterEach(() => {
		clearSpeechHardStop(agentDir);
		setAgentDir(previousAgentDir);
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("hard-stops speech on /pk-speak stop", async () => {
		const store = { enabled: true };
		const harness = createRuntimeHarness(store);
		const handled = await executeBuiltinSlashCommand("/pk-speak stop", harness.runtime);
		expect(handled).toBe(true);
		expect(store.enabled).toBe(false);
		expect(harness.set).toHaveBeenCalledWith("speech.enabled", false);
		expect(isSpeechHardStopped(agentDir)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("pk-speak stopped: speech disabled and playback cleared.");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("enables speech on /pk-speak on", async () => {
		enableSpeechHardStop(agentDir);
		const store = { enabled: false };
		const harness = createRuntimeHarness(store);
		const handled = await executeBuiltinSlashCommand("/pk-speak on", harness.runtime);
		expect(handled).toBe(true);
		expect(store.enabled).toBe(true);
		expect(isSpeechHardStopped(agentDir)).toBe(false);
		expect(harness.showStatus).toHaveBeenCalledWith("pk-speak enabled: speech vocalization on.");
	});

	it("reports status", async () => {
		const store = { enabled: false };
		enableSpeechHardStop(agentDir);
		const harness = createRuntimeHarness(store);
		const handled = await executeBuiltinSlashCommand("/pk-speak status", harness.runtime);
		expect(handled).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("pk-speak: speech off (hard-stopped).");
	});
});
