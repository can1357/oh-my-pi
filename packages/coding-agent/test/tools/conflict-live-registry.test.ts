import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { reconcileRegisteredConflicts } from "@oh-my-pi/pi-coding-agent/tools/conflict-detect";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CONFLICT = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("registered conflicts follow live marker blocks", () => {
	let cwd: string;
	let session: ToolSession;
	let read: ReadTool;
	let write: WriteTool;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-live-registry-"));
		session = {
			cwd,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};
		read = new ReadTool(session);
		write = new WriteTool(session);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("does not count or serve ids whose markers vanished outside the tool (aborted merge)", async () => {
		for (const name of ["a.ts", "b.ts", "c.ts"]) await Bun.write(path.join(cwd, name), CONFLICT);
		await read.execute("register", { path: "a.ts:conflicts;b.ts:conflicts;c.ts:conflicts" });
		await Bun.write(path.join(cwd, "a.ts"), "ours\n");

		const result = await write.execute("subset", { path: "conflict://*", content: "2: @theirs" });

		expect(text(result)).toContain("Resolved 1 conflict across 1 file");
		expect(text(result)).toContain("1 unlisted conflict still registered (#3)");
		await expect(read.execute("old", { path: "conflict://1" })).rejects.toThrow("not found");
		expect(await Bun.file(path.join(cwd, "b.ts")).text()).toBe("theirs\n");
	});

	it("retires an id whose block changed in place instead of rebinding it", async () => {
		const file = path.join(cwd, "changed.ts");
		await Bun.write(file, CONFLICT);
		await read.execute("register", { path: "changed.ts:conflicts" });
		const changed = CONFLICT.replace("ours\n", "new-ours\n");
		await Bun.write(file, changed);

		await expect(write.execute("stale", { path: "conflict://1", content: "@ours" })).rejects.toThrow("not found");
		expect(await Bun.file(file).text()).toBe(changed);
		await read.execute("reregister", { path: "changed.ts:conflicts" });
		expect(session.conflictHistory?.entries().map(entry => [entry.id, entry.oursLines])).toEqual([[2, ["new-ours"]]]);
	});

	it("keeps an unchanged block's id when lines above it shift", async () => {
		const file = path.join(cwd, "shift.ts");
		await Bun.write(file, CONFLICT);
		await read.execute("register", { path: "shift.ts:conflicts" });
		await Bun.write(file, `new header\n${CONFLICT}`);

		await write.execute("resolve", { path: "conflict://1", content: "@theirs" });

		expect(await Bun.file(file).text()).toBe("new header\ntheirs\n");
	});

	it("retires every id of a deleted file", async () => {
		const file = path.join(cwd, "deleted.ts");
		await Bun.write(file, CONFLICT);
		await read.execute("register", { path: "deleted.ts:conflicts" });
		await fs.unlink(file);

		await expect(write.execute("bulk", { path: "conflict://*", content: "@ours" })).rejects.toThrow(
			/nothing to resolve/,
		);
		expect(session.conflictHistory?.entries()).toEqual([]);
	});

	it("keeps and resolves a block registered past a capped :conflicts scan", async () => {
		const filler = `${"x".repeat(1023)}\n`.repeat(10_240);
		const file = path.join(cwd, "capped.ts");
		await Bun.write(file, `${filler}${CONFLICT}`);
		await read.execute("register-tail", { path: "capped.ts:10241-" });
		await read.execute("capped-summary", { path: "capped.ts:conflicts" });

		await write.execute("resolve-tail", { path: "conflict://1", content: "@ours" });

		expect(await Bun.file(file).text()).toBe(`${filler}ours\n`);
	});

	it("recognizes a BOM-prefixed CRLF diff3 block spanning stream chunks without a final newline", async () => {
		const file = path.join(cwd, "framing.ts");
		const lines = ["<<<<<<< HEAD", "x".repeat(64 * 1024 + 13), "||||||| ancestor", "base", "=======", "theirs"];
		await Bun.write(file, `\uFEFF${[...lines, ">>>>>>> topic"].join("\r\n")}`);
		await read.execute("register", { path: "framing.ts:conflicts" });
		await Bun.write(file, `\uFEFFshifted\r\n${[...lines, ">>>>>>> topic"].join("\r\n")}`);

		const history = session.conflictHistory!;
		await reconcileRegisteredConflicts(history);

		expect(history.entries().map(entry => [entry.id, entry.startLine, entry.endLine])).toEqual([[1, 2, 8]]);
	});
});
