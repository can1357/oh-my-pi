import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeJournal, type ChangeRecord } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FILE = "/repo/src/a.ts";
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function artifactsDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-journal-"));
	tempDirs.push(dir);
	return dir;
}

function record(journal: ChangeJournal, before: string | null, after: string | null): void {
	journal.recordChange({ agent: "Main", tool: "edit", path: FILE, before, after });
}

/** What `journal` replays for {@link FILE}, as `[before, after]` per write. */
async function replay(journal: ChangeJournal): Promise<Array<[string | null, string | null]> | undefined> {
	const records = (await journal.read()).filter((entry): entry is ChangeRecord => entry.type === "change");
	return (await journal.snapshots(records))?.map(write => [write.before, write.after]);
}

async function bytesUnder(dir: string): Promise<number> {
	let total = 0;
	for (const entry of await fs.readdir(dir, { recursive: true })) {
		const stat = await fs.stat(path.join(dir, entry));
		if (stat.isFile()) total += stat.size;
	}
	return total;
}

describe("change journal", () => {
	it("replays every write with the content around it, through changes nobody recorded", async () => {
		const journal = new ChangeJournal(await artifactsDir());
		const old = `${Array.from({ length: 3000 }, (_, line) => `old ${line}`).join("\n")}\n`;
		const rewritten = `${Array.from({ length: 3000 }, (_, line) => `new ${line}`).join("\n")}\n`;
		const writes: Array<[string | null, string | null]> = [
			[null, "a\nb\nc\n"],
			["a\nb\nc\n", "a\nB\nc\n"],
			// Someone appended a line without a final newline before this write.
			["a\nB\nc\nextra", "a\nB\nextra"],
			// More lines change than a write is diffed for.
			[old, rewritten],
			[rewritten, rewritten.replace("new 1500\n", "new 1500 edited\n").replace("new 7\n", "")],
			["\uFEFFx\r\ny\r\n", "\uFEFFx\r\nz\r\n"],
			["\uFEFFx\r\nz\r\n", null],
			[null, ""],
		];
		for (const [before, after] of writes) record(journal, before, after);

		expect(await replay(journal)).toEqual(writes);
	});

	it("stores a later write as its changes, not as another copy of the file", async () => {
		const dir = await artifactsDir();
		const journal = new ChangeJournal(dir);
		let seed = 1;
		const lines = Array.from({ length: 4000 }, () => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return `${seed.toString(36)} ${Bun.hash(String(seed)).toString(36)} ${seed.toString(16)}`;
		});
		const versions = [`${lines.join("\n")}\n`];
		for (let edit = 0; edit < 30; edit++) {
			lines[edit * 100] = `edited ${edit}`;
			versions.push(`${lines.join("\n")}\n`);
			record(journal, versions[edit], versions[edit + 1]);
		}

		expect((await replay(journal))?.at(-1)).toEqual([versions[29], versions[30]]);
		// Thirty more copies of the file would take thirty times its compressed size.
		expect(await bytesUnder(dir)).toBeLessThan(versions[0].length);
	});

	it("continues a path after a restart and drops history written against content it cannot see", async () => {
		const dir = await artifactsDir();
		const first = new ChangeJournal(dir);
		record(first, null, "one\n");
		await first.flush();
		// A new process knows nothing of the file's last recorded content; the user changed it meanwhile.
		const second = new ChangeJournal(dir);
		record(second, "one\nuser\n", "one\nuser\ntwo\n");
		expect(await replay(second)).toEqual([
			[null, "one\n"],
			["one\nuser\n", "one\nuser\ntwo\n"],
		]);

		// The first process still diffs against "one\n", which is no longer what the journal ends with.
		record(first, "one\nuser\ntwo\n", "one\nuser\ntwo\nthree\n");
		record(first, "one\nuser\ntwo\nthree\n", "one\nuser\ntwo\nthree\nfour\n");
		await first.flush();
		expect(await replay(second)).toBeUndefined();

		const third = new ChangeJournal(dir);
		record(third, "one\nuser\ntwo\nthree\nfour\n", "five\n");
		expect(await replay(third)).toEqual([["one\nuser\ntwo\nthree\nfour\n", "five\n"]]);
	});
});
