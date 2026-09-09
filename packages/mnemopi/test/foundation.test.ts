import { describe, expect, it } from "bun:test";
import * as Beam from "@oh-my-pi/pi-mnemopi/core/beam";
import * as Db from "@oh-my-pi/pi-mnemopi/db";

describe("Foundation smoke test", () => {
	it("initializes beam schema twice and inserts working memory row", () => {
		// Create in-memory database
		const db = Db.openDatabase(":memory:", { create: true, readwrite: true });

		try {
			// Initialize beam schema twice (idempotency test)
			Beam.initBeam(db);
			Beam.initBeam(db);

			// Insert one working memory row with minimal required fields
			const id = "test-wm-001";
			const content = "Test working memory content";
			const now = new Date().toISOString();

			db.run(
				`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[id, content, "test_source", now, "test_session", 0.5, "unknown", now],
			);

			// Query it back
			const row = db
				.query(`SELECT id, content, source, timestamp, session_id, importance, veracity, created_at
					FROM working_memory WHERE id = ?`)
				.get(id) as {
				id: string;
				content: string;
				source: string | null;
				timestamp: string | null;
				session_id: string;
				importance: number;
				veracity: string;
				created_at: string;
			} | null;

			// Verify the row was inserted correctly
			expect(row).not.toBeNull();
			expect(row?.id).toBe(id);
			expect(row?.content).toBe(content);
			expect(row?.source).toBe("test_source");
			expect(row?.timestamp).toBe(now);
			expect(row?.session_id).toBe("test_session");
			expect(row?.importance).toBe(0.5);
			expect(row?.veracity).toBe("unknown");
			expect(row?.created_at).toBe(now);
		} finally {
			// Close database
			Db.closeQuietly(db);
		}
	});
});
