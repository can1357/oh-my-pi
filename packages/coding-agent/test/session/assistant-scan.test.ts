import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSessions } from "../../src/session/session-listing";
import { FileSessionStorage } from "../../src/session/session-storage";

function readBytes(): number {
	return Number(fs.readFileSync("/proc/self/io", "utf8").match(/^rchar: (\d+)/m)![1]);
}

it.skipIf(process.platform !== "linux")(
	"listing an appended journal reads only new records and observes replacement",
	async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-scan-"));
		const file = path.join(dir, "session.jsonl");
		const user = `${JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(8192) } })}\r\n`;
		try {
			await Bun.write(file, user.repeat(1024));
			expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(false);
			fs.appendFileSync(file, user);
			const before = readBytes();
			expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(false);
			expect(readBytes() - before).toBeLessThan(256 * 1024);
			fs.appendFileSync(file, '{"type":"message","message":{"role":"assis');
			expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(false);
			fs.appendFileSync(file, 'tant","content":[]}}\n');
			expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(true);
			fs.appendFileSync(file, user);
			const positiveBefore = readBytes();
			expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(true);
			expect(readBytes() - positiveBefore).toBeLessThan(256 * 1024);
			const seen: string[] = [];
			await new FileSessionStorage().scanLines(file, line => {
				seen.push(line);
				return seen.length === 2;
			});
			expect(seen).toEqual([user.trimEnd(), user.trimEnd()]);
			await Bun.write(path.join(dir, "replacement"), user);
			fs.renameSync(path.join(dir, "replacement"), file);
			expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(false);
			await Bun.write(file, "{}\n");
			expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	},
);

it("session listing uses the append cursor and preserves fallback for missing prompts", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-listing-"));
	const storage = new FileSessionStorage();
	const fast = spyOn(storage, "scanAssistantTurn");
	const generic = spyOn(storage, "scanLines");
	const line = (value: unknown) => JSON.stringify(value) + "\n";
	const header = line({ type: "session", id: "one", cwd: "/repo", timestamp: "2026-06-27T00:00:00.000Z" });
	const prompt = line({ type: "message", message: { role: "user", content: "hello" } });
	const filler = line({ type: "custom", data: "x".repeat(8192) });
	const reply = line({ type: "message", message: { role: "assistant", content: "done" } });
	try {
		const file = path.join(dir, "one.jsonl");
		await Bun.write(file, header + prompt + filler);
		expect((await listSessions(dir, storage))[0]?.assistantTurns).toBe(0);
		expect(fast).toHaveBeenCalledTimes(1);
		fs.appendFileSync(file, reply + filler.repeat(5));
		expect((await listSessions(dir, storage))[0]?.assistantTurns).toBe(1);
		expect(fast).toHaveBeenCalledTimes(2);
		await Bun.write(path.join(dir, "two.jsonl"), header.replace('"one"', '"two"') + filler + prompt);
		const items = await listSessions(dir, storage);
		expect(items.find(x => x.id === "two")?.firstMessage).toBe("hello");
		expect(generic).toHaveBeenCalled();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

it.skipIf(process.platform !== "linux")("re-listing a grown journal does not re-read its old history", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-listing-bytes-"));
	const line = (value: unknown) => `${JSON.stringify(value)}\n`;
	const header = line({ type: "session", id: "big", cwd: "/repo", timestamp: "2026-06-27T00:00:00.000Z" });
	const prompt = line({ type: "message", message: { role: "user", content: "hello" } });
	const filler = line({ type: "custom", data: "x".repeat(8192) });
	try {
		const file = path.join(dir, "big.jsonl");
		await Bun.write(file, header + prompt + filler.repeat(2048));
		expect((await listSessions(dir, new FileSessionStorage()))[0]?.assistantTurns).toBe(0);
		fs.appendFileSync(file, filler);
		const before = readBytes();
		expect((await listSessions(dir, new FileSessionStorage()))[0]?.assistantTurns).toBe(0);
		// The journal is ~16 MiB; only the appended record and the bounded windows may be read.
		expect(readBytes() - before).toBeLessThan(1024 * 1024);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

it("a growing in-place rewrite is not mistaken for an append", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-rewrite-"));
	const file = path.join(dir, "session.jsonl");
	const line = (value: unknown) => `${JSON.stringify(value)}\n`;
	const filler = line({ type: "custom", data: "x".repeat(300) });
	const reply = line({ type: "message", message: { role: "assistant", content: "done" } });
	try {
		await Bun.write(file, filler.repeat(40));
		expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(false);
		// Same inode, larger, with a reply inserted before the previously scanned offset.
		const handle = fs.openSync(file, "r+");
		fs.writeSync(handle, filler.repeat(3) + reply + filler.repeat(40));
		fs.closeSync(handle);
		expect(await new FileSessionStorage().scanAssistantTurn(file)).toBe(true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
