import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

/** Canonical prefix for virtual tool-device URLs. */
export const XD_URL_PREFIX = "xd://";

export interface XdUrlTarget {
	name: string | null;
	query: string | null;
}

/**
 * Parse an `xd://` URL into its exact device target and optional root search.
 * Returns `null` for other or malformed URLs and `name: null` for the root.
 */
export function parseXdUrl(input: string): XdUrlTarget | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(XD_URL_PREFIX)) return null;
	const route = trimmed.slice(XD_URL_PREFIX.length);
	if (route.includes("#")) return null;
	const queryStart = route.indexOf("?");
	const encodedName = queryStart === -1 ? route : route.slice(0, queryStart);
	if (encodedName.includes("/")) return null;

	let name: string;
	try {
		name = decodeURIComponent(encodedName);
	} catch {
		return null;
	}

	if (queryStart === -1) return { name: name || null, query: null };
	const params = new URLSearchParams(route.slice(queryStart + 1));
	if ([...params.keys()].some(key => key !== "q") || params.getAll("q").length !== 1) return null;
	return { name: name || null, query: params.get("q") };
}

/** Build the canonical, reversible URL for an exact device name. */
export function xdevToolUrl(name: string): string {
	return `${XD_URL_PREFIX}${encodeURIComponent(name)}`;
}

/** Whether a streaming path prefix could still become an `xd://` URL. */
export function couldBecomeXdUrl(partialPath: string): boolean {
	if (partialPath.length <= XD_URL_PREFIX.length) {
		return XD_URL_PREFIX.startsWith(partialPath.toLowerCase());
	}
	return partialPath.toLowerCase().startsWith(XD_URL_PREFIX);
}

/** Routes session-bound virtual tool devices through `xd://` URLs. */
export class XdProtocolHandler implements ProtocolHandler {
	readonly scheme = "xd";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseXdUrl(url.rawHref ?? url.href);
		if (!target) throw new Error(`Invalid xd:// URL: ${url.href}. Use xd://, xd://?q=<term>, or xd://<tool>.`);
		if (target.name !== null && target.query !== null) {
			throw new Error("xd:// search queries are only valid on the catalog root: xd://?q=<term>.");
		}
		if (target.query !== null && target.query.trim().length === 0) {
			throw new Error("xd:// search requires a non-empty q parameter, for example xd://?q=github.");
		}
		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		const content = await context.xd.read(target.name, target.query ?? undefined);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = parseXdUrl(url.rawHref ?? url.href);
		if (!target) throw new Error(`Invalid xd:// URL: ${url.href}. Use xd://<tool>.`);
		if (target.query !== null) {
			throw new Error("Queries are not allowed on xd:// writes. Write to an exact xd://<tool> URL.");
		}
		if (target.name === null) {
			throw new Error("xd:// writes require an exact device URL: xd://<tool>.");
		}
		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		await context.xd.write(target.name, content);
	}
}
