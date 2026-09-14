import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const ESC = String.fromCharCode(27);
// SGR click on viewport row 2 (1-based y=3): the pinned expander row when the
// candidates below resolve it to the toggle sentinel.
const EXPANDER_CLICK = `${ESC}[<0;5;3M`;

beforeAll(async () => {
	await initTheme();
});

function makeHarness(options: { viewport?: { top: number; length: number }; editor?: CustomEditor } = {}) {
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const focused: string[] = [];
	let toggled = 0;
	let renders = 0;
	const ctx = {
		ui: {
			addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				listeners.push(fn);
			},
			getMutableViewport: () => options.viewport ?? { top: 0, length: 5 },
			hasOverlay: () => false,
			requestRender: () => {
				renders++;
			},
			addStartListener: () => {},
			getFocused: () => undefined,
		},
		handlesBtwBranchKey: () => false,
		editor:
			options.editor ??
			({
				getText: () => "",
				setActionKeys: () => {},
				setCustomKeyHandler: () => {},
				clearCustomKeyHandlers: () => {},
			} as unknown as CustomEditor),
		keybindings: KeybindingsManager.inMemory(),
		session: {
			extensionRunner: undefined,
		},
		resolveViewportClickCandidates: (index: number) => (index === 2 ? [PINNED_HUD_TOGGLE_ID] : []),
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
	const deliver = (data: string) => {
		for (const listener of listeners) listener(data);
	};
	return {
		click: () => deliver(EXPANDER_CLICK),
		optionClick: (report: string) => deliver(report),
		focused,
		toggled: () => toggled,
		renders: () => renders,
	};
}

/**
 * A real editor whose top border sits at viewport-relative row `paintRow`, so
 * its first content row is `paintRow + 1` (box chrome is one row).
 */
function editorAt(paintRow: number): CustomEditor {
	const editor = new CustomEditor(getEditorTheme());
	editor.setText("Hello world");
	editor.render(80);
	editor.setViewportPaintRow(paintRow);
	return editor;
}

describe("InputController click routing", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
		settings.set("tui.mouse", true);
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

	describe("option-click caret placement", () => {
		it("moves the caret and repaints instead of focusing an agent", () => {
			const editor = editorAt(0);
			expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
			const h = makeHarness({ editor });

			// Viewport row 1 is the editor's first content row; a column inside
			// the text lands strictly inside it.
			h.optionClick(`${ESC}[<8;8;2M`);

			expect(editor.getCursor().line).toBe(0);
			expect(editor.getCursor().col).toBeLessThan(11);
			expect(editor.getCursor().col).toBeGreaterThan(0);
			expect(h.focused).toEqual([]);
			expect(h.renders()).toBe(1);
		});

		it("lands further right for a further-right cell", () => {
			const editor = editorAt(0);
			const h = makeHarness({ editor });

			h.optionClick(`${ESC}[<8;6;2M`);
			const left = editor.getCursor().col;
			h.optionClick(`${ESC}[<8;11;2M`);

			expect(editor.getCursor().col).toBeGreaterThan(left);
		});

		it("rebases the click onto the published viewport top", () => {
			// Same viewport-relative row, but the viewport starts 4 screen rows
			// down: only a rebased screen row reaches the editor's content.
			const editor = editorAt(0);
			const h = makeHarness({ editor, viewport: { top: 4, length: 6 } });

			h.optionClick(`${ESC}[<8;8;6M`);

			expect(editor.getCursor().line).toBe(0);
			expect(editor.getCursor().col).toBeGreaterThan(0);
		});

		it("leaves the click unfocused while the viewport is not paintable", () => {
			const editor = editorAt(0);
			const h = makeHarness({ editor, viewport: { top: 0, length: 0 } });

			h.optionClick(`${ESC}[<8;8;2M`);

			expect(editor.getCursor()).toEqual({ line: 0, col: 11 });
			expect(h.renders()).toBe(0);
		});
	});
});
