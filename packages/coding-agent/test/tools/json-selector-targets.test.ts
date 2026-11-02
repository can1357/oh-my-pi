import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import type { ToolSession } from "../../src/sdk";
import { ReadTool } from "../../src/tools/read";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("JSON selector target admission", () => {
	let dir: string;
	let tool: ReadTool;

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-target-"));
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		tool = new ReadTool(session);
	});

	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("queries JSON backups and extensionless files instead of asking an image question", async () => {
		for (const name of ["config.json.bak", "config.json.bak-20261023T173116Z", "config"]) {
			const file = path.join(dir, name);
			await Bun.write(file, '{"projects":{"demo":{"ok":true}}}');
			expect(textOf(await tool.execute(name, { path: `${file}?q=.projects.demo.ok` }))).toBe("true");
		}
	});

	it("reports invalid backup JSON as a JSON parse error", async () => {
		const file = path.join(dir, "invalid.json.bak");
		await Bun.write(file, "not JSON");
		await expect(tool.execute("invalid-backup", { path: `${file}?q=.` })).rejects.toThrow(
			/Failed to execute JSON query:.*failed to parse/i,
		);
	});

	it("preserves percent arithmetic, literal plus signs, and escaped ampersands in filters", async () => {
		const file = path.join(dir, "arithmetic.backup");
		await Bun.write(file, '{"n":7}');
		expect(textOf(await tool.execute("modulo", { path: `${file}?q=.n % 3 + 1` }))).toBe("2");
		expect(textOf(await tool.execute("ampersand", { path: `${file}?query="a%26b"&raw=true` }))).toBe("a&b");
	});

	it.skipIf(process.platform === "win32")("prefers literal question-mark filenames to selector recovery", async () => {
		const file = path.join(dir, "literal.json");
		await Bun.write(file, '{"ok":false}');
		await Bun.write(`${file}?q=.ok`, "literal question-mark file\n");
		expect(textOf(await tool.execute("literal-json-question", { path: `${file}?q=.ok` }))).toContain(
			"literal question-mark file",
		);
		const backup = path.join(dir, "literal.bak");
		await Bun.write(backup, '{"ok":false}');
		await Bun.write(`${backup}?q=.ok`, "literal backup question-mark file\n");
		expect(textOf(await tool.execute("literal-backup-question", { path: `${backup}?q=.ok` }))).toContain(
			"literal backup question-mark file",
		);
	});

	it("queries a local URL backup while preserving its internal source identity", async () => {
		const options = { getArtifactsDir: () => dir, getSessionId: () => "backup-query" };
		await Bun.write(resolveLocalUrlToPath("local://config.json.bak", options), '{"ok":true}');
		const locatedTool = new ReadTool({
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			localProtocolOptions: options,
		});
		const uri = "local://config.json.bak?q=.ok";
		const result = await locatedTool.execute("local-backup", { path: uri });
		expect(textOf(result)).toBe("true");
		expect(result.details?.meta?.source).toEqual({ type: "internal", value: uri });

		if (process.platform !== "win32") {
			const literalUri = "local://literal.json%3Fq=.ok";
			await Bun.write(resolveLocalUrlToPath("local://literal.json", options), '{"ok":false}');
			await Bun.write(resolveLocalUrlToPath(literalUri, options), "literal local question-mark file\n");
			expect(textOf(await locatedTool.execute("local-literal-question", { path: literalUri }))).toContain(
				"literal local question-mark file",
			);
		}
	});
});
