import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
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

	it("surfaces cancellation while a recovered child read is still pending", async () => {
		const tool = new ReadTool(session);
		const controller = new AbortController();
		const childStarted = Promise.withResolvers<void>();
		const childPending = Promise.withResolvers<never>();
		const execute = tool.execute.bind(tool);
		const spy = spyOn(tool, "execute").mockImplementation(async (id, params, signal, update, toolContext) => {
			if (id === "read-delimited-part" && params.path === "Makefile:1-1") {
				childStarted.resolve();
				const onAbort = () => {
					childPending.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				return childPending.promise;
			}
			return execute(id, params, signal, update, toolContext);
		});
		try {
			const reading = tool.execute("cancel-list-read", { path: "Makefile:1-1;a.ts:1-1" }, controller.signal);
			await childStarted.promise;
			controller.abort();
			await expect(reading).rejects.toMatchObject({ name: "AbortError" });
		} finally {
			spy.mockRestore();
			childPending.resolve(undefined as never);
		}
	});

	it("keeps raw image routing for an image inside a recovered list", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
		await Bun.write(path.join(cwd, "pixel.png"), png);
		const context = { rawImages: true } as AgentToolContext;
		const result = await new ReadTool(session).execute(
			"raw-image-list",
			{ path: "pixel.png:raw;a.ts:1-1" },
			undefined,
			undefined,
			context,
		);
		expect(result.content.some(block => block.type === "image")).toBe(true);
		expect(result.content.some(block => block.type === "text" && block.text.includes("export const a = 1;"))).toBe(
			true,
		);
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
