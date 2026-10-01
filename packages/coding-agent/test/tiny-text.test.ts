import { describe, expect, it } from "bun:test";
import {
	formatTitleConversationContext,
	formatTitleUserMessage,
	MAX_TINY_MESSAGE_CHARS,
	preprocessTinyMessage,
	stripCodeBlocks,
} from "@oh-my-pi/pi-coding-agent/tiny/message-preproc";
import { isLowSignalTitleInput, NO_TITLE_SENTINEL, normalizeGeneratedTitle } from "@oh-my-pi/pi-coding-agent/tiny/text";

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

describe("preprocessTinyMessage", () => {
	it("strips code blocks before middle-truncating", () => {
		const message = `intro prose ${"x".repeat(MAX_TINY_MESSAGE_CHARS)}\n\`\`\`\n${"y".repeat(5000)}\n\`\`\``;
		const prepared = preprocessTinyMessage(message);
		expect(prepared).not.toContain("yyyy");
		expect(prepared.length).toBeLessThanOrEqual(MAX_TINY_MESSAGE_CHARS);
	});

	it("strips ANSI and XML noise while shortening full hashes", () => {
		const prepared = preprocessTinyMessage(
			"\u001b[31mmerge\u001b[0m <tool>ignore this output</tool> 54783db3f0f17c74cae81976f0e825a909deb71e",
		);
		expect(prepared).toBe("merge 54783db");
	});

	it("preserves both ends with a counted omission marker", () => {
		const prepared = preprocessTinyMessage(`HEAD ${"x".repeat(3000)} TAIL`);
		expect(prepared.startsWith("HEAD ")).toBe(true);
		expect(prepared.endsWith(" TAIL")).toBe(true);
		expect(prepared).toMatch(/\[… \d+ chars omitted …\]/);
		expect(prepared.length).toBeLessThanOrEqual(MAX_TINY_MESSAGE_CHARS);
	});
});

describe("formatTitleUserMessage", () => {
	it("wraps stripped content in user tags", () => {
		const formatted = formatTitleUserMessage("plan a thing\n```\nnoise\n```");
		expect(formatted.startsWith("<user>\n")).toBe(true);
		expect(formatted.endsWith("\n</user>")).toBe(true);
		expect(formatted).toContain("plan a thing");
		expect(formatted).not.toContain("noise");
	});

	it("passes preformatted chat context through unchanged", () => {
		const context = "<chat>\n<user>\nfix parser\n</user>\n</chat>";
		expect(formatTitleUserMessage(context)).toBe(context);
	});
});

describe("formatTitleConversationContext", () => {
	it("uses compact chat and think tags after cleaning each turn", () => {
		const formatted = formatTitleConversationContext([
			{ role: "user", text: "fix this <tool>noisy output</tool>" },
			{ role: "assistant", text: "Checking", thinking: "inspect the logs" },
		]);
		expect(formatted).toBe(
			"<chat>\n<user>\nfix this\n</user>\n\n<assistant>\nChecking\n\n<think>\ninspect the logs\n</think>\n</assistant>\n</chat>",
		);
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

	it("accepts empty, legacy, and partial title markers", () => {
		expect(normalizeGeneratedTitle("<title/>")).toBeNull();
		expect(normalizeGeneratedTitle("<title />")).toBeNull();
		expect(normalizeGeneratedTitle("<title>")).toBeNull();
		expect(normalizeGeneratedTitle("<title></title>")).toBeNull();
		expect(normalizeGeneratedTitle("<title>none</title>")).toBeNull();
		expect(normalizeGeneratedTitle("<title>Fix login</title>")).toBe("Fix login");
		expect(normalizeGeneratedTitle("Fix login</title>")).toBe("Fix login");
	});

	it("keeps a title that merely contains the word none", () => {
		expect(normalizeGeneratedTitle("Explain Python None keyword")).toBe("Explain Python None keyword");
	});

	it("returns null for empty or whitespace-only output", () => {
		expect(normalizeGeneratedTitle("")).toBeNull();
		expect(normalizeGeneratedTitle("   ")).toBeNull();
		expect(normalizeGeneratedTitle(null)).toBeNull();
	});

	it("rejects punctuation-only junk instead of titling the session '..'", () => {
		// Regression: a sampling model occasionally emits bare punctuation; the
		// trailing-punctuation strip then left "." as an accepted title.
		expect(normalizeGeneratedTitle("..")).toBeNull();
		expect(normalizeGeneratedTitle("---")).toBeNull();
		expect(normalizeGeneratedTitle("<title>..</title>")).toBeNull();
	});

	it("rejects an overlong answer the model produced instead of a title", () => {
		// Regression (#7303): a model that ignores the titling task and answers the
		// user's question returns a full sentence; without a length bound the whole
		// reply became the session title. Reject so the caller defers titling.
		const answer =
			"I don't have context on a \"registration system\" — that's not something I recognize from this conversation, and I don't see any prior discussion or code about it here";
		expect(normalizeGeneratedTitle(answer, "how does the registration system work?")).toBeNull();
		// Word-count bound: 13 short words stays under the char cap but is not a title.
		expect(
			normalizeGeneratedTitle("one two three four five six seven eight nine ten eleven twelve thirteen"),
		).toBeNull();
		// A normal 3-7 word title is unaffected.
		expect(normalizeGeneratedTitle("Investigate the title resolver bug")).toBe("Investigate the title resolver bug");
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

	it("restores an ALL-CAPS acronym the model title-cased at the start of the title", () => {
		// Reporter's case (#4220): the model produces `Cnpg` when sentence-casing
		// the user's `CNPG` — we must recover the acronym from the source.
		expect(normalizeGeneratedTitle("Cnpg consolidation", "Session about CNPG consolidation")).toBe(
			"CNPG consolidation",
		);
	});

	it("restores an ALL-CAPS acronym alongside a distinctive mixed-case proper noun", () => {
		// Model title-cased both `PostgreSQL` and `CNPG`; distinctive path restores
		// `PostgreSQL`, the new acronym path restores `CNPG`.
		expect(normalizeGeneratedTitle("Set up postgresql and Cnpg", "Set up PostgreSQL and CNPG")).toBe(
			"Set up PostgreSQL and CNPG",
		);
	});

	it("does not restore an ALL-CAPS acronym the model lowercased (leaves emphasis alone)", () => {
		// Lowercase model output could equally be `WORK`-style emphasis correctly
		// de-shouted. Restoration requires the model to produce a title-cased
		// artifact so we never re-shout an isolated single-word emphasis.
		expect(normalizeGeneratedTitle("make it work", "just make it WORK already")).toBe("make it work");
	});

	it("does not restore a single emphatic ALL-CAPS word from sentence-case title start", () => {
		// Normal sentence capitalization produces `Fix`/`Work` at title start.
		// Those words have no acronym signal, so they must not be restored as
		// `FIX`/`WORK` just because the source had one emphasized word.
		expect(normalizeGeneratedTitle("Fix login crash", "FIX login crash")).toBe("Fix login crash");
		expect(normalizeGeneratedTitle("Work around bug", "please WORK around the bug")).toBe("Work around bug");
	});

	it("restores common vowel-bearing technical acronyms via the acronym allowlist", () => {
		expect(normalizeGeneratedTitle("Api timeout", "API timeout")).toBe("API timeout");
		expect(normalizeGeneratedTitle("Etl pipeline cleanup", "clean up the ETL pipeline")).toBe("ETL pipeline cleanup");
	});

	it("still declines to restore ALL-CAPS when the source is shouty", () => {
		// `FIX the BUG NOW` has BUG↔NOW consecutive → shouty. Even though the
		// model title-cased `Fix` at the start, we must not restore `FIX`.
		expect(normalizeGeneratedTitle("Fix the bug now", "FIX the BUG NOW")).toBe("Fix the bug now");
	});

	it("declines acronym restoration when three source ALL-CAPS run consecutively", () => {
		// `ALL ERROR HANDLING` is a shouty run; even if the model title-cased one
		// of them, the acronym map is empty for shouty sources.
		expect(
			normalizeGeneratedTitle("Unify Error handling across the codebase", "unify ALL ERROR HANDLING everywhere"),
		).toBe("Unify Error handling across the codebase");
	});

	it("does not treat caseless scripts as shouting (CJK source still restores acronyms)", () => {
		// `修复`/`集群故障` carry no letter case at all; they must not register as
		// consecutive ALL-CAPS emphasis, otherwise every CJK message marks the
		// source shouty and silently disables acronym restoration.
		expect(normalizeGeneratedTitle("Cnpg 集群修复", "修复 CNPG 集群故障")).toBe("CNPG 集群修复");
	});

	it("does not misidentify PascalCase proper nouns as acronyms", () => {
		// The model produced `GitHub` from a source that also has the acronym
		// `API`; `GitHub` has interior uppercase so it's NOT a title-cased
		// artifact and must pass through untouched.
		expect(normalizeGeneratedTitle("Fix GitHub Api rate limit", "fix the GitHub API rate limit")).toBe(
			"Fix GitHub API rate limit",
		);
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

	it("does not treat preformatted chat context as low-signal even though it contains XML tags", () => {
		const context = "<chat>\n<user>\nfix parser\n</user>\n</chat>";
		expect(isLowSignalTitleInput(context)).toBe(false);
	});

	it("still evaluates the actual inner text of a preformatted chat context correctly", () => {
		const context = "<chat>\n<user>\nhi\n</user>\n</chat>";
		expect(isLowSignalTitleInput(context)).toBe(true);
	});
});
