import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildClipDerivative } from "../src/manifest";
import type { FrameSegment } from "../src/types";
import { frame } from "./fixtures";

function segment(overrides: Partial<FrameSegment> = {}): FrameSegment {
	return {
		deviceName: "device-1",
		frames: [
			frame({
				id: 10,
				timestamp: "2026-07-13T14:00:00.000Z",
				full_text_redacted_at: 1_752_415_200,
				has_full_text: 1,
			}),
			frame({
				id: 11,
				timestamp: "2026-07-13T14:01:00.000Z",
				full_text_redacted_at: 1_752_415_260,
				has_full_text: 1,
			}),
		],
		window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:01:00.000Z" },
		appIdentity: { processName: "code" },
		...overrides,
	};
}

describe("buildClipDerivative", () => {
	it("builds a derivative with a manifest file, clip hash, and attestation", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		try {
			const derivative = await buildClipDerivative(segment(), { sessionId: "session-1", captureRoot });

			expect(derivative.clipId).toBe("device-1:10-11");
			expect(derivative.sessionId).toBe("session-1");
			expect(derivative.window).toEqual({
				startedAt: "2026-07-13T14:00:00.000Z",
				endedAt: "2026-07-13T14:01:00.000Z",
			});
			expect(derivative.appIdentity).toEqual({ processName: "code" });
			expect(derivative.clipHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(derivative.keyframeHash).toBeUndefined();
			expect(derivative.sanitizationAttestation.status).toBe("sanitized");
			expect(derivative.sanitizationAttestation.completedAt).toBe("2026-07-13T14:01:00.000Z");
			expect(derivative.sanitizationAttestation.sanitizerVersion).toBe("screenpipe-redact");

			const manifestRaw = await fs.readFile(derivative.localManifestPointer, "utf8");
			expect(JSON.parse(manifestRaw)).toMatchObject({
				clipId: "device-1:10-11",
				frameIds: [10, 11],
			});
			const leftovers = (await fs.readdir(path.dirname(derivative.localManifestPointer))).filter(name =>
				name.endsWith(".tmp"),
			);
			expect(leftovers).toEqual([]);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("never leaks OCR text or window titles into the sanitized digest", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		try {
			const withSensitiveWindow = segment({
				appIdentity: { processName: "chrome", browserOrigin: "https://example.com" },
				frames: [frame({ id: 1, timestamp: "2026-07-13T14:00:00.000Z", window_name: "top secret memo.docx" })],
				window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:00:01.000Z" },
			});

			const derivative = await buildClipDerivative(withSensitiveWindow, { sessionId: "session-1", captureRoot });

			expect(derivative.sanitizedDigest).not.toContain("top secret memo");
			expect(derivative.sanitizedDigest).toBe(
				"chrome activity from 2026-07-13T14:00:00.000Z to 2026-07-13T14:00:01.000Z (https://example.com)",
			);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});

	it("hashes a snapshot as the keyframe only when it resolves inside mediaRoot", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-media-"));
		try {
			const snapshotPath = path.join(mediaRoot, "snapshot.jpg");
			await fs.writeFile(snapshotPath, "fake-jpeg-bytes");
			const withSnapshot = (snapshot: string) =>
				segment({
					frames: [
						frame({
							id: 1,
							timestamp: "2026-07-13T14:00:00.000Z",
							snapshot_path: snapshot,
							image_redacted_at: 1_752_415_200,
						}),
					],
					window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:00:01.000Z" },
				});

			const contained = await buildClipDerivative(withSnapshot(snapshotPath), {
				sessionId: "session-1",
				captureRoot,
				mediaRoot,
			});
			expect(contained.keyframeHash).toMatch(/^sha256:[0-9a-f]{64}$/);

			const outsideFile = path.join(captureRoot, "victim.txt");
			await fs.writeFile(outsideFile, "not a screenshot");
			const escaped = await buildClipDerivative(withSnapshot(outsideFile), {
				sessionId: "session-1",
				captureRoot,
				mediaRoot,
			});
			expect(escaped.keyframeHash).toBeUndefined();

			const noRoot = await buildClipDerivative(withSnapshot(snapshotPath), { sessionId: "session-1", captureRoot });
			expect(noRoot.keyframeHash).toBeUndefined();
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
			await fs.rm(mediaRoot, { recursive: true, force: true });
		}
	});

	it("produces a manifest pointer that is a plain local absolute path", async () => {
		const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "screenpipe-bridge-"));
		try {
			const derivative = await buildClipDerivative(segment(), { sessionId: "session-1", captureRoot });
			expect(path.isAbsolute(derivative.localManifestPointer)).toBe(true);
			expect(derivative.localManifestPointer.startsWith("file://")).toBe(false);
		} finally {
			await fs.rm(captureRoot, { recursive: true, force: true });
		}
	});
});
