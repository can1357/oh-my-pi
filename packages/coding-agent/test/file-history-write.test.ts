import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { FileHistory } from "../src/session/file-history";
import type { ToolSession } from "../src/tools";
import { WriteTool } from "../src/tools/write";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-write-"));
	dirs.push(root);
	const cwd = path.join(root, "workspace");
	await fs.mkdir(cwd);
	const history = new FileHistory(cwd, path.join(root, "history"), "write-test");
	const session: ToolSession = {
		cwd,
		hasUI: false,
		enableLsp: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		declareFileHistoryPaths: paths => history.declare(paths),
	};
	return { cwd, history, tool: new WriteTool(session) };
}

test("archive writes restore the actual hidden archive and remove a newly created archive", async () => {
	const { cwd, history, tool } = await fixture();
	await tool.execute("seed", { path: ".archive.zip:src/a.ts", content: "original" });
	const archive = path.join(cwd, ".archive.zip");
	const original = await Bun.file(archive).bytes();
	await history.command("on");
	await history.beginTurn({ leafId: "old", label: "archive edit" });
	await tool.execute("edit", { path: ".archive.zip:src/a.ts", content: "changed" });
	await tool.execute("create", { path: ".created.zip:a.txt", content: "new" });
	expect(await Bun.file(archive).bytes()).not.toEqual(original);
	await history.change(
		await history.points(),
		"new",
		async () => {},
		async () => true,
	);
	expect(await Bun.file(archive).bytes()).toEqual(original);
	expect(await Bun.file(path.join(cwd, ".created.zip")).exists()).toBe(false);
});

test("SQLite row writes preserve the hidden database preimage", async () => {
	const { cwd, history, tool } = await fixture();
	const databasePath = path.join(cwd, ".db.sqlite");
	const db = new Database(databasePath);
	db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES(42, 'before')");
	db.close();
	await history.command("on");
	await history.beginTurn({ leafId: "old", label: "database edit" });
	await tool.execute("edit", { path: ".db.sqlite:users:42", content: '{"name":"after"}' });
	await history.change(
		await history.points(),
		"new",
		async () => {},
		async () => true,
	);
	const restored = new Database(databasePath, { readonly: true });
	try {
		expect(restored.query("SELECT name FROM users WHERE id=42").get()).toEqual({ name: "before" });
	} finally {
		restored.close();
	}
});

test("hashline-wrapped hidden paths restore their original bytes", async () => {
	const { cwd, history, tool } = await fixture();
	const target = path.join(cwd, ".hidden.txt");
	await Bun.write(target, "before");
	await history.command("on");
	await history.beginTurn({ leafId: "old", label: "wrapped edit" });
	await tool.execute("edit", { path: "[.hidden.txt#ABCD]", content: "after" });
	await history.change(
		await history.points(),
		"new",
		async () => {},
		async () => true,
	);
	expect(await Bun.file(target).text()).toBe("before");
});
