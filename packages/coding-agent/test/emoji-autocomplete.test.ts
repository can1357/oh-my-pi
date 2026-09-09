import { describe, expect, it } from "bun:test";
import {
	applyEmojiCompletion,
	getEmojiSuggestions,
	tryEmojiInlineReplace,
} from "@oh-my-pi/pi-coding-agent/modes/emoji-autocomplete";

describe("emoji autocomplete", () => {
	describe("getEmojiSuggestions", () => {
		it("returns null for empty query (bare colon)", () => {
			expect(getEmojiSuggestions(":")).toBeNull();
			expect(getEmojiSuggestions("note:")).toBeNull();
		});

		it("returns prefix matches at line start", () => {
			const r = getEmojiSuggestions(":joy");
			expect(r).not.toBeNull();
			expect(r!.prefix).toBe(":joy");
			const names = r!.items.map(i => i.label);
			expect(names.some(n => n.includes(":joy:"))).toBe(true);
			expect(names.every(n => n.includes(":joy"))).toBe(true);
		});

		it("returns prefix matches after whitespace", () => {
			const r = getEmojiSuggestions("hello :sm");
			expect(r).not.toBeNull();
			expect(r!.prefix).toBe(":sm");
			expect(r!.items.length).toBeGreaterThan(0);
		});

		it("does not trigger when colon is mid-token", () => {
			expect(getEmojiSuggestions("http://example")).toBeNull();
			expect(getEmojiSuggestions("foo:bar")).toBeNull();
		});

		it("returns null for unknown prefix", () => {
			expect(getEmojiSuggestions(":zzzzzz")).toBeNull();
		});

		it("excludes regional-indicator flag sequences", () => {
			// `:jordan:` exists upstream as 🇯🇴 but should be filtered out.
			const r = getEmojiSuggestions(":jordan");
			expect(r).toBeNull();
		});

		it("caps the suggestion count", () => {
			const r = getEmojiSuggestions(":a");
			expect(r).not.toBeNull();
			expect(r!.items.length).toBeLessThanOrEqual(12);
		});
	});

	describe("tryEmojiInlineReplace", () => {
		it("returns null without trailing colon", () => {
			expect(tryEmojiInlineReplace(":joy")).toBeNull();
			expect(tryEmojiInlineReplace("hello")).toBeNull();
		});

		it("returns replacement for valid closing form", () => {
			const r = tryEmojiInlineReplace(":joy:");
			expect(r).toEqual({ replaceLen: 5, insert: "😂" });
		});

		it("returns replacement when preceded by whitespace", () => {
			const r = tryEmojiInlineReplace("hi :tada:");
			expect(r).toEqual({ replaceLen: 6, insert: "🎉" });
		});

		it("returns null for unknown name", () => {
			expect(tryEmojiInlineReplace(":notrealemoji:")).toBeNull();
		});

		it("returns null when colon is mid-word", () => {
			expect(tryEmojiInlineReplace("foo:joy:")).toBeNull();
		});

		it("returns null for filtered flag shortcodes", () => {
			expect(tryEmojiInlineReplace(":jordan:")).toBeNull();
		});
	});

	describe("applyEmojiCompletion", () => {
		it("replaces the prefix with the emoji character", () => {
			const r = applyEmojiCompletion(["hello :joy"], 0, 10, { value: "😂", label: "😂  :joy:" }, ":joy");
			expect(r.lines).toEqual(["hello 😂"]);
			expect(r.cursorLine).toBe(0);
			expect(r.cursorCol).toBe("hello ".length + "😂".length);
		});
	});
});
