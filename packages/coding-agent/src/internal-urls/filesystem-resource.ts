import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";
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

/**
 * Throw `<scheme>:// URL escapes <scheme> root[: <url>]` unless `targetPath` is `rootPath` or lies beneath it.
 * The message names the URL, never the on-disk path.
 */
export function ensureWithinRoot(targetPath: string, rootPath: string, scheme: string, url?: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new UrlContainmentError(`${scheme}:// URL escapes ${scheme} root${url ? `: ${url}` : ""}`);
	}
}

/**
 * Realpath of an existing `targetPath` under the already-realpathed `realRoot`,
 * checking the lexical target, its real parent (when it exists), and its real
 * path for containment so symlinks cannot escape the root. Returns `undefined`
 * when the target does not exist; write paths use {@link ensureCreatableWithinRoot}.
 * Escape errors name `url`.
 */
export async function containedRealPath(
	targetPath: string,
	realRoot: string,
	scheme: string,
	url: string,
): Promise<string | undefined> {
	ensureWithinRoot(targetPath, realRoot, scheme, url);
	if (targetPath !== realRoot) {
		try {
			ensureWithinRoot(await fs.realpath(path.dirname(targetPath)), realRoot, scheme, url);
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
	ensureWithinRoot(realTargetPath, realRoot, scheme, url);
	return realTargetPath;
}

/**
 * Throw {@link UrlContainmentError} unless creating `targetPath` (lexically under
 * the already-realpathed `realRoot`) stays inside the root: the deepest existing
 * entry on the way must canonically resolve within it, and no entry may be a
 * dangling symlink a `mkdir -p` + write would follow out of the root. Errors name
 * `url`, never the on-disk path; symlink loops and file ancestors fail closed.
 */
export async function ensureCreatableWithinRoot(
	targetPath: string,
	realRoot: string,
	scheme: string,
	url: string,
): Promise<void> {
	ensureWithinRoot(targetPath, realRoot, scheme, url);
	for (let current = targetPath; ; current = path.dirname(current)) {
		try {
			ensureWithinRoot(await fs.realpath(current), realRoot, scheme, url);
			return;
		} catch (error) {
			if (hasFsCode(error, "ELOOP")) {
				throw new UrlContainmentError(`${scheme}:// URL goes through a symlink loop: ${url}`);
			}
			if (isEnotdir(error)) throw new Error(`${scheme}:// URL goes through a file, not a directory: ${url}`);
			if (!isEnoent(error)) throw error;
		}
		let isLink: boolean;
		try {
			isLink = (await fs.lstat(current)).isSymbolicLink();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			isLink = false;
		}
		if (isLink) throw new UrlContainmentError(`${scheme}:// URL goes through a dangling symlink: ${url}`);
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
