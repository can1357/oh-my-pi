/**
 * Composer prose assists over the terminal: the magic-keyword glow (a gradient
 * per enabled keyword, swept on the terminal clock) and macOS spelling (typo
 * marks, autocorrect after a completed word, the replacement picker), with
 * Apple's service replaced by a fake backend.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot, type KeyEvent } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { CONSERVATIVE_EMOJI } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { Settings } from "../../../src/config/settings";
import { MacOSSpellingProvider, type SpellingBackend } from "../../../src/modes/view-model/prompt/macos-spelling";
import { Composer, ComposerChips } from "../../../src/ui/composer";
import { chipHref } from "../../../src/ui/composer/composer";
import { enabledMagicKeywords, magicKeywordDecorator } from "../../../src/ui/composer/magic-keywords";
import { skillAtomizer } from "../../../src/ui/composer/skill-chips";
import { attachSpelling } from "../../../src/ui/composer/spelling";
import { initTheme } from "../../../src/ui/theme/service";

const restoreTheme = currentTheme();

beforeAll(() => {
	// The glow assertions read truecolor SGR: pin the depth instead of following the runner's env.
	initTheme({
		capabilities: {
			truecolor: true,
			colors: 16_777_216,
			dark: true,
			emoji: CONSERVATIVE_EMOJI,
			styledUnderlines: false,
		},
	});
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
});

function mount(composer: Composer): TestTerminal {
	const term = createTestTerminal(() => ({ main: [composer.node] }), { columns: 60, rows: 8, theme: currentTheme() });
	term.focus(composer.field);
	return term;
}

/** Truecolor foregrounds painted on the composer's input row. */
function foregrounds(term: TestTerminal): string[] {
	const row = term.rows().find(line => line.includes("now")) ?? "";
	return [...row.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map(match => match[1]!);
}

const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("magic keyword glow", () => {
	test("paints an enabled keyword with its gradient, moving on the terminal clock", () => {
		createRoot(dispose => {
			const settings = Settings.isolated({});
			const composer = new Composer({ text: "please ultrathink now" });
			composer.addDecorator(magicKeywordDecorator(() => enabledMagicKeywords(settings)));
			const term = mount(composer);
			const still = foregrounds(term);
			// Ten letters of the keyword, each its own stop, over the plain text color.
			expect(new Set(still).size).toBeGreaterThan(5);
			term.tick(450);
			expect(foregrounds(term)).not.toEqual(still);
			term.dispose();
			dispose();
		});
	});

	test("stays plain when the keyword's setting is off, and still without animation", () => {
		createRoot(dispose => {
			const off = Settings.isolated({ "magicKeywords.ultrathink": false });
			const composer = new Composer({ text: "please ultrathink now" });
			composer.addDecorator(magicKeywordDecorator(() => enabledMagicKeywords(off)));
			const term = mount(composer);
			expect(new Set(foregrounds(term)).size).toBeLessThanOrEqual(2);
			term.dispose();

			const still = new Composer({ text: "please ultrathink now" });
			still.addDecorator(
				magicKeywordDecorator(
					() => enabledMagicKeywords(Settings.isolated({})),
					() => false,
				),
			);
			const stillTerm = mount(still);
			const before = foregrounds(stillTerm);
			stillTerm.tick(450);
			expect(foregrounds(stillTerm)).toEqual(before);
			stillTerm.dispose();
			dispose();
		});
	});
});

describe("macOS spelling", () => {
	const backend: SpellingBackend = {
		isAvailable: () => true,
		checkSpelling: async text => [...text.matchAll(/\bteh\b/g)].map(match => ({ start: match.index, length: 3 })),
		autocorrectWord: async (text, start, length) => (text.slice(start, start + length) === "teh" ? "the" : null),
		spellingGuesses: async () => ["the", "tea"],
	};
	const ctrlDot: KeyEvent = { id: "ctrl+.", kind: "press", raw: "" };

	function setup(features: { typoDetection: boolean; autocorrect: boolean }) {
		const composer = new Composer();
		const detach = attachSpelling(composer, new MacOSSpellingProvider(backend), {
			features: () => features,
			isSuggestionsKey: key => key.id === "ctrl+.",
		});
		const term = mount(composer);
		return { composer, term, detach };
	}

	test("underlines a misspelled word once the caret has left it", async () => {
		await createRoot(async dispose => {
			const { composer, term } = setup({ typoDetection: true, autocorrect: false });
			composer.setText("teh cat now");
			await settle();
			term.render();
			const row = term.rows().find(line => line.includes("now")) ?? "";
			expect(row).toMatch(/\x1b\[4m(?:\x1b\[[\d;]*m)*teh/);
			term.dispose();
			dispose();
		});
	});

	test("autocorrects a word a space completes", async () => {
		await createRoot(async dispose => {
			const { composer, term } = setup({ typoDetection: false, autocorrect: true });
			term.type("teh ");
			await settle();
			expect(composer.text()).toBe("the ");
			expect(composer.cursor()).toBe(4);
			term.dispose();
			dispose();
		});
	});

	test("lists replacements for the word at the caret; accepting one replaces it", async () => {
		await createRoot(async dispose => {
			const { composer, term } = setup({ typoDetection: true, autocorrect: false });
			composer.setText("say teh");
			await settle();
			term.press(ctrlDot.id);
			await settle();
			expect(composer.completing()).toBe(true);
			term.press("down");
			term.press("enter");
			expect(composer.text()).toBe("say tea");
			term.dispose();
			dispose();
		});
	});
});

describe("chip links", () => {
	test("an image chip links to its file in the draft and on its card where the terminal draws links", () => {
		createRoot(dispose => {
			const composer = new Composer();
			composer.insertAtom("[Image #1]", "[Image #1]", {
				kind: "image",
				image: { type: "image", data: "aGk=", mimeType: "image/png" },
				link: "/tmp/shot.png",
			});
			const term = createTestTerminal(() => ({ main: [ComposerChips({ composer }), composer.node] }), {
				columns: 60,
				rows: 12,
				theme: currentTheme(),
				capabilities: { hyperlinks: true },
			});
			term.focus(composer.field);
			// The file URI as this platform spells it (a drive-qualified path on Windows).
			const href = chipHref("/tmp/shot.png");
			const links = term.rows().filter(row => row.includes(`\x1b]8;;${href}`));
			// The card's title and the chip in the draft.
			expect(links.length).toBe(2);
			term.dispose();
			dispose();
		});
	});
});

describe("skill chip link", () => {
	test("links the chip to its SKILL.md where the terminal draws links", () => {
		createRoot(dispose => {
			const composer = new Composer();
			composer.setAtomizer(
				skillAtomizer(
					name => (name === "review" ? "/tmp/skills/review/SKILL.md" : undefined),
					() => "✦",
				),
			);
			composer.setCollapsedText("/skill:review now");
			const term = createTestTerminal(() => ({ main: [composer.node] }), {
				columns: 60,
				rows: 6,
				theme: currentTheme(),
				capabilities: { hyperlinks: true },
			});
			term.focus(composer.field);
			const row = term.rows().find(line => line.includes("now")) ?? "";
			const href = RegExp.escape(chipHref("/tmp/skills/review/SKILL.md")!);
			expect(row).toMatch(new RegExp(`\\x1b\\]8;;${href}[^\\x1b]*\\x1b\\\\(?:\\x1b\\[[\\d;]*m)*✦ review`));
			term.dispose();
			dispose();
		});
	});
});

describe("argument hint", () => {
	test("shows the provider's hint for the command's arguments at the line end", () => {
		createRoot(dispose => {
			const composer = new Composer({
				autocomplete: {
					getSuggestions: () => null,
					applyCompletion: lines => ({ lines, cursorLine: 0, cursorCol: lines[0]!.length }),
					getInlineHint: lines => (lines[0] === "/git-sync " ? "[base branch] [next]" : null),
				},
			});
			const term = mount(composer);
			term.type("/git-sync ");
			expect(term.screen().join("\n")).toContain("/git-sync ▏[base branch] [next]");
			// Mid-line the hint goes.
			term.press("left");
			expect(term.screen().join("\n")).not.toContain("[base branch]");
			term.dispose();
			dispose();
		});
	});
});
