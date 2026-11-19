import { ArchiveError } from "./error";

const PATH_ERROR_PREVIEW_BYTES = 256;

/**
 * Normalize a user-supplied lookup path inside an archive. Returns `""` for
 * the archive root, `undefined` when the path escapes the root via `..`.
 */
export function normalizeArchiveLookupPath(rawPath?: string): string | undefined {
	if (!rawPath) return "";

	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	return normalizedParts.join("/");
}

/**
 * Normalize an archive member path from container metadata. Returns
 * `undefined` for empty paths and paths that escape the root via `..`.
 */
export function normalizeArchiveEntryPath(rawPath: string): string | undefined {
	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) return undefined;
	return normalizedParts.join("/");
}

/** Whether raw container metadata spells a directory via a trailing separator. */
export function isArchiveDirectoryName(rawPath: string): boolean {
	return rawPath.endsWith("/") || rawPath.endsWith("\\");
}

/** Clamp an attacker-controlled path to a short preview for error messages. */
export function formatArchivePathForError(value: string): string {
	if (Buffer.byteLength(value, "utf-8") <= PATH_ERROR_PREVIEW_BYTES) return value;

	let end = 0;
	let size = 0;
	for (const char of value) {
		const charSize = Buffer.byteLength(char, "utf-8");
		if (size + charSize > PATH_ERROR_PREVIEW_BYTES - 3) break;
		end += char.length;
		size += charSize;
	}
	return `${value.slice(0, end)}...`;
}

/** Reject a member path/link target longer than `maxPathBytes`. */
export function assertArchivePathBytes(size: number, field: string, maxPathBytes: number): void {
	if (size > maxPathBytes) {
		throw new ArchiveError(`Archive ${field} exceeds ${maxPathBytes} bytes`);
	}
}

/** {@link assertArchivePathBytes} for an already-decoded string. */
export function assertArchivePathString(value: string, field: string, maxPathBytes: number): void {
	assertArchivePathBytes(Buffer.byteLength(value, "utf-8"), field, maxPathBytes);
}
