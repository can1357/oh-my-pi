const SHARE_VIEWER_PATH_RE = /^\/s\/([A-Za-z0-9_-]{10,64})\/?$/;
const SHARE_RAW_PATH_RE = /^\/s\/([A-Za-z0-9_-]{10,64})\/raw\/?$/;
const SHARE_KEY_PREFIX = "shares/";
const SHARE_VIEWER_ASSET_PATH = "/share-viewer/";
const SHARE_VIEWER_CSP_ASSET_PATH = "/share-viewer/csp.txt";
const MAX_SHARE_BYTES = 1_000_000;
export const SHARE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface SharePutOptions {
	readonly httpMetadata: {
		readonly contentType: string;
		readonly cacheControl: string;
	};
	readonly customMetadata: {
		readonly createdAt: string;
	};
}

export interface StoredShare {
	readonly body: ReadableStream;
	readonly uploaded: Date;
	readonly httpEtag?: string;
	readonly size?: number;
}

export interface ListedShare {
	readonly key: string;
	readonly uploaded: Date;
}

export interface ShareListing {
	readonly objects: readonly ListedShare[];
	readonly truncated: boolean;
	readonly cursor?: string;
}

export interface ShareAssetBinding {
	fetch(request: Request): Promise<Response>;
}

export interface ShareBucketBinding {
	get(key: string): Promise<StoredShare | null>;
	put(key: string, body: Uint8Array, options: SharePutOptions): Promise<unknown>;
	delete(keys: string | string[]): Promise<void>;
	list(options: { readonly prefix: string; readonly limit: number; readonly cursor?: string }): Promise<ShareListing>;
}

export interface ShareServiceDependencies {
	readonly assets: ShareAssetBinding;
	readonly shares: ShareBucketBinding;
	readonly claimUpload: (request: Request) => Promise<Response | null>;
	readonly now?: () => number;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function methodNotAllowed(allow: string): Response {
	return new Response("method not allowed", { status: 405, headers: { Allow: allow, "Cache-Control": "no-store" } });
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomShareId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return `r_${base64Url(bytes)}`;
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
	const contentLength = request.headers.get("Content-Length");
	if (contentLength !== null) {
		const parsed = Number(contentLength);
		if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_SHARE_BYTES) return null;
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > MAX_SHARE_BYTES) {
				await reader.cancel("share exceeds size limit");
				return null;
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function uploadShare(request: Request, deps: ShareServiceDependencies): Promise<Response> {
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType !== "application/octet-stream") {
		return json({ error: "share uploads require application/octet-stream" }, 415);
	}
	const limit = await deps.claimUpload(request);
	if (limit) return limit;
	const body = await readBoundedBody(request);
	if (!body || body.byteLength <= 12) return json({ error: "share body exceeds the 1 MB limit or is truncated" }, 413);
	const id = randomShareId();
	const createdAt = new Date((deps.now ?? Date.now)()).toISOString();
	await deps.shares.put(`${SHARE_KEY_PREFIX}${id}`, body, {
		httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, max-age=0" },
		customMetadata: { createdAt },
	});
	return json({ id }, 201);
}

async function serveShareViewer(request: Request, assets: ShareAssetBinding): Promise<Response> {
	const viewerUrl = new URL(request.url);
	viewerUrl.pathname = SHARE_VIEWER_ASSET_PATH;
	viewerUrl.search = "";
	const cspUrl = new URL(viewerUrl);
	cspUrl.pathname = SHARE_VIEWER_CSP_ASSET_PATH;
	const [asset, cspAsset] = await Promise.all([
		assets.fetch(new Request(viewerUrl, { headers: { Accept: "text/html" } })),
		assets.fetch(new Request(cspUrl, { headers: { Accept: "text/plain" } })),
	]);
	if (!asset.ok || !cspAsset.ok) return json({ error: "share viewer unavailable" }, 503);
	const csp = (await cspAsset.text()).trim();
	if (!csp.startsWith("default-src ")) return json({ error: "share viewer unavailable" }, 503);
	const headers = new Headers(asset.headers);
	headers.set("Cache-Control", "public, max-age=300");
	headers.set("Content-Security-Policy", csp);
	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
	return new Response(asset.body, { status: 200, headers });
}

async function deleteExpiredShare(key: string, shares: ShareBucketBinding): Promise<void> {
	try {
		await shares.delete(key);
	} catch {
		// Read-time expiry is fail-closed; the scheduled sweep can retry deletion.
	}
}

async function downloadShare(id: string, deps: ShareServiceDependencies): Promise<Response> {
	const key = `${SHARE_KEY_PREFIX}${id}`;
	const object = await deps.shares.get(key);
	if (!object) return new Response("share not found", { status: 404, headers: { "Cache-Control": "no-store" } });
	const uploadedAt = object.uploaded.getTime();
	const now = (deps.now ?? Date.now)();
	if (!Number.isFinite(uploadedAt) || uploadedAt + SHARE_RETENTION_MS <= now) {
		await deleteExpiredShare(key, deps.shares);
		return new Response("share expired", { status: 410, headers: { "Cache-Control": "no-store" } });
	}
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Content-Type": "application/octet-stream",
		"X-Content-Type-Options": "nosniff",
	});
	if (object.httpEtag) headers.set("ETag", object.httpEtag);
	if (object.size !== undefined) headers.set("Content-Length", String(object.size));
	return new Response(object.body, { headers });
}

export async function handleShareRequest(request: Request, deps: ShareServiceDependencies): Promise<Response | null> {
	const pathname = new URL(request.url).pathname;
	if (pathname === "/s" || pathname === "/s/") {
		return request.method === "POST" ? uploadShare(request, deps) : methodNotAllowed("POST");
	}
	const rawMatch = SHARE_RAW_PATH_RE.exec(pathname);
	if (rawMatch) return request.method === "GET" ? downloadShare(rawMatch[1]!, deps) : methodNotAllowed("GET");
	if (SHARE_VIEWER_PATH_RE.test(pathname)) {
		return request.method === "GET" ? serveShareViewer(request, deps.assets) : methodNotAllowed("GET");
	}
	return null;
}

export async function pruneShares(shares: ShareBucketBinding, now = Date.now()): Promise<void> {
	const cutoff = now - SHARE_RETENTION_MS;
	let cursor: string | undefined;
	do {
		const listing = await shares.list({ prefix: SHARE_KEY_PREFIX, limit: 1_000, cursor });
		const expired = listing.objects
			.filter(object => !Number.isFinite(object.uploaded.getTime()) || object.uploaded.getTime() <= cutoff)
			.map(object => object.key);
		if (expired.length > 0) await shares.delete(expired);
		cursor = listing.truncated ? listing.cursor : undefined;
	} while (cursor);
}
