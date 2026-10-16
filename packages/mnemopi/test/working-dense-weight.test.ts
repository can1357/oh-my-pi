/**
 * Working-tier recall blends keyword and embedding scores. When the embedding share was 0.2, a row that only
 * repeated the query's words outranked one that answered it by meaning but shared none of its words, so a user's short statement lost to
 * a long reply that echoed the question.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import "./setup";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// "zorblat" and "quexim" share an axis; "orthogonal" points at right angles to it (cosine 0, as low as recall
// scores); every other text points mostly elsewhere (cosine 0.3 to the query).
const provider = {
	async *embed(texts: readonly string[]) {
		yield texts.map(text => {
			if (/zorblat|quexim/i.test(text)) return [1, 0];
			if (/orthogonal/i.test(text)) return [0, 1];
			return [0.3, Math.sqrt(1 - 0.09)];
		});
	},
};

describe("working-tier dense weight", () => {
	it("ranks a memory that matches by meaning above one that only repeats the query's words", async () => {
		const memory = new Mnemopi({
			db: new Database(":memory:"),
			embeddings: { provider: provider.embed.bind(provider) },
		});
		try {
			const timestamp = new Date(Date.now() - 60_000).toISOString();
			const answer = memory.remember("quexim moved to friday", { source: "test", timestamp });
			const echo = memory.remember("which deploy window do we use?", { source: "test", timestamp });
			await memory.flushExtractions();

			const ids = (await memory.recall("zorblat deploy window", 5)).map(result => result.id);
			expect(ids).toContain(echo);
			expect(ids.indexOf(answer)).toBeLessThan(ids.indexOf(echo));
		} finally {
			memory.close();
		}
	});

	it("blends an embedded row whose similarity is zero instead of treating it as unembedded", async () => {
		const memory = new Mnemopi({
			db: new Database(":memory:"),
			embeddings: { provider: provider.embed.bind(provider) },
		});
		try {
			const timestamp = new Date(Date.now() - 60_000).toISOString();
			// Same query words; only the stored vectors differ.
			const unrelated = memory.remember("deploy window orthogonal", { source: "test", timestamp });
			const related = memory.remember("deploy window adjacent", { source: "test", timestamp });
			await memory.flushExtractions();

			const ids = (await memory.recall("zorblat deploy window", 5)).map(result => result.id);
			expect(ids).toContain(unrelated);
			expect(ids.indexOf(related)).toBeLessThan(ids.indexOf(unrelated));
		} finally {
			memory.close();
		}
	});
});
