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
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { InternalUrlRouter, LocalProtocolHandler, parseInternalUrl } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { ReadTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/read";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

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

	it("still reads a local:// text file as text (fast path falls through)", async () => {
		await Bun.write(path.join(localRoot, "notes.txt"), "hello world");
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://notes.txt" });

		expect(result.content.some(c => c.type === "image")).toBe(false);
		expect(joinText(result.content)).toContain("hello world");
	});

	it("rejects a local:// non-image binary without emitting decoded bytes", async () => {
		await Bun.write(path.join(localRoot, "clip.mp4"), new Uint8Array([0, 1, 2, 3, 4, 5]));
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://clip.mp4" });
		const text = joinText(result.content);

		expect(text).toContain("Cannot read binary file");
		expect(text).toContain("clip.mp4");
		expect(text).not.toContain("\u0000");
	});

	it("rejects a large local:// binary whose first line exceeds the streaming byte budget", async () => {
		// The streaming reader's byte budget is `max(DEFAULT_MAX_BYTES, defaultLimit*512)` —
		// 150 KiB under default settings. A NUL-filled blob larger than that with no 0x0A
		// byte forces streamLinesFromFile into the firstLineExceedsLimit path: collectedLines
		// stays empty, so the NUL check that walks collectedLines never sees these bytes.
		// Without the firstLinePreview guard, the preview would be decoded as UTF-8 and
		// emitted as text (the reviewer's video/archive case).
		const blob = new Uint8Array(256 * 1024);
		await Bun.write(path.join(localRoot, "video.mp4"), blob);
		const tool = new ReadTool(makeSession(testDir));

		const result = await tool.execute("call", { path: "local://video.mp4" });
		const text = joinText(result.content);

		expect(text).toContain("Cannot read binary file");
		expect(text).toContain("video.mp4");
		expect(text).not.toContain("\u0000");
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
