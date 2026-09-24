import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isMarkdownPath } from "@oh-my-pi/pi-tui/lang-from-path";
import type { InternalResource } from "./types";

/** Resource content type inferred from a file extension: markdown, JSON, or plain text. */
export function contentTypeForPath(filePath: string): InternalResource["contentType"] {
	if (isMarkdownPath(filePath)) return "text/markdown";
	if (path.extname(filePath).toLowerCase() === ".json") return "application/json";
	return "text/plain";
}

/**
 * Validate that a URL-relative path is safe (no traversal, no absolute paths).
 * Error messages name `scheme` so callers surface them unchanged.
 */
export function validateRelativePath(relativePath: string, scheme: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`Absolute paths are not allowed in ${scheme}:// URLs`);
	}

	const normalized = path.normalize(relativePath);
	if (
		relativePath.split(/[\\/]/).includes("..") ||
		normalized.startsWith("..") ||
		normalized.includes("/../") ||
		normalized.includes("/..")
	) {
		throw new Error(`Path traversal (..) is not allowed in ${scheme}:// URLs`);
	}
}

/** Thrown when an internal URL resolves outside its scheme root. */
export class UrlContainmentError extends Error {
	override name = "UrlContainmentError";
}

/** Throw `<scheme>:// URL escapes <scheme> root` unless `targetPath` is `rootPath` or lies beneath it. */
export function ensureWithinRoot(targetPath: string, rootPath: string, scheme: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new UrlContainmentError(`${scheme}:// URL escapes ${scheme} root`);
	}
}

/**
 * Realpath of an existing `targetPath` under the already-realpathed `realRoot`,
 * checking the lexical target, its real parent (when it exists), and its real
 * path for containment so symlinks cannot escape the root. Returns `undefined`
 * when the target does not exist; write paths use {@link ensureCreatableWithinRoot}.
 */
export async function containedRealPath(
	targetPath: string,
	realRoot: string,
	scheme: string,
): Promise<string | undefined> {
	ensureWithinRoot(targetPath, realRoot, scheme);
	if (targetPath !== realRoot) {
		try {
			ensureWithinRoot(await fs.realpath(path.dirname(targetPath)), realRoot, scheme);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}

	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	ensureWithinRoot(realTargetPath, realRoot, scheme);
	return realTargetPath;
}

/**
 * Throw {@link UrlContainmentError} unless creating `targetPath` (lexically under
 * the already-realpathed `realRoot`) stays inside the root: the deepest existing
 * entry on the way must canonically resolve within it, and no entry may be a
 * dangling symlink a `mkdir -p` + write would follow out of the root.
 */
export async function ensureCreatableWithinRoot(targetPath: string, realRoot: string, scheme: string): Promise<void> {
	ensureWithinRoot(targetPath, realRoot, scheme);
	for (let current = targetPath; ; current = path.dirname(current)) {
		try {
			ensureWithinRoot(await fs.realpath(current), realRoot, scheme);
			return;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		let isLink: boolean;
		try {
			isLink = (await fs.lstat(current)).isSymbolicLink();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			isLink = false;
		}
		if (isLink) throw new UrlContainmentError(`${scheme}:// URL goes through a dangling symlink`);
		if (current === realRoot || path.dirname(current) === current) return;
	}
}

/** Plain directory listing: directories first (`name/`), then files, by name; `(empty directory)` when empty. */
export function formatDirectoryListing(entries: ReadonlyArray<{ name: string; isDirectory: boolean }>): string {
	if (entries.length === 0) return "(empty directory)";
	return [...entries]
		.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
		.map(e => `${e.name}${e.isDirectory ? "/" : ""}`)
		.join("\n");
}

/**
 * Builds a text resource for a filesystem directory resolved by an internal URL handler.
 *
 * The resource is flagged immutable so the read tool never mints hashline edit
 * anchors against a directory listing — only file resources from the same
 * handler stay editable.
 */
export async function buildDirectoryResource(
	url: string,
	directoryPath: string,
	notes?: string[],
): Promise<InternalResource> {
	const entries = await fs.readdir(directoryPath, { withFileTypes: true });
	const content = formatDirectoryListing(entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })));
	return {
		url,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: directoryPath,
		immutable: true,
		...(notes ? { notes } : {}),
	};
}
