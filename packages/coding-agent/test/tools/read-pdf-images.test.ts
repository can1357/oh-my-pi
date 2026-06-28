/**
 * PDF image extraction: markit emits inert `<!-- image: <id> ... -->`
 * placeholders for embedded PDF images. The read tool rewrites those into
 * browsable `read <pdf>:<id>.png` handles, and serves the actual PNG when that
 * handle is read — extracting via markit's `imageDir` into a session-artifact
 * cache. These lock the rewrite, the member extraction, member validation, and
 * the caching contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { ReadTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/read";
import * as markit from "@pk-nerdsaver-ai/pi-coding-agent/utils/markit";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

// 1x1 transparent PNG — small enough to pass through image loading untouched.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "images.autoResize": false }),
	} as unknown as ToolSession;
}

/** Spy on markit so PDF "extraction" writes the given members into imageDir. */
function mockExtraction(members: Record<string, Buffer> = { "p11-img0.png": TINY_PNG }) {
	return vi.spyOn(markit, "convertFileWithMarkit").mockImplementation(async (_filePath: string, _signal, options) => {
		if (options?.imageDir) {
			fs.mkdirSync(options.imageDir, { recursive: true });
			for (const name in members) {
				fs.writeFileSync(path.join(options.imageDir, name), members[name]!);
			}
		}
		return { ok: true, content: "" };
	});
}

describe("read PDF image extraction", () => {
	let testDir: string;
	let pdfPath: string;
	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-pdf-img-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		pdfPath = path.join(testDir, "doc.pdf");
		fs.writeFileSync(pdfPath, "%PDF-stub");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("rewrites image placeholders into browse handles on a full read", async () => {
		const converted = [
			"Heading",
			"",
			"<!-- image: p11-img0 (page 11, 199x124pt) -->",
			"",
			"<!-- image: p11-img1 (page 11, 199x54pt) -->",
			"",
			"Footer",
		].join("\n");
		vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({ ok: true, content: converted });

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: pdfPath });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).not.toContain("<!-- image:");
		expect(text).toContain(`read \`${pdfPath}:p11-img0.png\``);
		expect(text).toContain(`read \`${pdfPath}:p11-img1.png\``);
		// Page/size metadata is preserved in the handle text.
		expect(text).toContain("page 11, 199x124pt");
	});

	it("rewrites placeholders inside a line-range view", async () => {
		const lines = Array.from({ length: 20 }, (_, i) => `pdf line ${i + 1}`);
		lines[9] = "<!-- image: p3-img0 (page 3, 100x50pt) -->"; // line 10
		vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({ ok: true, content: lines.join("\n") });

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: `${pdfPath}:8-12` });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).not.toContain("<!-- image:");
		expect(text).toContain(`read \`${pdfPath}:p3-img0.png\``);
	});

	it("extracts a PDF image member as an inline image block", async () => {
		const spy = mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain("Read image file");
		// Extraction was driven through markit with an imageDir target.
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[2]?.imageDir).toBeTruthy();
	});

	it("reuses the extraction cache across member reads", async () => {
		const spy = mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		// Second read is served from the `.extracted` cache, not re-converted.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("errors with the available members for an unknown member", async () => {
		mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		await expect(tool.execute("call", { path: `${pdfPath}:does-not-exist.png` })).rejects.toThrow(
			/not found.*p11-img0\.png/s,
		);
	});

	it("rejects member traversal attempts", async () => {
		mockExtraction();
		const tool = new ReadTool(makeSession(testDir));
		// `../../escape.png` matches the image-member shape but is not a known
		// basename, so it must be refused rather than joined into the cache path.
		await expect(tool.execute("call", { path: `${pdfPath}:../../escape.png` })).rejects.toThrow(/not found/);
	});

	it("lists extractable members for a trailing-colon read", async () => {
		mockExtraction({ "p1-img0.png": TINY_PNG, "p2-img0.png": TINY_PNG });
		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("call", { path: `${pdfPath}:` });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain(`read \`${pdfPath}:p1-img0.png\``);
		expect(text).toContain(`read \`${pdfPath}:p2-img0.png\``);
	});

	it("does not cache a failed conversion", async () => {
		const spy = vi.spyOn(markit, "convertFileWithMarkit");
		// First attempt fails and writes nothing → throws, leaves no `.extracted` marker.
		spy.mockResolvedValueOnce({ ok: false, content: "", error: "boom" });
		const tool = new ReadTool(makeSession(testDir));
		await expect(tool.execute("call", { path: `${pdfPath}:p11-img0.png` })).rejects.toThrow(/Cannot extract images/);
		// A later attempt succeeds and must re-run conversion (cache not poisoned).
		spy.mockImplementationOnce(async (_filePath: string, _signal, options) => {
			if (options?.imageDir) {
				fs.mkdirSync(options.imageDir, { recursive: true });
				fs.writeFileSync(path.join(options.imageDir, "p11-img0.png"), TINY_PNG);
			}
			return { ok: true, content: "" };
		});
		const result = await tool.execute("call", { path: `${pdfPath}:p11-img0.png` });
		expect(result.content.some(c => c.type === "image")).toBe(true);
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
