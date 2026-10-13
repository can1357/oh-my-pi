/**
 * Recall scores embeddings only for the newest rows per tier. With a 500-row cap, a memory that matches
 * the query by meaning but shares no words with it disappeared once 500 newer rows existed.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import "./setup";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// "zorblat" and "quexim" share an axis, so a query and a memory can match by meaning without sharing a word.
const provider = {
	async *embed(texts: readonly string[]) {
		yield texts.map(text => (/zorblat|quexim/i.test(text) ? [1, 0] : [0, 1]));
	},
};

describe("dense candidate pool", () => {
	it("recalls a semantically matching memory older than 500 newer rows", async () => {
		const memory = new Mnemopi({
			db: new Database(":memory:"),
			embeddings: { provider: provider.embed.bind(provider) },
		});
		try {
			const start = Date.now() - 3_600_000;
			const target = memory.remember("quexim checklist agreed for friday", {
				source: "test",
				timestamp: new Date(start).toISOString(),
			});
			for (let i = 1; i <= 600; i++) {
				memory.remember(`gardening note ${i}`, {
					source: "test",
					timestamp: new Date(start + i * 1000).toISOString(),
				});
			}
			await memory.flushExtractions();

			const results = await memory.recall("zorblat plan", 5);
			expect(results[0]?.id).toBe(target);
		} finally {
			memory.close();
		}
	});
});
