import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildResearchHint, readScreeningCounts } from "../statusline";

const fixtures: string[] = [];

function reviewDbFixture(verdicts: (string | null)[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-statusline-"));
	fixtures.push(dir);
	const dbPath = path.join(dir, "review.db");
	const db = new Database(dbPath, { create: true });
	db.run("CREATE TABLE records (id TEXT PRIMARY KEY, state TEXT NOT NULL, ta_verdict TEXT)");
	const insert = db.prepare("INSERT INTO records (id, state, ta_verdict) VALUES (?, 'identified', ?)");
	verdicts.forEach((verdict, index) => insert.run(`r${index}`, verdict));
	db.close();
	return dbPath;
}

afterEach(() => {
	for (const dir of fixtures.splice(0)) {
		fs.chmodSync(dir, 0o755);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("buildResearchHint", () => {
	it("points a researcher with no project at the guide", () => {
		expect(buildResearchHint({ activeProject: null, counts: null })).toBe(
			"type /help to see what this harness can do",
		);
	});

	it("reports project and screening progress when both are known", () => {
		expect(buildResearchHint({ activeProject: "jev-scoping", counts: { screened: 12, total: 50 } })).toBe(
			"active: jev-scoping · 12/50 screened · type /help for commands",
		);
	});

	it("drops the counts, not the project, when the review store is unreadable", () => {
		expect(buildResearchHint({ activeProject: "jev-scoping", counts: null })).toBe(
			"active: jev-scoping · type /help for commands",
		);
	});
});

describe("readScreeningCounts", () => {
	it("counts records carrying a title/abstract verdict", () => {
		const dbPath = reviewDbFixture(["include", "exclude", null, null, "maybe"]);
		expect(readScreeningCounts(dbPath)).toEqual({ screened: 3, total: 5 });
	});

	it("returns null for a missing review store instead of creating one", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-statusline-"));
		fixtures.push(dir);
		const dbPath = path.join(dir, "review.db");
		expect(readScreeningCounts(dbPath)).toBeNull();
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("returns null for a corrupt review store", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-statusline-"));
		fixtures.push(dir);
		const dbPath = path.join(dir, "review.db");
		fs.writeFileSync(dbPath, "this is not a database");
		expect(readScreeningCounts(dbPath)).toBeNull();
	});

	it("reads a read-only store without touching it", () => {
		const dbPath = reviewDbFixture(["include", null]);
		const dir = path.dirname(dbPath);
		fs.chmodSync(dbPath, 0o444);
		const before = fs.statSync(dbPath).mtimeMs;
		expect(readScreeningCounts(dbPath)).toEqual({ screened: 1, total: 2 });
		expect(fs.statSync(dbPath).mtimeMs).toBe(before);
		expect(fs.readdirSync(dir)).toEqual(["review.db"]);
	});
});
