import { afterEach, describe, expect, it } from "bun:test";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-tui/app-keybindings";
import { formatExpandHint } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { configureCodingAgentI18n, localizeCodingAgentUiMessage } from "../src/i18n";
import { formatExtensionLoadNotifications } from "../src/extensibility/extensions/load-errors";

const plainTheme = {
	fg: (_color: unknown, text: string) => text,
	format: { bracketLeft: "[", bracketRight: "]" },
} as unknown as Theme;

afterEach(() => {
	configureCodingAgentI18n({ language: "en" });
	setKeybindings(KeybindingsManager.inMemory());
	setKeyHintPlatform(undefined);
});

describe("coding-agent localized output", () => {
	it("localizes extension load failures while preserving path and error text", () => {
		configureCodingAgentI18n({ language: "zh-CN" });
		const [message] = formatExtensionLoadNotifications([{ path: "/tmp/example.ts", error: "SyntaxError: boom" }]);

		expect(message).toBe("加载扩展失败 /tmp/example.ts：SyntaxError: boom");
	});

	it("shares the resolved locale with the TUI default translator", () => {
		setKeyHintPlatform("linux");
		setKeybindings(KeybindingsManager.inMemory());
		configureCodingAgentI18n({ language: "zh-CN" });
		expect(formatExpandHint(plainTheme, false, true)).toBe("[Ctrl+O: 展开]");
	});

	it("localizes fixed controller status without translating dynamic content", () => {
		configureCodingAgentI18n({ language: "zh-CN" });
		expect(localizeCodingAgentUiMessage("Auto-shake completed")).toBe("自动抖动已完成");
		expect(localizeCodingAgentUiMessage("Memory data cleared and system prompt refreshed.")).toBe(
			"记忆数据已清除，系统提示已刷新。",
		);
		expect(localizeCodingAgentUiMessage("Fallback succeeded on openai/gpt-5.2")).toBe(
			"已在 openai/gpt-5.2 上成功使用备用模型",
		);
		expect(localizeCodingAgentUiMessage("remote tool result")).toBe("remote tool result");
	});
});
