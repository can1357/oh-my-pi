import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { KeybindingsManager, setKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { ModelHub } from "../src/ui/overlays/pickers/model-hub";
import { SessionSelector } from "../src/ui/overlays/pickers/session-selector";
import { mountLayer } from "./helpers/layer-terminal";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
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
	it("cancels the session selector on Esc and exits on Ctrl+C by default", () => {
		const onCancel = vi.fn();
		const onExit = vi.fn();
		const selector = mountLayer(() =>
			SessionSelector({
				sessions: [createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
				onSelect: () => {},
				onCancel,
				onExit,
			}),
		);

		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onExit).not.toHaveBeenCalled();

		selector.handleInput("\x03");
		expect(onExit).toHaveBeenCalledTimes(1);
		selector.dispose();
	});

	// Remapped selector keys: pending the picker keymap wiring (KeyRemaps).
	it("uses app.interrupt for session selector cancel without changing Ctrl+C exit", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.interrupt": "alt+x",
		});
		setKeybindings(keybindings);

		const onCancel = vi.fn();
		const onExit = vi.fn();
		const selector = mountLayer(() =>
			SessionSelector({
				sessions: [createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
				onSelect: () => {},
				onCancel,
				onExit,
			}),
		);

		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		selector.handleInput("\x1bx");
		expect(onCancel).toHaveBeenCalledTimes(1);

		selector.handleInput("\x03");
		expect(onExit).toHaveBeenCalledTimes(1);
		selector.dispose();
	});

	it("uses tui.select.cancel for model selector cancellation", () => {
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
		const modelRegistry = {
			getAll: () => [model],
			getAvailable: () => [model],
			getError: () => undefined,
			getDiscoverableProviders: () => [],
			getProviderDiscoveryState: () => undefined,
			refresh: async () => {},
			refreshProvider: async () => {},
			authStorage: { keys: { source: () => undefined } },
		} as unknown as ModelRegistry;
		const onCancel = vi.fn();

		const hub = mountLayer(() =>
			ModelHub({
				source: createModelBrowserSource(settings),
				registry: modelRegistry,
				scopedModels: [{ model, thinkingLevel: "off" }],
				callbacks: { onAssign: () => {}, onUnassign: () => {}, onCancel },
			}),
		);

		hub.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();

		hub.handleInput("\x07");
		expect(onCancel).toHaveBeenCalledTimes(1);

		hub.dispose();
	});
});
