import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";

import { HookInputComponent } from "@oh-my-pi/pi-tui/overlays/hook-input";
import { TinyTitleDownloadProgressComponent } from "@oh-my-pi/pi-tui/overlays/tiny-title-download-progress";
import { configureDefaultI18n } from "@oh-my-pi/pi-tui/i18n";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

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

	it("renders fixed input chrome through the active locale", () => {
		configureDefaultI18n("zh-CN");
		try {
			const component = new HookInputComponent(
				"Prompt",
				undefined,
				() => {},
				() => {},
			);
			const output = component.render(80).join("\n");
			expect(output).toContain("提交");
			expect(output).toContain("取消");
			expect(output).not.toContain("enter submit");
			component.dispose();
		} finally {
			configureDefaultI18n("en");
		}
	});

	it("localizes tiny-model download status labels", () => {
		configureDefaultI18n("zh-CN");
		try {
			const component = new TinyTitleDownloadProgressComponent("test-model");
			component.update({ status: "error", progress: 50 });
			const output = component.render(80).join("\n");
			expect(output).toContain("小模型");
			expect(output).toContain("失败");
			expect(output).not.toContain("Tiny model");
		} finally {
			configureDefaultI18n("en");
		}
	});
});
