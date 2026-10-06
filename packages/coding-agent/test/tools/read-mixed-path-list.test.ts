import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Database } from "bun:sqlite";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let cwd: string;
let session: ToolSession;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-mixed-list-"));
	await Bun.write(path.join(cwd, "Makefile"), "build:\n\techo make\n");
	await Bun.write(path.join(cwd, "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(cwd, "a;b.md"), "literal semicolon file\n");
	await Bun.write(path.join(cwd, "a"), "plain a\n");
	await Bun.write(path.join(cwd, "b.md"), "plain b\n");
	const db = new Database(path.join(cwd, "data.sqlite"));
	db.run("CREATE TABLE t (name TEXT)");
	db.run("INSERT INTO t VALUES ('row-one')");
	db.close();
	session = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		enableLsp: false,
	};
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

async function readText(target: string): Promise<string> {
	const result = await new ReadTool(session).execute("r", { path: target });
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

describe("read with a `;` list mixing URLs and local paths", () => {
	it("reads an extensionless file with a selector as a local path, not an MCP resource", async () => {
		const text = await readText("Makefile:1-1;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("build:");
		expect(text).toContain("export const a = 1;");
	});

	it("splits an internal URL followed by a local path", async () => {
		const text = await readText("omp://;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("export const a = 1;");
		expect(text).not.toContain("Documentation file not found");
	});

	it("splits a URL followed by an existing local path", async () => {
		const text = await readText("https://127.0.0.1:9/x;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("export const a = 1;");
	});

	it("keeps a URL that contains `;` whole", async () => {
		const text = await readText("https://127.0.0.1:9/x;v=1").catch((error: Error) => error.message);
		expect(text).not.toContain("interpreted as");
	});

	it("keeps a sqlite query ending in `;` whole", async () => {
		const text = await readText("data.sqlite?q=SELECT * FROM t;");
		expect(text).not.toContain("interpreted as");
		expect(text).toContain("row-one");
	});

	it("keeps an image question containing `; …?` whole", async () => {
		const text = await readText("missing.png?q=is it a cat; or a dog?").catch((error: Error) => error.message);
		expect(text).not.toContain("interpreted as");
	});

	it("reads `a;b.md:1-1` as the literal file even when `a` and `b.md` exist", async () => {
		const text = await readText("a;b.md:1-1");
		expect(text).not.toContain("interpreted as");
		expect(text).toContain("literal semicolon file");
	});
});
