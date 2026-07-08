import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import { openWikigraphDb } from "../../src/wikigraph/db";
import { getWikigraphDbPath } from "../../src/wikigraph/paths";

async function tempDbPath(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikigraph-db-"));
	return path.join(root, "index.sqlite");
}

describe("wikigraph db", () => {
	it("opens under agent wikigraph path", () => {
		expect(getWikigraphDbPath()).toBe(path.join(getAgentDir(), "wikigraph", "index.sqlite"));
	});

	it("runs schema idempotently and enables WAL", async () => {
		const dbPath = await tempDbPath();
		const first = await openWikigraphDb(dbPath);
		first.close();
		const second = await openWikigraphDb(dbPath);
		second.db.exec(
			"INSERT INTO nodes (id, kind, title, summary, path, source_hash, valid_from, created_at, updated_at) VALUES ('n1', 'doc', 'Doc', 'Summary', '/tmp/doc.md', 'hash', 1, 1, 1)",
		);
		const row = second.db.query<{ title: string }, []>("SELECT title FROM nodes WHERE id = 'n1'").get();
		const journal = second.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
		expect(row?.title).toBe("Doc");
		expect(journal?.journal_mode).toBe("wal");
		second.close();
	});
});
