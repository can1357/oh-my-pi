/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A sent prompt's magic keywords glow: their gradient sweeps on the terminal clock, stays still
 * under reduced motion, and natively they are accent marks with the shimmer effect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { MAGIC_KEYWORDS } from "../../../../src/modes/magic-keywords";
import "../../../../src/ui/styles/messages";
import { UserMessage } from "../../../../src/ui/transcript/messages/user-message";
import { initTheme } from "../../../../src/ui/theme/service";

const restoreTheme = currentTheme();

beforeAll(() => {
	initTheme();
});

afterAll(() => {
	setCurrentTheme(restoreTheme);
});

const keywords = () => MAGIC_KEYWORDS;

/** Truecolor foregrounds on the prompt's row. */
function colors(rows: readonly string[]): string[] {
	const row = rows.find(line => line.includes("now")) ?? "";
	return [...row.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map(match => match[1]!);
}

describe("sent prompt glow", () => {
	test("sweeps on the terminal clock", () => {
		createRoot(dispose => {
			const term = createTestTerminal(
				() => ({ main: [<UserMessage model={{ text: "ultrathink it now", magicKeywords: keywords }} />] }),
				{ columns: 40, rows: 6, theme: currentTheme() },
			);
			const before = colors(term.rows());
			expect(new Set(before).size).toBeGreaterThan(5);
			term.tick(450);
			expect(colors(term.rows())).not.toEqual(before);
			term.dispose();
			dispose();
		});
	});

	test("stays plain without keywords (and in code)", () => {
		createRoot(dispose => {
			const term = createTestTerminal(
				() => ({ main: [<UserMessage model={{ text: "`ultrathink` it now", magicKeywords: keywords }} />] }),
				{ columns: 40, rows: 6, theme: currentTheme() },
			);
			expect(term.rows().join("\n")).toContain("ultrathink");
			term.dispose();
			dispose();
		});
	});
});
