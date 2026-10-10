import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager, type KeybindingsConfig } from "@oh-my-pi/pi-tui/app-keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const CTRL_SHIFT_I = "\x1b[105;6u";

type InputListener = (data: string) => { consume: boolean } | undefined;

function createHarness(userBindings: KeybindingsConfig) {
	const listeners: InputListener[] = [];
	let overlayVisible = false;
	const retransmitInlineImages = vi.fn();
	const ctx = {
		ui: {
			addInputListener: (fn: InputListener) => {
				listeners.push(fn);
			},
			addStartListener: () => {},
			getFocused: () => undefined,
			hasOverlay: () => overlayVisible,
			requestRender: vi.fn(),
			retransmitInlineImages,
		},
		editor: {
			getText: () => "",
			setText: () => {},
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			spaceHold: new SpaceHoldGesture(() => {}),
		},
		// The real manager, so a missing KEYBINDINGS definition is observable here
		// exactly as it is for a user who put the action in keybindings.yml.
		keybindings: KeybindingsManager.inMemory(userBindings),
		settings,
		dictationSpaceHold: () => undefined,
		session: { extensionRunner: undefined },
		handlesBtwBranchKey: () => false,
		focusedAgentId: undefined,
		showStatus: () => {},
		setOverlayVisible(visible: boolean) {
			overlayVisible = visible;
		},
	} as unknown as InteractiveModeContext;

	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	return {
		ctx,
		retransmitInlineImages,
		setOverlayVisible(visible: boolean) {
			overlayVisible = visible;
		},
		dispatch(data: string) {
			for (const listener of listeners) {
				const result = listener(data);
				if (result) return result;
			}
			return undefined;
		},
	};
}

describe("InputController app.images.retransmit (#12595)", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("retransmits inline images on a user-bound key", () => {
		const harness = createHarness({ "app.images.retransmit": "ctrl+shift+i" });

		expect(harness.dispatch(CTRL_SHIFT_I)).toEqual({ consume: true });
		expect(harness.retransmitInlineImages).toHaveBeenCalledTimes(1);
	});

	it("leaves the key alone while an overlay holds focus", () => {
		const harness = createHarness({ "app.images.retransmit": "ctrl+shift+i" });
		harness.setOverlayVisible(true);

		expect(harness.dispatch(CTRL_SHIFT_I)).toBeUndefined();
		expect(harness.retransmitInlineImages).not.toHaveBeenCalled();
	});

	it("does not fire on an unrelated key", () => {
		const harness = createHarness({ "app.images.retransmit": "ctrl+shift+i" });

		expect(harness.dispatch("\x03")).toBeUndefined();
		expect(harness.retransmitInlineImages).not.toHaveBeenCalled();
	});

	it("claims no key by default so it cannot shadow an existing chord", () => {
		const manager = KeybindingsManager.inMemory();

		expect(manager.getKeys("app.images.retransmit")).toEqual([]);
		expect(manager.matches("\x03", "app.images.retransmit")).toBe(false);
	});
});
