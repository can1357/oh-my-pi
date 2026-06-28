import { describe, expect, it } from "bun:test";
import {
	formatTitleUserMessage,
	isLowSignalTitleInput,
	MAX_TITLE_INPUT_CHARS,
	NO_TITLE_SENTINEL,
	normalizeGeneratedTitle,
	prepareTitleInput,
	stripCodeBlocks,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/text";

describe("stripCodeBlocks", () => {
	it("drops fenced code blocks but keeps the surrounding prose", () => {
		const message = "lets plan a setup screen together.\n```\nsome mockup\n```\nit should only show once.";
		const stripped = stripCodeBlocks(message);
		expect(stripped).not.toContain("some mockup");
		expect(stripped).toContain("plan a setup screen");
		expect(stripped).toContain("it should only show once.");
	});

	it("removes literal noise inside a pasted mockup (the reported regression)", () => {
		// A small title model titled this session "Setup Screen for Claude Code v2.1.158"
		// because the version string lived inside the fenced mockup.
		const message =
			"lets plan a setup screen together.\nSomething like\n```\nWelcome to Claude Code v2.1.158\n[splash]\n1. Auto\n2. Dark mode\n```\nsteps: pick provider, pick theme";
		const stripped = stripCodeBlocks(message);
		expect(stripped).not.toContain("Claude Code v2.1.158");
		expect(stripped).toContain("pick provider, pick theme");
	});

	it("handles an unterminated fence by stripping to end of message", () => {
		const stripped = stripCodeBlocks("describe the bug\n```\nthrows here and never closes");
		expect(stripped).toBe("describe the bug");
	});

	it("keeps inline code (single backticks) as high-signal context", () => {
		const stripped = stripCodeBlocks("wire up the `/login` provider step");
		expect(stripped).toContain("`/login`");
	});

	it("falls back to the original when the message is essentially only a code block", () => {
		const message = "```python\ndef merge_sort(a):\n    return a\n```";
		expect(stripCodeBlocks(message)).toBe(message);
	});

	it("returns prose unchanged when there is no code block", () => {
		expect(stripCodeBlocks("Investigate the resolver")).toBe("Investigate the resolver");
	});
});

describe("prepareTitleInput", () => {
	it("strips code blocks before bounding length", () => {
		const message = `intro prose ${"x".repeat(MAX_TITLE_INPUT_CHARS)}\n\`\`\`\n${"y".repeat(5000)}\n\`\`\``;
		const prepared = prepareTitleInput(message);
		expect(prepared).not.toContain("yyyy");
		expect(prepared.length).toBeLessThanOrEqual(MAX_TITLE_INPUT_CHARS + 1); // +1 for the ellipsis
	});
});

describe("formatTitleUserMessage", () => {
	it("wraps stripped content in user-message tags", () => {
		const formatted = formatTitleUserMessage("plan a thing\n```\nnoise\n```");
		expect(formatted.startsWith("<user-message>\n")).toBe(true);
		expect(formatted.endsWith("\n</user-message>")).toBe(true);
		expect(formatted).toContain("plan a thing");
		expect(formatted).not.toContain("noise");
	});
});

describe("normalizeGeneratedTitle", () => {
	it("strips surrounding quotes and trailing punctuation but preserves casing", () => {
		expect(normalizeGeneratedTitle('"Investigate the resolver"')).toBe("Investigate the resolver");
		expect(normalizeGeneratedTitle("Investigate the resolver.")).toBe("Investigate the resolver");
	});

	it("preserves the model's sentence/proper-noun casing without title-casing", () => {
		// Regression: the normalizer used to force Title Case, capitalizing function
		// words ("for" → "For") and clobbering proper nouns the model cased right.
		expect(normalizeGeneratedTitle("Docker client/daemon for TinyVMM")).toBe("Docker client/daemon for TinyVMM");
	});

	it("preserves model casing verbatim when no source message is provided", () => {
		// Without the user's message there is nothing to reconcile against, so the
		// model's output is kept as-is (no title-casing, no flattening).
		expect(normalizeGeneratedTitle("Docker client/dAemon for tinyvmm")).toBe("Docker client/dAemon for tinyvmm");
	});

	it("treats the bare none sentinel as no title (case/punctuation-insensitive)", () => {
		expect(NO_TITLE_SENTINEL).toBe("none");
		expect(normalizeGeneratedTitle("none")).toBeNull();
		expect(normalizeGeneratedTitle("None.")).toBeNull();
		expect(normalizeGeneratedTitle('"none"')).toBeNull();
	});

	it("keeps a title that merely contains the word none", () => {
		expect(normalizeGeneratedTitle("Explain Python None keyword")).toBe("Explain Python None keyword");
	});

	it("returns null for empty or whitespace-only output", () => {
		expect(normalizeGeneratedTitle("")).toBeNull();
		expect(normalizeGeneratedTitle("   ")).toBeNull();
		expect(normalizeGeneratedTitle(null)).toBeNull();
	});
});

describe("normalizeGeneratedTitle source-aware casing", () => {
	it("flattens a stray interior capital the user never typed", () => {
		// "dAemon" is a model artifact; the user's message has no such token.
		expect(normalizeGeneratedTitle("Docker client/dAemon for tinyvmm", "build a docker daemon for tinyvmm")).toBe(
			"Docker client/daemon for tinyvmm",
		);
	});

	it("keeps odd casing the user typed verbatim", () => {
		expect(normalizeGeneratedTitle("Use the dAemon API", "the dAemon name is intentional")).toBe(
			"Use the dAemon API",
		);
	});

	it("restores a proper noun's casing from the user's message", () => {
		// Tiny model flattened "TinyVMM" → "tinyvmm"; the user wrote it distinctively.
		expect(normalizeGeneratedTitle("Set up tinyvmm daemon", "please configure TinyVMM")).toBe(
			"Set up TinyVMM daemon",
		);
	});

	it("leaves PascalCase proper nouns the model produced even when absent from source", () => {
		expect(normalizeGeneratedTitle("Fix GitHub OAuth flow", "fix the login redirect")).toBe("Fix GitHub OAuth flow");
	});

	it("does not lowercase the model's correct casing when the user typed it lower", () => {
		// Source "tinyvmm" is not distinctive, so it must not pull "TinyVMM" down.
		expect(normalizeGeneratedTitle("Improve TinyVMM startup", "improve tinyvmm startup")).toBe(
			"Improve TinyVMM startup",
		);
	});

	it("a source word that merely starts a sentence does not force mid-title casing", () => {
		// Regression: leading "For" in the message must not capitalize "for" in the title.
		expect(normalizeGeneratedTitle("Add retry to the for loop", "For reliability, add retries")).toBe(
			"Add retry to the for loop",
		);
	});

	it("does not re-shout emphatic ALL-CAPS the model normalized to sentence case", () => {
		// Reported regression: the user shouted "ALL ERROR HANDLING" / "IDIOTIC"
		// for emphasis; the model returned clean sentence case and we must not
		// restore the shouting over it ("error handling" stayed "ERROR HANDLING").
		expect(
			normalizeGeneratedTitle(
				"Unify error handling with error IDs",
				"unify ALL ERROR HANDLING instead of IDIOTIC substring checks",
			),
		).toBe("Unify error handling with error IDs");
	});

	it("never re-shouts emphatic all-caps over the model's sentence case", () => {
		// Short shouts qualify too: FIX/THE/BUG must not be restored.
		expect(normalizeGeneratedTitle("fix the bug now", "FIX the BUG NOW")).toBe("fix the bug now");
	});

	it("preserves an acronym the model itself produced", () => {
		// All-caps restoration is dropped, but the model's own casing passes through.
		expect(normalizeGeneratedTitle("fix the API timeout", "fix the api timeout")).toBe("fix the API timeout");
	});
});

describe("isLowSignalTitleInput", () => {
	it("treats greetings and acknowledgements as low signal (defer)", () => {
		for (const msg of [
			"hi",
			"Hi!",
			"hey there",
			"hello :)",
			"good morning",
			"thanks!",
			"ok cool",
			"yo",
			"test",
			"ping",
		]) {
			expect(isLowSignalTitleInput(msg)).toBe(true);
		}
	});

	it("treats empty / punctuation / emoji-only input as low signal", () => {
		expect(isLowSignalTitleInput("")).toBe(true);
		expect(isLowSignalTitleInput("   ")).toBe(true);
		expect(isLowSignalTitleInput("👋👋")).toBe(true);
		expect(isLowSignalTitleInput("?!")).toBe(true);
		expect(isLowSignalTitleInput("42")).toBe(true);
	});

	it("treats messages with a real task as title-worthy", () => {
		for (const msg of [
			"fix the resolver bug",
			"deploy",
			"hi, can you fix the login flow",
			"add a test for the parser",
			"what does this regex do",
		]) {
			expect(isLowSignalTitleInput(msg)).toBe(false);
		}
	});
});
