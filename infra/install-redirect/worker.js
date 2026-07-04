// Cloudflare Worker for oh-my-pk distribution — no GitHub Actions, no GitHub
// Releases, no billing.
//
// Routes:
//   /                                      -> landing page
//   /install /install.sh                  -> proxy scripts/install.sh   (GitHub raw)
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

function landingPage(request) {
	const origin = new URL(request.url).origin;
	const installSh = `curl -fsSL ${origin}/install.sh | sh`;
	const installPs = `irm ${origin}/install.ps1 | iex`;
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>oh-my-pk</title>
<meta name="description" content="oh-my-pk is a fast coding-agent CLI with install, update, RPC, ACP, and TUI surfaces.">
<style>
:root { color-scheme: dark; --bg: #080a0f; --panel: #101521; --text: #eef4ff; --muted: #9da8ba; --line: #233044; --accent: #79ffe1; --pink: #ff7ad9; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; font: 16px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; color: var(--text); background: radial-gradient(circle at 15% 10%, #1f3358 0, transparent 34rem), radial-gradient(circle at 90% 20%, #47234f 0, transparent 30rem), var(--bg); }
main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 72px 0 48px; }
.hero { display: grid; gap: 28px; grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr); align-items: center; }
.eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .18em; font-size: 12px; font-weight: 800; }
h1 { margin: 12px 0 16px; font-size: clamp(48px, 9vw, 92px); line-height: .9; letter-spacing: -.07em; }
.lead { color: var(--muted); font-size: clamp(18px, 2vw, 22px); max-width: 680px; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
a.button { color: #06100e; background: var(--accent); border: 1px solid var(--accent); text-decoration: none; padding: 12px 16px; border-radius: 999px; font-weight: 800; }
a.ghost { color: var(--text); background: transparent; border-color: var(--line); }
.card { background: color-mix(in srgb, var(--panel), transparent 8%); border: 1px solid var(--line); border-radius: 24px; padding: 22px; box-shadow: 0 24px 80px #0008; }
.terminal { font: 14px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; color: #c9f7ee; background: #03060a; border: 1px solid #1a2838; border-radius: 18px; padding: 18px; overflow-x: auto; }
.prompt { color: var(--pink); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 36px; }
.feature h2 { margin: 0 0 8px; font-size: 17px; }
.feature p { margin: 0; color: var(--muted); font-size: 14px; }
.links { margin-top: 28px; color: var(--muted); font-size: 14px; }
.links a { color: var(--accent); }
@media (max-width: 820px) { .hero, .grid { grid-template-columns: 1fr; } main { padding-top: 42px; } }
</style>
</head>
<body>
<main>
<section class="hero">
<div>
<div class="eyebrow">canonical CLI · install endpoint live</div>
<h1>oh-my-pk</h1>
<p class="lead">A coding-agent CLI with a terminal TUI, one-shot prompts, RPC/ACP surfaces, built-in tools, skills-on-request, and fast local workflows.</p>
<div class="actions">
<a class="button" href="/install.sh">Install for macOS/Linux</a>
<a class="button ghost" href="/install.ps1">Install for Windows</a>
<a class="button ghost" href="https://github.com/kingkillery/oh-my-pi">GitHub</a>
</div>
</div>
<div class="card">
<div class="terminal"><span class="prompt">$</span> ${escapeHtml(installSh)}<br><br><span class="prompt">PS&gt;</span> ${escapeHtml(installPs)}<br><br><span class="prompt">$</span> oh-my-pk</div>
</div>
</section>
<section class="grid">
<div class="card feature"><h2>Context-preserving</h2><p>Skills are discovered on request instead of dumped into every prompt.</p></div>
<div class="card feature"><h2>Multiple surfaces</h2><p>Use the TUI, one-shot mode, RPC, or ACP from editors and automation.</p></div>
<div class="card feature"><h2>Private binary distribution</h2><p>This Worker serves installers, versions, and binaries without exposing storage tokens.</p></div>
</section>
<p class="links">Endpoints: <a href="/version">/version</a> · <a href="/install.sh">/install.sh</a> · <a href="/install.ps1">/install.ps1</a>. Legacy alias: <code>oh-my-pi.pkking.computer</code>.</p>
</main>
</body>
</html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "public, max-age=300",
		},
	});
}

function escapeHtml(value) {
	return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
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
				return landingPage(request);
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
