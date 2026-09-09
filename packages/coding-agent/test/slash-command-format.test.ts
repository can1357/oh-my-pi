import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as settingsModule from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderAsciiBar } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/format";

const testTheme = {
	fg(color: Parameters<Theme["fg"]>[0], text: string): string {
		const codes = {
			accent: "\x1b[36m",
			dim: "\x1b[2m",
			muted: "\x1b[90m",
		};
		return `${codes[color as "accent" | "dim" | "muted"] ?? ""}${text}\x1b[39m`;
	},
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	},
	getFgAnsi(color: Parameters<Theme["fg"]>[0]): string {
		const codes = {
			accent: "\x1b[36m",
			dim: "\x1b[2m",
			muted: "\x1b[90m",
		};
		return codes[color as "accent" | "dim" | "muted"] ?? "";
	},
};

// 30 cells/s with classic padding 10 positions the crest on the first cell.
const CLASSIC_CREST_VISIBLE_MS = 333;

describe("renderAsciiBar", () => {
	beforeEach(() => {
		vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the visible progress-bar contract", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);

		const rendered = renderAsciiBar(0.5, 4, testTheme);

		expect(Bun.stripANSI(rendered)).toBe("[██░░] 50%");
	});

	it("colors the shimmer band with the theme accent", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);

		const rendered = renderAsciiBar(undefined, 4, testTheme);

		expect(rendered).toContain("\x1b[36m");
		expect(Bun.stripANSI(rendered)).toBe("[····]");
	});
});
