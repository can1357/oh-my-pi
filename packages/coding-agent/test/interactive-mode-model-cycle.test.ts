import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function renderCycle(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.modelCycleContainer.render(120).join("\n"));
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

describe("InteractiveMode model-cycle track", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-model-cycle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders into the anchored container, not the chat scrollback", () => {
		const before = mode.chatContainer.children.length;
		mode.showModelCycleTrack("default>slow");

		expect(renderCycle(mode)).toContain("default>slow");
		// The whole point of the move: the track never lands in the scrollback,
		// which is where back-to-back appends used to stack duplicates.
		expect(mode.chatContainer.children.length).toBe(before);
	});

	it("rebuilds in place without stacking duplicate tracks on repeated cycles", () => {
		mode.showModelCycleTrack("track-one");
		const childCountAfterFirst = mode.modelCycleContainer.children.length;
		mode.showModelCycleTrack("track-two");

		const rendered = renderCycle(mode);
		expect(rendered).not.toContain("track-one");
		expect(countOccurrences(rendered, "track-two")).toBe(1);
		// Cleared + rebuilt each cycle, so the child count never grows.
		expect(mode.modelCycleContainer.children.length).toBe(childCountAfterFirst);
	});

	it("auto-clears the track after lingering", () => {
		vi.useFakeTimers();
		mode.showModelCycleTrack("temporary-track");
		expect(renderCycle(mode)).toContain("temporary-track");

		// Still lingering shortly after.
		vi.advanceTimersByTime(1000);
		expect(renderCycle(mode)).toContain("temporary-track");

		// Gone well past the linger window.
		vi.advanceTimersByTime(5000);
		expect(renderCycle(mode)).not.toContain("temporary-track");
	});
});
