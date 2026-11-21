import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";

import { stripVTControlCharacters } from "node:util";
import { HookInputComponent } from "@oh-my-pi/pi-tui/overlays/hook-input";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";

const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

/** Every described node under `child`, components expanded through their own `describe`. */
function nodes(child: NativeChild): NativeNode[] {
	const described = "k" in child ? child : child.describe?.(CX);
	if (!described) return [];
	return [described, ...(described.c ?? []).flatMap(nodes)];
}

/** The spans of a `text` node (none for other kinds). */
function spans(node: NativeNode): readonly TspSpan[] {
	return node.k === "text" ? (node.p?.spans ?? []) : [];
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});
describe("HookInputComponent timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resets timeout on user activity and still expires when idle", () => {
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		vi.advanceTimersByTime(900);
		component.handleInput("a");

		vi.advanceTimersByTime(900);
		component.handleInput("\x7f");

		vi.advanceTimersByTime(900);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		vi.advanceTimersByTime(200);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);

		component.dispose();
	});

	it("preserves submit behavior", () => {
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		component.handleInput("h");
		component.handleInput("i");
		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("hi");
		expect(onCancel).not.toHaveBeenCalled();
		expect(onTimeout).not.toHaveBeenCalled();

		component.dispose();
	});

	it("absorbs enhanced-paste payloads via pasteText and resets the timeout", () => {
		// Regression: enhanced-paste (kitty OSC 5522) focus routing only targets
		// components exposing a `pasteText` hook; without one the payload landed
		// in the hidden main prompt behind the dialog (#2127 contract).
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		vi.advanceTimersByTime(900);
		component.pasteText("sk-line1\nsk-line2");

		vi.advanceTimersByTime(900);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("sk-line1sk-line2");

		component.dispose();
	});

	it("masks characters as bullets when secret is true", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookInputComponent("API Key", undefined, onSubmit, onCancel, { secret: true });

		component.handleInput("s");
		component.handleInput("e");
		component.handleInput("c");
		component.handleInput("r");
		component.handleInput("e");
		component.handleInput("t");

		const rendered = stripVTControlCharacters(component.render(80).join("\n"));
		expect(rendered).toContain("••••••");
		expect(rendered).not.toContain("secret");

		component.handleInput("\n");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("secret");

		component.dispose();
	});
});

describe("HookInputComponent native sheet", () => {
	it("Submit and Cancel run what Enter and Esc run; keys live only in tooltips", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new HookInputComponent("Search pull requests", undefined, onSubmit, onCancel);
		const buttons = nodes(component.describe(CX)).filter(node => node.p?.role === "omp.btn");
		expect(buttons.map(button => [button.key, button.p?.title])).toEqual([
			["cancel", "Cancel  esc"],
			["submit", "Submit  ⏎"],
		]);
		// No key legend text in the native body: the terminal-only hint stays in render().
		const texts = nodes(component.describe(CX)).flatMap(node => spans(node).map(s => s.t));
		expect(texts.some(t => t.includes("submit"))).toBe(false);
		expect(stripVTControlCharacters(component.render(80).join("\n"))).toContain("submit");

		component.handleInput("4");
		component.handleInput("2");
		component.handleNativeEvent({ type: "action", key: "actions/submit", act: "submit", mods: [] });
		expect(onSubmit).toHaveBeenCalledWith("42");
		component.handleNativeEvent({ type: "action", key: "actions/cancel", act: "cancel", mods: [] });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("splits the title into head and detail and draws the placeholder natively", () => {
		const component = new HookInputComponent(
			"Search pull requests\nTitle, author or #123",
			"e.g. #482",
			vi.fn(),
			vi.fn(),
		);
		const all = nodes(component.describe(CX));
		const title = all.find(node => node.p?.role === "omp.hook-input.title");
		const detail = all.find(node => node.p?.role === "omp.hook-input.detail");
		expect(title && spans(title).map(s => s.t)).toEqual(["Search pull requests"]);
		expect(detail && spans(detail).map(s => s.t)).toEqual(["Title, author or #123"]);
		expect(all.find(node => node.k === "input")?.p).toMatchObject({ placeholder: "e.g. #482" });
	});

	it("a refused submit keeps the value and tints the field with the reason under it", () => {
		const component = new HookInputComponent(
			"PR number",
			undefined,
			value => {
				throw new Error(`"${value}" isn't a number`);
			},
			vi.fn(),
		);
		component.handleInput("x");
		component.handleInput("\n");
		const all = nodes(component.describe(CX));
		expect(all.find(node => node.p?.role === "omp.hook-input.field")?.p).toMatchObject({ tone: "error" });
		expect(all.some(node => spans(node).some(s => s.t === `"x" isn't a number` && s.s === "error"))).toBe(true);
		expect(all.find(node => node.k === "input")?.p).toMatchObject({ text: "x" });
	});
});
