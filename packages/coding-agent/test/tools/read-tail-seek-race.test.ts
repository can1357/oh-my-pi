import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool, SNAPSHOT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/tools/read";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

describe("read :-N tail on a file edited between the count and the window read", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-tail-race-"));
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("returns the file's current last lines", async () => {
		const filePath = path.join(testDir, "big.log");
		// Past the whole-file snapshot size, so the tail is located by a separate scan.
		const lineCount = Math.ceil(SNAPSHOT_MAX_BYTES / 16) + 1_000;
		const lines = Array.from({ length: lineCount }, (_, index) => `line-${String(index).padStart(12, "0")}`);
		await Bun.write(filePath, `${lines.join("\n")}\n`);
		const session: ToolSession = {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tool = new ReadTool(session);

		// The tail scan reads the whole file through one handle, then closes it before the
		// window read reopens the file: edit the file at that close.
		const probe = await fs.open(filePath, "r");
		const handleProto: {
			read(...args: unknown[]): Promise<{ bytesRead: number }>;
			close(): Promise<void>;
		} = Object.getPrototypeOf(probe);
		await probe.close();
		const fileSize = (await fs.stat(filePath)).size;
		const bytesReadBy = new WeakMap<object, number>();
		const realRead = handleProto.read;
		const realClose = handleProto.close;
		spyOn(handleProto, "read").mockImplementation(async function (this: object, ...args: unknown[]) {
			const result = await realRead.apply(this, args);
			bytesReadBy.set(this, (bytesReadBy.get(this) ?? 0) + result.bytesRead);
			return result;
		});
		let edited = false;
		spyOn(handleProto, "close").mockImplementation(async function (this: object) {
			await realClose.call(this);
			if (edited || (bytesReadBy.get(this) ?? 0) < fileSize) return;
			edited = true;
			// An earlier line grows: same line count, shifted offsets.
			lines[0] = `${lines[0]}-rewritten-earlier-line`;
			await Bun.write(filePath, `${lines.join("\n")}\n`);
		});

		const output = textOf(await tool.execute("tail", { path: `${filePath}:-2` }));
		expect(edited).toBe(true);
		// The selected tail plus one leading context line, each whole.
		expect(output.split("\n").map(row => row.slice(row.indexOf(":") + 1))).toEqual(lines.slice(-3));
	});
});
