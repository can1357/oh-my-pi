import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SIZE_HARD_CAP = 1_000_000;
export const SIZE_BASE64_CHECK = 100_000;
export const ENTROPY_THRESHOLD = 5.0;

const DATA_URI_RE = /^data:(?<mime>[^;]+)?(?:;base64)?,(?<payload>.*)/i;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface BlobMetadata {
	blob_ref?: string;
	original_size?: number;
	mime?: string;
	extraction_reason?: "data_uri" | "size_cap" | "high_entropy";
	entropy?: number;
}

export function blobRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.MNEMOPI_BLOB_DIR && env.MNEMOPI_BLOB_DIR.length > 0
		? env.MNEMOPI_BLOB_DIR
		: join(homedir(), ".hermes", "mnemopi", "blobs");
}

export function computeSha256(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

export function isDataUri(content: string): boolean {
	return content.startsWith("data:");
}

export function parseDataUri(content: string): [mimeType: string, raw: Buffer] | null {
	const match = DATA_URI_RE.exec(content);
	if (match?.groups === undefined) return null;

	const mimeType = match.groups.mime ?? "application/octet-stream";
	const payload = match.groups.payload ?? "";
	if (!isValidBase64(payload)) return null;

	return [mimeType, Buffer.from(payload, "base64")];
}

export function shannonEntropy(text: string): number {
	if (text.length === 0) return 0.0;

	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);

	let entropy = 0.0;
	for (const count of counts.values()) {
		const p = count / text.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

export function looksLikeBase64Blob(content: string): boolean {
	if (content.length < SIZE_BASE64_CHECK) return false;
	return shannonEntropy(content) > ENTROPY_THRESHOLD;
}

export function storeBlob(rawBytes: Uint8Array): string {
	const sha256 = computeSha256(rawBytes);
	const blobDir = join(blobRoot(), sha256.slice(0, 2), sha256.slice(0, 4));
	mkdirSync(blobDir, { recursive: true });
	const blobPath = join(blobDir, sha256);
	if (!existsSync(blobPath)) writeFileSync(blobPath, rawBytes);
	return sha256;
}

export function sanitizeContent(content: string): [sanitizedContent: string, blobMetadata: BlobMetadata] {
	const originalSize = Buffer.byteLength(content, "utf8");

	if (isDataUri(content)) {
		const parsed = parseDataUri(content);
		if (parsed !== null) {
			const [mimeType, rawBytes] = parsed;
			const sha256 = storeBlob(rawBytes);
			const blobRef = `blob://sha256/${sha256}`;
			return [
				`[Binary content extracted: ${mimeType}, ${rawBytes.length.toLocaleString("en-US")} bytes → ${blobRef}]`,
				{
					blob_ref: blobRef,
					original_size: rawBytes.length,
					mime: mimeType,
					extraction_reason: "data_uri",
				},
			];
		}
	}

	if (originalSize > SIZE_HARD_CAP) {
		const rawBytes = Buffer.from(content, "utf8");
		const sha256 = storeBlob(rawBytes);
		const blobRef = `blob://sha256/${sha256}`;
		return [
			`[Large content extracted: ${originalSize.toLocaleString("en-US")} bytes → ${blobRef}]`,
			{
				blob_ref: blobRef,
				original_size: originalSize,
				extraction_reason: "size_cap",
			},
		];
	}

	if (originalSize > SIZE_BASE64_CHECK && looksLikeBase64Blob(content)) {
		const rawBytes = Buffer.from(content, "utf8");
		const sha256 = storeBlob(rawBytes);
		const entropy = Math.round(shannonEntropy(content) * 100) / 100;
		const blobRef = `blob://sha256/${sha256}`;
		return [
			`[Encoded content extracted: ${originalSize.toLocaleString("en-US")} bytes, entropy ${entropy.toFixed(1)} bits/char → ${blobRef}]`,
			{
				blob_ref: blobRef,
				original_size: originalSize,
				entropy,
				extraction_reason: "high_entropy",
			},
		];
	}

	return [content, {}];
}
function isValidBase64(payload: string): boolean {
	if (payload.length % 4 !== 0) return false;
	if (!BASE64_RE.test(payload)) return false;
	try {
		Buffer.from(payload, "base64");
		return true;
	} catch {
		return false;
	}
}
