/**
 * The yield-queue shorthand in the composer: the terminal's `Queueing` header
 * line, the list markers' accent, and Tern's inline prefix.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createRoot, setNativeRenderingForTest } from "@oh-my-pi/pi-tui";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { Composer } from "../../../src/ui/composer";
import { attachQueueShorthand } from "../../../src/ui/composer/queue-shorthand";
import { initTheme } from "../../../src/ui/theme/service";

const restoreTheme = currentTheme();

beforeAll(() => {
	initTheme({ capabilities: { truecolor: true, colors: 16_777_216, dark: true } });
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
});

afterEach(() => {
	setNativeRenderingForTest(false);
});

function mount(text?: string): { composer: Composer; term: TestTerminal } {
	const composer = new Composer({ text });
	attachQueueShorthand(composer, () => "➤");
	const term = createTestTerminal(() => ({ main: [composer.node] }), { columns: 60, rows: 8, theme: currentTheme() });
	term.focus(composer.field);
	return { composer, term };
}

const screen = (term: TestTerminal): string => term.screen().join("\n");

/** The decorations the field describes to a Tern terminal. */
function nativeDecor(composer: Composer): unknown {
	const props = composer.field.props();
	return "decor" in props ? props.decor : undefined;
}

describe("queue shorthand in the terminal", () => {
	test("a completed prefix opens the body beneath a Queueing header a backspace cannot remove", () => {
		for (const prefix of ["->", "=>"]) {
			createRoot(dispose => {
				const { composer, term } = mount();
				term.type(prefix);
				expect(composer.text()).toBe(`${prefix}\n`);
				expect(composer.cursor()).toBe(3);
				term.press("backspace");
				expect(composer.text()).toBe(`${prefix}\n`);
				term.type("ship it");
				expect(screen(term)).toContain("Queueing ➤");
				expect(screen(term)).not.toContain(prefix);
				term.dispose();
				dispose();
			});
		}
	});

	test("the prefix shows as typed while the caret is on it", () => {
		createRoot(dispose => {
			const { composer, term } = mount("=>\nship it");
			composer.setCursor(1);
			term.render();
			expect(screen(term)).toContain("=>");
			expect(screen(term)).not.toContain("Queueing");
			term.dispose();
			dispose();
		});
	});

	test("accents the markers of a sequential list body, not of nested lines", () => {
		createRoot(dispose => {
			const { composer, term } = mount("=>\n1. first\n   1. nested\n2. second");
			expect(nativeDecor(composer)).toEqual([
				{ from: 0, to: 2, s: "dim" },
				{ from: 3, to: 5, s: "accent" },
				{ from: 25, to: 27, s: "accent" },
			]);
			composer.setText("=>\n1. first\n3. third");
			expect(nativeDecor(composer)).toEqual([{ from: 0, to: 2, s: "dim" }]);
			term.dispose();
			dispose();
		});
	});
});

describe("queue shorthand in Tern", () => {
	test("the body continues on the prefix's line, the prefix dimmed", () => {
		setNativeRenderingForTest(true);
		createRoot(dispose => {
			const { composer, term } = mount();
			term.type("-> add");
			expect(composer.text()).toBe("-> add");
			expect(composer.cursor()).toBe(6);
			expect(nativeDecor(composer)).toEqual([{ from: 0, to: 2, s: "dim" }]);
			term.dispose();
			dispose();
		});
	});
});
