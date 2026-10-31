import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("SQLite row selectors with shadowed rowid names", () => {
	let dir: TempDir;
	let db: Database;
	let file: string;
	let session: ToolSession;

	beforeEach(async () => {
		dir = await TempDir.create("@sqlite-rowid-shadow-");
		file = dir.join("records.sqlite");
		db = new Database(file);
		session = {
			cwd: dir.path(),
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(dir.path(), "artifacts"),
			settings: Settings.isolated({ "edit.mode": "replace" }),
		};
	});

	afterEach(async () => {
		db.close();
		await dir.remove();
	});

	it("reads and mutates only the hidden rowid even when a named rowid column is duplicated", async () => {
		db.run("CREATE TABLE records (rowid INTEGER, body TEXT); INSERT INTO records VALUES (2, 'first'), (2, 'second')");
		const read = new ReadTool(session);
		const write = new WriteTool(session);
		const result = await read.execute("read", { path: `${file}:records:2` });
		expect(result.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("second") })]),
		);
		await write.execute("update", { path: `${file}:records:2`, content: '{body: "updated"}' });
		expect(db.query("SELECT body FROM records ORDER BY _rowid_").all()).toEqual([
			{ body: "first" },
			{ body: "updated" },
		]);
		await write.execute("delete", { path: `${file}:records:2`, content: "" });
		expect(db.query("SELECT body FROM records").all()).toEqual([{ body: "first" }]);
	});

	it("falls back to oid when mixed-case and generated columns shadow the first two aliases", async () => {
		db.run(`CREATE TABLE records (RoWiD INTEGER, _RoWiD_ INTEGER GENERATED ALWAYS AS (RoWiD), body TEXT);
			INSERT INTO records (RoWiD, body) VALUES (2, 'first'), (2, 'second')`);
		await new WriteTool(session).execute("delete", { path: `${file}:records:2`, content: "" });
		expect(db.query("SELECT body FROM records").all()).toEqual([{ body: "first" }]);
	});

	it("refuses row-key reads and writes when all hidden aliases are shadowed", async () => {
		db.run(`CREATE TABLE records (rowid INTEGER, _rowid_ INTEGER, OID INTEGER, body TEXT);
			INSERT INTO records VALUES (2, 2, 2, 'first'), (2, 2, 2, 'second')`);
		await expect(new ReadTool(session).execute("read", { path: `${file}:records:2` })).rejects.toThrow(
			"shadows all ROWID aliases",
		);
		const write = new WriteTool(session);
		await expect(
			write.execute("update", { path: `${file}:records:2`, content: '{body: "changed"}' }),
		).rejects.toThrow("shadows all ROWID aliases");
		await expect(write.execute("delete", { path: `${file}:records:2`, content: "" })).rejects.toThrow(
			"shadows all ROWID aliases",
		);
		expect(db.query("SELECT body FROM records ORDER BY body").all()).toEqual([{ body: "first" }, { body: "second" }]);
	});
});
