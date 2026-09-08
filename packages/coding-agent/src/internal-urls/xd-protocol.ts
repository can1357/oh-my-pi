import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
	XdCatalogQuery,
} from "./types";

/** Canonical prefix for virtual tool-device URLs. */
export const XD_URL_PREFIX = "xd://";

/** Returns the canonical tool name from a bare or `xd://`-prefixed spelling. */
export function stripXdUrlPrefix(name: string): string {
	return name.toLowerCase().startsWith(XD_URL_PREFIX) ? name.slice(XD_URL_PREFIX.length) : name;
}

/**
 * Parse an `xd://` URL into its device target.
 * Returns `null` for other or malformed URLs and `name: null` for the root.
 */
export function parseXdUrl(input: string): { name: string | null } | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(XD_URL_PREFIX)) return null;
	const name = trimmed.slice(XD_URL_PREFIX.length);
	if (name.length === 0) return { name: null };
	if (/[/?#]/.test(name)) return null;
	return { name };
}

/** Parse only root catalog queries; exact device parsing deliberately stays separate. */
export function parseXdCatalogQuery(input: string): XdCatalogQuery | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(`${XD_URL_PREFIX}?`)) return null;
	const query = trimmed.slice(XD_URL_PREFIX.length + 1);
	if (query.includes("#")) throw new Error("xd:// catalog queries do not accept fragments.");
	try {
		decodeURIComponent(query.replace(/\+/g, " "));
	} catch {
		throw new Error("Invalid percent encoding in xd:// catalog query.");
	}
	const parameters = new URLSearchParams(query);
	const seen = new Set<string>();
	for (const key of parameters.keys()) {
		if (key !== "family" && key !== "q" && key !== "offset" && key !== "limit" && key !== "snapshot") {
			throw new Error(`Unknown xd:// catalog query field: ${key}. Allowed: family, q, offset, limit, snapshot.`);
		}
		if (seen.has(key)) throw new Error(`Duplicate xd:// catalog query field: ${key}.`);
		seen.add(key);
	}
	const offset = catalogInteger(parameters, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
	const limit = catalogInteger(parameters, "limit", 50, 1, 200);
	const family = parameters.get("family") ?? undefined;
	const snapshot = parameters.get("snapshot") ?? undefined;
	if (family === "") throw new Error("xd:// catalog family must not be empty; omit it to search all families.");
	if (snapshot === "") throw new Error("xd:// catalog snapshot must not be empty.");
	if (offset > 0 && snapshot === undefined) {
		throw new Error("xd:// catalog pagination requires the snapshot from the first page; start with offset=0.");
	}
	return { family, q: parameters.get("q") ?? undefined, offset, limit, snapshot };
}

function catalogInteger(parameters: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
	const value = parameters.get(key);
	if (value === null) return fallback;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`xd:// catalog ${key} must be an integer from ${min} to ${max}.`);
	}
	return parsed;
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
		const query = parseXdCatalogQuery(url.rawHref ?? url.href);
		if (query) {
			if (!context?.xd?.catalog) throw new Error("xd:// catalog lookup is not available in this session.");
			const content = await context.xd.catalog(query);
			return { url: url.href, content, contentType: "application/json", size: Buffer.byteLength(content) };
		}
		const target = parseXdUrl(url.href);
		if (!target) throw new Error(`Invalid xd:// URL: ${url.href}. Use xd:// or xd://<tool>.`);
		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		const content = await context.xd.read(target.name);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		if (parseXdCatalogQuery(url.rawHref ?? url.href))
			throw new Error("xd:// catalog queries are read-only; use read, not write.");
		const target = parseXdUrl(url.href);
		if (!target) throw new Error(`Invalid xd:// URL: ${url.href}. Use xd://<tool>.`);
		if (!context?.xd) throw new Error("xd:// is not mounted in this session.");
		await context.xd.write(target.name, content);
	}
}
