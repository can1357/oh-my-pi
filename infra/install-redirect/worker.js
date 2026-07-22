// Cloudflare Worker for the Hugging Face-backed oh-my-pk installer channel.
// This route is independent of the GitHub Actions/GitHub Releases channel.
//
// Routes:
//   /                                      -> landing page
//   /install /install.sh                  -> proxy scripts/install.sh   (GitHub raw)
//   /install.ps1                          -> proxy scripts/install.ps1  (GitHub raw)
//   /version                              -> latest tag, from the private HF repo
//   /bin/<path>                           -> binary, from the private HF repo
//   /collab/*                             -> product-hosted collab browser client
//
// Binaries live in a PRIVATE Hugging Face repo (free storage, free egress). The
// repo stays private: this Worker holds the HF token as a secret and proxies
// downloads, so the installer never sees a token. Config via wrangler:
//   vars:    HF_REPO     e.g. "pkkidking/oh-my-pi-binaries"
//   secret:  HF_TOKEN    a read-scoped HF access token (wrangler secret put HF_TOKEN)
//   var (optional): HF_REPO_TYPE "models" (default) | "datasets"
//   service: COLLAB      ompk-collab Worker binding

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
	const url = new URL(request.url);
	const isApex = url.hostname === "pkking.computer";
	const cliOrigin = isApex ? "https://oh-my-pk.pkking.computer" : url.origin;
	const installSh = `curl -fsSL ${cliOrigin}/install.sh | sh`;
	const installPs = `irm ${cliOrigin}/install.ps1 | iex`;
	const title = isApex ? "pkking.computer" : "oh-my-pk";
	const eyebrow = isApex ? "private project domain" : "canonical CLI · install endpoint live";
	const heading = isApex ? "pkking.computer" : "oh-my-pk";
	const lead = isApex
		? "A small personal project domain for tools, experiments, and private infrastructure. The public thing here today is oh-my-pk."
		: "A coding-agent CLI with a terminal TUI, one-shot prompts, RPC/ACP surfaces, built-in tools, skills-on-request, and fast local workflows.";
	const primaryHref = isApex ? "https://oh-my-pk.pkking.computer" : "/install.sh";
	const primaryLabel = isApex ? "Open oh-my-pk" : "Install for macOS/Linux";
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(lead)}">
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
<div class="eyebrow">${escapeHtml(eyebrow)}</div>
<h1>${escapeHtml(heading)}</h1>
<p class="lead">${escapeHtml(lead)}</p>
<div class="actions">
<a class="button" href="${escapeHtml(primaryHref)}">${escapeHtml(primaryLabel)}</a>
<a class="button ghost" href="${escapeHtml(cliOrigin)}/docs">Documentation</a>
<a class="button ghost" href="${escapeHtml(cliOrigin)}/install.ps1">Install for Windows</a>
<a class="button ghost" href="https://github.com/kingkillery/oh-my-pk">GitHub</a>
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
<p class="links">Endpoints: <a href="${escapeHtml(cliOrigin)}/docs">/docs</a> · <a href="${escapeHtml(cliOrigin)}/version">/version</a> · <a href="${escapeHtml(cliOrigin)}/install.sh">/install.sh</a> · <a href="${escapeHtml(cliOrigin)}/install.ps1">/install.ps1</a>. Canonical CLI host: <code>oh-my-pk.pkking.computer</code>.</p>
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

const DOCS_REPO = "kingkillery/oh-my-pk";
const DOCS_REF = "main";
const DOCS_TREE_BASE = `https://github.com/${DOCS_REPO}/tree/${DOCS_REF}/docs`;
const DOCS_RAW_BASE = `https://raw.githubusercontent.com/${DOCS_REPO}/${DOCS_REF}/docs`;

function rawDocUrl(path) {
	return `${DOCS_RAW_BASE}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function docLink(path, label = path) {
	return `<li><a href="/docs/${escapeHtml(path.replace(/\.md$/i, ""))}">${escapeHtml(label)}</a></li>`;
}

function docsSection(title, links) {
	return `<section class="card docs-section"><h2>${escapeHtml(title)}</h2><ul>${links.map(link => docLink(...link)).join("")}</ul></section>`;
}

function docsPage(request) {
	const url = new URL(request.url);
	const cliOrigin = url.hostname === "pkking.computer" ? "https://oh-my-pk.pkking.computer" : url.origin;
	const lead = "User guides, configuration reference, tools, integration surfaces, and architecture notes for the canonical oh-my-pk CLI.";
	const sections = [
		docsSection("Start here", [
			["settings.md", "Settings and config.yml"],
			["environment-variables.md", "Environment variables"],
			["models.md", "Models and models.yml"],
			["providers.md", "Providers and credentials"],
			["help.md", "Built-in feature help"],
			["keybindings.md", "Keybindings"],
			["theme.md", "Themes and appearance"],
			["context-files.md", "Context files"],
		]),
		docsSection("Daily workflows", [
			["session.md", "Sessions and resume"],
			["session-operations-export-share-fork-resume.md", "Export, share, fork, and resume"],
			["approval-mode.md", "Approval modes"],
			["compaction.md", "Compaction"],
			["memory.md", "Memory"],
			["advisor-watchdog.md", "Advisor and watchdog"],
			["cost-performance-tuning.md", "Cost and performance tuning"],
			["ethereal-workspaces.md", "Ethereal workspaces"],
			["session-switching-and-recent-listing.md", "Session switching and recent listing"],
			["tree.md", "Session tree"],
		]),
		docsSection("Tools and skills", [
			["custom-tools.md", "Custom tools"],
			["skills.md", "Skills"],
			["hooks.md", "Hooks"],
			["mcp-config.md", "MCP configuration"],
			["mcp-server-tool-authoring.md", "MCP server and tool authoring"],
			["lsp-config.md", "LSP configuration"],
			["python-repl.md", "Python REPL"],
			["notebook-tool-runtime.md", "Notebook tool runtime"],
			["resolve-tool-runtime.md", "Resolve tool runtime"],
			["bash-tool-runtime.md", "Bash tool runtime"],
		]),
		docsSection("Collaboration and remote", [
			["collab.md", "Collab sessions and browser client"],
			["environments-cloud.md", "Environments cloud"],
			["fork-boundaries.md", "Fork boundaries"],
			["multi-agent-fork-collaboration.md", "Multi-agent collaboration"],
			["task-agent-discovery.md", "Task agent discovery"],
			["task-contract-orchestration.md", "Task contract orchestration"],
			["capture-to-agent.md", "Capture to agent"],
		]),
		docsSection("Tool reference", [
			["tools/read.md", "read"],
			["tools/write.md", "write"],
			["tools/edit.md", "edit"],
			["tools/ast-edit.md", "ast_edit"],
			["tools/search.md", "search"],
			["tools/find.md", "find"],
			["tools/bash.md", "bash"],
			["tools/eval.md", "eval"],
			["tools/lsp.md", "lsp"],
			["tools/debug.md", "debug"],
			["tools/browser.md", "browser"],
			["tools/github.md", "github"],
			["tools/web_search.md", "web_search"],
			["tools/task.md", "task"],
			["tools/search_tool_bm25.md", "search_tool_bm25"],
			["tools/context-layer.md", "Context layer"],
		]),
		docsSection("Extensions and integrations", [
			["extensions.md", "Extensions"],
			["extension-loading.md", "Extension loading"],
			["marketplace.md", "Marketplace"],
			["gemini-manifest-extensions.md", "Gemini manifest extensions"],
			["auth-broker-gateway.md", "Auth broker and gateway"],
			["rpc.md", "RPC"],
			["sdk.md", "SDK"],
			["adding-a-provider.md", "Adding a provider"],
		]),
		docsSection("Model dialects", [
			["toolconv/anthropic.md", "Anthropic"],
			["toolconv/deepseek.md", "DeepSeek"],
			["toolconv/gemini.md", "Gemini"],
			["toolconv/gemma.md", "Gemma"],
			["toolconv/glm-4.5.md", "GLM 4.5"],
			["toolconv/harmony.md", "Harmony"],
			["toolconv/kimi-k2.md", "Kimi K2"],
			["toolconv/pi-native.md", "Pi native"],
			["toolconv/qwen3.md", "Qwen3"],
		]),
		docsSection("Architecture and internals", [
			["natives-architecture.md", "Native architecture"],
			["natives-binding-contract.md", "Native binding contract"],
			["provider-streaming-internals.md", "Provider streaming internals"],
			["provider-endpoint-constraints.md", "Provider endpoint constraints"],
			["tui.md", "TUI"],
			["tui-core-renderer.md", "TUI core renderer"],
			["mcp-protocol-transports.md", "MCP protocol transports"],
			["mcp-runtime-lifecycle.md", "MCP runtime lifecycle"],
			["porting-from-pi-mono.md", "Porting from Pi"],
			["porting-to-natives.md", "Porting to natives"],
		]),
		docsSection("Operations", [
			["RELEASING-FORK.md", "Fork releases"],
			["macos-signing-notarization.md", "macOS signing and notarization"],
			["install-id.md", "Install identity"],
			["config-usage.md", "Config usage"],
			["local-models.md", "Local models"],
			["handoff-generation-pipeline.md", "Handoff generation pipeline"],
			["blob-artifact-architecture.md", "Blob artifact architecture"],
			["fs-scan-cache-architecture.md", "Filesystem scan cache architecture"],
		]),
	].join("");
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>oh-my-pk documentation</title>
<meta name="description" content="${escapeHtml(lead)}">
<style>
:root { color-scheme: dark; --bg: #080a0f; --panel: #101521; --text: #eef4ff; --muted: #9da8ba; --line: #233044; --accent: #79ffe1; --pink: #ff7ad9; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; font: 16px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; color: var(--text); background: radial-gradient(circle at 15% 10%, #1f3358 0, transparent 34rem), radial-gradient(circle at 90% 20%, #47234f 0, transparent 30rem), var(--bg); }
main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0; }
.eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .18em; font-size: 12px; font-weight: 800; }
h1 { margin: 12px 0 16px; font-size: clamp(42px, 8vw, 72px); line-height: .95; letter-spacing: -.06em; }
.lead { color: var(--muted); font-size: clamp(17px, 2vw, 21px); max-width: 760px; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
a.button { color: #06100e; background: var(--accent); border: 1px solid var(--accent); text-decoration: none; padding: 11px 15px; border-radius: 999px; font-weight: 800; }
a.ghost { color: var(--text); background: transparent; border-color: var(--line); }
.card { background: color-mix(in srgb, var(--panel), transparent 8%); border: 1px solid var(--line); border-radius: 22px; padding: 20px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 30px; }
.docs-section h2 { margin: 0 0 10px; font-size: 18px; }
.docs-section ul { columns: 2; gap: 32px; margin: 0; padding-left: 20px; color: var(--muted); }
.docs-section li { break-inside: avoid; margin: 5px 0; }
.docs-section a { color: var(--accent); text-decoration: none; }
.docs-section a:hover { text-decoration: underline; }
.note { margin-top: 24px; color: var(--muted); font-size: 14px; }
.note a { color: var(--accent); }
@media (max-width: 820px) { main { padding-top: 36px; } .grid { grid-template-columns: 1fr; } .docs-section ul { columns: 1; } }
</style>
</head>
<body>
<main>
<div class="eyebrow">documentation</div>
<h1>oh-my-pk docs</h1>
<p class="lead">${escapeHtml(lead)}</p>
<div class="actions">
<a class="button" href="${escapeHtml(cliOrigin)}/">Back to install</a>
<a class="button ghost" href="/llms.txt">Machine index</a>
<a class="button ghost" href="${escapeHtml(cliOrigin)}/collab/">Open collab client</a>
</div>
<section class="grid">${sections}</section>
<p class="note">The complete canonical Markdown set stays versioned with the CLI at <a href="${DOCS_TREE_BASE}">github.com/${DOCS_REPO}/docs</a>. Machine-readable index: <a href="/llms.txt">/llms.txt</a>. Inside a session, the same content is available through <code>omp://docs</code> and <code>/help &lt;question&gt;</code>.</p>
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

async function proxyCollabClient(request, env) {
	if (!env.COLLAB) return new Response("Collab client unavailable", { status: 503 });
	const upstreamUrl = new URL(request.url);
	upstreamUrl.pathname = upstreamUrl.pathname.slice("/collab".length) || "/";
	return env.COLLAB.fetch(new Request(upstreamUrl, request));
}

function markdownTitle(markdown, path) {
	const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return stripMarkdownInline(heading);
	return path.split("/").pop()?.replace(/\.md$/i, "") ?? "Documentation";
}

function stripMarkdownInline(value) {
	return value
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
		.trim();
}

function markdownSlug(value, used) {
	const base = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-") || "section";
	let slug = base;
	let suffix = 1;
	while (used.has(slug)) slug = `${base}-${++suffix}`;
	used.add(slug);
	return slug;
}

function inlineMarkdown(value) {
	let html = escapeHtml(value);
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, href) => {
		if (/^(?:https?:\/\/|\/|#|mailto:)/i.test(href)) {
			return `<a href="${escapeHtml(href)}">${text}</a>`;
		}
		return text;
	});
	return html;
}

function rewriteDocLink(rawHref, currentPath) {
	const href = rawHref.trim();
	if (!href || href.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return href;
	const [target, fragment = ""] = href.split("#");
	if (!target) return href;
	const baseParts = currentPath.split("/").slice(0, -1).filter(Boolean);
	for (const part of target.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") baseParts.pop();
		else baseParts.push(part);
	}
	const normalized = baseParts.join("/");
	if (normalized.toLowerCase().endsWith(".md")) {
		return `/docs/${normalized.slice(0, -3)}${fragment ? `#${fragment}` : ""}`;
	}
	return `https://github.com/${DOCS_REPO}/tree/${DOCS_REF}/docs/${normalized}${fragment ? `#${fragment}` : ""}`;
}

function renderMarkdown(markdown, currentPath, toc) {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const usedSlugs = new Set();
	const html = [];
	let paragraph = [];
	let listType = null;
	let inCode = false;
	let codeLang = "";
	let code = [];
	let inTable = false;
	let tableRows = [];

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (!listType) return;
		html.push(`</${listType}>`);
		listType = null;
	};
	const flushTable = () => {
		if (!inTable) return;
		const rows = tableRows.filter(row => !/^\s*\|?\s*:?-{3,}:?/.test(row.replaceAll("|", "|")) || row.includes("---") === false);
		if (rows.length > 0) {
			const parsed = rows.map(row => {
				const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
				return trimmed.split("|").map(cell => inlineMarkdown(cell.trim()));
			});
			const [head, ...body] = parsed;
			html.push("<div class=\"table-wrap\"><table>");
			if (head) html.push(`<thead><tr>${head.map(cell => `<th>${cell}</th>`).join("")}</tr></thead>`);
			if (body.length) html.push(`<tbody>${body.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>`);
			html.push("</table></div>");
		}
		inTable = false;
		tableRows = [];
	};

	for (const line of lines) {
		if (inCode) {
			if (line.trim().startsWith("```")) {
				html.push(`<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
				inCode = false;
				code = [];
				codeLang = "";
			} else {
				code.push(line);
			}
			continue;
		}
		const fence = line.trim().match(/^```\s*([\w-]*)\s*$/);
		if (fence) {
			flushParagraph();
			flushList();
			flushTable();
			inCode = true;
			codeLang = fence[1] ?? "";
			continue;
		}
		if (!line.trim()) {
			flushParagraph();
			flushList();
			flushTable();
			continue;
		}
		if (line.trim().startsWith("|")) {
			flushParagraph();
			flushList();
			inTable = true;
			tableRows.push(line);
			continue;
		}
		flushTable();
		const heading = line.match(/^(#{1,4})\s+(.+)$/);
		if (heading) {
			flushParagraph();
			flushList();
			const level = Math.min(4, heading[1].length);
			const text = stripMarkdownInline(heading[2]);
			const id = markdownSlug(text, usedSlugs);
			if (level <= 3) toc.push({ level, text, id });
			html.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inlineMarkdown(heading[2])}</h${level}>`);
			continue;
		}
		if (line.match(/^\s*[-*+]\s+/)) {
			flushParagraph();
			if (listType !== "ul") {
				flushList();
				html.push("<ul>");
				listType = "ul";
			}
			html.push(`<li>${inlineMarkdown(line.replace(/^\s*[-*+]\s+/, ""))}</li>`);
			continue;
		}
		if (line.match(/^\s*\d+[.)]\s+/)) {
			flushParagraph();
			if (listType !== "ol") {
				flushList();
				html.push("<ol>");
				listType = "ol";
			}
			html.push(`<li>${inlineMarkdown(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
			continue;
		}
		paragraph.push(line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, href) => `[${text}](${rewriteDocLink(href, currentPath)})`));
	}
	if (inCode) {
		html.push(`<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
	}
	flushParagraph();
	flushList();
	flushTable();
	return html.join("\n");
}

function docsStyles() {
	return `
:root { color-scheme: dark; --bg: #080a0f; --panel: #101521; --text: #eef4ff; --muted: #9da8ba; --line: #233044; --accent: #79ffe1; --pink: #ff7ad9; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; font: 16px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; color: var(--text); background: radial-gradient(circle at 15% 10%, #1f3358 0, transparent 34rem), var(--bg); }
main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.side { position: sticky; top: 24px; align-self: start; max-height: calc(100vh - 48px); overflow: auto; }
.side .brand { font-size: 24px; font-weight: 900; letter-spacing: -.04em; }
.side .muted, .meta { color: var(--muted); font-size: 13px; }
.toc { margin-top: 18px; padding-left: 0; list-style: none; }
.toc li { margin: 7px 0; }
.toc li.level-2 { margin-left: 0; } .toc li.level-3 { margin-left: 16px; }
.article { min-width: 0; }
.doc-header { margin-bottom: 26px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.doc-header h1 { margin: 8px 0 10px; font-size: clamp(34px, 6vw, 56px); line-height: 1; letter-spacing: -.05em; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
a.button { display: inline-block; padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); font-size: 13px; font-weight: 800; }
.content h1, .content h2, .content h3, .content h4 { scroll-margin-top: 18px; line-height: 1.15; letter-spacing: -.025em; }
.content h1 { font-size: 2.3rem; border-bottom: 1px solid var(--line); padding-bottom: .35em; }
.content h2 { font-size: 1.65rem; margin-top: 2rem; border-bottom: 1px solid var(--line); padding-bottom: .25em; }
.content h3 { font-size: 1.25rem; margin-top: 1.6rem; }
.content p { margin: 1em 0; max-width: 78ch; }
.content li { margin: .35em 0; }
.content ul, .content ol { padding-left: 1.4rem; }
.anchor { opacity: 0; margin-right: .35em; color: var(--muted); }
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }
code { font: .92em ui-monospace, SFMono-Regular, Consolas, monospace; background: #172033; border: 1px solid #273349; border-radius: 5px; padding: .12em .28em; }
pre { background: #03060a; border: 1px solid #1a2838; border-radius: 14px; padding: 16px; overflow-x: auto; }
pre code { background: transparent; border: 0; padding: 0; }
.table-wrap { overflow-x: auto; margin: 1.2rem 0; }
table { border-collapse: collapse; width: 100%; font-size: .94rem; }
th, td { border: 1px solid var(--line); padding: .55rem .7rem; text-align: left; vertical-align: top; }
th { background: #131b2b; }
.note { color: var(--muted); font-size: 13px; margin-top: 32px; border-top: 1px solid var(--line); padding-top: 18px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } .side { position: static; max-height: none; } }
`;
}

function docPageHtml({ title, description, path, markdownPath, content, toc }) {
	const canonical = `/docs/${path}`;
	const source = `${DOCS_TREE_BASE}/${markdownPath}`;
	const raw = `/docs/raw/${markdownPath}`;
	const tocHtml = toc.length
		? `<ul class="toc">${toc.map(item => `<li class="level-${item.level}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`).join("")}</ul>`
		: `<p class="muted">No section headings.</p>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · oh-my-pk docs</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="https://oh-my-pk.pkking.computer${canonical}">
<style>${docsStyles()}</style>
</head>
<body>
<main>
<aside class="side">
<div class="brand"><a href="/">oh-my-pk</a></div>
<div class="muted">documentation</div>
<div class="actions"><a class="button" href="/docs">All docs</a></div>
<nav aria-label="On this page">${tocHtml}</nav>
</aside>
<article class="article">
<header class="doc-header">
<div class="meta">${escapeHtml(markdownPath)}</div>
<h1>${escapeHtml(title)}</h1>
<div class="actions"><a class="button" href="${escapeHtml(source)}">GitHub source</a><a class="button" href="${escapeHtml(raw)}">Raw Markdown</a></div>
</header>
<div class="content">${content}</div>
<p class="note">Machine index: <a href="/llms.txt">/llms.txt</a> · In-session docs: <code>omp://docs</code></p>
</article>
</main>
</body>
</html>`;
}

function safeDocPath(pathname) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(pathname)) return undefined;
	if (pathname.includes("..") || pathname.toLowerCase().endsWith(".md")) return undefined;
	return `${pathname}.md`;
}

async function fetchRawDoc(markdownPath, request, ctx) {
	const cache = caches.default;
	const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });
	const cached = await cache.match(cacheKey);
	if (cached) return cached;
	const upstream = await fetch(rawDocUrl(markdownPath), { headers: { "User-Agent": "oh-my-pk-docs" } });
	if (!upstream.ok) return undefined;
	const markdown = await upstream.text();
	const response = new Response(markdown, {
		headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" },
	});
	if (ctx) ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

async function docsDocument(request, pathname, ctx) {
	const markdownPath = safeDocPath(pathname);
	if (!markdownPath) return undefined;
	const raw = await fetchRawDoc(markdownPath, request, ctx);
	if (!raw) return undefined;
	const markdown = await raw.text();
	const toc = [];
	const content = renderMarkdown(markdown, markdownPath, toc);
	const title = markdownTitle(markdown, markdownPath);
	const html = docPageHtml({
		title,
		description: `oh-my-pk documentation: ${title}`,
		path: pathname,
		markdownPath,
		content,
		toc,
	});
	return new Response(html, {
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
	});
}

function llmsIndex() {
	const sections = [
		["Start here", ["settings.md", "environment-variables.md", "models.md", "providers.md", "help.md", "keybindings.md", "theme.md", "context-files.md"]],
		["Daily workflows", ["session.md", "session-operations-export-share-fork-resume.md", "approval-mode.md", "compaction.md", "memory.md", "advisor-watchdog.md", "cost-performance-tuning.md", "ethereal-workspaces.md", "session-switching-and-recent-listing.md", "tree.md"]],
		["Tools and skills", ["custom-tools.md", "skills.md", "hooks.md", "mcp-config.md", "mcp-server-tool-authoring.md", "lsp-config.md", "python-repl.md", "notebook-tool-runtime.md", "resolve-tool-runtime.md", "bash-tool-runtime.md"]],
		["Tool reference", ["tools/read.md", "tools/write.md", "tools/edit.md", "tools/ast-edit.md", "tools/search.md", "tools/find.md", "tools/bash.md", "tools/eval.md", "tools/lsp.md", "tools/debug.md", "tools/browser.md", "tools/github.md", "tools/web_search.md", "tools/task.md", "tools/search_tool_bm25.md", "tools/context-layer.md"]],
		["Collaboration", ["collab.md", "environments-cloud.md", "fork-boundaries.md", "multi-agent-fork-collaboration.md", "task-agent-discovery.md", "task-contract-orchestration.md", "capture-to-agent.md"]],
		["Integrations", ["extensions.md", "extension-loading.md", "marketplace.md", "gemini-manifest-extensions.md", "auth-broker-gateway.md", "rpc.md", "sdk.md", "adding-a-provider.md"]],
		["Architecture", ["natives-architecture.md", "natives-binding-contract.md", "provider-streaming-internals.md", "provider-endpoint-constraints.md", "tui.md", "tui-core-renderer.md", "mcp-protocol-transports.md", "mcp-runtime-lifecycle.md", "porting-from-pi-mono.md", "porting-to-natives.md"]],
		["Operations", ["RELEASING-FORK.md", "macos-signing-notarization.md", "install-id.md", "config-usage.md", "local-models.md", "handoff-generation-pipeline.md", "blob-artifact-architecture.md", "fs-scan-cache-architecture.md"]],
	];
	const lines = ["# oh-my-pk", "", "> Canonical CLI documentation index for humans and LLM agents.", "", "## Docs index"];
	for (const [section, paths] of sections) {
		lines.push("", `### ${section}`);
		for (const path of paths) {
			const pretty = path.replace(/\.md$/i, "");
			lines.push(`- [${pretty}](https://oh-my-pk.pkking.computer/docs/${pretty})`);
		}
	}
	return lines.join("\n");
}

function htmlResponse(html, status = 200) {
	return new Response(html, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
	});
}

function textResponse(text, contentType = "text/plain; charset=utf-8", status = 200) {
	return new Response(text, { status, headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=300" } });
}

export default {
	async fetch(request, env, ctx) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405 });
		}
		const url = new URL(request.url);
		const pathname = url.pathname;
		if (pathname === "/collab") {
			url.pathname = "/collab/";
			return Response.redirect(url, 308);
		}
		if (pathname.startsWith("/collab/")) return proxyCollabClient(request, env);
		if (pathname === "/llms.txt") return textResponse(llmsIndex(), "text/markdown; charset=utf-8");
		if (pathname.startsWith("/docs/raw/")) {
			const rawPath = pathname.slice("/docs/raw/".length);
			if (rawPath.toLowerCase().endsWith(".md")) {
				const raw = await fetchRawDoc(rawPath, request, ctx);
				if (raw) return raw;
			}
			return new Response("Not found", { status: 404 });
		}
		if (pathname.startsWith("/docs/") && pathname !== "/docs/") {
			const doc = await docsDocument(request, pathname.slice("/docs/".length), ctx);
			if (doc) return doc;
			return new Response("Not found", { status: 404 });
		}

		switch (pathname) {
			case "/":
				return landingPage(request);
			case "/docs":
			case "/docs/":
				return docsPage(request);
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
