import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { configureDefaultI18n, localizeTuiText } from "@oh-my-pi/pi-tui/i18n";
import { formatExpandHint } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { OverlayPanel } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { settingGroupLabel, settingTabLabel } from "@oh-my-pi/pi-tui/overlays/settings-defs";

const plainTheme = {
	fg: (_color: unknown, text: string) => text,
	format: { bracketLeft: "[", bracketRight: "]" },
} as unknown as Theme;

describe("TUI i18n", () => {
	beforeEach(() => {
		setKeyHintPlatform("linux");
		setKeybindings(KeybindingsManager.inMemory());
		configureDefaultI18n("en");
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		setKeyHintPlatform(undefined);
		configureDefaultI18n("en");
	});

	it("renders fixed expand hints in the configured locale", () => {
		configureDefaultI18n("zh-CN");
		expect(formatExpandHint(plainTheme, false, true)).toBe("[Ctrl+O: 展开]");
	});

	it("localizes shared overlay titles", () => {
		configureDefaultI18n("zh-CN");
		const panel = new OverlayPanel("Theme");
		expect(panel.title).toBe("主题");
	});

	it("localizes built-in form hints but leaves custom text unchanged", () => {
		configureDefaultI18n("zh-CN");
		expect(localizeTuiText("  Enter to save · Esc to cancel · Clear field to unset")).toBe(
			"  按 Enter 保存 · 按 Esc 取消 · 清空字段以取消设置",
		);
		expect(localizeTuiText("extension-provided hint")).toBe("extension-provided hint");
	});

	it("localizes settings tabs and stable group headings", () => {
		configureDefaultI18n("zh-CN");
		expect(settingTabLabel("appearance")).toBe("外观");
		expect(settingGroupLabel("Theme")).toBe("主题");
		expect(settingGroupLabel("extension-defined group")).toBe("extension-defined group");
	});
});
