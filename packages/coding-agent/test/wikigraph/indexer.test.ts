import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openWikigraphDb } from "../../src/wikigraph/db";
import { indexMarkdownFile, wikigraphNodeId } from "../../src/wikigraph/indexer";

describe("wikigraph indexer", () => {
	it("indexes docs, sections, links, and supersession", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikigraph-indexer-"));
		await fs.writeFile(path.join(root, "old.md"), "# Old\n\nOld procedure.");
		const oldId = wikigraphNodeId("doc", "old.md");
		await fs.writeFile(
			path.join(root, "install.md"),
			`---\nsupersedes: "${oldId}"\n---\n# Install\n\nInstall summary.\n\n## Steps\nRun installer.\n[Old](old.md)`,
		);
		await fs.writeFile(
			path.join(root, "notes.md"),
			"# Notes\n\nSee [Install](install.md#Steps).\n\n## Detail\nMore notes.",
		);
		const db = await openWikigraphDb(path.join(root, "index.sqlite"));
		await indexMarkdownFile(db, path.join(root, "old.md"), root);
		await indexMarkdownFile(db, path.join(root, "install.md"), root);
		await indexMarkdownFile(db, path.join(root, "notes.md"), root);
		const counts = db.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM nodes").get();
		const edgeKinds = db.db
			.query<{ kind: string }, []>("SELECT DISTINCT kind FROM edges ORDER BY kind")
			.all()
			.map(row => row.kind);
		const oldNode = db.db
			.query<{ status: string; superseded_by: string | null }, [string]>(
				"SELECT status, superseded_by FROM nodes WHERE id = ?",
			)
			.get(oldId);
		expect(counts?.c).toBe(5);
		expect(edgeKinds).toContain("links_to");
		expect(edgeKinds).toContain("supersedes");
		expect(oldNode?.status).toBe("superseded");
		expect(oldNode?.superseded_by).toBe(wikigraphNodeId("doc", "install.md"));
		db.close();
	});
});
