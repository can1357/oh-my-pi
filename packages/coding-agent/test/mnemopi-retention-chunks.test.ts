import { describe, expect, it } from "bun:test";
import type { HindsightMessage } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import * as retentionContent from "@oh-my-pi/pi-coding-agent/hindsight/content";

type RetentionChunkRange = {
	readonly messageIndex: number;
	readonly start: number;
	readonly end: number;
};

type RetentionChunk = {
	readonly messages: HindsightMessage[];
	readonly ranges: readonly RetentionChunkRange[];
	/** Cumulative user turns fully persisted by this chunk. */
	readonly completedUserTurns: number;
};

type ChunkRetentionMessages = (messages: HindsightMessage[], maxChars: number) => RetentionChunk[];
type ReconstructRetentionChunks = (chunks: readonly RetentionChunk[]) => HindsightMessage[];

function chunker(): ChunkRetentionMessages {
	const candidate = (retentionContent as unknown as { chunkRetentionMessages?: unknown }).chunkRetentionMessages;
	expect(typeof candidate).toBe("function");
	if (typeof candidate !== "function") throw new Error("chunkRetentionMessages is not implemented");
	return candidate as ChunkRetentionMessages;
}

function reconstructor(): ReconstructRetentionChunks {
	const candidate = (retentionContent as unknown as { reconstructRetentionChunks?: unknown })
		.reconstructRetentionChunks;
	expect(typeof candidate).toBe("function");
	if (typeof candidate !== "function") throw new Error("reconstructRetentionChunks is not implemented");
	return candidate as ReconstructRetentionChunks;
}

function framedLength(messages: HindsightMessage[]): number {
	return retentionContent.prepareRetentionTranscript(messages, true).transcript?.length ?? 0;
}

describe("Mnemopi retention chunking", () => {
	it("greedily preserves user-bounded turns under a hard framed-content cap", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: `first question ${"a".repeat(55)}` },
			{ role: "assistant", content: `first answer ${"b".repeat(55)}` },
			{ role: "user", content: `second question ${"c".repeat(55)}` },
			{ role: "assistant", content: `second answer ${"d".repeat(55)}` },
		];
		const maxChars = 190;
		const chunks = chunker()(messages, maxChars);

		expect(chunks).toHaveLength(2);
		expect(chunks.map(chunk => chunk.completedUserTurns)).toEqual([1, 2]);
		expect(chunks.every(chunk => framedLength(chunk.messages) <= maxChars)).toBe(true);
		expect(reconstructor()(chunks)).toEqual(messages);
	});

	it("splits one oversized message without cutting Unicode and advances its turn only on the final piece", () => {
		const content = `remember ${"árvíztűrő tükörfúrógép 🧠 ".repeat(30)}`;
		const messages: HindsightMessage[] = [{ role: "user", content }];
		const maxChars = 120;
		const chunks = chunker()(messages, maxChars);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.slice(0, -1).every(chunk => chunk.completedUserTurns === 0)).toBe(true);
		expect(chunks.at(-1)?.completedUserTurns).toBe(1);
		expect(chunks.every(chunk => framedLength(chunk.messages) <= maxChars)).toBe(true);
		expect(chunks.flatMap(chunk => chunk.messages).every(message => !message.content.includes("�"))).toBe(true);
		expect(reconstructor()(chunks)).toEqual(messages);
	});

	it("survives the formatter trimming each persisted piece without losing boundary whitespace", () => {
		const messages: HindsightMessage[] = [{ role: "user", content: `prefix ${"word ".repeat(100)}suffix` }];
		const chunks = chunker()(messages, 120);
		const persistedChunks = chunks.map(chunk => ({
			...chunk,
			// This is what prepareRetentionTranscript writes for each child today.
			messages: chunk.messages.map(message => ({ ...message, content: message.content.trim() })),
		}));

		expect(chunks.length).toBeGreaterThan(1);
		expect(reconstructor()(persistedChunks)).toEqual(messages);
	});

	it("preserves tool-only content without inventing a completed user turn", () => {
		const messages: HindsightMessage[] = [{ role: "tool", content: "tool output that must remain durable" }];
		const chunks = chunker()(messages, 200);

		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.completedUserTurns).toBe(0);
		expect(reconstructor()(chunks)).toEqual(messages);
	});

	it("rejects a cap too small to hold one framed code point rather than truncating", () => {
		expect(() => chunker()([{ role: "user", content: "substantive" }], 8)).toThrow(/maxChars/i);
	});
});
