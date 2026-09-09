import { describe, expect, it } from "bun:test";

import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

function createVecEpisodes(beam: BeamMemory): void {
	beam.db.run("CREATE TABLE vec_episodes (rowid INTEGER PRIMARY KEY, embedding TEXT NOT NULL)");
}

function vecCount(beam: BeamMemory): number {
	return (beam.db.query("SELECT COUNT(*) AS count FROM vec_episodes").get() as { count: number }).count;
}

function payload(
	rowid: number,
	embeddings: Array<{ rowid: number; embedding: number[] }> = [],
): Record<string, unknown> {
	return {
		version: 1,
		working_memory: [],
		episodic_memory: [
			{
				id: "em-1",
				rowid,
				content: "new content",
				source: "import",
				timestamp: "2026-05-11T00:00:00.000Z",
				session_id: "import-session",
				importance: 0.7,
				metadata_json: "{}",
				summary_of: "",
				valid_until: null,
				superseded_by: null,
				scope: "session",
				recall_count: 0,
				last_recalled: null,
				created_at: "2026-05-11T00:00:00.000Z",
			},
		],
		episodic_embeddings: embeddings,
	};
}

describe("importFromDict vec_episodes cleanup", () => {
	it("force overwrite deletes the old rowid before replacing episodic memory", () => {
		const beam = new BeamMemory({ sessionId: "orphan-clean", dbPath: ":memory:" });
		try {
			createVecEpisodes(beam);
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, importance) VALUES ('em-1', 'original', 'test', datetime('now'), 0.5)",
			);
			const rowid = (
				beam.db.query("SELECT rowid FROM episodic_memory WHERE id = 'em-1'").get() as {
					rowid: number;
				}
			).rowid;
			beam.db.run("INSERT INTO vec_episodes(rowid, embedding) VALUES (?, ?)", [rowid, JSON.stringify([0.1, 0.2])]);

			beam.importFromDict(payload(rowid), true);

			expect((beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get() as { count: number }).count).toBe(
				1,
			);
			expect(vecCount(beam)).toBe(0);
		} finally {
			beam.close();
		}
	});

	it("force=false skip path does not touch existing vector rows", () => {
		const beam = new BeamMemory({ sessionId: "orphan-skip", dbPath: ":memory:" });
		try {
			createVecEpisodes(beam);
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, importance) VALUES ('em-1', 'original', 'test', datetime('now'), 0.5)",
			);
			const rowid = (
				beam.db.query("SELECT rowid FROM episodic_memory WHERE id = 'em-1'").get() as {
					rowid: number;
				}
			).rowid;
			beam.db.run("INSERT INTO vec_episodes(rowid, embedding) VALUES (?, ?)", [rowid, JSON.stringify([0.1, 0.2])]);

			beam.importFromDict(payload(rowid), false);

			expect(vecCount(beam)).toBe(1);
		} finally {
			beam.close();
		}
	});

	it("maps imported embeddings to the replacement rowid instead of preserving an orphan", () => {
		const beam = new BeamMemory({ sessionId: "orphan-reimport", dbPath: ":memory:" });
		try {
			createVecEpisodes(beam);
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, importance) VALUES ('em-1', 'original', 'test', datetime('now'), 0.5)",
			);
			const oldRowid = (
				beam.db.query("SELECT rowid FROM episodic_memory WHERE id = 'em-1'").get() as {
					rowid: number;
				}
			).rowid;
			beam.db.run("INSERT INTO vec_episodes(rowid, embedding) VALUES (?, ?)", [
				oldRowid,
				JSON.stringify([0.1, 0.2]),
			]);

			beam.importFromDict(payload(oldRowid, [{ rowid: oldRowid, embedding: [0.9, 0.1] }]), true);

			const newRowid = (
				beam.db.query("SELECT rowid FROM episodic_memory WHERE id = 'em-1'").get() as {
					rowid: number;
				}
			).rowid;
			const vecRowid = (beam.db.query("SELECT rowid FROM vec_episodes").get() as { rowid: number }).rowid;
			expect(vecCount(beam)).toBe(1);
			expect(vecRowid).toBe(newRowid);
			expect(vecRowid).not.toBe(oldRowid);
		} finally {
			beam.close();
		}
	});
});
