import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgMagicKeywordsEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { imageLinksForMessage } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { chipLabel } from "../../../src/ui/composer/attachments";
import { enabledMagicKeywords } from "../../../src/ui/composer/magic-keywords";
import { printRows } from "../../../src/ui/print-rows";
import "../../../src/ui/styles/messages";
import { UserMessage, type UserMessageModel } from "../../../src/ui/transcript/messages/user-message";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

const restoreTheme = currentTheme();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	cfgMagicKeywordsEnabled.set(Settings.instance, true);
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
	resetSettingsForTest();
});

/** The sent bubble's rows at 80 columns, styled; the keywords the settings enable glow. */
function bubbleRaw(model: UserMessageModel): string {
	const glowing = { magicKeywords: () => enabledMagicKeywords(Settings.instance), ...model };
	return printRows(() => UserMessage({ model: glowing }), 80).join("\n");
}

/** The sent bubble's rows at 80 columns, ANSI stripped. */
function bubbleText(model: UserMessageModel): string {
	return Bun.stripANSI(bubbleRaw(model));
}

describe("user message magic-keyword highlighting", () => {
	it("gradient-paints a magic keyword in the sent message bubble", () => {
		const raw = bubbleRaw({ text: "please orchestrate the rollout" });
		// Visible text is preserved.
		expect(Bun.stripANSI(raw)).toContain("please orchestrate the rollout");
		// The keyword is gradient-painted per character: the word no longer survives
		// as a contiguous run in the styled rows.
		expect(raw).not.toContain("orchestrate");
	});

	it("does not paint a keyword inside an inline code span", () => {
		const raw = bubbleRaw({ text: "ship the `orchestrate` helper" });
		expect(raw).toContain("orchestrate");
	});

	it("does not paint a keyword inside a fenced code block", () => {
		const raw = bubbleRaw({ text: "intro\n```\norchestrate\n```" });
		expect(raw).toContain("orchestrate");
	});
});

describe("user message bubble", () => {
	it("collapses model tags to the model's visible label", () => {
		const text = bubbleText({ text: 'ask <model agent="m1" name="Claude (Fast)"/> then continue' });
		expect(text).toContain("Claude (Fast) then continue");
		expect(text).not.toContain("<model agent=");
	});

	it("collapses image markers to chips", () => {
		const text = bubbleText({ text: "please inspect [Image #1, 800x600] before continuing" });
		expect(text).toContain(`${chipLabel("image", 1)} before continuing`);
		expect(text).not.toContain("[Image #1");
	});

	it("draws chips in the symbol preset's glyphs, the ones the composer drew them with", () => {
		// A Nerd Font session (every Tern session is one) must not fall back to the unicode preset's emoji.
		const nerd = presetSymbols("nerd");
		setCurrentTheme(loadThemeSync("dark", { symbolPreset: "nerd" }));
		try {
			const text = bubbleText({
				text: 'ask <model agent="m1" name="Fast"/> about [Image #1, 800x600] and [Video #2]',
			});
			expect(text).toContain(
				`${nerd["icon.model"]} Fast about ${nerd["chip.image"]} #1 and ${nerd["chip.video"]} #2`,
			);
		} finally {
			setCurrentTheme(restoreTheme);
		}
	});
});

describe("image links on transcript rebuild", () => {
	it("materializes inline image data to a blob path when links are not precomputed", () => {
		const displayPath = path.resolve("/tmp/abc123.png");
		const sessionManager = {
			putBlobSync: () => ({
				hash: "abc123",
				path: path.resolve("/tmp/abc123"),
				displayPath,
				ref: "blob:sha256:abc123",
			}),
		};
		const links = imageLinksForMessage(
			[{ type: "image", data: Buffer.from("image-bytes").toString("base64"), mimeType: "image/png" }],
			sessionManager as unknown as Parameters<typeof imageLinksForMessage>[1],
			InternalUrlRouter.builtins(),
		);
		expect(links).toEqual([displayPath]);
	});
});
