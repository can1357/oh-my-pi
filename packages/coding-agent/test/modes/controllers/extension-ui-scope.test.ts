/**
 * The `ctx.ui` hosts of an extension's components: a `custom` dialog and a widget. The factory the
 * host is handed carries the scope its session's code runs in (`rendererScope`); the host mounts
 * what it returns through that scope, and once the scope has gone takes it away — the dialog is
 * closed as an aborted one is, the widget draws nothing — calling nothing of the extension's.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { retireGoneInputScopes, type ToolRendererScope } from "@oh-my-pi/pi-tui/tools/renderer-scope";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

interface OwnedScope {
	readonly scope: ToolRendererScope;
	inside(): boolean;
	retire(): void;
}

function ownedScope(): OwnedScope {
	let live = true;
	const context = new AsyncLocalStorage<true>();
	return {
		scope: {
			get live() {
				return live;
			},
			run<T>(call: () => T): T {
				if (!live) throw new Error("scope retired");
				return context.run(true, call);
			},
		},
		inside: () => context.getStore() === true,
		retire: () => {
			live = false;
		},
	};
}

function recording(label: string, owner: OwnedScope, calls: Array<[string, boolean]>): Component {
	return {
		render() {
			calls.push([`${label}.render`, owner.inside()]);
			return [`${label} line`];
		},
		invalidate() {
			calls.push([`${label}.invalidate`, owner.inside()]);
		},
		handleInput() {
			calls.push([`${label}.handleInput`, owner.inside()]);
		},
		dispose() {
			calls.push([`${label}.dispose`, owner.inside()]);
		},
	};
}

function makeController() {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const hookWidgetContainerAbove = new Container();
	const hookWidgetContainerBelow = new Container();
	const handle = { hide: vi.fn(), setHidden: vi.fn(), isHidden: vi.fn(() => false) };
	const setFocus = vi.fn();
	const showOverlay = vi.fn(() => handle);
	const ctx = {
		editor,
		editorContainer,
		hookWidgetContainerAbove,
		hookWidgetContainerBelow,
		statusRowOccupied: false,
		ui: {
			requestRender: vi.fn(),
			setFocus,
			showOverlay,
			getFocused: () => editor,
			terminal: { rows: 40, columns: 120 },
		},
		session: { extensionRunner: undefined },
	} as unknown as InteractiveModeContext;
	return {
		controller: new ExtensionUiController(ctx),
		editor,
		hookWidgetContainerAbove,
		handle,
		setFocus,
		showOverlay,
	};
}

const flushMicrotasks = async () => {
	for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe("an extension's custom dialog", () => {
	it("is closed, as an aborted one is, once its session has gone, and nothing of it is disposed or called", async () => {
		const h = makeController();
		const owner = ownedScope();
		const calls: Array<[string, boolean]> = [];
		const factory = Object.assign(() => recording("dialog", owner, calls), { rendererScope: owner.scope });
		const pending = h.controller.showHookCustom<void>(factory, { overlay: true });
		await flushMicrotasks();
		expect(h.showOverlay).toHaveBeenCalledTimes(1);

		owner.retire();
		// What the TUI does before it hands out the next key or draws the next frame.
		retireGoneInputScopes();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(h.handle.hide).toHaveBeenCalledTimes(1);
		expect(h.setFocus).toHaveBeenLastCalledWith(h.editor);
		expect(calls).toEqual([]);
	});

	it("a factory refused because the session has gone opens no dialog", async () => {
		const h = makeController();
		const owner = ownedScope();
		owner.retire();
		const factory = Object.assign(() => undefined as unknown as Component, { rendererScope: owner.scope });
		await expect(h.controller.showHookCustom<void>(factory, { overlay: true })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(h.showOverlay).not.toHaveBeenCalled();
	});
});

describe("an extension's widget", () => {
	it("draws inside its session's scope, and nothing once the session has gone", () => {
		const h = makeController();
		const owner = ownedScope();
		const calls: Array<[string, boolean]> = [];
		const factory = Object.assign(() => recording("widget", owner, calls), { rendererScope: owner.scope });
		h.controller.setHookWidget("ext", factory);
		const live = h.hookWidgetContainerAbove.render(80).join("\n");
		expect(live).toContain("widget line");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter(([, inside]) => !inside)).toEqual([]);

		calls.length = 0;
		owner.retire();
		h.hookWidgetContainerAbove.invalidate();
		const retired = h.hookWidgetContainerAbove.render(79).join("\n");
		h.controller.setHookWidget("ext", undefined);
		expect(retired).not.toContain("widget line");
		expect(calls).toEqual([]);
	});

	it("a factory refused because the session has gone mounts no widget", () => {
		const h = makeController();
		const owner = ownedScope();
		owner.retire();
		const factory = Object.assign(() => undefined as unknown as Component, { rendererScope: owner.scope });
		h.controller.setHookWidget("ext", factory);
		expect(h.hookWidgetContainerAbove.render(80).join("\n").trim()).toBe("");
	});
});
