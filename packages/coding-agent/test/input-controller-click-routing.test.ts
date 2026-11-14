import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";

const ESC = String.fromCharCode(27);
// SGR click on viewport row 2 (1-based y=3): the pinned expander row when the
// candidates below resolve it to the toggle sentinel.
const EXPANDER_CLICK = `${ESC}[<0;5;3M`;
// Wheel ticks on the same row: capture consumes them, and omp has no viewport
// of its own to scroll (history lives in terminal scrollback), so they must not
// reach click routing.
const WHEEL_UP = `${ESC}[<64;5;3M`;
const WHEEL_DOWN = `${ESC}[<65;5;3M`;

function makeHarness() {
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const focused: string[] = [];
	let toggled = 0;
	const ctx = {
		ui: {
			addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				listeners.push(fn);
			},
			getMutableViewport: () => ({ top: 0, length: 5 }),
			hasOverlay: () => false,
			requestRender: () => {},
			addStartListener: () => {},
			getFocused: () => undefined,
		},
		handlesBtwBranchKey: () => false,
		editor: {
			getText: () => "",
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			spaceHold: new SpaceHoldGesture(() => {}),
		},
		keybindings: KeybindingsManager.inMemory(),
		settings,
		dictationSpaceHold: () => undefined,
		session: {
			extensionRunner: undefined,
		},
		resolveViewportClickCandidates: (index: number) => (index === 2 ? [PINNED_HUD_TOGGLE_ID] : []),
		activateViewportLink: () => false,
		focusedAgentId: undefined,
		focusAgentSession: async (id: string) => {
			focused.push(id);
		},
		togglePinnedHudExpanded: () => {
			toggled++;
		},
		showStatus: () => {},
		setClickHoverId: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	/** Bytes each registered listener received alongside the ones that consumed them. */
	const send = (data: string) => {
		const consumed: string[] = [];
		for (const listener of listeners) if (listener(data)?.consume) consumed.push(data);
		return consumed;
	};
	return {
		send,
		click: () => {
			send(EXPANDER_CLICK);
		},
		focused,
		toggled: () => toggled,
	};
}

describe("InputController click routing", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
		cfgTuiMouse.set(settings, true);
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("focuses a live agent whose id equals the toggle sentinel", () => {
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "evil",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		const h = makeHarness();
		h.click();
		expect(h.focused).toEqual([PINNED_HUD_TOGGLE_ID]);
		expect(h.toggled()).toBe(0);
	});

	it("toggles when no live agent matches the sentinel", () => {
		const h = makeHarness();
		h.click();
		expect(h.toggled()).toBe(1);
		expect(h.focused).toEqual([]);
	});

	it("consumes wheel ticks without scrolling or clicking", () => {
		const h = makeHarness();
		expect(h.send(WHEEL_UP)).toEqual([WHEEL_UP]);
		expect(h.send(WHEEL_DOWN)).toEqual([WHEEL_DOWN]);
		// Consumed *and* inert: capture owns the terminal's wheel, and omp has no
		// viewport of its own to scroll (history lives in terminal scrollback).
		expect(h.toggled()).toBe(0);
		expect(h.focused).toEqual([]);
	});

	it("leaves wheel ticks unclaimed with capture off", () => {
		cfgTuiMouse.set(settings, false);
		const h = makeHarness();
		expect(h.send(WHEEL_UP)).toEqual([]);
		expect(h.toggled()).toBe(0);
	});
});
