import { describe, expect, it } from "bun:test";
import { canonicalNerdFontName } from "@oh-my-pi/pi-coding-agent/utils/nerd-font-glyphs";

describe("canonicalNerdFontName", () => {
	it.each([
		["the wrong class (a title fork reply)", "nf-md-spinner", "nf-fa-spinner"],
		["a Nerd Fonts v2 class", "nf-mdi-language_rust", "nf-md-language_rust"],
		["reordered words", "nf-md-text_cursor", "nf-md-cursor_text"],
		["a missing word", "nf-md-test", "nf-md-test_tube"],
		["an extra word", "nf-md-timer_sand_half", "nf-md-timer_sand"],
		["fewest added words over the named class", "nf-md-go", "nf-dev-go"],
		["the named class among equal matches", "nf-fa-python_logo", "nf-fa-python"],
	])("resolves %s to the glyph it means", (_case, name, canonical) => {
		expect(canonicalNerdFontName(name)).toBe(canonical);
	});
});
