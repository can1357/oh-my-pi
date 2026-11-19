/**
 * Hashline editing for remote text resources (`ssh://`): the native edit engine
 * patches local files, so a remote file is fetched into a local mirror that
 * `read` tags and `edit` patches, and the patched text is written back through
 * the scheme's handler.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SchemeSpec } from "../internal-urls/types";

/** Mirror path → the remote URL it stands for. */
const mirrors = new Map<string, string>();

/** Whether `spec` names remote text written whole through its handler, so `edit` may patch it via a mirror. */
export function isRemoteTextWritable(spec: SchemeSpec | undefined): boolean {
	return spec?.backing === "remote" && spec.write?.via === "handler" && spec.write.payload === "text";
}

/**
 * Write `content` (the remote file's current text) to the mirror of `url` and
 * return the mirror's path. The file keeps the URL's name, so language
 * detection matches the remote file.
 */
export async function writeRemoteMirror(url: string, content: string): Promise<string> {
	const root = await fs.realpath(os.tmpdir());
	const name = path.posix.basename(new URL(url).pathname) || "file";
	const mirror = path.join(root, "omp-remote-edit", Bun.hash(url).toString(16), name);
	await Bun.write(mirror, content);
	mirrors.set(mirror, url);
	return mirror;
}

/** The remote URL `mirror` stands for, when it is a remote mirror. */
export function remoteMirrorUrl(mirror: string): string | undefined {
	return mirrors.get(mirror);
}
