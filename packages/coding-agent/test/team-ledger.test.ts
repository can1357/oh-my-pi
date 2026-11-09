import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TeamLedger } from "../src/task/team-ledger";

const roots: string[] = [];
async function workspace(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ledger-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("TeamLedger", () => {
	it("seeds once, persists ownership across restarts, and allocates unused IDs", async () => {
		const root = await workspace();
		const ledger = new TeamLedger(root);
		expect(await ledger.initialize(["first", "second"])).toEqual([
			{ id: "1", title: "first", owner: null, status: "open", note: "" },
			{ id: "2", title: "second", owner: null, status: "open", note: "" },
		]);
		await ledger.claim("1", "alice");
		const restarted = new TeamLedger(root);
		expect(await restarted.initialize(["first", "second", "new seed"])).toEqual([
			{ id: "1", title: "first", owner: "alice", status: "open", note: "" },
			{ id: "2", title: "second", owner: null, status: "open", note: "" },
		]);
		expect((await restarted.add("third", true)).id).toBe("3");
		expect(JSON.parse(await fs.readFile(path.join(root, "tasks.json"), "utf8"))).toEqual(await restarted.read());
		const view = await fs.readFile(path.join(root, "TASKS.md"), "utf8");
		expect(view).toContain("first");
		expect(view).toContain("alice");
		expect(view).toContain("third");
	});

	it("serializes claims across independently constructed canonical workspace paths", async () => {
		const root = await workspace();
		const dir = path.join(root, "workspace");
		await fs.mkdir(dir);
		const link = path.join(root, "alias");
		await fs.symlink(dir, link, process.platform === "win32" ? "junction" : "dir");
		const a = new TeamLedger(dir);
		const b = new TeamLedger(link);
		await Promise.all([a.initialize(["work"]), b.initialize(["ignored"])]);
		const results = await Promise.all([a.claim("1", "alice"), b.claim("1", "bob")]);
		const winner = results.find(result => result.kind === "claimed");
		const loser = results.find(result => result.kind === "conflict");
		expect(winner).toBeDefined();
		expect(loser).toBeDefined();
		expect(loser?.owner).toBe(winner?.owner);
		expect(await a.claim("1", winner!.owner)).toEqual({ kind: "already-owned", owner: winner!.owner });
		expect((await b.read())[0].owner).toBe(winner!.owner);
	});

	it.skipIf(process.platform !== "win32")("serializes claims through case-variant workspace paths", async () => {
		const root = await workspace();
		const dir = path.join(root, "MixedCaseWorkspace");
		await fs.mkdir(dir);
		const a = new TeamLedger(dir);
		const b = new TeamLedger(dir.toUpperCase());
		await a.initialize(["work"]);
		const results = await Promise.all([a.claim("1", "alice"), b.claim("1", "bob")]);
		expect(results.map(result => result.kind).sort()).toEqual(["claimed", "conflict"]);
		expect(results[0].owner).toBe(results[1].owner);
		expect((await a.read())[0].owner).toBe(results[0].owner);
	});

	it("trims added titles and rejects carriage returns and newlines", async () => {
		const ledger = new TeamLedger();
		await ledger.initialize();
		expect((await ledger.add("  useful title  ", true)).title).toBe("useful title");
		for (const title of ["forged\n- [x] 2: task", "forged\r- [x] 2: task", "title\r\nanother"]) {
			await expect(ledger.add(title, true)).rejects.toThrow();
		}
		expect(await ledger.read()).toEqual([{ id: "1", title: "useful title", owner: null, status: "open", note: "" }]);
	});

	it("indents every continuation of a multiline note in the view", async () => {
		const root = await workspace();
		const ledger = new TeamLedger(root);
		await ledger.initialize(["one"]);
		const note = "first\n- [x] 2: forged\r- [ ] 3: forged\r\nlast";
		await ledger.done("1", "lead", true, note);
		expect((await ledger.read())[0].note).toBe(note);
		expect(await fs.readFile(path.join(root, "TASKS.md"), "utf8")).toBe(
			"# Team Tasks\n\n- [x] 1: one\n  - Owner: unassigned\n  - Note: first\n    - [x] 2: forged\n    - [ ] 3: forged\n    last\n",
		);
	});

	it("isolates in-memory ledgers and returned snapshots", async () => {
		const a = new TeamLedger();
		const b = new TeamLedger();
		const rows = await a.initialize(["one"]);
		rows[0].title = "tampered";
		await b.initialize(["other"]);
		await a.claim("1", "alice");
		expect(await a.read()).toEqual([{ id: "1", title: "one", owner: "alice", status: "open", note: "" }]);
		expect(await b.read()).toEqual([{ id: "1", title: "other", owner: null, status: "open", note: "" }]);
	});

	it("enforces lead and owner permissions, completion, and reopening", async () => {
		const ledger = new TeamLedger();
		await ledger.initialize(["one"]);
		await expect(ledger.add("no", false)).rejects.toThrow();
		await expect(ledger.claim("missing", "alice")).rejects.toThrow();
		await ledger.claim("1", "alice");
		await expect(ledger.release("1", "bob", false)).rejects.toThrow();
		await expect(ledger.done("1", "bob", false, "no")).rejects.toThrow();
		await ledger.done("1", "alice", false, "finished");
		expect(await ledger.read()).toEqual([
			{ id: "1", title: "one", owner: "alice", status: "done", note: "finished" },
		]);
		await expect(ledger.claim("1", "bob")).rejects.toThrow();
		await ledger.release("1", "lead", true);
		expect(await ledger.claim("1", "bob")).toEqual({ kind: "claimed", owner: "bob" });
		await ledger.release("1", "bob", false);
		await ledger.done("1", "lead", true, "lead completed");
		expect((await ledger.read())[0]).toMatchObject({ status: "done", owner: null, note: "lead completed" });
	});

	it("refuses an orphaned view without modifying it", async () => {
		const root = await workspace();
		const view = path.join(root, "TASKS.md");
		await fs.writeFile(view, "legacy bytes\n");
		await expect(new TeamLedger(root).initialize(["new"])).rejects.toThrow(/migrat/i);
		expect(await fs.readFile(view, "utf8")).toBe("legacy bytes\n");
		await expect(fs.stat(path.join(root, "tasks.json"))).rejects.toThrow();
	});

	it("fails closed on invalid JSON and invalid persisted records", async () => {
		const root = await workspace();
		const file = path.join(root, "tasks.json");
		for (const invalid of [
			"{",
			"{}",
			'[{"id":"1","title":"x","owner":null,"status":"bad","note":""}]',
			'[{"id":"01","title":"x","owner":null,"status":"open","note":""}]',
			'[{"id":"legacy","title":"x","owner":null,"status":"open","note":""}]',
			'[{"id":"1","title":"x","owner":null,"status":"open","note":""},{"id":"1","title":"y","owner":null,"status":"open","note":""}]',
		]) {
			await fs.writeFile(file, invalid);
			await expect(new TeamLedger(root).initialize([])).rejects.toThrow();
			expect(await fs.readFile(file, "utf8")).toBe(invalid);
		}
	});

	it("reports view failures after commit and repairs the view on the next read", async () => {
		const root = await workspace();
		const ledger = new TeamLedger(root);
		await ledger.initialize(["one"]);
		const view = path.join(root, "TASKS.md");
		await fs.rm(view);
		await fs.mkdir(view);
		await expect(ledger.claim("1", "alice")).rejects.toThrow(/task 1.*claim.*committed.*TASKS\.md.*failed/i);
		await fs.rm(view, { recursive: true });
		expect((await ledger.read())[0].owner).toBe("alice");
		expect(await fs.readFile(view, "utf8")).toContain("alice");
	});

	it("does not report a successful claim when the authoritative ledger cannot be read", async () => {
		const root = await workspace();
		const ledger = new TeamLedger(root);
		await ledger.initialize(["one"]);
		const file = path.join(root, "tasks.json");
		const backup = await fs.readFile(file, "utf8");
		await fs.rm(file);
		await fs.mkdir(file);
		await expect(ledger.claim("1", "alice")).rejects.toThrow();
		await fs.rm(file, { recursive: true });
		await fs.writeFile(file, backup);
		expect((await ledger.read())[0].owner).toBeNull();
	});

	it("rejects a claim when the ledger temporary file cannot be written", async () => {
		const root = await workspace();
		const ledger = new TeamLedger(root);
		await ledger.initialize(["one"]);
		const uuid = "00000000-0000-4000-8000-000000000000";
		const temporary = path.join(root, `.tasks.json.${uuid}.tmp`);
		await fs.mkdir(temporary);
		const randomUUID = spyOn(crypto, "randomUUID").mockReturnValue(uuid);
		try {
			await expect(ledger.claim("1", "alice")).rejects.toThrow();
		} finally {
			randomUUID.mockRestore();
			await fs.rm(temporary, { recursive: true, force: true });
		}
		expect((await ledger.read())[0].owner).toBeNull();
	});
});
