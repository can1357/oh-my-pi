/**
 * Hashline editing for remote text resources (`ssh://`): the native edit engine
 * patches local files, so a remote file is fetched into a local mirror that
 * `read` tags and `edit` patches, and the patched text is written back through
 * the scheme's handler.
 *
 * Sessions resolve a scheme through their own routers, so one URL can name
 * different resources in two sessions (RPC host URIs). A mirror belongs to the
 * handler registration that served it: its path is keyed by that registration
 * and the URL, and only a router that resolves the URL to the same registration
 * may write it back.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractUriScheme } from "../internal-urls/parse";
import { type InternalUrlRouter, registrationId } from "../internal-urls/router";
import type { ProtocolHandler, SchemeSpec } from "../internal-urls/types";

/** Mirror path → the remote URL it stands for and the handler registration that served it. */
const mirrors = new Map<string, { url: string; owner: ProtocolHandler }>();

/** Whether `spec` names remote text written whole through its handler, so `edit` may patch it via a mirror. */
export function isRemoteTextWritable(spec: SchemeSpec | undefined): boolean {
	return spec?.backing === "remote" && spec.write?.via === "handler" && spec.write.payload === "text";
}

/** The handler `router` resolves `url`'s scheme to; throws for a URL of a scheme it does not handle. */
function ownerOf(url: string, router: InternalUrlRouter): ProtocolHandler {
	const scheme = extractUriScheme(url);
	const owner = scheme === undefined ? undefined : router.getHandler(scheme);
	if (!owner) throw new Error(`No handler serves ${url}`);
	return owner;
}

/**
 * Write `content` (the remote file's current text) to the mirror of `url` as
 * `router` resolves it, and return the mirror's path. The file keeps the URL's
 * name, so language detection matches the remote file.
 */
export async function writeRemoteMirror(url: string, content: string, router: InternalUrlRouter): Promise<string> {
	const owner = ownerOf(url, router);
	const root = await fs.realpath(os.tmpdir());
	const name = path.posix.basename(new URL(url).pathname) || "file";
	const key = Bun.hash(`${registrationId(owner)}\0${url}`).toString(16);
	const mirror = path.join(root, "omp-remote-edit", key, name);
	await Bun.write(mirror, content);
	mirrors.set(mirror, { url, owner });
	return mirror;
}

/**
 * The remote URL `mirror` stands for, when it is a remote mirror. Throws when
 * `router` resolves that URL to another registration than the one that served
 * the mirror: its text belongs to another session's resource.
 */
export function remoteMirrorUrl(mirror: string, router: InternalUrlRouter): string | undefined {
	const entry = mirrors.get(mirror);
	if (!entry) return undefined;
	if (ownerOf(entry.url, router) !== entry.owner) {
		throw new Error(`${mirror} mirrors ${entry.url} as another session resolves it`);
	}
	return entry.url;
}
