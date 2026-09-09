import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultTripleDbPath, TripleStore } from "@oh-my-pi/pi-mnemopi/core/triples";

const originalHome = process.env.HOME;
const originalDataDir = process.env.MNEMOPI_DATA_DIR;
const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-ts-triples-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalDataDir === undefined) delete process.env.MNEMOPI_DATA_DIR;
	else process.env.MNEMOPI_DATA_DIR = originalDataDir;
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("TripleStore default data-directory handling", () => {
	it("keeps triples.db beside the configured Mnemopi data directory", () => {
		const root = tempRoot();
		const home = join(root, "home");
		const dataDir = join(root, "configured-data");
		process.env.HOME = home;
		process.env.MNEMOPI_DATA_DIR = dataDir;

		const store = new TripleStore();
		try {
			expect(store.dbPath).toBe(join(dataDir, "triples.db"));
			expect(defaultTripleDbPath()).toBe(join(dataDir, "triples.db"));
			expect(existsSync(join(dataDir, "triples.db"))).toBe(true);
			expect(existsSync(join(home, ".hermes", "mnemopi", "data", "triples.db"))).toBe(false);
		} finally {
			store.close();
		}
	});

	it("copies an existing legacy triples database into MNEMOPI_DATA_DIR", () => {
		const root = tempRoot();
		const home = join(root, "home");
		const dataDir = join(root, "configured-data");
		const legacyDb = join(home, ".hermes", "mnemopi", "data", "triples.db");
		process.env.HOME = home;
		process.env.MNEMOPI_DATA_DIR = dataDir;

		const legacy = new TripleStore(legacyDb);
		try {
			legacy.add("legacy-subject", "legacy-predicate", "legacy-object", {
				validFrom: "2026-05-08",
			});
		} finally {
			legacy.close();
		}
		expect(existsSync(legacyDb)).toBe(true);
		expect(existsSync(join(dataDir, "triples.db"))).toBe(false);

		const migrated = new TripleStore();
		try {
			expect(migrated.dbPath).toBe(join(dataDir, "triples.db"));
			expect(migrated.query({ subject: "legacy-subject" })[0]?.object).toBe("legacy-object");
		} finally {
			migrated.close();
		}
		expect(existsSync(legacyDb)).toBe(true);
		expect(existsSync(join(dataDir, "triples.db"))).toBe(true);
	});

	it("supports single-current-truth CRUD and historical queries", () => {
		const dbPath = join(tempRoot(), "triples.db");
		const store = new TripleStore(dbPath);
		try {
			const first = store.add("Maya", "assigned_to", "auth-migration", {
				validFrom: "2026-01-15",
				source: "stated",
			});
			const second = store.add("Maya", "assigned_to", "billing", {
				validFrom: "2026-03-01",
				source: "stated",
				confidence: 0.9,
			});
			expect(second).toBeGreaterThan(first);
			expect(
				store.query({ subject: "Maya", predicate: "assigned_to", asOf: "2026-02-01" }).map(row => row.object),
			).toEqual(["auth-migration"]);
			expect(store.query("Maya", "assigned_to", null, "2026-04-01").map(row => row.object)).toEqual(["billing"]);
			expect(store.queryByPredicate("assigned_to", "billing").map(row => row.subject)).toEqual(["Maya"]);
			expect(store.getDistinctObjects("assigned_to")).toEqual(["auth-migration", "billing"]);
			expect(store.exportAll()).toHaveLength(2);
		} finally {
			store.close();
		}
	});
});
