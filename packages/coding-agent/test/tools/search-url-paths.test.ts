import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { mockFetch } from "../helpers/fetch-mock";

function createSession(testDir: string, request: Parameters<typeof mockFetch>[0]): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		fetch: mockFetch(request),
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => "*",
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.log`) };
		},
		settings: Settings.isolated({
			"fetch.enabled": true,
			"grep.contextBefore": 0,
			"grep.contextAfter": 0,
			"astGrep.enabled": true,
			"astEdit.enabled": true,
			"tools.commands": false,
		}),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function stubTextResponse(url: string, body: string | (() => string)) {
	return vi.fn<Parameters<typeof mockFetch>[0]>(input =>
		input === url
			? new Response(typeof body === "function" ? body() : body, { headers: { "content-type": "text/plain" } })
			: new Response(null, { status: 404 }),
	);
}

describe("search tools with external URL paths", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-url-paths-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("search fetches a URL and greps the rendered text", async () => {
		const request = stubTextResponse("https://example.com/notes.txt", "alpha\nremote needle\nomega\n");
		const tools = await createTools(createSession(testDir, request));
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
		const request = stubTextResponse("https://example.com/live.txt", () => body);
		const tools = await createTools(createSession(testDir, request));
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
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("search applies URL line-range selectors after materialization", async () => {
		const request = stubTextResponse(
			"https://example.com/notes.txt",
			"outside before\nremote needle\noutside after\n",
		);
		const tools = await createTools(createSession(testDir, request));
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

	it("ast_edit rejects external URLs instead of staging read-cache files", async () => {
		const request = stubTextResponse("https://example.com/snippet.ts", "legacyWrap(x, value)\n");
		const tools = await createTools(createSession(testDir, request));
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
		const request = stubTextResponse(
			"https://example.com/snippet.ts",
			"export function remoteNeedle() {\n\treturn 1;\n}\n",
		);
		const tools = await createTools(createSession(testDir, request));
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
		const request = stubTextResponse("https://www.example.com/notes.txt", "alpha\nremote needle\nomega\n");
		const tools = await createTools(createSession(testDir, request));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-www", {
			pattern: "remote needle",
			path: "www.example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(request).toHaveBeenCalledWith("https://www.example.com/notes.txt", expect.anything());
	});

	it("search repairs a collapsed https:/ scheme before materializing", async () => {
		const request = stubTextResponse("https://example.com/notes.txt", "alpha\nremote needle\nomega\n");
		const tools = await createTools(createSession(testDir, request));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-collapsed", {
			pattern: "remote needle",
			path: "https:/example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(request).toHaveBeenCalledWith("https://example.com/notes.txt", expect.anything());
	});

	it("search prefers an existing local directory named like a www. host", async () => {
		const request = stubTextResponse("https://www.example.com/", "remote body\n");
		await fs.mkdir(path.join(testDir, "www.example.com"), { recursive: true });
		await fs.writeFile(path.join(testDir, "www.example.com", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir, request));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-dir", {
			pattern: "local needle",
			path: "www.example.com",
		});

		expect(resultText(result)).toContain("local needle");
		expect(request).not.toHaveBeenCalled();
	});

	it("search leaves plain relative paths untouched by URL materialization", async () => {
		const request = stubTextResponse("https://src/notes.txt", "remote body\n");
		await fs.mkdir(path.join(testDir, "src"), { recursive: true });
		await fs.writeFile(path.join(testDir, "src", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir, request));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-rel", {
			pattern: "local needle",
			path: "src/notes.txt",
		});

		expect(resultText(result)).toContain("local needle");
		expect(request).not.toHaveBeenCalled();
	});

	it("search rejects unsupported URL schemes explicitly", async () => {
		const request = stubTextResponse("ftp://example.com/notes.txt", "remote body\n");
		const tools = await createTools(createSession(testDir, request));
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
