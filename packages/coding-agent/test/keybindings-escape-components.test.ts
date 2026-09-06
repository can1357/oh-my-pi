import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { KeybindingsManager } from "@pk-nerdsaver-ai/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/model-selector";
import { SessionSelectorComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import type { SessionInfo } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-listing";
import { setKeybindings, type TUI } from "@pk-nerdsaver-ai/pi-tui";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

let authStorage: AuthStorage | undefined;
let tempDir: TempDir | undefined;

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

describe("component escape bindings", () => {
	it("uses app.interrupt for session selector cancel without changing Ctrl+C exit", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.interrupt": "alt+x",
		});
		setKeybindings(keybindings);

		const onCancel = vi.fn();
		const onExit = vi.fn();
		const selector = new SessionSelectorComponent(
			[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
			() => {},
			onCancel,
			onExit,
		);

		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		selector.handleInput("\x1bx");
		expect(onCancel).toHaveBeenCalledTimes(1);

		selector.handleInput("\x03");
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it("uses tui.select.cancel for model selector cancellation", async () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.select.cancel": "ctrl+g",
		});
		setKeybindings(keybindings);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
		}

		const settings = Settings.isolated({
			modelRoles: {
				default: `${model.provider}/${model.id}`,
			},
		});
		tempDir = TempDir.createSync("@pi-model-selector-escape-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const ui = {
			requestRender: vi.fn(),
		} as unknown as TUI;
		const onCancel = vi.fn();

		const selector = new ModelSelectorComponent(
			ui,
			model,
			settings,
			modelRegistry,
			[{ model, thinkingLevel: "off" }],
			() => {},
			onCancel,
		);

		await Bun.sleep(0);

		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		selector.handleInput("\x07");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
