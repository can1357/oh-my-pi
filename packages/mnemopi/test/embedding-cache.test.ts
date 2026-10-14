/**
 * Recall keeps decoded embeddings per connection. These pin the two ways a cached vector could go stale:
 * a vector written later by this connection, and a vector written by another connection on the same bank.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import "./setup";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// "zorblat" and "quexim" share an axis, so a query and a memory can match by meaning without sharing a word.
const axis = (text: string) => (/zorblat|quexim/i.test(text) ? [1, 0] : [0, 1]);

describe("embedding cache", () => {
	it("uses a vector stored after an earlier recall cached its absence", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let held = false;
		const provider = async function* (texts: readonly string[]) {
			// Hold only the target's document embedding, so the first recall sees it without a vector.
			if (!held && texts.some(text => text.startsWith("quexim checklist"))) {
				held = true;
				await gate;
			}
			yield texts.map(axis);
		};
		const memory = new Mnemopi({ db: new Database(":memory:"), embeddings: { provider } });
		try {
			memory.remember("gardening note about soil", { source: "test" });
			await memory.flushExtractions();
			const target = memory.remember("quexim checklist agreed for friday", { source: "test" });

			const before = await memory.recall("zorblat plan", 5);
			expect(before.some(result => result.id === target)).toBe(false);

			release();
			await memory.flushExtractions();
			const after = await memory.recall("zorblat plan", 5);
			expect(after[0]?.id).toBe(target);
		} finally {
			memory.close();
		}
	});

	it("sees embeddings another connection rewrote", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-embedding-cache-"));
		const dbPath = path.join(dir, "bank.db");
		const memory = new Mnemopi({
			dbPath,
			embeddings: {
				provider: async function* (texts: readonly string[]) {
					yield texts.map(axis);
				},
			},
		});
		try {
			const target = memory.remember("quexim checklist agreed for friday", { source: "test" });
			const other = memory.remember("gardening note about soil", { source: "test" });
			await memory.flushExtractions();
			expect((await memory.recall("zorblat plan", 5))[0]?.id).toBe(target);

			const peer = new Database(dbPath);
			try {
				peer.run("UPDATE memory_embeddings SET embedding_json = ? WHERE memory_id = ?", ["[0,1]", target]);
				peer.run("UPDATE memory_embeddings SET embedding_json = ? WHERE memory_id = ?", ["[1,0]", other]);
			} finally {
				peer.close();
			}

			expect((await memory.recall("zorblat plan", 5))[0]?.id).toBe(other);
		} finally {
			memory.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
