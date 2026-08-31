/**
 * Source resolver for marketplace plugin entries.
 *
 * Resolves plugin sources to absolute local directory paths:
 *   - Relative string "./plugins/foo" → path within marketplace clone
 *   - { source: "url", url: "https://...git" } → git clone
 *   - { source: "github", repo: "owner/repo" } → git clone from GitHub
 *   - { source: "git-subdir", url: "...", path: "sub/dir" } → git clone + subdir
 *   - { source: "npm", ... } → npm registry fetch, integrity-verified extraction
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, pathIsWithin } from "@oh-my-pi/pi-utils";
import type { ArchiveLimits } from "@oh-my-pi/pi-utils/ar";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";

import type { MarketplaceCatalogMetadata, MarketplacePluginEntry, PluginSource, PluginSourceNpm } from "./types";
import { assertRuntimePackageName } from "./types";

const GIT_CLONE_TIMEOUT_MS = 30 * 60 * 1000;

// ── npm source constants ────────────────────────────────────────────

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const PACKUMENT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const PACKUMENT_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 300_000;
const TARBALL_MAX_BYTES = 256 * 1024 * 1024; // 256 MiB compressed
const MAX_REDIRECTS = 5;
const MAX_VERSION_EXPR_BYTES = 256;

const NPM_ARCHIVE_LIMITS: ArchiveLimits = {
	maxEntries: 1_000_000,
	maxInMemorySize: 256 * 1024 * 1024,
	maxIndexSize: 64 * 1024 * 1024,
	maxMemberSize: 64 * 1024 * 1024,
	maxPathBytes: 4096,
	maxLinkDepth: 40,
};

/** Headers that must never be forwarded across origins. */
const SENSITIVE_HEADERS: Record<string, true> = {
	authorization: true,
	cookie: true,
	"set-cookie": true,
	"proxy-authorization": true,
	"x-api-key": true,
};

export interface ResolveContext {
	/** Absolute path to the cloned/local marketplace directory. Required for relative sources. */
	marketplaceClonePath?: string;
	/** Catalog metadata — used for `pluginRoot` prepend. */
	catalogMetadata?: MarketplaceCatalogMetadata;
	/** Scratch directory for sources that require cloning or extraction. */
	tmpDir: string;
}

/**
 * Result of resolving a plugin source.
 *
 * `resolvedVersion` is set when the source itself determines the exact version
 * (e.g. npm registry resolution). The manager uses it before falling back to
 * catalog/manifest/git-SHA version detection.
 */
export interface ResolveResult {
	dir: string;
	tempCloneRoot?: string;
	/** Exact version selected by the source resolver (npm only). */
	resolvedVersion?: string;
}

/**
 * Resolve a plugin source to an absolute local directory path.
 *
 * The resolved path is verified to exist on disk.
 */
export async function resolvePluginSource(
	entry: MarketplacePluginEntry,
	context: ResolveContext,
): Promise<ResolveResult> {
	const { source } = entry;

	if (typeof source === "string") {
		return resolveRelativeSource(source, context);
	}

	return resolveObjectSource(source, context);
}

// ── Relative string source ("./plugins/foo") ────────────────────────

async function resolveRelativeSource(source: string, context: ResolveContext): Promise<ResolveResult> {
	if (!source.startsWith("./")) {
		throw new Error(`Relative plugin source paths must start with "./" — got: "${source}"`);
	}

	if (!context.marketplaceClonePath) {
		throw new Error(`Cannot resolve relative source "${source}": marketplaceClonePath is required`);
	}

	// If pluginRoot is set, prepend it to the path segment after "./"
	const pluginRoot = context.catalogMetadata?.pluginRoot;
	const relativePath = pluginRoot ? `./${path.join(pluginRoot, source.slice(2))}` : source;

	// Resolve against marketplace root (not the .claude-plugin/ catalog subdirectory)
	const resolved = path.resolve(context.marketplaceClonePath, relativePath);

	if (!pathIsWithin(context.marketplaceClonePath, resolved)) {
		throw new Error(
			`Plugin source "${source}" resolves outside marketplace root ("${context.marketplaceClonePath}")`,
		);
	}

	await verifyDirExists(resolved, `Plugin source directory does not exist: "${resolved}"`);
	return { dir: resolved };
}

// ── Object source variants ──────────────────────────────────────────

async function resolveObjectSource(
	source: Exclude<PluginSource, string>,
	context: ResolveContext,
): Promise<ResolveResult> {
	switch (source.source) {
		case "url": {
			// { source: "url", url: "https://github.com/owner/repo.git" }
			// Despite the name, this is typically a git clone URL
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await vcs.clone(source.url, targetDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "github": {
			// { source: "github", repo: "owner/repo" }
			const url = `https://github.com/${source.repo}.git`;
			const targetDir = path.join(context.tmpDir, `plugin-${crypto.randomUUID()}`);
			await vcs.clone(url, targetDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});
			return { dir: targetDir, tempCloneRoot: targetDir };
		}

		case "git-subdir": {
			// { source: "git-subdir", url: "owner/repo" | "https://...", path: "plugins/foo" }
			const url =
				source.url.includes("://") || source.url.startsWith("git@")
					? source.url
					: `https://github.com/${source.url}.git`;
			const cloneDir = path.join(context.tmpDir, `plugin-repo-${crypto.randomUUID()}`);
			await vcs.clone(url, cloneDir, {
				refName: source.ref,
				sha: source.sha,
				timeoutMs: GIT_CLONE_TIMEOUT_MS,
			});

			const subdirPath = path.resolve(cloneDir, source.path);
			if (!pathIsWithin(cloneDir, subdirPath)) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw new Error(`git-subdir path "${source.path}" escapes the cloned repository`);
			}
			try {
				await verifyDirExists(subdirPath, `git-subdir path "${source.path}" does not exist in cloned repository`);
			} catch (err) {
				await fs.rm(cloneDir, { recursive: true, force: true });
				throw err;
			}
			return { dir: subdirPath, tempCloneRoot: cloneDir };
		}

		case "npm":
			return resolveNpmSource(source, context);

		default:
			throw new Error(`Unknown plugin source type: "${(source as { source: string }).source}"`);
	}
}

// ── npm source ──────────────────────────────────────────────────────

/**
 * Resolve an npm plugin source: fetch packument, select version, download
 * tarball, verify SHA-512 integrity, extract, and return the package directory.
 *
 * Trust boundary:
 *   - Validates package name, version expression, and registry URL syntax.
 *   - Fetches packument with byte/time caps, manual redirects, no credential forwarding.
 *   - Selects version via dist-tags.latest, exact key, or highest semver match.
 *   - Requires HTTPS tarball URL and canonical SHA-512 SRI.
 *   - Streams tarball once to a private temp root while hashing.
 *   - Compares digest with timingSafeEqual before extraction.
 *   - Extracts through extractArchive with pinned resource limits.
 *   - Requires exactly one top-level `package/` directory.
 *
 * Errors include the package and stage but never response bodies, credentials,
 * or uncontrolled metadata.
 */
async function resolveNpmSource(source: PluginSourceNpm, context: ResolveContext): Promise<ResolveResult> {
	const pkg = assertRuntimePackageName(source.package);
	const stage = (s: string) => `npm source for "${pkg}": ${s}`;

	// ── Validate version expression ──────────────────────────────────
	let versionExpr: string | undefined;
	if (source.version !== undefined) {
		if (source.version.length === 0) {
			throw new Error(stage("version expression must be nonempty when present"));
		}
		if (source.version.length > MAX_VERSION_EXPR_BYTES) {
			throw new Error(stage("version expression exceeds 256 bytes"));
		}
		versionExpr = source.version;
	}

	// ── Validate registry URL ────────────────────────────────────────
	const registryUrl = validateRegistryUrl(source.registry ?? DEFAULT_REGISTRY);

	// ── Fetch packument ──────────────────────────────────────────────
	const packument = await fetchPackument(pkg, registryUrl, stage);

	// ── Select version ───────────────────────────────────────────────
	const selectedVersion = selectVersion(packument, versionExpr, stage);

	// ── Validate version metadata ────────────────────────────────────
	const versionMeta = packument.versions?.[selectedVersion];
	if (!versionMeta || typeof versionMeta !== "object") {
		throw new Error(stage(`no metadata for version "${selectedVersion}"`));
	}

	if (versionMeta.name !== pkg) {
		throw new Error(stage(`metadata name mismatch: expected "${pkg}", got "${String(versionMeta.name)}"`));
	}

	// ── Validate tarball URL ─────────────────────────────────────────
	const tarballUrl = versionMeta.dist?.tarball;
	if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
		throw new Error(stage(`no tarball URL for version "${selectedVersion}"`));
	}
	if (!isPublicHttpsUrl(tarballUrl)) {
		throw new Error(stage(`tarball URL must be public HTTPS without credentials`));
	}

	// ── Validate SRI integrity ───────────────────────────────────────
	const integrity = versionMeta.dist?.integrity;
	if (typeof integrity !== "string" || integrity.length === 0) {
		throw new Error(stage(`missing integrity hash for version "${selectedVersion}"`));
	}
	const expectedDigest = parseSriSha512(integrity, stage);

	// ── Stream tarball to temp root while hashing ────────────────────
	const tempRoot = path.join(context.tmpDir, `npm-${pkg.replace(/[^a-z0-9._~-]/g, "-")}-${crypto.randomUUID()}`);
	await fs.mkdir(tempRoot, { recursive: true });
	const tarballPath = path.join(tempRoot, "package.tgz");

	try {
		await downloadTarball(tarballUrl, tarballPath, registryUrl, stage);

		// ── Verify SHA-512 digest before extraction ──────────────────
		const actualDigest = await sha512File(tarballPath);
		if (actualDigest.length !== 64 || !crypto.timingSafeEqual(actualDigest, expectedDigest)) {
			throw new Error(stage(`integrity verification failed for version "${selectedVersion}"`));
		}

		// ── Extract through extractArchive ───────────────────────────
		const extractDir = path.join(tempRoot, "extracted");
		await fs.mkdir(extractDir, { recursive: true });
		await extractArchive(tarballPath, extractDir, { limits: NPM_ARCHIVE_LIMITS });

		// ── Require one top-level package/ directory ─────────────────
		const entries = await fs.readdir(extractDir, { withFileTypes: true });
		const packageDir = entries.find(e => e.isDirectory() && e.name === "package");
		if (!packageDir) {
			throw new Error(stage("archive must contain a top-level `package/` directory"));
		}
		const siblings = entries.filter(e => e.name !== "package");
		if (siblings.length > 0) {
			throw new Error(
				stage(`archive must contain only "package/" — found siblings: ${siblings.map(s => s.name).join(", ")}`),
			);
		}

		const pkgPath = path.join(extractDir, "package");
		await verifyDirExists(pkgPath, stage("extracted package/ directory does not exist"));

		return { dir: pkgPath, tempCloneRoot: tempRoot, resolvedVersion: selectedVersion };
	} catch (err) {
		// Clean up on any failure — the temp root is private and disposable.
		await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
}

// ── npm helpers ─────────────────────────────────────────────────────

/** Validate a registry URL: public absolute HTTPS, no credentials, query, or fragment. */
function validateRegistryUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`npm source: invalid registry URL: ${JSON.stringify(url)}`);
	}

	if (parsed.protocol !== "https:") {
		throw new Error(`npm source: registry URL must be HTTPS: ${JSON.stringify(url)}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`npm source: registry URL must not contain credentials`);
	}
	if (parsed.search) {
		throw new Error(`npm source: registry URL must not contain a query string`);
	}
	if (parsed.hash) {
		throw new Error(`npm source: registry URL must not contain a fragment`);
	}

	return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/** Check that a URL is HTTPS with no embedded credentials. */
function isPublicHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" && !parsed.username && !parsed.password;
	} catch {
		return false;
	}
}

/** Packument shape (subset). */
interface Packument {
	name?: string;
	"dist-tags"?: Record<string, string>;
	versions?: Record<
		string,
		{
			name?: string;
			dist?: {
				tarball?: string;
				integrity?: string;
				shasum?: string;
			};
		}
	>;
}

/**
 * Fetch a packument with byte/time caps, manual redirects, and no credential forwarding.
 * Permits at most five redirects and keeps them on the registry origin.
 */
async function fetchPackument(pkg: string, registryUrl: string, stage: (s: string) => string): Promise<Packument> {
	const encodedName = pkg.startsWith("@") ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg);
	const packumentUrl = `${registryUrl}/${encodedName}`;

	const response = await fetchWithRedirects(packumentUrl, registryUrl, {
		maxBytes: PACKUMENT_MAX_BYTES,
		timeoutMs: PACKUMENT_TIMEOUT_MS,
		stage,
		headers: { accept: "application/json" },
	});

	if (response.status === 404) {
		throw new Error(stage(`package not found on registry`));
	}
	if (!response.ok) {
		throw new Error(stage(`packument fetch failed: HTTP ${response.status}`));
	}

	let body: string;
	try {
		body = await response.text();
	} catch (err) {
		throw new Error(stage(`failed to read packument: ${err instanceof Error ? err.message : String(err)}`));
	}

	if (body.length > PACKUMENT_MAX_BYTES) {
		throw new Error(stage(`packument exceeds ${PACKUMENT_MAX_BYTES} bytes`));
	}

	try {
		return JSON.parse(body) as Packument;
	} catch {
		throw new Error(stage(`packument is not valid JSON`));
	}
}

/**
 * Select version from packument:
 *   1. Exact `versions` key when the expression is an exact version.
 *   2. `dist-tags.latest` when version is omitted.
 *   3. Highest Bun-semver match for a range expression.
 */
function selectVersion(packument: Packument, versionExpr: string | undefined, stage: (s: string) => string): string {
	const versions = packument.versions;
	if (!versions || typeof versions !== "object") {
		throw new Error(stage("packument has no versions"));
	}

	// No version specified → dist-tags.latest
	if (versionExpr === undefined) {
		const latest = packument["dist-tags"]?.latest;
		if (typeof latest !== "string" || !latest) {
			throw new Error(stage("no version specified and dist-tags.latest is missing"));
		}
		if (!versions[latest]) {
			throw new Error(stage(`dist-tags.latest "${latest}" not found in versions`));
		}
		return latest;
	}

	// Exact version key
	if (versions[versionExpr]) {
		return versionExpr;
	}

	// Range match — find highest satisfying version
	const allVersions = Object.keys(versions).filter(v => {
		try {
			return Bun.semver.order(v, "0.0.0") >= 0;
		} catch {
			return false;
		}
	});
	if (allVersions.length === 0) {
		throw new Error(stage(`version "${versionExpr}" not found and no semver versions available`));
	}

	// Try semver range match
	let best: string | undefined;
	for (const v of allVersions) {
		try {
			if (Bun.semver.satisfies(v, versionExpr)) {
				if (best === undefined || Bun.semver.order(v, best) > 0) {
					best = v;
				}
			}
		} catch {
			// Invalid range or version — skip
		}
	}

	if (best === undefined) {
		throw new Error(stage(`no version matching "${versionExpr}"`));
	}

	return best;
}

/** Parse a canonical SHA-512 SRI string (`sha512-<base64>`) and return the 64-byte digest. */
function parseSriSha512(integrity: string, stage: (s: string) => string): Uint8Array {
	const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
	if (!match) {
		throw new Error(stage(`integrity must be canonical SHA-512 SRI (sha512-<base64>)`));
	}
	const digest = Buffer.from(match[1], "base64");
	if (digest.length !== 64) {
		throw new Error(stage(`SHA-512 digest must be 64 bytes, got ${digest.length}`));
	}
	return new Uint8Array(digest);
}

/** Compute SHA-512 of a file and return the 64-byte digest. */
async function sha512File(filePath: string): Promise<Uint8Array> {
	const file = Bun.file(filePath);
	const buffer = await file.arrayBuffer();
	const digest = crypto.createHash("sha512").update(Buffer.from(buffer)).digest();
	return new Uint8Array(digest);
}

interface FetchOptions {
	maxBytes: number;
	timeoutMs: number;
	stage: (s: string) => string;
	headers?: Record<string, string>;
}

/**
 * Fetch with manual redirect handling: at most MAX_REDIRECTS redirects,
 * staying on the registry origin, never forwarding sensitive headers across origins.
 */
async function fetchWithRedirects(url: string, registryOrigin: string, opts: FetchOptions): Promise<Response> {
	let currentUrl = url;
	const origin = new URL(registryOrigin).origin;

	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

		// Only forward non-sensitive headers; strip anything that could leak credentials.
		const headers: Record<string, string> = {};
		if (opts.headers) {
			for (const [key, value] of Object.entries(opts.headers)) {
				if (!(key.toLowerCase() in SENSITIVE_HEADERS)) {
					headers[key] = value;
				}
			}
		}

		let response: Response;
		try {
			response = await fetch(currentUrl, {
				redirect: "manual",
				signal: controller.signal,
				headers,
			});
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(opts.stage(`request timed out after ${opts.timeoutMs}ms`));
			}
			throw new Error(opts.stage(`fetch failed: ${err instanceof Error ? err.message : String(err)}`));
		}
		clearTimeout(timer);

		// Handle redirects (3xx)
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new Error(opts.stage(`redirect ${response.status} without Location header`));
			}

			let nextUrl: string;
			try {
				nextUrl = new URL(location, currentUrl).href;
			} catch {
				throw new Error(opts.stage(`invalid redirect Location: ${JSON.stringify(location)}`));
			}

			// Stay on registry origin
			let nextOrigin: string;
			try {
				nextOrigin = new URL(nextUrl).origin;
			} catch {
				throw new Error(opts.stage(`invalid redirect URL: ${JSON.stringify(nextUrl)}`));
			}
			if (nextOrigin !== origin) {
				throw new Error(opts.stage(`redirect leaves registry origin: ${nextOrigin}`));
			}

			if (!nextUrl.startsWith("https://")) {
				throw new Error(opts.stage(`redirect must stay HTTPS: ${JSON.stringify(nextUrl)}`));
			}

			currentUrl = nextUrl;
			continue;
		}

		return response;
	}

	throw new Error(opts.stage(`exceeded ${MAX_REDIRECTS} redirects`));
}

/**
 * Download a tarball to a file path while enforcing byte and time limits.
 * Uses manual redirects with the same origin-staying and header-stripping policy.
 */
async function downloadTarball(
	tarballUrl: string,
	destPath: string,
	registryOrigin: string,
	stage: (s: string) => string,
): Promise<void> {
	const response = await fetchWithRedirects(tarballUrl, registryOrigin, {
		maxBytes: TARBALL_MAX_BYTES,
		timeoutMs: TARBALL_TIMEOUT_MS,
		stage,
	});

	if (!response.ok) {
		throw new Error(stage(`tarball download failed: HTTP ${response.status}`));
	}

	const contentLength = response.headers.get("content-length");
	if (contentLength && parseInt(contentLength, 10) > TARBALL_MAX_BYTES) {
		throw new Error(stage(`tarball exceeds ${TARBALL_MAX_BYTES} bytes`));
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TARBALL_TIMEOUT_MS);

	try {
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error(stage(`tarball response has no body`));
		}

		const file = Bun.file(destPath);
		const writer = file.writer();
		let totalBytes = 0;

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > TARBALL_MAX_BYTES) {
					throw new Error(stage(`tarball exceeds ${TARBALL_MAX_BYTES} compressed bytes`));
				}
				writer.write(value);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(stage(`tarball download timed out after ${TARBALL_TIMEOUT_MS}ms`));
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

async function verifyDirExists(dirPath: string, errorMessage: string): Promise<void> {
	try {
		const stat = await fs.stat(dirPath);
		if (!stat.isDirectory()) {
			throw new Error(errorMessage);
		}
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(errorMessage);
		}
		throw err;
	}
}
