/**
 * Serves the static collab-web guest client with security headers.
 *
 * The room key rides in the URL fragment of the client page, so XSS there is
 * room compromise. HTML responses get the build-generated CSP (`/csp.txt`,
 * whose inline-script hashes are computed from the built page by
 * `scripts/generate-csp.ts`) plus no-referrer and nosniff. Non-HTML assets
 * pass through untouched so hashed js/css keep their asset-layer headers.
 */

export interface ClientAssets {
	fetch(request: Request): Promise<Response>;
}

const CSP_ASSET_PATH = "/csp.txt";

export async function serveClientAsset(request: Request, assets: ClientAssets): Promise<Response> {
	const asset = await assetOrSpa(request, assets);
	const contentType = asset.headers.get("Content-Type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("text/html")) return asset;
	const headers = new Headers(asset.headers);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	const csp = await loadClientCsp(request, assets);
	if (csp) headers.set("Content-Security-Policy", csp);
	return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

/** CSP is fail-open: a missing or malformed csp.txt serves the page without one rather than bricking it. */
async function loadClientCsp(request: Request, assets: ClientAssets): Promise<string | null> {
	const url = new URL(request.url);
	url.pathname = CSP_ASSET_PATH;
	url.search = "";
	const response = await assets.fetch(new Request(url, { headers: { Accept: "text/plain" } }));
	if (!response.ok) return null;
	const csp = (await response.text()).trim();
	return csp.startsWith("default-src ") ? csp : null;
}

async function assetOrSpa(request: Request, assets: ClientAssets): Promise<Response> {
	const asset = await assets.fetch(request);
	if (asset.status !== 404 || request.method !== "GET") return asset;
	const rootUrl = new URL(request.url);
	rootUrl.pathname = "/";
	rootUrl.search = "";
	return assets.fetch(new Request(rootUrl, { headers: request.headers }));
}
