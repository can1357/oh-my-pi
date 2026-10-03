import assert from "node:assert/strict";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { installLegacyPiSpecifierShim } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Component } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

await initTheme();
const model = buildModel({
	id: "compat-picker-model",
	name: "Compatibility Picker Model",
	provider: "test",
	api: "ollama-chat",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 1024,
});
const editor: Component = { render: () => [] };
let overlay: Component | undefined;
let focus: Component = editor;
const ctx = {
	settings: Settings.isolated({}),
	session: {
		model,
		getContextUsage: () => ({ tokens: 0 }),
		getRoleModelCycle: () => undefined,
		modelRegistry: {
			refresh: async () => {},
			getError: () => undefined,
			getAvailable: () => [model],
			getAll: () => [model],
		},
		scopedModels: [],
	},
	keybindings: { getKeys: () => ["Alt+P"], getDisplayString: () => "Alt+P" },
	editor,
	editorContainer: { children: [editor] },
	ui: {
		terminal: { rows: 40 },
		requestRender: () => {},
		setFocus: (component: Component) => {
			focus = component;
		},
		showOverlay: (component: Component) => {
			overlay = component;
			return {
				hide: () => {
					overlay = undefined;
				},
			};
		},
	},
} as unknown as InteractiveModeContext;
const controller = new SelectorController(ctx);

// Bun.plugin registrations are process-global. Install the real compatibility
// shim before the first picker open, without preloading either model overlay.
installLegacyPiSpecifierShim();
controller.showModelSelector({ temporaryOnly: true });
assert.ok(overlay, "the picker must open with the compatibility shim installed");
assert.match(Bun.stripANSI(overlay.render(160).join("\n")), /test\/compat-picker-model/);
assert.equal(focus, overlay);
overlay.handleInput?.("\x1b");
assert.equal(overlay, undefined, "Escape must dismiss the picker");
assert.equal(focus, editor, "Escape must return keyboard focus to the editor");
process.stdout.write("picker opened and dismissed\n");
