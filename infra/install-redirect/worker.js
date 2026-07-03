// Cloudflare Worker for oh-my-pk distribution — no GitHub Actions, no GitHub
// Releases, no billing.
//
// Routes:
//   /              /install /install.sh   -> proxy scripts/install.sh   (GitHub raw)
//   /install.ps1                          -> proxy scripts/install.ps1  (GitHub raw)
//   /version                              -> latest tag, from the private HF repo
//   /bin/<path>                           -> binary, from the private HF repo
//
// Binaries live in a PRIVATE Hugging Face repo (free storage, free egress). The
// repo stays private: this Worker holds the HF token as a secret and proxies
// downloads, so the installer never sees a token. Config via wrangler:
//   vars:    HF_REPO     e.g. "pkkidking/oh-my-pi-binaries"
//   secret:  HF_TOKEN    a read-scoped HF access token (wrangler secret put HF_TOKEN)
//   var (optional): HF_REPO_TYPE "models" (default) | "datasets"

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/kingkillery/oh-my-pi/main/scripts";

function hfResolveUrl(env, repoPath) {
	const repoType = env.HF_REPO_TYPE === "datasets" ? "datasets/" : "";
	const revision = env.HF_REVISION || "main";
	// `repoPath` is the path inside the repo, e.g. "VERSION" or "v16.1.8/omp-linux-x64".
	return `https://huggingface.co/${repoType}${env.HF_REPO}/resolve/${revision}/${repoPath}`;
}

async function proxyInstallScript(target, request) {
	const upstream = await fetch(target, { headers: { "User-Agent": "oh-my-pk-install-redirect" } });
	if (!upstream.ok) {
		return new Response(`Failed to fetch installer: ${upstream.status}`, { status: 502 });
	}
	const publicBase = new URL(request.url).origin;
	const text = (await upstream.text()).replaceAll("https://oh-my-pi.pkking.computer", publicBase);
	const headers = new Headers(upstream.headers);
	headers.set("Cache-Control", "public, max-age=60");
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Content-Type", "text/plain; charset=utf-8");
	return new Response(text, { status: upstream.status, headers });
}

async function proxyHf(env, repoPath, { cacheSeconds, ctx, request }) {
	if (!env.HF_REPO || !env.HF_TOKEN) {
		return new Response("Distribution backend not configured (HF_REPO/HF_TOKEN).", { status: 503 });
	}
	// Edge-cache successful binary/version responses so repeated installs do not
	// re-hit Hugging Face. Keyed by the public request URL.
	const cache = caches.default;
	const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	// `resolve` 302-redirects private LFS objects to a pre-signed CDN URL that needs
	// no auth, so following the redirect (default) is safe — the token only unlocks
	// the initial resolve and is never forwarded to the public install client.
	const upstream = await fetch(hfResolveUrl(env, repoPath), {
		headers: { Authorization: `Bearer ${env.HF_TOKEN}`, "User-Agent": "oh-my-pk-install-redirect" },
	});
	if (!upstream.ok) {
		return new Response(`Asset not found: ${repoPath} (${upstream.status})`, { status: upstream.status === 404 ? 404 : 502 });
	}

	const headers = new Headers();
	headers.set("Cache-Control", `public, max-age=${cacheSeconds}`);
	headers.set("Access-Control-Allow-Origin", "*");
	const contentType = upstream.headers.get("Content-Type");
	if (contentType) headers.set("Content-Type", contentType);
	const contentLength = upstream.headers.get("Content-Length");
	if (contentLength) headers.set("Content-Length", contentLength);

	const response = new Response(upstream.body, { status: 200, headers });
	if (ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

export default {
	async fetch(request, env, ctx) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405 });
		}
		const url = new URL(request.url);
		const pathname = url.pathname;

		switch (pathname) {
			case "/":
			case "/install":
			case "/install.sh":
				return proxyInstallScript(`${GITHUB_RAW_BASE}/install.sh`, request);
			case "/install.ps1":
				return proxyInstallScript(`${GITHUB_RAW_BASE}/install.ps1`, request);
			case "/version":
				// Short cache: the version pointer changes every release.
				return proxyHf(env, "VERSION", { cacheSeconds: 60, ctx, request });
		}

		if (pathname.startsWith("/bin/")) {
			const repoPath = decodeURIComponent(pathname.slice("/bin/".length));
			// Reject path traversal; binaries are addressed as "<tag>/<file>".
			if (!repoPath || repoPath.includes("..")) {
				return new Response("Bad request", { status: 400 });
			}
			// Binaries are immutable per tag → cache hard.
			return proxyHf(env, repoPath, { cacheSeconds: 86400, ctx, request });
		}

		return new Response("Not found", { status: 404 });
	},
};
