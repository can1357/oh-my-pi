/**
 * Hashline editing for remote text resources (`ssh://`): the native edit engine
 * patches local files, so a remote file is mirrored into a local file that
 * `read` tags and `edit` patches, and the patched text is written back through
 * the scheme's {@link RemoteEditHooks}. A mirror is keyed by the destination a
 * URL resolved to and the absolute path there, never by the URL as written, so
 * every spelling of one remote file (`/~/x` and `/home/u/x`, `Prod` and `prod`)
 * shares one mirror and one snapshot tag, while one URL that resolves to
 * different hosts (a per-project `ssh.json` alias) never does.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RemoteEditLocation, SchemeSpec } from "../internal-urls/types";

/** Mirror path → the canonical remote URL it stands for. */
const mirrors = new Map<string, string>();
/** Location key → its mirror path. */
const mirrorsByLocation = new Map<string, string>();

const locationKey = (location: RemoteEditLocation) => `${location.target}\n${location.path}`;

/**
 * The preview entry that stands in for a remote file whose preview waits for the
 * edit's fetch (no mirror existed before the call ran). It rides the entry's
 * `error` field, the only text a preview entry carries, but it is not a failure:
 * `edit.streamingAbort` skips it.
 */
export const DEFERRED_PREVIEW_NOTICE = "Preview deferred: fetched when the edit runs";

/** Characters no Windows filename may contain (`/` and NUL are invalid everywhere). */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A local filename for the mirror of `url` that keeps the remote file's name, and
 * so its extension (language detection, notebook projection), wherever the
 * name is a valid local filename on every platform.
 */
function mirrorFileName(url: string): string {
	let name = path.posix.basename(new URL(url).pathname);
	try {
		name = decodeURIComponent(name);
	} catch {
		// Keep the encoded spelling.
	}
	name = name.replace(INVALID_FILENAME_CHARS, "_").replace(/[. ]+$/, "_");
	if (!name || name === "." || name === "..") return "file";
	return RESERVED_WINDOWS_NAME.test(name) ? `_${name}` : name;
}

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
 * Write `content` (the remote file's current text) to the mirror of `location`
 * and return the mirror's path.
 */
export async function writeRemoteMirror(location: RemoteEditLocation, content: string): Promise<string> {
	const root = await fs.realpath(os.tmpdir());
	const key = locationKey(location);
	const mirror = path.join(root, "omp-remote-edit", Bun.hash(key).toString(16), mirrorFileName(location.url));
	await Bun.write(mirror, content);
	mirrors.set(mirror, location.url);
	mirrorsByLocation.set(key, mirror);
	return mirror;
}

/** The mirror an earlier read or edit wrote for `location`, if any; never touches the remote host. */
export function remoteMirrorPath(location: RemoteEditLocation): string | undefined {
	return mirrorsByLocation.get(locationKey(location));
}

/** The canonical remote URL `mirror` stands for, when it is a remote mirror. */
export function remoteMirrorUrl(mirror: string): string | undefined {
	return mirrors.get(mirror);
}
