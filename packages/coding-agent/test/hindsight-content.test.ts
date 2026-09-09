import { describe, expect, it } from "bun:test";
import {
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	hasSubstantiveContent,
	prepareEmbeddableRetentionTranscript,
	prepareRetentionTranscript,
	prepareUserRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	stripMemoryTags,
	stripRetentionProtocolMarkers,
	truncateRecallQuery,
} from "@oh-my-pi/pi-coding-agent/hindsight/content";

describe("stripMemoryTags", () => {
	it("removes both <memories> and legacy memory blocks", () => {
		const text = [
			"hello",
			"<memories>",
			"- some recalled fact",
			"</memories>",
			"middle",
			"<hindsight_memories>",
			"old recalled fact",
			"</hindsight_memories>",
			"<relevant_memories>",
			"more facts",
			"</relevant_memories>",
			"end",
		].join("\n");
		const stripped = stripMemoryTags(text);
		expect(stripped).not.toContain("<memories>");
		expect(stripped).not.toContain("</memories>");
		expect(stripped).not.toContain("<hindsight_memories>");
		expect(stripped).not.toContain("</hindsight_memories>");
		expect(stripped).not.toContain("<relevant_memories>");
		expect(stripped).not.toContain("</relevant_memories>");
		expect(stripped).toContain("hello");
		expect(stripped).toContain("middle");
		expect(stripped).toContain("end");
	});

	it("strips multiple sequential blocks", () => {
		const text = "<memories>a</memories><memories>b</memories>tail";
		expect(stripMemoryTags(text)).toBe("tail");
	});

	it("is a no-op when no tags are present", () => {
		expect(stripMemoryTags("plain content")).toBe("plain content");
	});

	it("strips <mental_models> blocks so curated context cannot leak back into retention", () => {
		const text = ["alpha", "<mental_models>", "# User Preferences", "prefers tabs", "</mental_models>", "beta"].join(
			"\n",
		);
		const stripped = stripMemoryTags(text);
		expect(stripped).not.toContain("<mental_models>");
		expect(stripped).not.toContain("</mental_models>");
		expect(stripped).not.toContain("# User Preferences");
		expect(stripped).toContain("alpha");
		expect(stripped).toContain("beta");
	});
});

describe("composeRecallQuery", () => {
	const messages: HindsightMessage[] = [
		{ role: "user", content: "What's the cwd?" },
		{ role: "assistant", content: "It's /tmp/foo" },
		{ role: "user", content: "Run the tests" },
		{ role: "assistant", content: "Done" },
		{ role: "user", content: "Latest question" },
	];

	it("returns the trimmed latest query when context turns is 0 or 1", () => {
		expect(composeRecallQuery("  Latest question  ", messages, 0)).toBe("Latest question");
		expect(composeRecallQuery("Latest question", messages, 1)).toBe("Latest question");
	});

	it("prepends prior context for context turns > 1", () => {
		const out = composeRecallQuery("Latest question", messages, 2);
		expect(out.startsWith("Prior context:")).toBe(true);
		expect(out.endsWith("Latest question")).toBe(true);
		// last user message must not be duplicated inside the context block
		const contextSection = out.slice("Prior context:\n\n".length, out.lastIndexOf("\n\nLatest question"));
		expect(contextSection.split("\n").every(line => !line.endsWith("Latest question"))).toBe(true);
	});

	it("strips memory tags from prior context turns", () => {
		const tagged: HindsightMessage[] = [
			{ role: "user", content: "before" },
			{ role: "assistant", content: "<memories>secret</memories>visible" },
			{ role: "user", content: "Latest" },
		];
		const out = composeRecallQuery("Latest", tagged, 5);
		expect(out).not.toContain("secret");
		expect(out).toContain("visible");
	});
});

describe("truncateRecallQuery", () => {
	it("returns the query untouched when under the budget", () => {
		expect(truncateRecallQuery("short", "short", 100)).toBe("short");
	});

	it("falls back to the latest query alone when no prior context block exists", () => {
		const long = "x".repeat(200);
		expect(truncateRecallQuery(long, long, 50)).toBe(long.slice(0, 50));
	});

	it("drops oldest context lines first", () => {
		const latest = "ZZ";
		const composed = `Prior context:\n\nuser: AAAA\nuser: BBBB\nuser: CCCC\n\n${latest}`;
		const out = truncateRecallQuery(composed, latest, "Prior context:\n\nuser: CCCC\n\nZZ".length);
		expect(out.endsWith(latest)).toBe(true);
		expect(out).toContain("CCCC");
		expect(out).not.toContain("AAAA");
	});
});

describe("sliceLastTurnsByUserBoundary", () => {
	const messages: HindsightMessage[] = [
		{ role: "user", content: "u1" },
		{ role: "assistant", content: "a1" },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: "a2" },
		{ role: "user", content: "u3" },
	];

	it("returns the last N user-bounded turns", () => {
		expect(sliceLastTurnsByUserBoundary(messages, 1)).toEqual([{ role: "user", content: "u3" }]);
		expect(sliceLastTurnsByUserBoundary(messages, 2)).toEqual(messages.slice(2));
	});

	it("returns the full list when N exceeds the number of user turns", () => {
		expect(sliceLastTurnsByUserBoundary(messages, 99)).toEqual(messages);
	});

	it("returns an empty list for empty input or non-positive turns", () => {
		expect(sliceLastTurnsByUserBoundary([], 1)).toEqual([]);
		expect(sliceLastTurnsByUserBoundary(messages, 0)).toEqual([]);
	});
});

describe("prepareRetentionTranscript", () => {
	it("uses only the last turn when retainFullWindow is false", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "earlier" },
			{ role: "assistant", content: "earlier reply" },
			{ role: "user", content: "latest user message" },
			{ role: "assistant", content: "latest assistant reply" },
		];
		const { transcript, messageCount } = prepareRetentionTranscript(messages);
		expect(messageCount).toBe(2);
		expect(transcript).toContain("[role: user]\nlatest user message\n[user:end]");
		expect(transcript).not.toContain("earlier reply");
	});

	it("uses every message when retainFullWindow is true", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "u1 with enough text" },
			{ role: "assistant", content: "a1 with more text" },
		];
		const { transcript, messageCount } = prepareRetentionTranscript(messages, true);
		expect(messageCount).toBe(2);
		expect(transcript).toContain("u1");
		expect(transcript).toContain("a1");
	});

	it("strips recalled memory blocks before retaining (no feedback loop)", () => {
		const messages: HindsightMessage[] = [
			{
				role: "user",
				content: "<memories>\n- recalled fact about user\n</memories>\nuser-real-question-here",
			},
			{ role: "assistant", content: "answer about question" },
		];
		const { transcript } = prepareRetentionTranscript(messages, true);
		expect(transcript).not.toContain("<memories>");
		expect(transcript).not.toContain("recalled fact about user");
		expect(transcript).toContain("user-real-question-here");
	});

	it("returns null when nothing meaningful remains", () => {
		const empty = prepareRetentionTranscript([{ role: "user", content: "<memories>x</memories>" }], true);
		expect(empty.transcript).toBeNull();
	});

	it("skips punctuation-only assistant turns so retain never stores `.` noise (#1806)", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "explain how transformers work" },
			{ role: "assistant", content: "." },
			{ role: "user", content: "now ssh into the server" },
			{ role: "assistant", content: "..." },
			{ role: "user", content: "any more updates?" },
			{ role: "assistant", content: "  \n\t" },
			{ role: "user", content: "ok keep going" },
			{ role: "assistant", content: "done — here are the results" },
		];
		const { transcript, messageCount } = prepareRetentionTranscript(messages, true);
		expect(messageCount).toBe(5);
		expect(transcript).not.toContain("[role: assistant]\n.\n[assistant:end]");
		expect(transcript).not.toContain("[role: assistant]\n...\n[assistant:end]");
		expect(transcript).toContain("done — here are the results");
	});

	it("formats only user-authored messages for extraction", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "I always prefer tabs" },
			{ role: "assistant", content: "the panel never initializes" },
			{ role: "user", content: "<memories>old</memories>\nI never use semicolons" },
		];
		const { transcript, messageCount } = prepareUserRetentionTranscript(messages);
		expect(messageCount).toBe(2);
		expect(transcript).toContain("[role: user]\nI always prefer tabs\n[user:end]");
		expect(transcript).toContain("I never use semicolons");
		expect(transcript).not.toContain("panel never initializes");
		expect(transcript).not.toContain("<memories>");
	});

	it("formats marker-free transcripts for embedding and FTS", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "I always prefer tabs" },
			{ role: "assistant", content: "the parser never initializes" },
			{ role: "user", content: "<memories>old</memories>\nI never use semicolons" },
		];
		const { transcript, messageCount } = prepareEmbeddableRetentionTranscript(messages);
		expect(messageCount).toBe(3);
		expect(transcript).toContain("I always prefer tabs");
		expect(transcript).toContain("the parser never initializes");
		expect(transcript).toContain("I never use semicolons");
		expect(transcript).not.toContain("[role:");
		expect(transcript).not.toContain(":end]");
		expect(transcript).not.toContain("<memories>");
	});
	it("preserves source message timestamps in the retained conversation content", () => {
		const messages: HindsightMessage[] = [
			{
				role: "user",
				content: "i stopped doing that yesterday",
				timestamp: "2026-08-17T10:00:00.000Z",
			},
			{
				role: "assistant",
				content: "got it, that was sunday then",
				timestamp: "2026-08-17T10:00:05.000Z",
			},
		];
		const { transcript, messageCount } = prepareRetentionTranscript(messages, true, { includeTimestamps: true });
		expect(messageCount).toBe(2);
		expect(transcript).toContain(
			"[role: user]\n[timestamp: 2026-08-17T10:00:00.000Z]\ni stopped doing that yesterday\n[user:end]",
		);
		expect(transcript).toContain(
			"[role: assistant]\n[timestamp: 2026-08-17T10:00:05.000Z]\ngot it, that was sunday then\n[assistant:end]",
		);
	});

	it("still strips recalled memory blocks when messages carry timestamps", () => {
		const messages: HindsightMessage[] = [
			{
				role: "user",
				content: "<memories>\n- recalled fact about user\n</memories>\nuser-real-question-here",
				timestamp: "2026-08-17T10:00:00.000Z",
			},
		];
		const { transcript } = prepareRetentionTranscript(messages, true, { includeTimestamps: true });
		expect(transcript).not.toContain("<memories>");
		expect(transcript).not.toContain("recalled fact about user");
		expect(transcript).toContain("[timestamp: 2026-08-17T10:00:00.000Z]");
		expect(transcript).toContain("user-real-question-here");
	});

	it("keeps timestamp framing opt-in so shared Mnemopi formatting stays marker-only", () => {
		const messages: HindsightMessage[] = [
			{
				role: "user",
				content: "i stopped doing that yesterday",
				timestamp: "2026-08-17T10:00:00.000Z",
			},
		];
		const { transcript } = prepareRetentionTranscript(messages, true);
		expect(transcript).toBe("[role: user]\ni stopped doing that yesterday\n[user:end]");
		expect(transcript).not.toContain("[timestamp:");
	});

	it("strips timestamp protocol markers from recalled stored transcripts", () => {
		const stored = "[role: user]\n[timestamp: 2026-08-17T10:00:00.000Z]\ni stopped doing that yesterday\n[user:end]";
		expect(stripRetentionProtocolMarkers(stored)).toBe("i stopped doing that yesterday");
	});
});

describe("hasSubstantiveContent", () => {
	it("treats letter/digit-bearing strings as substantive", () => {
		expect(hasSubstantiveContent("ok")).toBe(true);
		expect(hasSubstantiveContent("y")).toBe(true);
		expect(hasSubstantiveContent("4")).toBe(true);
		expect(hasSubstantiveContent("こんにちは")).toBe(true);
	});

	it("rejects whitespace and punctuation-only strings", () => {
		expect(hasSubstantiveContent("")).toBe(false);
		expect(hasSubstantiveContent(".")).toBe(false);
		expect(hasSubstantiveContent("...")).toBe(false);
		expect(hasSubstantiveContent(" \t\n")).toBe(false);
		expect(hasSubstantiveContent("— ! ?")).toBe(false);
	});
});

describe("formatMemories", () => {
	it("renders results with type and date suffixes when present", () => {
		const out = formatMemories([
			{ text: "fact one", type: "world", mentioned_at: "2024-01-01" },
			{ text: "fact two" },
		]);
		expect(out).toContain("- fact one [world] (2024-01-01)");
		expect(out).toContain("- fact two");
	});

	it("returns an empty string for no results", () => {
		expect(formatMemories([])).toBe("");
	});
});

describe("formatCurrentTime", () => {
	it("emits a UTC YYYY-MM-DD HH:MM stamp", () => {
		const stamp = formatCurrentTime(new Date(Date.UTC(2024, 5, 7, 9, 5)));
		expect(stamp).toBe("2024-06-07 09:05");
	});
});
