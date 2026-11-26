import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { HttpSession } from "@oh-my-pi/pi-coding-agent/web/http-session";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";
import { mockFetch } from "../helpers/fetch-mock";

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

function stubResponse(session: ToolSession, url: string, body: Uint8Array | string, contentType: string) {
	const request = vi.fn((input: string | URL | Request) =>
		String(input) === url
			? new Response(typeof body === "string" ? body : new Uint8Array(body), {
					headers: { "content-type": contentType },
				})
			: new Response(null, { status: 404 }),
	);
	session.fetch = mockFetch(request);
	return request;
}

function textOutput(result: { content: Array<TextContent | ImageContent> }): string {
	return result.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

async function createSqliteFixtureBytes(testDir: string): Promise<Uint8Array> {
	const dbPath = path.join(testDir, `url-fixture-${Snowflake.next()}.sqlite`);
	const db = new Database(dbPath);
	try {
		db.exec(`
			CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
			INSERT INTO notes (title) VALUES ('alpha'), ('beta');
		`);
	} finally {
		db.close();
	}
	return Bun.file(dbPath).bytes();
}

function createNotebookFixtureBytes(): Uint8Array {
	return Buffer.from(
		JSON.stringify({
			cells: [
				{ cell_type: "markdown", metadata: {}, source: ["# Remote notebook\n", "Rendered as editable cells"] },
				{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["answer = 42\n"] },
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5,
		}),
	);
}

function uniqueUrl(name: string, extension: string): string {
	return `https://example.com/${name}-${Snowflake.next()}${extension}`;
}

describe("read URL binary dispatch", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-binary-dispatch-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("lists a remote zip instead of dumping decoded bytes", async () => {
		const zipBytes = await encodeArchive("zip", [
			["root.txt", "root file\n"],
			["nested/data.txt", "nested file\n"],
		]);
		const url = uniqueUrl("archive", ".zip");
		const session = makeSession(testDir);
		stubResponse(session, url, zipBytes, "application/octet-stream");

		const tool = new ReadTool(session);
		const result = await tool.execute("read-url-zip", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("archive");
		expect(text).toContain("Method: archive");
		expect(text).toContain("root.txt");
		expect(text).toContain("nested/");
		expect(text).not.toContain("PK\u0003\u0004");
		expect(text).not.toContain("�");
	});

	it("reads a member of a remote zip named after the archive URL", async () => {
		const zipBytes = await encodeArchive("zip", [
			["root.txt", "root file\n"],
			["nested/data.txt", "nested line one\nnested line two\n"],
		]);
		const url = uniqueUrl("archive", ".zip");
		const fetchBinary = vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: zipBytes,
			contentType: "application/zip",
		});

		const tool = new ReadTool(makeSession(testDir));
		const member = textOutput(await tool.execute("read-url-zip-member", { path: `${url}:nested/data.txt` }));
		expect(member).toContain("nested line one");
		expect(fetchBinary.mock.calls[0]?.[0]).toBe(url);

		const listing = textOutput(await tool.execute("read-url-zip-dir", { path: `${url}:nested/` }));
		expect(listing).toContain("data.txt");
	});

	it("downloads a generic-MIME convertible document body only once", async () => {
		const url = uniqueUrl("report", ".pdf");
		const session = makeSession(testDir);
		const bytes = Buffer.from("%PDF-1.4 binary");
		const download = stubResponse(session, url, bytes, "application/octet-stream");
		const convert = vi
			.spyOn(scraperUtils, "convertWithMarkit")
			.mockResolvedValue({ content: "", ok: false, error: "offline" });

		const result = await new ReadTool(session).execute("read-url-generic-pdf", { path: url });

		expect(download).toHaveBeenCalledTimes(1);
		expect(convert).toHaveBeenCalledTimes(1);
		const [body, extension] = convert.mock.calls[0]!;
		expect(Buffer.from(body)).toEqual(bytes);
		expect(extension).toBe(".pdf");
		expect(textOutput(result)).toContain("markit conversion failed: offline");
	});

	it("returns a metadata notice rather than parsing a truncated archive", async () => {
		const url = uniqueUrl("oversized", ".zip");
		const session = makeSession(testDir);
		stubResponse(session, url, "", "application/octet-stream");
		vi.spyOn(HttpSession.prototype, "request").mockResolvedValue({
			status: 200,
			url,
			headers: [{ name: "content-type", value: "application/octet-stream" }],
			body: Buffer.from("PK\u0003\u0004\u0000\u0001"),
			truncated: true,
		});

		const result = await new ReadTool(session).execute("read-url-zip-too-large", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("binary");
		expect(text).toContain("was cut mid-stream; content is incomplete");
		expect(text).toContain("[Binary content: application/octet-stream");
		expect(text).not.toContain("PK\u0003\u0004");
	});

	it("renders a remote sqlite database through the sqlite reader", async () => {
		const sqliteBytes = await createSqliteFixtureBytes(testDir);
		const url = uniqueUrl("data", ".db");
		const session = makeSession(testDir);
		stubResponse(session, url, sqliteBytes, "application/octet-stream");

		const tool = new ReadTool(session);
		const result = await tool.execute("read-url-sqlite", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("sqlite");
		expect(text).toContain("Method: sqlite");
		expect(text).toContain("notes (2 rows)");
	});

	it("renders a remote notebook as editable cells", async () => {
		const notebookBytes = createNotebookFixtureBytes();
		const url = uniqueUrl("notebook", ".ipynb");
		const session = makeSession(testDir);
		stubResponse(session, url, notebookBytes, "application/octet-stream");

		const tool = new ReadTool(session);
		const result = await tool.execute("read-url-notebook", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("notebook");
		expect(text).toContain("Method: notebook");
		expect(text).toContain("# %% [markdown] cell:0");
		expect(text).toContain("# %% [code] cell:1");
		expect(text).toContain("answer = 42");
	});

	it("returns a metadata notice for unrenderable binary bytes", async () => {
		const binaryBytes = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 0, 7, 8]);
		const url = uniqueUrl("payload", ".bin");
		const session = makeSession(testDir);
		stubResponse(session, url, binaryBytes, "application/octet-stream");

		const tool = new ReadTool(session);
		const result = await tool.execute("read-url-binary", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("binary");
		expect(text).toContain("Method: binary");
		expect(text).toContain("[Binary content: application/octet-stream");
		expect(text).not.toContain("\u0000");
		expect(text).not.toContain("�");
	});

	it("leaves valid UTF-8 octet-stream payloads on the text path", async () => {
		const url = uniqueUrl("plain", ".txt");
		const session = makeSession(testDir);
		const download = stubResponse(session, url, "plain UTF-8 text\nsecond line", "application/octet-stream");

		const tool = new ReadTool(session);
		const result = await tool.execute("read-url-text-octet", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).not.toBe("binary");
		expect(text).toContain("plain UTF-8 text");
		expect(text).toContain("second line");
		expect(download).toHaveBeenCalledTimes(1);
	});

	it("renders HTML when a binary-looking identity response is valid text on refetch", async () => {
		const html = `<!DOCTYPE html><html><body><h1>ARTICLE_TITLE</h1>${"<p>Readable article paragraph.</p>".repeat(300)}</body></html>`;
		const compressed = Bun.gzipSync(new TextEncoder().encode(html));
		const encodings: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname !== "/article") return new Response("Not found", { status: 404 });
				const encoding = request.headers.get("accept-encoding") ?? "";
				encodings.push(encoding);
				const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
				if (encoding.includes("gzip")) headers["content-encoding"] = "gzip";
				return new Response(compressed, { headers });
			},
		});

		try {
			const tool = new ReadTool(makeSession(testDir));
			const result = await tool.execute("read-url-gzip-html", { path: `http://127.0.0.1:${server.port}/article` });
			const text = textOutput(result);

			expect(encodings[0]).toBe("identity");
			expect(encodings[1]).toContain("gzip");
			expect(result.details?.method).not.toBe("binary");
			expect(text).toContain("ARTICLE_TITLE");
			expect(text).toContain("Readable article paragraph.");
			expect(text).not.toContain("[Binary content:");
		} finally {
			server.stop(true);
		}
	});

	for (const { charset, encoding, title } of [
		{ charset: "utf-16le", encoding: "utf16le", title: "Северный чай" },
		{ charset: "windows-1252", encoding: "latin1", title: "Café résumé" },
	] as const) {
		it(`renders refetched ${charset} HTML using its HTTP charset`, async () => {
			const html = `<!DOCTYPE html><html><body><h1>${title}</h1>${"<p>Readable article paragraph.</p>".repeat(300)}</body></html>`;
			const compressed = Bun.gzipSync(Buffer.from(html, encoding));
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (new URL(request.url).pathname !== "/article") return new Response("Not found", { status: 404 });
					const headers: Record<string, string> = { "content-type": "text/html" };
					if (request.headers.get("accept-encoding")?.includes("gzip")) {
						headers["content-type"] = `text/html; charset=${charset}`;
						headers["content-encoding"] = "gzip";
					}
					return new Response(compressed, { headers });
				},
			});

			try {
				const result = await new ReadTool(makeSession(testDir)).execute("read-url-charset-html", {
					path: `http://127.0.0.1:${server.port}/article`,
				});
				expect(result.details?.method).not.toBe("binary");
				expect(textOutput(result)).toContain(title);
			} finally {
				server.stop(true);
			}
		});
	}
});
