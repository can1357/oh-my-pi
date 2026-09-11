import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileHistory } from "../src/session/file-history";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-filesnap-"));
	dirs.push(base);
	const cwd = path.join(base, "workspace"),
		data = path.join(base, "history");
	await fs.mkdir(cwd);
	return { cwd, data, history: new FileHistory(cwd, data, "session", process.env.FILESNAP_TEST_BIN) };
}

test("restores pre-edit and absent files, survives resume, and reverses recovery repeatedly", async () => {
	const { cwd, data, history } = await fixture();
	await Bun.write(path.join(cwd, "asset.bin"), new Uint8Array([0, 255, 3]));
	await history.command("on");
	const turn = (await history.command("list")).split(/\s+/)[0]!;
	const hidden = path.join(cwd, ".hidden");
	await Bun.write(hidden, "before");
	await history.declare([hidden, "created.bin"]);
	await Bun.write(hidden, "after");
	await Bun.write(path.join(cwd, "created.bin"), "new");
	await Bun.write(path.join(cwd, "asset.bin"), new Uint8Array([1, 2]));
	const resumed = new FileHistory(cwd, data, "session", process.env.FILESNAP_TEST_BIN);
	await resumed.command(`restore ${turn}`);
	expect(await Bun.file(hidden).text()).toBe("before");
	expect(await Bun.file(path.join(cwd, "asset.bin")).bytes()).toEqual(new Uint8Array([0, 255, 3]));
	expect(await Bun.file(path.join(cwd, "created.bin")).exists()).toBe(false);
	await resumed.command("redo");
	expect(await Bun.file(hidden).text()).toBe("after");
	expect(await Bun.file(path.join(cwd, "created.bin")).text()).toBe("new");
	await resumed.command("redo");
	expect(await Bun.file(hidden).text()).toBe("before");
});

test("new prompts advance history, disabled sessions do not capture, foreign turns are refused", async () => {
	const { cwd, data, history } = await fixture();
	await Bun.write(path.join(cwd, "a"), "one");
	await history.beginTurn();
	expect(await history.command("list")).toContain("No file checkpoints");
	await history.command("on");
	const first = (await history.command("list")).split(/\s+/)[0]!;
	await history.beginTurn();
	expect((await history.command("list")).split("\n")).toHaveLength(2);
	const other = new FileHistory(cwd, data, "other", process.env.FILESNAP_TEST_BIN);
	await expect(other.command(`restore ${first}`)).rejects.toThrow("not in this session");
	await history.command("off");
	await history.beginTurn();
	expect((await history.command("list")).split("\n")).toHaveLength(2);
});

test("a failed preimage capture refuses the edit rather than recording absence", async () => {
	const { cwd, history } = await fixture();
	await history.command("on");
	await fs.mkdir(path.join(cwd, "directory"));
	await expect(history.declare(["directory"])).rejects.toThrow();
});

test("refuses a content store inside the workspace", async () => {
	const { cwd } = await fixture();
	const history = new FileHistory(cwd, path.join(cwd, "store"), "session", process.env.FILESNAP_TEST_BIN);
	await expect(history.command("on")).rejects.toThrow("outside the workspace");
});

test("clear removes only the selected session and disables capture", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-history-clear-"));
	try {
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd);
		const file = path.join(cwd, "asset.bin");
		await fs.writeFile(file, new Uint8Array([0, 255, 7]));
		const first = new FileHistory(cwd, path.join(root, "data"), "first");
		const second = new FileHistory(cwd, path.join(root, "data"), "second");
		await first.command("on");
		await second.command("on");
		const target = (await second.command("list")).split(/\s+/)[0];
		await first.command("clear");
		await first.beginTurn();
		expect(await first.command("list")).toContain("No file checkpoints");
		await fs.writeFile(file, "changed");
		await second.command(`restore ${target}`);
		expect([...(await fs.readFile(file))]).toEqual([0, 255, 7]);
		await first.command("clear");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("combined rewind restores all later preimages and supports multiple redo levels", async () => {
	const { cwd, history } = await fixture();
	await history.command("on");
	let leaf: string | null = "before-first";
	const navigate = async (next: string | null) => {
		leaf = next;
	};
	await Bun.write(path.join(cwd, "asset.bin"), new Uint8Array([0, 255]));
	await history.beginTurn({ leafId: leaf, label: "first prompt" });
	await Bun.write(path.join(cwd, "asset.bin"), "first result");
	leaf = "before-second";
	await history.beginTurn({ leafId: leaf, label: "second prompt" });
	await history.declare([".created"]);
	await Bun.write(path.join(cwd, ".created"), "second result");
	leaf = "after-second";
	const points = await history.points();
	await history.change([points[1]!], leaf, navigate, async () => true);
	expect(leaf).toBe("before-second");
	expect(await Bun.file(path.join(cwd, ".created")).exists()).toBe(false);
	await history.change([points[0]!], leaf, navigate, async () => true);
	expect(leaf).toBe("before-first");
	expect(await Bun.file(path.join(cwd, "asset.bin")).bytes()).toEqual(new Uint8Array([0, 255]));
	await history.change([], leaf, navigate, async () => true);
	expect(leaf).toBe("before-second");
	expect(await Bun.file(path.join(cwd, "asset.bin")).text()).toBe("first result");
	await history.change([], leaf, navigate, async () => true);
	expect(leaf).toBe("after-second");
	expect(await Bun.file(path.join(cwd, ".created")).text()).toBe("second result");
	await expect(history.change([], leaf, navigate, async () => true)).rejects.toThrow("Nothing to redo");
	// A single jump must include the newly declared path from the later checkpoint.
	await history.change([...points].reverse(), leaf, navigate, async () => true);
	expect(await Bun.file(path.join(cwd, ".created")).exists()).toBe(false);
	expect(leaf).toBe("before-first");
});

test("cancel and failed conversation navigation preserve both original states", async () => {
	const { cwd, history } = await fixture();
	await history.command("on");
	await Bun.write(path.join(cwd, "a"), "before");
	await history.beginTurn({ leafId: "old", label: "edit" });
	await Bun.write(path.join(cwd, "a"), "after");
	const points = await history.points();
	let leaf: string | null = "current";
	expect(
		await history.change(
			points,
			leaf,
			async next => {
				leaf = next;
			},
			async () => false,
		),
	).toBe(false);
	expect(await Bun.file(path.join(cwd, "a")).text()).toBe("after");
	await expect(
		history.change(
			points,
			leaf,
			async next => {
				if (next === "old") throw new Error("host navigation failed");
				leaf = next;
			},
			async () => true,
		),
	).rejects.toThrow("host navigation failed");
	expect(leaf).toBe("current");
	expect(await Bun.file(path.join(cwd, "a")).text()).toBe("after");
	await history.beginTurn({ leafId: leaf, label: "continue after recovered failure" });
});
