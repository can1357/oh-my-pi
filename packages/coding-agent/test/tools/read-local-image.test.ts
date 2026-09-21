/**
 * `local://` is routed through the internal-URL handler, whose resource
 * contract is text-only (`content: string`). Before the image fast path, a
 * `local://photo.png` read UTF-8-decoded the PNG bytes into mojibake. These
 * lock the fix: genuine image files under the session local root decode into an
 * inline image block, text files still read as text, and a file symlinked
 * outside the local root is rejected by the same realpath guard the router uses
 * (the fast path must not become a containment bypass).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { completeSimple } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

const hasFfprobe = Boolean($which("ffprobe"));

// The video reader owns every video path before the binary sniff: with
// ffprobe it reports a probe failure naming the file, without it the install
// hint — either way no decoded byte reaches the text pipeline.
function expectVideoProbeFailure(text: string, fileName: string): void {
	if (hasFfprobe) {
		expect(text).toContain("Could not probe video");
		expect(text).toContain(fileName);
	} else {
		expect(text).toContain("requires ffprobe");
	}
	expect(text).not.toContain("\u0000");
}

// 1x1 transparent PNG — small enough to pass through image loading untouched.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const TINY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>';

function makeSession(testDir: string, textOnlyModel = false): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	const model = createMockModel({ id: textOnlyModel ? "text-only" : "vision" });
	if (!textOnlyModel) model.input.push("image");
	const settings = Settings.isolated({ "images.autoResize": false });
	settings.setModelRole("vision", `${model.provider}/${model.id}`);
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		getModelString: () => `${model.provider}/${model.id}`,
		getActiveModelString: () => `${model.provider}/${model.id}`,
		getActiveModel: () => model,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		},
		settings,
	} as unknown as ToolSession;
}

function joinText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("read local:// images", () => {
	let testDir: string;
	let localRoot: string;

	beforeEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-local-image-"));
		const artifactsDir = path.join(testDir, "artifacts");
		localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => "session-local-image",
		});
	});

	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		await removeWithRetries(testDir);
	});

	it("decodes a local:// PNG into an inline image block", async () => {
		await Bun.write(path.join(localRoot, "clifford.png"), TINY_PNG);
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://clifford.png" });

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		// The pre-fix bug surfaced the PNG signature byte (0x89) UTF-8-decoded to
		// the replacement char; the fixed path must never emit it as text.
		expect(joinText(result.content)).not.toContain("\uFFFDPNG");
	});
	it("rasterizes a local SVG into a PNG attachment when :img is selected", async () => {
		await Bun.write(path.join(localRoot, "diagram.svg"), TINY_SVG);
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${path.join(localRoot, "diagram.svg")}:img` });

		const image = result.content.find(content => content.type === "image");
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		const png = image?.type === "image" ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		expect(joinText(result.content)).toContain("Read SVG file [image/png]");
	});
	it("returns SVG metadata plus a question hint for text-only models", async () => {
		await Bun.write(path.join(localRoot, "diagram.svg"), TINY_SVG);
		const tool = new ReadTool(makeSession(testDir, true));

		const result = await tool.execute("call", { path: "local://diagram.svg:img" });

		expect(result.content.some(content => content.type === "image")).toBe(false);
		expect(joinText(result.content)).toContain("local://diagram.svg:img?q=<question>");
	});

	it("answers questions about selected local SVGs", async () => {
		await Bun.write(path.join(localRoot, "diagram.svg"), TINY_SVG);
		const complete: typeof completeSimple = async model => ({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text: "Red rectangle" }],
		});
		const tool = new ReadTool(makeSession(testDir), complete);

		const result = await tool.execute("call", { path: "local://diagram.svg:img?q=What shape is shown?" });

		expect(result.content).toEqual([{ type: "text", text: "Red rectangle" }]);
	});

	it("keeps a local SVG as text without :img", async () => {
		await Bun.write(path.join(localRoot, "diagram.svg"), TINY_SVG);
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://diagram.svg" });

		expect(result.content.some(content => content.type === "image")).toBe(false);
		expect(joinText(result.content)).toContain("<svg");
	});

	it("still reads a local:// text file as text (fast path falls through)", async () => {
		await Bun.write(path.join(localRoot, "notes.txt"), "hello world");
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://notes.txt" });

		expect(result.content.some(c => c.type === "image")).toBe(false);
		expect(joinText(result.content)).toContain("hello world");
	});

	it("surfaces a corrupt local:// video as a probe failure without emitting decoded bytes", async () => {
		await Bun.write(path.join(localRoot, "clip.mp4"), new Uint8Array([0, 1, 2, 3, 4, 5]));
		const tool = new ReadTool(makeSession(testDir));

		const error = await tool.execute("call", { path: "local://clip.mp4" }).catch(e => e);
		expectVideoProbeFailure(String(error?.message ?? error), "clip.mp4");
	});

	it("surfaces a large corrupt local:// video as a probe failure without emitting decoded bytes", async () => {
		// A NUL-filled blob wearing a video extension must fail in the video
		// reader, not in the text pipeline: no byte budget or line scan ever sees
		// these bytes.
		const blob = new Uint8Array(256 * 1024);
		await Bun.write(path.join(localRoot, "video.mp4"), blob);
		const tool = new ReadTool(makeSession(testDir));

		const error = await tool.execute("call", { path: "local://video.mp4" }).catch(e => e);
		expectVideoProbeFailure(String(error?.message ?? error), "video.mp4");
	});

	it("does not materialize local:// binary resources in the protocol handler", async () => {
		await Bun.write(path.join(localRoot, "archive.zip"), new Uint8Array([0, 1, 2, 3, 4, 5]));

		const resource = await new LocalProtocolHandler().resolve(parseInternalUrl("local://archive.zip"));

		expect(resource.content).toContain("Cannot read binary local:// file");
		expect(resource.content).toContain("archive.zip");
		expect(resource.content).not.toContain("\u0000");
	});

	it("does not read an image symlinked outside the local root", async () => {
		if (process.platform === "win32") return;
		const outsideDir = path.join(testDir, "outside");
		await fs.mkdir(outsideDir, { recursive: true });
		await Bun.write(path.join(outsideDir, "secret.png"), TINY_PNG);
		await fs.symlink(outsideDir, path.join(localRoot, "linked"));
		const tool = new ReadTool(makeSession(testDir));

		// The realpath/containment guard the router applies must still reject the
		// escape; the image fast path must not silently read it.
		await expect(tool.execute("call", { path: "local://linked/secret.png" })).rejects.toThrow(
			"local:// URL escapes local root",
		);
	});
});
