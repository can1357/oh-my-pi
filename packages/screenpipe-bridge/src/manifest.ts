import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GopkCapturedDerivative } from "@pk-nerdsaver-ai/pi-activity-journal";
import type { FrameSegment } from "./types";

export interface BuildClipDerivativeOptions {
	readonly sessionId: string;
	readonly captureRoot: string;
	/**
	 * Root directory that screenpipe writes its snapshot JPEGs under. A frame's
	 * `snapshot_path` is only opened for keyframe hashing when it resolves
	 * inside this root — the path comes from an untrusted process, and hashing
	 * an attacker-chosen file would leak a content fingerprint of it. When
	 * unset, no snapshot is ever read and derivatives carry no keyframe hash.
	 */
	readonly mediaRoot?: string;
}

/**
 * Turns a segment of already-redacted screenpipe frames into a
 * `GopkCapturedDerivative` the activity-journal gopk sink will accept:
 * a manifest listing the frame range (written under `captureRoot`), a
 * cryptographic clipHash this bridge computes over the frame identity —
 * never over screen content; screenpipe's `content_hash` fingerprints
 * pre-redaction content and is deliberately not read — and an attestation
 * built from screenpipe's redaction watermarks. No raw media is copied or
 * retained here — `rawClip` is intentionally omitted, since screenpipe owns
 * the lifecycle of its own snapshot files.
 */
export async function buildClipDerivative(
	segment: FrameSegment,
	options: BuildClipDerivativeOptions,
): Promise<GopkCapturedDerivative> {
	const first = segment.frames[0];
	const last = segment.frames[segment.frames.length - 1];
	if (!first || !last) throw new Error("segment must contain at least one frame");

	const clipId = `${segment.deviceName}:${first.id}-${last.id}`;
	const frameIds = segment.frames.map(frame => frame.id);

	const clipHash = `sha256:${sha256Hex(
		JSON.stringify({
			deviceName: segment.deviceName,
			frameIds,
			window: segment.window,
			appIdentity: segment.appIdentity,
		}),
	)}`;

	const keyframeFrame = segment.frames.find(frame => frame.snapshot_path);
	const keyframeHash =
		keyframeFrame?.snapshot_path && options.mediaRoot
			? await hashContainedFile(keyframeFrame.snapshot_path, options.mediaRoot)
			: undefined;

	let completedAtSeconds = Date.parse(last.timestamp) / 1000;
	for (const frame of segment.frames) {
		for (const watermark of [
			frame.full_text_redacted_at,
			frame.accessibility_redacted_at,
			frame.accessibility_tree_redacted_at,
			frame.window_name_redacted_at,
			frame.browser_url_redacted_at,
			frame.text_json_redacted_at,
			frame.image_redacted_at,
		]) {
			if (watermark !== null && watermark > completedAtSeconds) completedAtSeconds = watermark;
		}
	}

	const manifestDir = path.join(path.resolve(options.captureRoot), "manifests");
	await fs.mkdir(manifestDir, { recursive: true });
	// Hashed rather than sanitized-and-truncated: distinct clipIds (e.g. a device
	// name containing "/" vs "_") must never collide onto the same manifest file.
	const manifestPath = path.join(manifestDir, `${sha256Hex(clipId)}.manifest.json`);
	const manifestBody = JSON.stringify(
		{
			clipId,
			deviceName: segment.deviceName,
			appIdentity: segment.appIdentity,
			window: segment.window,
			frameIds,
		},
		null,
		2,
	);
	const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`;
	await fs.writeFile(temporaryManifestPath, manifestBody);
	await fs.rename(temporaryManifestPath, manifestPath);

	return {
		clipId,
		sessionId: options.sessionId,
		window: segment.window,
		appIdentity: segment.appIdentity,
		sanitizedDigest: buildSanitizedDigest(segment),
		sanitizationAttestation: {
			status: "sanitized",
			completedAt: new Date(completedAtSeconds * 1000).toISOString(),
			sanitizerVersion: "screenpipe-redact",
		},
		clipHash,
		...(keyframeHash ? { keyframeHash } : {}),
		localManifestPointer: manifestPath,
	};
}

/** Built only from app/browser-origin identity, never window titles or OCR text, even though those are redacted too. */
function buildSanitizedDigest(segment: FrameSegment): string {
	const { processName, browserOrigin } = segment.appIdentity;
	const suffix = browserOrigin ? ` (${browserOrigin})` : "";
	return `${processName} activity from ${segment.window.startedAt} to ${segment.window.endedAt}${suffix}`;
}

async function hashContainedFile(filePath: string, mediaRoot: string): Promise<string | undefined> {
	try {
		const root = await fs.realpath(mediaRoot);
		const resolved = await fs.realpath(filePath);
		if (!resolved.startsWith(`${root}${path.sep}`)) return undefined;
		const bytes = await fs.readFile(resolved);
		return `sha256:${sha256Hex(bytes)}`;
	} catch {
		return undefined;
	}
}

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}
