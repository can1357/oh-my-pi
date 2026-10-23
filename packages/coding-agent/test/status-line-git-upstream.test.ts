/**
 * The git segment renders upstream divergence counts next to the branch:
 * `⇡N` commits ahead of upstream (statusLineStaged) and `⇣N` behind
 * (statusLineDirty). Counts come from the native statusSummary; they are
 * absent (undefined) for jj workspaces and branches without an upstream,
 * and zero when in sync — both render nothing. `showAheadBehind: false`
 * and the ascii symbol preset (`^`/`v`) are honored.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "@oh-my-pi/pi-tui/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-tui/status-line/types";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import {
	exchangeTheme,
	getColorBlindMode,
	getCurrentThemeName,
	getNativeThemePaletteKey,
	getSymbolPresetOverride,
	getThemeEpoch,
	type SymbolPreset,
	type Theme,
	theme,
} from "@oh-my-pi/pi-tui/theme";

// Segments render through the process-global theme object. `exchangeTheme`
// swaps that object only: theme name, auto-detection, symbol-preset override,
// color-blind mode, and the watcher stay as this file found them.
let priorTheme: Theme | undefined;
let unicodeTheme: Theme;
let asciiTheme: Theme;
let managerKey = "";
let themeName: string | undefined;
let symbolPreset: SymbolPreset | undefined;
let colorBlind = false;
let themeEpoch = 0;

beforeAll(async () => {
	unicodeTheme = await loadTheme("dark", { symbolPresetOverride: "unicode" });
	asciiTheme = await loadTheme("dark", { symbolPresetOverride: "ascii" });
	managerKey = getNativeThemePaletteKey();
	themeName = getCurrentThemeName();
	symbolPreset = getSymbolPresetOverride();
	colorBlind = getColorBlindMode();
	themeEpoch = getThemeEpoch();
	priorTheme = typeof theme === "undefined" ? undefined : theme;
	exchangeTheme(unicodeTheme);
	expect(managerFingerprint()).toEqual(savedManager());
});

afterAll(() => {
	if (priorTheme) exchangeTheme(priorTheme);
	expect(managerFingerprint()).toEqual(savedManager());
});

interface ThemeManagerSnapshot {
	key: string;
	name: string | undefined;
	preset: SymbolPreset | undefined;
	colorBlind: boolean;
	epoch: number;
}

function savedManager(): ThemeManagerSnapshot {
	return { key: managerKey, name: themeName, preset: symbolPreset, colorBlind, epoch: themeEpoch };
}

function managerFingerprint(): ThemeManagerSnapshot {
	return {
		key: getNativeThemePaletteKey(),
		name: getCurrentThemeName(),
		preset: getSymbolPresetOverride(),
		colorBlind: getColorBlindMode(),
		epoch: getThemeEpoch(),
	};
}

type GitStatus = NonNullable<SegmentContext["git"]["status"]>;

function ctxWith(status: GitStatus | null, showAheadBehind?: boolean): SegmentContext {
	return {
		git: { branch: "main", status, pr: null },
		options: { git: { showBranch: true, showAheadBehind } },
	} as unknown as SegmentContext;
}

function plain(status: GitStatus | null, showAheadBehind?: boolean): string {
	return stripVTControlCharacters(renderSegment("git", ctxWith(status, showAheadBehind)).content);
}

describe("git segment upstream indicators", () => {
	it("renders ahead and behind counts before the dirty indicators", () => {
		const text = plain({ staged: 1, unstaged: 1, untracked: 0, ahead: 2, behind: 1 });
		expect(text).toContain("⇡2");
		expect(text).toContain("⇣1");
		expect(text.indexOf("⇡2")).toBeLessThan(text.indexOf("⇣1"));
		expect(text.indexOf("⇣1")).toBeLessThan(text.indexOf("*1"));
	});

	it("renders only the nonzero direction", () => {
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 3, behind: 0 })).toContain("⇡3");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 3, behind: 0 })).not.toContain("⇣");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 4 })).toContain("⇣4");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 4 })).not.toContain("⇡");
	});

	it("renders nothing when in sync or when counts are absent (jj / no upstream)", () => {
		expect(plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 })).not.toContain("⇡");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0 })).not.toContain("⇡");
		expect(plain({ staged: 0, unstaged: 0, untracked: 0 })).not.toContain("⇣");
	});

	it("honors showAheadBehind: false", () => {
		const text = plain({ staged: 1, unstaged: 0, untracked: 0, ahead: 2, behind: 1 }, false);
		expect(text).not.toContain("⇡");
		expect(text).not.toContain("⇣");
		expect(text).toContain("+1");
	});

	it("falls back to ASCII arrows under the ascii symbol preset", () => {
		// The finally restores the suite's theme object even when an assertion fails.
		try {
			exchangeTheme(asciiTheme);
			const text = plain({ staged: 0, unstaged: 0, untracked: 0, ahead: 2, behind: 1 });
			expect(text).toContain("^2");
			expect(text).toContain("v1");
			expect(text).not.toContain("⇡");
			expect(managerFingerprint()).toEqual(savedManager());
		} finally {
			exchangeTheme(unicodeTheme);
		}
	});
});
