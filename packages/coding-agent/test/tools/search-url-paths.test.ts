import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => "*",
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({
			"fetch.enabled": true,
			"grep.contextBefore": 0,
			"grep.contextAfter": 0,
			"astGrep.enabled": true,
			"astEdit.enabled": true,
			"tools.xdev": false,
		}),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function stubLoadPage(body: string, contentType: string) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType,
		content: body,
	}));
}

describe("search tools with external URL paths", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-url-paths-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("search fetches a URL and greps the rendered text", async () => {
		stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url", {
			pattern: "remote needle",
			path: "https://example.com/notes.txt",
		});

		const text = resultText(result);
		expect(text).toContain("remote needle");
		expect(text).not.toContain("Cannot search external URL");
	});

	it("refetches the same URL before each search", async () => {
		let body = "first needle\n";
		const loadPage = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
		}));
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const first = await tool!.execute("search-url-first", {
			pattern: "first|second",
			path: "https://example.com/live.txt",
		});
		body = "second needle\n";
		const second = await tool!.execute("search-url-second", {
			pattern: "first|second",
			path: "https://example.com/live.txt",
		});

		expect(resultText(first)).toContain("first needle");
		expect(resultText(second)).toContain("second needle");
		expect(resultText(second)).not.toContain("first needle");
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it("search applies URL line-range selectors after materialization", async () => {
		stubLoadPage("outside before\nremote needle\noutside after\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-range", {
			pattern: "outside|remote needle",
			path: "https://example.com/notes.txt:2-2",
		});

		const text = resultText(result);
		expect(text).toContain("remote needle");
		expect(text).not.toContain("outside before");
		expect(text).not.toContain("outside after");
	});

	it("search accepts a :raw URL selector and fetches the page", async () => {
		// The raw flag only means "skip the markdown conversion", which is
		// meaningful for a remote response and not for a local file. A JSON body
		// is used because the rendered and raw forms differ in whitespace alone,
		// so a `text/plain` body would pass whether or not `:raw` reached the
		// fetch — and this case would then prove nothing.
		const loadPage = stubLoadPage('{"marker":"RAWMARKER"}', "application/json");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-raw", {
			pattern: '"marker":"RAWMARKER"',
			path: "https://example.com/notes.json:raw",
		});

		expect(resultText(result)).toContain("RAWMARKER");
		// The rendered form carries a space the raw bytes do not, so its absence
		// is what pins the fetch to raw mode.
		expect(resultText(result)).not.toContain('"marker": "RAWMARKER"');
		expect(loadPage).toHaveBeenCalled();
	});

	it("search applies a :raw URL selector together with a line range", async () => {
		// Pins both halves at once: the needle sits on line 2 so the range admits
		// it and excludes its neighbours, and it is written in the raw spelling so
		// the match also proves `:raw` reached the fetch.
		stubLoadPage('{\n"marker":"RAWMARKER"\n}\n', "application/json");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-raw-range", {
			pattern: '"marker":"RAWMARKER"|\\{|\\}',
			path: "https://example.com/notes.json:2-2:raw",
		});

		const text = resultText(result);
		expect(text).toContain("RAWMARKER");
		// Lines 1 and 3 are outside `:2-2`.
		expect(text).not.toContain('"marker": "RAWMARKER"');
	});

	it("search still rejects :raw on a local path", async () => {
		// The counterpart to the URL case, and the reason the fix is not a blanket
		// relaxation: a local file is already verbatim, so the selector is a
		// typo there, not a request.
		await fs.writeFile(path.join(testDir, "notes.txt"), "alpha\nbeta\n", "utf-8");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		await expect(tool!.execute("search-local-raw", { pattern: "alpha", path: "notes.txt:raw" })).rejects.toThrow(
			"only line-range selectors",
		);
	});

	it("ast_edit rejects external URLs instead of staging read-cache files", async () => {
		stubLoadPage("legacyWrap(x, value)\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();

		await expect(
			tool!.execute("ast-edit-url", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["https://example.com/snippet.ts"],
			}),
		).rejects.toThrow("Cannot rewrite external URL");
	});

	it("ast_grep materializes URL content with the source extension", async () => {
		stubLoadPage("export function remoteNeedle() {\n\treturn 1;\n}\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("ast-grep-url", {
			pat: "remoteNeedle",
			path: "https://example.com/snippet.ts",
		});

		const text = resultText(result);
		expect(text).toContain("remoteNeedle");
		expect(text).not.toContain("Parse issues");
	});

	it("search materializes a scheme-less www. scope like its canonical spelling", async () => {
		const loadPage = stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-www", {
			pattern: "remote needle",
			path: "www.example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(loadPage).toHaveBeenCalledWith("https://www.example.com/notes.txt", expect.anything());
	});

	it("search repairs a collapsed https:/ scheme before materializing", async () => {
		const loadPage = stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-collapsed", {
			pattern: "remote needle",
			path: "https:/example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(loadPage).toHaveBeenCalledWith("https://example.com/notes.txt", expect.anything());
	});

	it("search prefers an existing local directory named like a www. host", async () => {
		const loadPage = stubLoadPage("remote body\n", "text/plain");
		await fs.mkdir(path.join(testDir, "www.example.com"), { recursive: true });
		await fs.writeFile(path.join(testDir, "www.example.com", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-dir", {
			pattern: "local needle",
			path: "www.example.com",
		});

		expect(resultText(result)).toContain("local needle");
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("search leaves plain relative paths untouched by URL materialization", async () => {
		const loadPage = stubLoadPage("remote body\n", "text/plain");
		await fs.mkdir(path.join(testDir, "src"), { recursive: true });
		await fs.writeFile(path.join(testDir, "src", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-rel", {
			pattern: "local needle",
			path: "src/notes.txt",
		});

		expect(resultText(result)).toContain("local needle");
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("search rejects unsupported URL schemes explicitly", async () => {
		stubLoadPage("remote body\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		await expect(
			tool!.execute("search-url-ftp", {
				pattern: "needle",
				path: "ftp://example.com/notes.txt",
			}),
		).rejects.toThrow("Cannot search external URL");
	});
});
