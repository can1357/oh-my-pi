import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspText } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";

function plainTspText(value: TspText | undefined): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	return value.map(span => (typeof span === "string" ? span : span.t)).join("");
}

// Custom editor components (`setEditorComponent`) are gone: extensions hook the composer
// (`addKeyHandler`/`addDecorator`/`setSubmitTransform`/`setShape`). What stays is the startup gate.
describe("InteractiveMode composer startup submit gate", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
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
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps Enter from sending (or clearing) a draft typed before init finishes", () => {
		mode.composer.setText("draft prompt");
		mode.composer.submit();
		expect(mode.composer.text()).toBe("draft prompt");
	});

	it("shows stash feedback in the composer placeholder and restores the current hint", () => {
		vi.useFakeTimers();
		try {
			const ordinaryHint = plainTspText(mode.composer.placeholder());
			const setPlaceholder = vi.spyOn(mode.composer, "setPlaceholder");

			mode.notifyComposerStash();

			expect(plainTspText(mode.composer.placeholder())).toBe("Prompt stashed");
			expect(mode.composer.placeholder()).toEqual([{ t: "Prompt stashed", s: "dim" }]);
			const rendered = plainRows([
				...paintNode(staticEnvironment(currentTheme()), mode.composer.node, 80).rows,
			]).join("\n");
			expect(rendered).toContain("Prompt stashed");
			expect(setPlaceholder).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(100);
			expect(plainTspText(mode.composer.placeholder())).toBe("Prompt stashed");

			vi.advanceTimersByTime(10_000);
			expect(plainTspText(mode.composer.placeholder())).toBe(ordinaryHint);
			expect(setPlaceholder).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels stash feedback when a saved draft is restored", () => {
		vi.useFakeTimers();
		try {
			const ordinaryHint = plainTspText(mode.composer.placeholder());
			const setPlaceholder = vi.spyOn(mode.composer, "setPlaceholder");

			mode.notifyComposerStash();
			expect(plainTspText(mode.composer.placeholder())).toBe("Prompt stashed");

			vi.advanceTimersByTime(100);
			mode.cancelComposerStashNotice();

			expect(plainTspText(mode.composer.placeholder())).toBe(ordinaryHint);
			expect(setPlaceholder).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(10_000);
			expect(plainTspText(mode.composer.placeholder())).toBe(ordinaryHint);
			expect(setPlaceholder).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels the stash feedback timer when transient session UI is cleared", () => {
		vi.useFakeTimers();
		try {
			const ordinaryHint = plainTspText(mode.composer.placeholder());
			const setPlaceholder = vi.spyOn(mode.composer, "setPlaceholder");

			mode.notifyComposerStash();
			expect(plainTspText(mode.composer.placeholder())).toBe("Prompt stashed");

			mode.clearTransientSessionUi();
			setPlaceholder.mockClear();
			vi.advanceTimersByTime(10_000);

			expect(plainTspText(mode.composer.placeholder())).toBe(ordinaryHint);
			expect(setPlaceholder).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
