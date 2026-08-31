import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getMarkdownTheme, setCopyUrlHandlerReady } from "@oh-my-pi/pi-coding-agent/modes/theme/tui-adapters";
import { resolveCopyBlock, supportsCopyUrlHandler } from "@oh-my-pi/pi-coding-agent/utils/copy-store";
import { Markdown, TERMINAL } from "@oh-my-pi/pi-tui";

const originalHyperlinks = TERMINAL.hyperlinks;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	TERMINAL.hyperlinks = true;
	setCopyUrlHandlerReady(true);
});

afterEach(() => {
	setCopyUrlHandlerReady(false);
	TERMINAL.hyperlinks = originalHyperlinks;
	resetSettingsForTest();
});

describe("Markdown copy link", () => {
	it("renders the copy chip as an OSC 8 hyperlink carrying the original code", () => {
		const code = "const value = 1;\n";
		const footer = new Markdown(`\`\`\`ts\n${code}\`\`\``, 0, 0, getMarkdownTheme()).render(80).at(-1) ?? "";
		const target = footer.match(/\x1b]8;;(omp-copy:[^\x07]+)\x07/)?.[1];

		expect(target).toBeDefined();
		expect(resolveCopyBlock(target!)).toBe(code.trimEnd());
		expect(footer).toContain("[copy]");
	});

	it("emits clickable copy targets only on platforms with an installed handler path", () => {
		expect(supportsCopyUrlHandler("linux", {}, "/usr/bin/xdg-mime")).toBe(true);
		expect(supportsCopyUrlHandler("darwin")).toBe(false);
		expect(supportsCopyUrlHandler("win32")).toBe(false);
	});
});
