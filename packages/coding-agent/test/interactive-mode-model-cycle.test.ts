import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { ModelCycleTrack } from "../src/ui/dock";
import { createModeTerminal, renderRows } from "./helpers/mode-terminal";
import { nativeShell } from "./helpers/native-shell";

/** The model-cycle track above the prompt. */
function renderCycle(mode: InteractiveMode): string {
	return renderRows(() => ModelCycleTrack({ model: mode.hud.modelCycle })).join("\n");
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
		initTheme();
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
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
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

	it("opens a searchable session picker when Tern clicks the model chip without losing the draft", async () => {
		await using ui = await nativeShell(mode.shell);
		mode.composer.setText("unfinished draft");
		ui.click("row", "model");

		expect(ui.node("picker").parent).toBe("layer");
		ui.type("sonnet");
		expect(ui.node("picker").p.query).toBe("sonnet");
		expect(mode.composer.text()).toBe("unfinished draft");
	});

	it("opens the context report from its meter and returns to the draft on Close", async () => {
		await using ui = await nativeShell(mode.shell);
		mode.composer.setText("unsent draft");
		ui.click("meter", "context");
		expect(ui.node("list", "categories").c).toContain(ui.node("item", "free").id);
		ui.click("button", "close");
		expect(mode.shell.overlays.open()).toBe(false);
		expect(mode.composer.text()).toBe("unsent draft");
	});

	it("renders into the anchored container, not the chat scrollback", () => {
		const before = mode.shell.transcript.blocks().length;
		mode.showModelCycleTrack([{ label: "default>slow" }], 0);

		expect(renderCycle(mode)).toContain("default>slow");
		// The whole point of the move: the track never lands in the scrollback,
		// which is where back-to-back appends used to stack duplicates.
		expect(mode.shell.transcript.blocks().length).toBe(before);
	});

	it("rebuilds in place without stacking duplicate tracks on repeated cycles", () => {
		mode.showModelCycleTrack([{ label: "track-one" }], 0);
		mode.showModelCycleTrack([{ label: "track-two" }], 0);

		const rendered = renderCycle(mode);
		expect(rendered).not.toContain("track-one");
		expect(countOccurrences(rendered, "track-two")).toBe(1);
	});

	it("auto-clears the track after lingering", () => {
		vi.useFakeTimers();
		mode.showModelCycleTrack([{ label: "temporary-track" }], 0);
		expect(renderCycle(mode)).toContain("temporary-track");

		// Still lingering shortly after.
		vi.advanceTimersByTime(1000);
		expect(renderCycle(mode)).toContain("temporary-track");

		// Gone well past the linger window.
		vi.advanceTimersByTime(5000);
		expect(renderCycle(mode)).not.toContain("temporary-track");
	});
});
