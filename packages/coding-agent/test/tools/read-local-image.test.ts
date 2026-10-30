/**
 * `local://` URLs locate to real files, which `read` serves through the
 * filesystem pipeline rather than the text-only resource contract
 * (`content: string`) that once UTF-8-decoded PNG bytes into mojibake. These
 * lock that: genuine image files under the session local root decode into an
 * inline image block, text files still read as text, and a file symlinked
 * outside the local root is rejected by the handler's realpath guard (locating
 * must not become a containment bypass).
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
import { decodeStillImageJpeg } from "@oh-my-pi/pi-coding-agent/utils/video";
import { $which, parseImageMetadata, removeWithRetries } from "@oh-my-pi/pi-utils";

const hasFfprobe = Boolean($which("ffprobe"));

// The video reader owns every video path before the binary sniff: with
// ffprobe it reports a probe failure naming the file, without it the install
// hint — either way no decoded byte reaches the text pipeline.
function expectVideoProbeFailure(text: string, fileName: string): void {
	if (hasFfprobe) {
		expect(text).toContain("Could not probe video");
		expect(text).toContain(fileName);
	} else {
		expect(text).toContain("require ffprobe");
	}
	expect(text).not.toContain("\u0000");
}

// 1x1 transparent PNG — small enough to pass through image loading untouched.
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const OTHER_TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);
const TINY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>';

// Red stills: a 1100x8 HEIC that macOS `sips` stores as three tiles, as cameras store
// photos, and a 16x8 AVIF from ffmpeg's libaom.
const TILED_HEIC = Buffer.from(
	"AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAACTG1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAQAAABiaWluZgAAAAAABAAAABVpbmZlAgAAAQABAABodmMxAAAAABVpbmZlAgAAAQACAABodmMxAAAAABVpbmZlAgAAAQADAABodmMxAAAAABVpbmZlAgAAAAAEAABncmlkAAAAAB5pcmVmAAAAAAAAABJkaW1nAAQAAwABAAIAAwAAAQ1pcHJwAAAA2GlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAACAAAAAgAAAAAUaXNwZQAAAAAAAARMAAAACAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABwaHZjQwEDcAAAALAAAAAAAFrwAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAFpwJKEAAQAiQgEBA3AAAAMAsAAAAwAAAwBaoAQCAIBYh7kWVTcCAgYAgKIAAQAJRAHAYXLIRFNkAAAALWlwbWEAAAAAAAAABAABBIOBAocAAgSDgQKHAAMEg4EChwAEBYECBAaFAAAAEGlkYXQAAAACBEwACAAAAFBpbG9jAQAAAEQAAAQAAQAAAAAAAQAAAoAAAADSAAIAAAAAAAEAAANSAAAA0gADAAAAAAABAAAEJAAAAO8ABAABAAAAAQAAAAAAAAAIAAAAAW1kYXQAAAAAAAACowAAAM4oAa+EDVHmmmFkkkEDDDCiwBp7P/rm//oPsuNmXlF3/zaTVkTH7VnCaaptNde15RCEyTsAAAMAAAMAIKA8DyD1RTpAAAADAAADAF1ANCY9WAAAAwAAAwAAEvA8WAAAAwAAAwAAAwBIwAAAAwAAAwAAAwAAP6AAAAMAAAMAAAMAMCAAAAMAAAMAAAd8AAADAAADAADdgAAAAwAAAwAQ0AAAAwAAAwDOgAAAAwAABtQAAAMAACVgAAADAACUgAAAAwACLgAAAwAFbAAAAwAOGAAAAM4oAa+EDVHmmmFkkkEDDDCiwBp7P/rm//oPsuNmXlF3/zaTVkTH7VnCaaptNde15RCEyTsAAAMAAAMAIKA8DyD1RTpAAAADAAADAF1ANCY9WAAAAwAAAwAAEvA8WAAAAwAAAwAAAwBIwAAAAwAAAwAAAwAAP6AAAAMAAAMAAAMAMCAAAAMAAAMAAAd8AAADAAADAADdgAAAAwAAAwAQ0AAAAwAAAwDOgAAAAwAABtQAAAMAACVgAAADAACUgAAAAwACLgAAAwAFbAAAAwAOGAAAAOsoAa+EDxR40aMFiRIgQGDBgoWAGns/+ub/+g+y42ZeUXf/NpNWRMftWcJpqm0117RcXovX/O+Dh1RiFt3xtwF9AC0nNJMfbUjamlQnNbGheAoeAAADAAAU0DwPIbP85AAAAwAAAwAALKA0Jj1YAAADAAADAAAS8DxYAAADAAADAAADAEjAAAADAAADAAADAAA/oAAAAwAAAwAAAwAwIAAAAwAAAwAAB3wAAAMAAAMAAN2AAAADAAADABDQAAADAAADAM6AAAADAAAG1AAAAwAAJWAAAAMAAJSAAAADAAIuAAADAAVsAAADAA4Y",
	"base64",
);
const TINY_AVIF = Buffer.from(
	"AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAQAAAACAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoFGAy/tgEyEhgAAABQAAAAD1ltwbcN3z7Hqg==",
	"base64",
);

// What this machine's ffmpeg makes of the tiled HEIC: ffmpeg 8.1+ assembles the tiles, 7.x
// decodes only the first one, older builds and machines without ffmpeg cannot read it.
async function probeHeifTiles(): Promise<"assembled" | "one-tile" | "unreadable"> {
	if (!$which("ffmpeg")) return "unreadable";
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-heif-probe-"));
	try {
		await Bun.write(path.join(dir, "in.heic"), TILED_HEIC);
		const decoded = await Bun.$`ffmpeg -v error -i in.heic -frames:v 1 out.png`.cwd(dir).quiet().nothrow();
		if (decoded.exitCode !== 0) return "unreadable";
		const png = await fs.readFile(path.join(dir, "out.png"));
		return parseImageMetadata(png)?.width === 1100 ? "assembled" : "one-tile";
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}
const heifTiles = await probeHeifTiles();

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
		localProtocolOptions: {
			getArtifactsDir: () => path.join(testDir, "artifacts"),
			getSessionId: () => "session-local-image",
		},
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
	it("resets the repeat-read hint when an image at the same path changes", async () => {
		const file = path.join(localRoot, "regenerated.png");
		const tool = new ReadTool(makeSession(testDir));
		await Bun.write(file, TINY_PNG);
		const first = await tool.execute("first", { path: file });
		await Bun.write(file, OTHER_TINY_PNG);
		const changed = await tool.execute("changed", { path: file });
		await Bun.write(file, TINY_PNG);
		const restored = await tool.execute("restored", { path: file });

		expect(first.content[0]).toEqual(changed.content[0]);
		expect(first.content[1]).not.toEqual(changed.content[1]);
		expect(joinText(restored.content)).not.toContain("identical output");

		await tool.execute("repeat", { path: file });
		const repeated = await tool.execute("repeat-again", { path: file });
		expect(joinText(repeated.content)).toContain("identical output 3 times");
	});

	it("rasterizes a local SVG into a PNG attachment when :img is selected", async () => {
		await Bun.write(path.join(localRoot, "diagram.svg"), TINY_SVG);
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `${path.join(localRoot, "diagram.svg")}:img` });

		const image = result.content.find(content => content.type === "image");
		expect(image && "mimeType" in image ? image.mimeType : undefined).toBe("image/png");
		const png = image?.type === "image" ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
		expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		expect(joinText(result.content)).toContain("Read SVG file [image/svg+xml] (displayed as image/png)");
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

	it.skipIf(heifTiles !== "assembled").each([
		["photo.heic", TILED_HEIC, "image/heic", 1100],
		["photo.avif", TINY_AVIF, "image/avif", 16],
	])("decodes %s whole into an inline JPEG", async (name, bytes, mimeType, width) => {
		await Bun.write(path.join(localRoot, name), bytes);
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: `local://${name}` });

		const image = result.content.find(content => content.type === "image");
		expect(image?.type === "image" ? image.mimeType : undefined).toBe("image/jpeg");
		const jpeg = image?.type === "image" ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
		expect(parseImageMetadata(jpeg)).toMatchObject({ width, height: 8 });
		expect(joinText(result.content)).toContain(`Read image file [${mimeType}] (displayed as image/jpeg)`);
	});

	it.skipIf(heifTiles !== "one-tile")("refuses a tiled HEIC that this ffmpeg would show as one tile", async () => {
		await Bun.write(path.join(localRoot, "photo.heic"), TILED_HEIC);
		const tool = new ReadTool(makeSession(testDir));

		const error = await tool.execute("call", { path: "local://photo.heic" }).catch(e => e);

		expect(String(error?.message ?? error)).toContain("cannot decode tiled HEIF images");
	});

	it("returns HEIC metadata plus a question hint for text-only models", async () => {
		await Bun.write(path.join(localRoot, "photo.heic"), TILED_HEIC);
		const tool = new ReadTool(makeSession(testDir, true));

		const result = await tool.execute("call", { path: "local://photo.heic" });

		const text = joinText(result.content);
		expect(text).toContain("- MIME: image/heic");
		expect(text).toContain("local://photo.heic?q=<question>");
	});

	it("names a conversion when ffmpeg cannot decode a HEIC", async () => {
		const corrupt = Buffer.concat([TILED_HEIC.subarray(0, 36), new Uint8Array(64)]);
		await Bun.write(path.join(localRoot, "broken.heic"), corrupt);
		const tool = new ReadTool(makeSession(testDir));

		const error = await tool.execute("call", { path: "local://broken.heic" }).catch(e => e);

		const message = String(error?.message ?? error);
		expect(message).toContain("Could not decode HEIC image");
		expect(message).toContain("Convert it to PNG or JPEG");
	});

	it.skipIf(heifTiles !== "assembled")("decodes again at lower quality when the JPEG is over the cap", async () => {
		const file = path.join(localRoot, "photo.heic");
		await Bun.write(file, TILED_HEIC);
		const full = await decodeStillImageJpeg(file, Number.POSITIVE_INFINITY);

		const smaller = await decodeStillImageJpeg(file, full.length - 1);

		expect(smaller.length).toBeLessThan(full.length);
		expect(parseImageMetadata(smaller)).toMatchObject({ width: 1100, height: 8 });
	});

	it.skipIf(heifTiles !== "assembled")("names the decoded size when no quality fits the cap", async () => {
		const file = path.join(localRoot, "photo.heic");
		await Bun.write(file, TILED_HEIC);

		const error = await decodeStillImageJpeg(file, 1).catch(e => e);

		expect(String(error?.message ?? error)).toContain("of JPEG, over the 1 B image limit");
	});

	it("still refuses an MP4-branded file without a video extension as binary", async () => {
		const mp4Header = Buffer.from("0000001c6674797069736f6d0000020069736f6d69736f326d703431", "hex");
		await Bun.write(path.join(localRoot, "clip.bin"), Buffer.concat([mp4Header, new Uint8Array(64)]));
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://clip.bin" });

		expect(joinText(result.content)).toContain("Cannot read binary file");
	});

	it("still reads a local:// text file as text", async () => {
		await Bun.write(path.join(localRoot, "notes.txt"), "hello world");
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://notes.txt" });

		expect(result.content.some(c => c.type === "image")).toBe(false);
		expect(joinText(result.content)).toContain("hello world");
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

		// The handler's realpath/containment guard must reject the escape before
		// the filesystem pipeline could read it.
		await expect(tool.execute("call", { path: "local://linked/secret.png" })).rejects.toThrow(
			"local:// URL escapes local root",
		);
	});
});
