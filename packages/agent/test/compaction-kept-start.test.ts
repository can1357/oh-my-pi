import { describe, expect, test } from "bun:test";
import { type CompactionEntry, compactionKeptStart, type SessionEntry } from "@oh-my-pi/pi-agent-core/compaction";
import { createUserMessage } from "./helpers";

function messageEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: createUserMessage(id),
	};
}

function compactionEntry(
	kept: Pick<CompactionEntry, "firstKeptEntryId" | "providerReplayThroughEntryId">,
): CompactionEntry {
	return {
		type: "compaction",
		id: "compaction",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		summary: "summary",
		tokensBefore: 0,
		...kept,
	};
}

describe("compactionKeptStart", () => {
	const history = ["u1", "a1", "u2", "a2"].map(messageEntry);
	const startOf = (compaction: CompactionEntry): number =>
		compactionKeptStart([...history, compaction], compaction, history.length);

	test("a compaction that kept entries starts at the first one it kept", () => {
		expect(startOf(compactionEntry({ firstKeptEntryId: "u2" }))).toBe(2);
	});

	test("a kept entry that is not on the path before the compaction leaves the compaction as the start", () => {
		expect(startOf(compactionEntry({ firstKeptEntryId: "gone" }))).toBe(history.length);
	});
});
