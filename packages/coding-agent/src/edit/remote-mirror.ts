/**
 * Hashline editing for remote text resources (`ssh://`): the native edit engine
 * patches local files, so a remote file is mirrored into a local file that
 * `read` tags and `edit` patches, and the patched text is written back through
 * the scheme's {@link RemoteEditHooks}. Mirrors are keyed by the canonical URL,
 * so every spelling of one remote file shares one mirror and one snapshot tag.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SchemeSpec } from "../internal-urls/types";

/** Mirror path → the canonical remote URL it stands for. */
const mirrors = new Map<string, string>();
/** Canonical remote URL → its mirror path. */
const mirrorsByUrl = new Map<string, string>();

/** Whether `spec` names remote text that `edit` may update in place through a mirror. */
export function isRemoteTextWritable(spec: SchemeSpec | undefined): boolean {
	return (
		spec?.backing === "remote" &&
		spec.write?.via === "handler" &&
		spec.write.payload === "text" &&
		spec.write.edits === "update"
	);
}

/**
 * Write `content` (the remote file's current text) to the mirror of the
 * canonical `url` and return the mirror's path. The file keeps the URL's name,
 * so language detection (and notebook projection) matches the remote file.
 */
export async function writeRemoteMirror(url: string, content: string): Promise<string> {
	const root = await fs.realpath(os.tmpdir());
	const name = path.posix.basename(new URL(url).pathname) || "file";
	const mirror = path.join(root, "omp-remote-edit", Bun.hash(url).toString(16), name);
	await Bun.write(mirror, content);
	mirrors.set(mirror, url);
	mirrorsByUrl.set(url, mirror);
	return mirror;
}

/** The mirror an earlier read or edit wrote for the canonical `url`, if any; never touches the remote host. */
export function remoteMirrorPath(url: string): string | undefined {
	return mirrorsByUrl.get(url);
}

/** The canonical remote URL `mirror` stands for, when it is a remote mirror. */
export function remoteMirrorUrl(mirror: string): string | undefined {
	return mirrors.get(mirror);
}
