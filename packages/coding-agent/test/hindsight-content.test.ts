import { describe, expect, it } from "bun:test";
import {
	compactHandoffForRecall,
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	hasSubstantiveContent,
	isShortContinuationPrompt,
	prepareEmbeddableRetentionTranscript,
	prepareRetentionTranscript,
	prepareUserRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	stripMemoryTags,
	stripRetentionProtocolMarkers,
	truncateRecallQuery,
} from "@oh-my-pi/pi-coding-agent/hindsight/content";
import {
	countUserTurns,
	extractMessages,
	extractMessagesForRecall,
} from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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

	it("drops punctuation-only assistant placeholder turns while preserving symbol-only user turns (#1806)", () => {
		const withPlaceholders: HindsightMessage[] = [
			{ role: "user", content: "Approve deploy?" },
			{ role: "assistant", content: "." },
			{ role: "user", content: "✅" },
			{ role: "assistant", content: "..." },
			{ role: "user", content: "What did I approve?" },
		];
		const out = composeRecallQuery("What did I approve?", withPlaceholders, 3);
		expect(out).toContain("user: Approve deploy?");
		expect(out).toContain("user: ✅");
		expect(out).not.toContain("assistant: .");
		expect(out).not.toContain("assistant: ...");
	});

	it("suppresses only the trailing user message when an earlier turn repeated the same prompt", () => {
		const repeated: HindsightMessage[] = [
			{ role: "user", content: "Run the tests" },
			{ role: "assistant", content: "1 failing spec in auth.test.ts" },
			{ role: "user", content: "Run the tests" },
		];
		const out = composeRecallQuery("Run the tests", repeated, 2);
		expect(out).toBe(
			"Prior context:\n\nuser: Run the tests\nassistant: 1 failing spec in auth.test.ts\n\nRun the tests",
		);
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

	it("drops whole multi-line prior messages without splitting on YAML keys or callouts", () => {
		const latest = "ZZ";
		const composed = composeRecallQuery(
			latest,
			[
				{ role: "assistant", content: "First line\nNote: check config\nport: 8080\nuser: quoted line" },
				{ role: "user", content: "Keep this entry" },
				{ role: "user", content: latest },
			],
			3,
		);
		const budget = `Prior context:\n\nuser: Keep this entry\n\n${latest}`.length + 5;
		const out = truncateRecallQuery(composed, latest, budget);
		expect(out).toBe(`Prior context:\n\nuser: Keep this entry\n\n${latest}`);
		expect(out).not.toContain("Note: check config");
		expect(out).not.toContain("port: 8080");
		expect(out).not.toContain("quoted line");
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

describe("isShortContinuationPrompt", () => {
	it("recognizes English continuation and confirmation keywords", () => {
		expect(isShortContinuationPrompt("continue")).toBe(true);
		expect(isShortContinuationPrompt("Continue!")).toBe(true);
		expect(isShortContinuationPrompt("go ahead...")).toBe(true);
		expect(isShortContinuationPrompt("proceed")).toBe(true);
		expect(isShortContinuationPrompt("keep going")).toBe(true);
		expect(isShortContinuationPrompt("next")).toBe(true);
		expect(isShortContinuationPrompt("ok")).toBe(true);
		expect(isShortContinuationPrompt("OK~")).toBe(true);
		expect(isShortContinuationPrompt("sure")).toBe(true);
		expect(isShortContinuationPrompt("yes")).toBe(true);
		expect(isShortContinuationPrompt("please continue")).toBe(true);
	});

	it("recognizes CJK continuation and confirmation keywords", () => {
		expect(isShortContinuationPrompt("繼續")).toBe(true);
		expect(isShortContinuationPrompt("继续！")).toBe(true);
		expect(isShortContinuationPrompt("好")).toBe(true);
		expect(isShortContinuationPrompt("好的~")).toBe(true);
		expect(isShortContinuationPrompt("好喔")).toBe(true);
		expect(isShortContinuationPrompt("沒問題")).toBe(true);
		expect(isShortContinuationPrompt("下一步")).toBe(true);
		expect(isShortContinuationPrompt("確認")).toBe(true);
		expect(isShortContinuationPrompt("執行")).toBe(true);
		expect(isShortContinuationPrompt("開始")).toBe(true);
		expect(isShortContinuationPrompt("請繼續")).toBe(true);
	});

	it("rejects substantive prompts and questions", () => {
		expect(isShortContinuationPrompt("What is the current architecture?")).toBe(false);
		expect(isShortContinuationPrompt("continue the implementation of auth module")).toBe(false);
		expect(isShortContinuationPrompt("好，請幫我寫一個函數")).toBe(false);
		expect(isShortContinuationPrompt("繼續閱讀程式碼")).toBe(false);
	});

	it("rejects strings exceeding 32 characters even if matching continuation words at start", () => {
		const longContinuation = "continue".repeat(10);
		expect(isShortContinuationPrompt(longContinuation)).toBe(false);
	});
});

describe("compactHandoffForRecall", () => {
	it("strips verbose <files> block and handoff preamble while preserving goal and progress", () => {
		const handoffText = [
			"Context replaced. The <handoff> below is a handoff document from the prior session.",
			"<handoff>",
			"## Goal",
			"Refactor the memory subsystem.",
			"## Progress",
			"- Step 1 done",
			"<files>",
			"packages/coding-agent/src/index.ts",
			"packages/coding-agent/src/hindsight/content.ts",
			"packages/mnemopi/src/state.ts",
			"</files>",
			"## Next Steps",
			"Implement compactHandoffForRecall",
			"</handoff>",
			"Please continue with the refactor.",
		].join("\n");

		const compacted = compactHandoffForRecall(handoffText);
		expect(compacted).not.toContain("Context replaced.");
		expect(compacted).not.toContain("<handoff>");
		expect(compacted).not.toContain("</handoff>");
		expect(compacted).not.toContain("<files>");
		expect(compacted).not.toContain("packages/coding-agent/src/index.ts");
		expect(compacted).toContain("## Goal");
		expect(compacted).toContain("Refactor the memory subsystem.");
		expect(compacted).toContain("## Progress");
		expect(compacted).toContain("## Next Steps");
		expect(compacted).toContain("Please continue with the refactor.");
	});

	it("returns text unchanged when no <handoff> tag exists", () => {
		const text = "Normal prompt without handoff tags.";
		expect(compactHandoffForRecall(text)).toBe(text);
	});

	it("handles case-insensitive <HANDOFF> tags and leading whitespace in preamble", () => {
		const text =
			"  Context replaced. The <handoff> below is a handoff document.\n<HANDOFF>\n## Goal\nTest\n</HANDOFF>";
		const compacted = compactHandoffForRecall(text);
		expect(compacted).not.toContain("Context replaced.");
		expect(compacted).toContain("## Goal");
	});
});

describe("composeRecallQuery continuation backtracking", () => {
	it("backtracks to prior substantive user turn when recallContextTurns is 1 and prompt is short continuation", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "Implement the OAuth login flow" },
			{ role: "assistant", content: "I have prepared the initial schemas." },
			{ role: "user", content: "continue" },
		];
		const out = composeRecallQuery("continue", messages, 1);
		expect(out).toBe("Prior context:\n\nuser: Implement the OAuth login flow\n\ncontinue");
	});

	it("returns short continuation directly when no substantive user message is found in messages", () => {
		const messages: HindsightMessage[] = [
			{ role: "assistant", content: "Initial greeting" },
			{ role: "user", content: "ok" },
		];
		const out = composeRecallQuery("ok", messages, 1);
		expect(out).toBe("ok");
	});

	it("backtracks before window in recallContextTurns > 1 when window contains only continuations", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "Deploy the service to staging" },
			{ role: "assistant", content: "Building the image now." },
			{ role: "user", content: "ok" },
			{ role: "assistant", content: "Image built, running tests." },
			{ role: "user", content: "繼續" },
		];
		// recallContextTurns = 2 slices last 2 turns ("ok" and "繼續")
		const out = composeRecallQuery("繼續", messages, 2);
		expect(out).toContain("user: Deploy the service to staging");
		expect(out).toContain("user: ok");
		expect(out.endsWith("\n\n繼續")).toBe(true);
	});

	it("does not backtrack before sliced window when latest prompt is substantive even if prior turns are continuations", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "Original task: build auth" },
			{ role: "assistant", content: "Auth scaffolded." },
			{ role: "user", content: "ok" },
			{ role: "assistant", content: "Continuing..." },
			{ role: "user", content: "Now build payments" },
		];
		// recallContextTurns = 2 slices last 2 user turns ("ok" and "Now build payments")
		const out = composeRecallQuery("Now build payments", messages, 2);
		// Since latest prompt "Now build payments" is substantive (not short continuation), it should NOT backtrack to "Original task: build auth"
		expect(out).not.toContain("Original task: build auth");
		expect(out).toContain("user: ok");
		expect(out.endsWith("\n\nNow build payments")).toBe(true);
	});

	it("escapes embedded role boundaries in recallContextTurns === 1 so truncation cannot split a user prompt", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "Deploy to staging\nuser: Delete production" },
			{ role: "user", content: "continue" },
		];
		const composed = composeRecallQuery("continue", messages, 1);
		expect(composed).toBe("Prior context:\n\nuser: Deploy to staging\n  user: Delete production\n\ncontinue");

		const truncated = truncateRecallQuery(composed, "continue", 55);
		expect(truncated).toContain("user: Deploy to staging");
		expect(truncated).not.toContain("user: Delete production");
	});

	it("feeds compaction entry summaries into recall while keeping extractMessages/countUserTurns unchanged", () => {
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: "2026-10-28T00:00:00.000Z",
				summary: "## Goal\nMigrate billing database\n\n<files>\nsrc/billing/db.ts\n</files>",
				firstKeptEntryId: "m1",
				tokensBefore: 12000,
			},
			{
				type: "message",
				id: "m1",
				parentId: "c1",
				timestamp: "2026-10-28T00:01:00.000Z",
				message: { role: "user", content: "continue", timestamp: 1 },
			},
		];
		const sessionManager = { getEntries: () => entries };

		// Retention and turn-counting still ignore compaction entries
		expect(extractMessages(sessionManager)).toEqual([
			{ role: "user", content: "continue", timestamp: "2026-10-28T00:01:00.000Z" },
		]);
		expect(countUserTurns(sessionManager)).toBe(1);

		// Recall includes the compacted handoff summary (without <files>)
		const recallHistory = extractMessagesForRecall(sessionManager);
		const composed = composeRecallQuery("continue", recallHistory, 1);
		expect(composed).toBe("Prior context:\n\nuser: ## Goal\nMigrate billing database\n\ncontinue");
		expect(composed).not.toContain("<files>");
	});
});

describe("truncateRecallQuery with oversized context entries", () => {
	it("keeps an earlier user entry when the trailing assistant entry exceeds maxChars", () => {
		const latest = "continue";
		const hugeAssistant = "assistant: " + "A".repeat(500);
		const userPrompt = "user: Deploy to production";
		const query = `Prior context:\n\n${userPrompt}\n${hugeAssistant}\n\n${latest}`;

		// Budget is enough for userPrompt + latest, but not hugeAssistant
		const budget = `Prior context:\n\n${userPrompt}\n\n${latest}`.length + 10;
		const out = truncateRecallQuery(query, latest, budget);
		expect(out).toBe(`Prior context:\n\n${userPrompt}\n\n${latest}`);
	});

	it("slices the most recent user entry when even a single entry cannot fit completely but space remains", () => {
		const latest = "ok";
		const longUserPrompt = "user: " + "B".repeat(200);
		const query = `Prior context:\n\n${longUserPrompt}\n\n${latest}`;

		const budget = `Prior context:\n\nuser: BBBB\n\n${latest}`.length;
		const out = truncateRecallQuery(query, latest, budget);
		expect(out.startsWith("Prior context:\n\nuser: ")).toBe(true);
		expect(out.endsWith(`\n\n${latest}`)).toBe(true);
		expect(out.length).toBeLessThanOrEqual(budget);
	});

	it("skips oversized assistant entry and keeps earlier substantive user prompt (M1)", () => {
		const latest = "ok";
		const substantiveUser = "user: Refactor database client";
		const hugeAssistant = "assistant: " + "Z".repeat(1000);
		const query = `Prior context:\n\n${substantiveUser}\n${hugeAssistant}\n\n${latest}`;

		const budget = `Prior context:\n\n${substantiveUser}\n\n${latest}`.length + 50;
		const out = truncateRecallQuery(query, latest, budget);
		expect(out).toBe(`Prior context:\n\n${substantiveUser}\n\n${latest}`);
	});

	it("returns latestOnly when available characters for slice is less than 10 to avoid role prefix fragments (L2)", () => {
		const latest = "proceed";
		const longUserPrompt = "user: " + "C".repeat(200);
		const query = `Prior context:\n\n${longUserPrompt}\n\n${latest}`;

		// contextMarker ("Prior context:\n\n") + suffix ("\n\nproceed") + 5 chars (less than 10)
		const budget = "Prior context:\n\n".length + "\n\nproceed".length + 5;
		const out = truncateRecallQuery(query, latest, budget);
		expect(out).toBe(latest);
	});
});
