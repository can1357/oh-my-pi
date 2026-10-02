import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { TspListProps } from "@oh-my-pi/pi-wire";
import { CountdownTimer } from "@oh-my-pi/pi-tui/chrome/countdown-timer";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { Loader, type LoaderMessageColorFn } from "@oh-my-pi/pi-tui/components/loader";
import { type SelectItem, SelectList } from "@oh-my-pi/pi-tui/components/select-list";
import { type SettingItem, SettingsList } from "@oh-my-pi/pi-tui/components/settings-list";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { getEditorTheme, getSelectListTheme, getSettingsListTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

/** The `editor` node an Editor describes, wherever its layout places it. */
function editorNode(editor: Editor): Extract<NativeNode, { k: "editor" }> {
	const find = (described: NativeNode): Extract<NativeNode, { k: "editor" }> | undefined => {
		if (described.k === "editor") return described;
		for (const child of described.c ?? []) {
			const found = "k" in child ? find(child) : undefined;
			if (found) return found;
		}
		return undefined;
	};
	const found = find(editor.describe(cx));
	if (!found) throw new Error("editor node missing");
	return found;
}

function changedProps(before: NativeNode, after: NativeNode): string[] {
	const a = (before.p ?? {}) as Record<string, unknown>;
	const b = (after.p ?? {}) as Record<string, unknown>;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	return [...keys].filter(key => a[key] !== b[key]).sort();
}

function listProps(root: NativeNode): TspListProps {
	for (const child of root.c ?? []) {
		if ("k" in child && child.k === "list" && child.p) return child.p;
	}
	throw new Error("list node missing");
}

const ITEMS: SelectItem[] = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta", disabled: true },
	{ value: "c", label: "Gamma" },
	{ value: "d", label: "Delta", confirmation: "Press again to delete" },
];

describe("native interactive primitives", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		setNativeRendering(false);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("schedules no loader repaint timer while a TSP surface renders, and describes an escape-free spinner row", () => {
		vi.useFakeTimers();
		setNativeRendering(true);
		const ui = { requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `\x1b[36m${text}\x1b[39m`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => `\x1b[35m${text}\x1b[39m`, colorMessage, "Working");

		vi.advanceTimersByTime(1000);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		expect(loader.debugState().running).toBe(false);

		const described = loader.describe(cx);
		expect(JSON.stringify(described)).not.toContain("\x1b");
		expect(JSON.stringify(described)).toContain('"k":"spinner"');
		expect(loader.describe(cx)).toBe(described);
		loader.stop();
	});

	it("stops a running loader's timer chain once a TSP surface opens", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Working",
		);
		vi.advanceTimersByTime(200);
		const paints = ui.requestComponentRender.mock.calls.length;
		expect(paints).toBeGreaterThan(1);

		setNativeRendering(true);
		vi.advanceTimersByTime(1000);
		expect(ui.requestComponentRender.mock.calls.length).toBe(paints);
		expect(loader.debugState().running).toBe(false);
	});

	it("counts down natively without a per-second tick", () => {
		vi.useFakeTimers();
		setNativeRendering(true);
		const onTick = vi.fn();
		const onExpire = vi.fn();
		const countdown = new CountdownTimer(5000, undefined, onTick, onExpire);

		vi.advanceTimersByTime(3000);
		expect(onTick).toHaveBeenCalledTimes(1);
		const described = countdown.describe();
		if (described.k !== "elapsed") throw new Error("expected an elapsed node");
		expect(described.p?.stopped).toBe(0);
		expect(described.p?.age).toBeLessThanOrEqual(0);

		vi.advanceTimersByTime(2000);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("schedules no magic-keyword shimmer frame under TSP and declares the shimmer as a decoration", () => {
		setMagicKeywords([{ word: "ultrathink", hue: [0, 360] }]);
		try {
			setNativeRendering(true);
			const editor = new CustomEditor(getEditorTheme());
			const repaint = vi.fn();
			editor.setShimmerRepaintHandler(repaint);
			editor.focused = true;
			editor.setText("please ultrathink");
			const timeout = vi.spyOn(globalThis, "setTimeout");
			editor.render(60);
			expect(timeout).not.toHaveBeenCalled();

			const decor = editorNode(editor).p?.decor ?? [];
			expect(decor).toContainEqual({ from: 7, to: 17, s: "accent", fx: "shimmer" });
		} finally {
			setMagicKeywords([]);
		}
	});

	it("changes only text and cursor when typing and only the cursor when moving", () => {
		const editor = new Editor(getEditorTheme());
		editor.focused = true;
		editor.setText("hello");
		const first = editorNode(editor);
		expect(editorNode(editor)).toBe(first);

		editor.handleInput("!");
		const typed = editorNode(editor);
		expect(changedProps(first, typed)).toEqual(["cursor", "text"]);
		expect(typed.key).toBe(first.key);
		expect(typed.p).toMatchObject({ text: "hello!", cursor: 6 });

		editor.handleInput("\x1b[D");
		const moved = editorNode(editor);
		expect(changedProps(typed, moved)).toEqual(["cursor"]);
		expect(moved.p).toMatchObject({ cursor: 5 });
	});

	it("takes the terminal's wrap natively: Up and Down reach it only on the first and last drawn row", () => {
		const editor = new Editor(getEditorTheme());
		editor.focused = true;
		const text = `${"word ".repeat(40)}end`;
		editor.setText(text);
		expect(editorNode(editor).p).toMatchObject({ cursor: text.length });
		// Tern moves the caret between the rows it drew; an Up it hands over comes
		// from its first row, which is on the first line whatever width omp assumes.
		editor.handleInput("\x1b[A");
		expect(editorNode(editor).p).toMatchObject({ cursor: 0 });
		editor.handleInput("\x1b[B");
		expect(editorNode(editor).p).toMatchObject({ cursor: text.length });
	});

	it("never describes a masked input's secret", () => {
		const input = new Input();
		input.mask = true;
		input.setValue("hunter2");
		input.handleInput("\x1b[D");
		const described = input.describe(cx);
		expect(described.p).toMatchObject({ text: "•••••••", cursor: 6 });
		expect(JSON.stringify(described)).not.toContain("hunter2");
	});

	it("activates the same item through a native select event as through the keyboard", () => {
		const keyboard = new SelectList(ITEMS, 5, getSelectListTheme());
		const keyboardSelect = vi.fn();
		keyboard.onSelect = keyboardSelect;
		keyboard.handleInput("\x1b[B");
		keyboard.handleInput("\r");

		const pointer = new SelectList(ITEMS, 5, getSelectListTheme());
		const pointerSelect = vi.fn();
		pointer.onSelect = pointerSelect;
		pointer.handleNativeEvent({ type: "select", key: "list", item: "c" });

		expect(keyboardSelect).toHaveBeenCalledWith(ITEMS[2]);
		expect(pointerSelect).toHaveBeenCalledWith(ITEMS[2]);
		expect(listProps(pointer.describe(cx)).selected).toBe("c");
	});

	it("keeps the confirmation step for native activation of a confirm-required item", () => {
		const list = new SelectList(ITEMS, 5, getSelectListTheme());
		const onSelect = vi.fn();
		list.onSelect = onSelect;

		list.handleNativeEvent({ type: "activate", key: "list", item: "d" });
		expect(onSelect).not.toHaveBeenCalled();
		expect(JSON.stringify(list.describe(cx))).toContain("Press again to delete");

		list.handleNativeEvent({ type: "activate", key: "list", item: "d" });
		expect(onSelect).toHaveBeenCalledWith(ITEMS[3]);
	});

	it("moves settings selection on select and changes the value only when the selected row is picked again", () => {
		const items: SettingItem[] = [
			{ id: "one", label: "One", currentValue: "on", values: ["on", "off"] },
			{ id: "two", label: "Two", currentValue: "on", values: ["on", "off"] },
		];
		const onChange = vi.fn();
		const list = new SettingsList(items, 5, getSettingsListTheme(), onChange, () => {});

		list.handleNativeEvent({ type: "select", key: "list", item: "two" });
		expect(list.getSelectedItem()?.id).toBe("two");
		expect(onChange).not.toHaveBeenCalled();

		list.handleNativeEvent({ type: "select", key: "list", item: "two" });
		expect(onChange).toHaveBeenCalledWith("two", "off");
		expect(JSON.stringify(list.describe(cx))).toContain('"t":"off"');
	});
});
