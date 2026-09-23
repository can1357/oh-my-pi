import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";

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
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

function stubUrlBytes(bytes: Uint8Array, contentType: string, contentDisposition?: string) {
	const decoded = Buffer.from(bytes).toString("utf-8");
	vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType,
		content: decoded,
	}));
	return vi.spyOn(scraperUtils, "fetchBinary").mockImplementation(async () => ({
		ok: true,
		buffer: bytes,
		contentDisposition,
	}));
}

function stubUrlText(body: string, contentType: string) {
	vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType,
		content: body,
	}));
	return vi.spyOn(scraperUtils, "fetchBinary").mockImplementation(async () => {
		throw new Error("unexpected binary fetch");
	});
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
		stubUrlBytes(zipBytes, "application/octet-stream");

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("read-url-zip", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("archive");
		expect(text).toContain("Method: archive");
		expect(text).toContain("root.txt");
		expect(text).toContain("nested/");
		expect(text).not.toContain("PK\u0003\u0004");
		expect(text).not.toContain("�");
	});

	it("returns a metadata notice when a hinted binary refetch fails", async () => {
		const url = uniqueUrl("oversized", ".zip");
		vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "application/octet-stream",
			content: "PK\u0003\u0004\u0000\u0001",
		}));
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: false,
			error: "content-length 52428801 exceeds 52428800",
		});

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("read-url-zip-too-large", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("binary");
		expect(result.details?.notes).toContain("Binary fetch failed: content-length 52428801 exceeds 52428800");
		expect(text).toContain("[Binary content: application/octet-stream");
		expect(text).not.toContain("PK\u0003\u0004");
	});

	it("renders a remote sqlite database through the sqlite reader", async () => {
		const sqliteBytes = await createSqliteFixtureBytes(testDir);
		const url = uniqueUrl("data", ".db");
		stubUrlBytes(sqliteBytes, "application/octet-stream");

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("read-url-sqlite", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("sqlite");
		expect(text).toContain("Method: sqlite");
		expect(text).toContain("notes (2 rows)");
	});

	it("renders a remote notebook as editable cells", async () => {
		const notebookBytes = createNotebookFixtureBytes();
		const url = uniqueUrl("notebook", ".ipynb");
		stubUrlBytes(notebookBytes, "application/octet-stream");

		const tool = new ReadTool(makeSession(testDir));
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
		stubUrlBytes(binaryBytes, "application/octet-stream");

		const tool = new ReadTool(makeSession(testDir));
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
		const fetchBinarySpy = stubUrlText("plain UTF-8 text\nsecond line", "application/octet-stream");

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("read-url-text-octet", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("raw");
		expect(text).toContain("plain UTF-8 text");
		expect(text).toContain("second line");
		expect(fetchBinarySpy).not.toHaveBeenCalled();
	});
});
