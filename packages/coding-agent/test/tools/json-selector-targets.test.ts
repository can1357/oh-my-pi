import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";
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
			/Failed to execute JSON query: jq: parse error:/,
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

	for (const format of ["tar", "zip"] as const) {
		describe(`${format} member queries`, () => {
			let archivePath: string;

			beforeAll(async () => {
				archivePath = path.join(dir, `targets.${format}`);
				await writeArchive(archivePath, format, [
					["nested/receipt.json", JSON.stringify({ x: 7, label: "paper receipt", items: [1, 2, 3] }, null, 2)],
					["lines.txt", "one\ntwo\nthree\nfour"],
					["literal.json", '{"x":-1}'],
					["literal.json?q=.x", "literal member\nsecond line\nthird line"],
					["invalid.json", "not JSON"],
					["binary.bin", new Uint8Array([0, 255, 1, 2])],
					["sample.pdf", "%PDF-1.4\n"],
				]);
			});

			it("applies raw and compact query options instead of looking them up as member names", async () => {
				const raw = await tool.execute("archive-json-raw", {
					path: `${archivePath}:nested/receipt.json?q=.label&raw=true`,
				});
				expect(textOf(raw)).toBe("paper receipt");
				const compact = await tool.execute("archive-json-compact", {
					path: `${archivePath}:nested/receipt.json?q=.items[0:2] | map({x:.})&compact=true`,
				});
				expect(textOf(compact)).toBe('[{"x":1},{"x":2}]');
				const modifierOnly = await tool.execute("archive-json-default-filter", {
					path: `${archivePath}:nested/receipt.json?compact=true`,
				});
				expect(textOf(modifierOnly)).toBe('{"x":7,"label":"paper receipt","items":[1,2,3]}');
			});

			it("pages array and stream query results with followable continuation options", async () => {
				const arrayPage = textOf(
					await tool.execute("archive-json-array-page", {
						path: `${archivePath}:nested/receipt.json?q=.items&compact=true&limit=1&offset=1`,
					}),
				);
				expect(arrayPage).toStartWith("[2]\n");
				expect(arrayPage).toContain("append ?q=.items&compact=true&limit=1&offset=2");
				const streamPage = textOf(
					await tool.execute("archive-json-stream-page", {
						path: `${archivePath}:nested/receipt.json?q=.items[]&limit=1&offset=1`,
					}),
				);
				expect(streamPage).toStartWith("2\n");
				expect(streamPage).toContain("append ?q=.items[]&limit=1&offset=2");
			});

			it("keeps member line ranges and applies query line selectors to the query output", async () => {
				const memberLines = await tool.execute("archive-member-lines", {
					path: `${archivePath}:lines.txt:2-3:raw`,
				});
				expect(textOf(memberLines)).toBe("two\nthree");
				const queryLine = await tool.execute("archive-query-line", {
					path: `${archivePath}:nested/receipt.json?q=.items[]:raw:2`,
				});
				expect(textOf(queryLine)).toBe("2");
			});

			it("prefers a literal question-mark member over its query-shaped suffix", async () => {
				const literal = await tool.execute("archive-literal-query", {
					path: `${archivePath}:literal.json?q=.x`,
				});
				expect(textOf(literal)).toContain("literal member");
				const literalLine = await tool.execute("archive-literal-query-line", {
					path: `${archivePath}:literal.json?q=.x:2:raw`,
				});
				expect(textOf(literalLine)).toBe("second line");
			});

			it("still reports a genuinely missing queried member as missing", async () => {
				await expect(
					tool.execute("archive-missing-json", { path: `${archivePath}:missing.json?q=.x` }),
				).rejects.toThrow(/missing\.json.*not found inside archive/);
			});

			it("reports unsupported query targets by type rather than as missing members", async () => {
				for (const member of ["nested", "binary.bin", "sample.pdf"]) {
					await expect(
						tool.execute("archive-query-type", { path: `${archivePath}:${member}?q=.` }),
					).rejects.toThrow("JSON selectors require a text archive member");
				}
				const binary = await tool.execute("archive-binary", { path: `${archivePath}:binary.bin` });
				expect(textOf(binary)).toContain("Cannot read binary archive entry 'binary.bin'");
			});

			it("reports malformed JSON in an existing member as a query parse error", async () => {
				await expect(
					tool.execute("archive-invalid-json", { path: `${archivePath}:invalid.json?q=.` }),
				).rejects.toThrow(/Failed to execute JSON query: jq: parse error:/);
			});
		});
	}

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
