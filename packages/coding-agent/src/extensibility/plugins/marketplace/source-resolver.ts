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

/** Resolved npm fetch/extraction limits (defaults with optional overrides applied). */
interface NpmFetchLimits {
	packumentMaxBytes: number;
	tarballMaxBytes: number;
	packumentTimeoutMs: number;
	tarballTimeoutMs: number;
	maxRedirects: number;
}

/** Resolve the five npm fetch limits, applying optional test-injectable overrides. */
function resolveLimits(limits?: ResolveContext["limits"]): NpmFetchLimits {
	return {
		packumentMaxBytes: limits?.packumentMaxBytes ?? PACKUMENT_MAX_BYTES,
		tarballMaxBytes: limits?.tarballMaxBytes ?? TARBALL_MAX_BYTES,
		packumentTimeoutMs: limits?.packumentTimeoutMs ?? PACKUMENT_TIMEOUT_MS,
		tarballTimeoutMs: limits?.tarballTimeoutMs ?? TARBALL_TIMEOUT_MS,
		maxRedirects: limits?.maxRedirects ?? MAX_REDIRECTS,
	};
}

/**
 * Truncate and strip control/escape characters from an untrusted fragment
 * before echoing it into a thrown error. Keeps registry- or archive-controlled
 * strings from carrying arbitrary bytes, ANSI escapes, or unbounded length.
 */
function sanitizeFragment(s: unknown, maxLen = 64): string {
	const stripped = String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
	return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…` : stripped;
}

export interface ResolveContext {
	/** Absolute path to the cloned/local marketplace directory. Required for relative sources. */
	marketplaceClonePath?: string;
	/** Catalog metadata — used for `pluginRoot` prepend. */
	catalogMetadata?: MarketplaceCatalogMetadata;
	/** Scratch directory for sources that require cloning or extraction. */
	tmpDir: string;
	/**
	 * Test-injectable overrides for npm fetch limits. All five constants
	 * (packumentMaxBytes, tarballMaxBytes, packumentTimeoutMs, tarballTimeoutMs,
	 * maxRedirects) default to the pinned values when omitted.
	 */
	limits?: Partial<{
		packumentMaxBytes: number;
		tarballMaxBytes: number;
		packumentTimeoutMs: number;
		tarballTimeoutMs: number;
		maxRedirects: number;
	}>;
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
 *   - Streams tarball once to a private temp root, hashing incrementally.
 *   - Compares the incremental digest with timingSafeEqual before extraction.
 *   - Extracts through extractArchive with pinned resource limits.
 *   - Requires exactly one top-level `package/` directory.
 *   - Verifies the extracted package/package.json name (and version, when present)
 *     matches the requested package and selected version.
 *
 * Errors include the package and stage. Untrusted registry- or archive-controlled
 * fragments echoed into errors are truncated and stripped of control/escape bytes
 * via sanitizeFragment; response bodies and credentials are never included.
 */
async function resolveNpmSource(source: PluginSourceNpm, context: ResolveContext): Promise<ResolveResult> {
	const pkg = assertRuntimePackageName(source.package);
	const stage = (s: string) => `npm source for "${pkg}": ${s}`;
	const lim = resolveLimits(context.limits);

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
	const packument = await fetchPackument(pkg, registryUrl, stage, lim);

	// ── Select version ───────────────────────────────────────────────
	const selectedVersion = selectVersion(packument, versionExpr, stage);

	// ── Validate version metadata ────────────────────────────────────
	const versionMeta = packument.versions?.[selectedVersion];
	if (!versionMeta || typeof versionMeta !== "object") {
		throw new Error(stage(`no metadata for version "${selectedVersion}"`));
	}

	if (versionMeta.name !== pkg) {
		throw new Error(stage(`metadata name mismatch: expected "${pkg}", got "${sanitizeFragment(versionMeta.name)}"`));
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
	await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
	const tarballPath = path.join(tempRoot, "package.tgz");

	try {
		// downloadTarball streams the body, enforces byte/time caps, and feeds
		// each chunk to an incremental SHA-512 hasher, returning the digest.
		const actualDigest = await downloadTarball(tarballUrl, tarballPath, new URL(tarballUrl).origin, stage, lim);

		// ── Verify SHA-512 digest before extraction ──────────────────
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
			const shown = siblings
				.slice(0, 5)
				.map(s => sanitizeFragment(s.name))
				.join(", ");
			const extra = siblings.length > 5 ? ` (and ${siblings.length - 5} more)` : "";
			throw new Error(stage(`archive must contain only "package/" — found siblings: ${shown}${extra}`));
		}

		const pkgPath = path.join(extractDir, "package");
		await verifyDirExists(pkgPath, stage("extracted package/ directory does not exist"));

		// ── Verify extracted package identity ────────────────────────
		const manifestPath = path.join(pkgPath, "package.json");
		let manifest: { name?: unknown; version?: unknown };
		try {
			manifest = JSON.parse(await Bun.file(manifestPath).text()) as { name?: unknown; version?: unknown };
		} catch {
			throw new Error(stage("extracted package/package.json is missing or not valid JSON"));
		}
		if (manifest.name !== pkg) {
			throw new Error(
				stage(`package identity mismatch: expected name "${pkg}", got "${sanitizeFragment(manifest.name)}"`),
			);
		}
		if (manifest.version !== undefined && manifest.version !== selectedVersion) {
			throw new Error(
				stage(
					`package identity mismatch: expected version "${selectedVersion}", got "${sanitizeFragment(manifest.version)}"`,
				),
			);
		}

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

// ── RFC 3986 URI-reference validation ───────────────────────────────

// RFC 3986 (Appendix A) URI-reference grammar, compiled to a single anchored
// regex. The WHATWG URL parser accepts strings that are not valid URI-references
// (e.g. "::" is silently treated as a relative path), so each redirect Location
// is checked against this grammar before resolution. This rejects degenerate
// values at the parsing stage without special-casing any particular literal.
//
// Notable structural rules enforced:
//   - A URI scheme must start with ALPHA (scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )).
//   - A relative-ref's first segment must not contain ":" (segment-nz-nc),
//     which is what rejects "::" — it has no valid scheme and its first
//     segment contains a colon.
const _PCHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})";
const _SEGMENT_NZ_NC = "(?:[A-Za-z0-9._~!$&'()*+,;=@-]|%[0-9A-Fa-f]{2})+";
const _SEG = `${_PCHAR}*`;
const _SEG_NZ = `${_PCHAR}+`;
const _PATH_ABE = `(?:/${_SEG})*`;
const _PATH_ABS = `/(?:${_SEG_NZ}(?:/${_SEG})*)?`;
const _PATH_NS = `${_SEGMENT_NZ_NC}(?:/${_SEG})*`;
const _PATH_RTL = `${_SEG_NZ}(?:/${_SEG})*`;
const _QF = `(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*`;
const _SCHEME = "[A-Za-z][A-Za-z0-9+.-]*";
const _REG_NAME = "(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*";
const _IP_LITERAL = "\\[[0-9A-Fa-f:.]+\\]";
const _HOST = `(?:${_IP_LITERAL}|${_REG_NAME})`;
const _PORT = "[0-9]*";
const _USERINFO = "(?:[A-Za-z0-9._~!$&'()*+,;=:-]|%[0-9A-Fa-f]{2})*";
const _AUTHORITY = `(?:${_USERINFO}@)?${_HOST}(?::${_PORT})?`;
const _HIER_PART = `(?://${_AUTHORITY}${_PATH_ABE}|${_PATH_ABS}|${_PATH_RTL}|)`;
const _REL_PART = `(?://${_AUTHORITY}${_PATH_ABE}|${_PATH_ABS}|${_PATH_NS}|)`;
const _URI = `${_SCHEME}:${_HIER_PART}(?:\\?${_QF})?(?:#${_QF})?`;
const _REL_REF = `${_REL_PART}(?:\\?${_QF})?(?:#${_QF})?`;
const URI_REFERENCE_RE = new RegExp(`^(?:${_URI}|${_REL_REF})$`);

/** Check that `s` is a well-formed RFC 3986 URI-reference (URI or relative-ref). */
function isValidUriReference(s: string): boolean {
	return URI_REFERENCE_RE.test(s);
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
 * The deadline covers the entire body consumption (one AbortController from fetch
 * through the final byte); redirects stay on the registry origin.
 */
async function fetchPackument(
	pkg: string,
	registryUrl: string,
	stage: (s: string) => string,
	lim: NpmFetchLimits,
): Promise<Packument> {
	const encodedName = pkg.startsWith("@") ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg);
	const packumentUrl = `${registryUrl}/${encodedName}`;

	const { response, clearTimer } = await fetchWithRedirects(packumentUrl, new URL(registryUrl).origin, {
		timeoutMs: lim.packumentTimeoutMs,
		maxRedirects: lim.maxRedirects,
		stage,
		headers: { accept: "application/json" },
	});

	try {
		if (response.status === 404) {
			throw new Error(stage(`package not found on registry`));
		}
		if (!response.ok) {
			throw new Error(stage(`packument fetch failed: HTTP ${response.status}`));
		}

		// Stream the body counting BYTES (not UTF-16 units); abort past the cap.
		let bytes: Uint8Array;
		try {
			bytes = await readCappedBytes(response, lim.packumentMaxBytes, stage);
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(stage(`request timed out after ${lim.packumentTimeoutMs}ms`));
			}
			throw err;
		}

		let body: string;
		try {
			body = Buffer.from(bytes).toString("utf8");
		} catch (err) {
			throw new Error(stage(`failed to read packument: ${err instanceof Error ? err.message : String(err)}`));
		}

		try {
			return JSON.parse(body) as Packument;
		} catch {
			throw new Error(stage(`packument is not valid JSON`));
		}
	} finally {
		clearTimer();
	}
}

/** Read a response body as bytes, aborting once it exceeds `maxBytes`. */
async function readCappedBytes(
	response: Response,
	maxBytes: number,
	stage: (s: string) => string,
): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error(stage(`response has no body`));
	}
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				throw new Error(stage(`response exceeds ${maxBytes} bytes`));
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

/**
 * Select version from packument:
 *   1. `dist-tags.latest` when version is omitted.
 *   2. Exact `versions` key when the expression is an exact version.
 *   3. Highest Bun-semver match for a range expression.
 *
 * Range expressions are validated against a conservative semver range grammar
 * before the satisfies loop: Bun.semver.satisfies treats garbage like "foobar"
 * or "latest" as a universal match, so an invalid expression must be rejected
 * explicitly to avoid silently resolving to the highest published version.
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
			throw new Error(stage(`dist-tags.latest "${sanitizeFragment(latest)}" not found in versions`));
		}
		return latest;
	}

	// Exact version key
	if (versions[versionExpr]) {
		return versionExpr;
	}

	// Range expression — validate grammar before matching, since Bun.semver.satisfies
	// silently treats unparseable ranges (e.g. "foobar", "latest") as a universal match.
	if (!isValidSemverRange(versionExpr)) {
		throw new Error(stage(`invalid version expression: "${sanitizeFragment(versionExpr)}"`));
	}

	// Find highest satisfying version. The satisfies call skips non-semver keys
	// (it throws for unparseable versions, caught here); no prerelease prefilter
	// so a range whose only match is e.g. 0.0.0-alpha resolves to it.
	let best: string | undefined;
	for (const v of Object.keys(versions)) {
		try {
			if (Bun.semver.satisfies(v, versionExpr)) {
				if (best === undefined || Bun.semver.order(v, best) > 0) {
					best = v;
				}
			}
		} catch {
			// Non-semver version key or unsatisfiable — skip
		}
	}

	if (best === undefined) {
		throw new Error(stage(`no version matching "${sanitizeFragment(versionExpr)}"`));
	}

	return best;
}

// ── semver range grammar ────────────────────────────────────────────

// Conservative semver range grammar. Accepts caret/tilde/comparator/hyphen/x-range
// and OR (||) sets — the forms npm and Bun.semver.satisfies honor — while rejecting
// garbage like "foobar", "latest", "@latest", "1..2", "==1.0.0", "1.2.3.4".
const SEMVER_PART =
	"(?:[vV]?\\d+(?:\\.(?:\\d+|[xX*])(?:\\.(?:\\d+|[xX*])(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?)?)?|[xX*])";
const SEMVER_OP = "(?:>=|<=|>|<|=|~|\\^)";
const SEMVER_COMPARATOR = `(?:${SEMVER_OP}\\s*)?${SEMVER_PART}`;
const SEMVER_HYPHEN_RANGE = `${SEMVER_PART}\\s+-\\s+${SEMVER_PART}`;
const SEMVER_COMPARATOR_SET = `(?:${SEMVER_HYPHEN_RANGE}|${SEMVER_COMPARATOR})(?:\\s+${SEMVER_COMPARATOR})*`;
const SEMVER_RANGE_RE = new RegExp(`^\\s*${SEMVER_COMPARATOR_SET}(?:\\s*\\|\\|\\s*${SEMVER_COMPARATOR_SET})*\\s*$`);

/** Conservative check that `expr` looks like a valid semver range expression. */
function isValidSemverRange(expr: string): boolean {
	return SEMVER_RANGE_RE.test(expr);
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

interface FetchOptions {
	timeoutMs: number;
	maxRedirects: number;
	stage: (s: string) => string;
	headers?: Record<string, string>;
}

/**
 * Fetch with manual redirect handling.
 *
 * One AbortController lives from fetch() through the final body byte: the timer
 * is NOT cleared when headers arrive. Callers receive a `clearTimer` callback
 * to invoke in a `finally` after body consumption, so the deadline covers the
 * entire stream. Redirects are constrained to `allowedOrigin` (the registry
 * origin for packuments, the tarball URL's own origin for tarballs). Every
 * redirect target is rejected if it carries embedded credentials (userinfo).
 * Sensitive headers are never forwarded across origins. Query strings and
 * fragments are permitted on redirect hops only — signed CDN URLs commonly
 * append query parameters (e.g. ?expires=…) on redirect, while the initial
 * URL is validated strictly by the caller.
 */
async function fetchWithRedirects(
	url: string,
	allowedOrigin: string,
	opts: FetchOptions,
): Promise<{ response: Response; clearTimer: () => void }> {
	let currentUrl = url;
	const origin = new URL(allowedOrigin).origin;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	const clearTimer = () => clearTimeout(timer);

	for (let i = 0; i <= opts.maxRedirects; i++) {
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
			clearTimer();
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(opts.stage(`request timed out after ${opts.timeoutMs}ms`));
			}
			throw new Error(opts.stage(`fetch failed: ${err instanceof Error ? err.message : String(err)}`));
		}

		// Handle redirects (3xx)
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				clearTimer();
				throw new Error(opts.stage(`redirect ${response.status} without Location header`));
			}

			// Validate the Location header as an RFC 3986 URI-reference before
			// resolving it. The WHATWG URL parser accepts strings that are not
			// valid URI-references (e.g. "::" is silently treated as a relative
			// path), so the grammar check rejects degenerate values here.
			if (!isValidUriReference(location)) {
				clearTimer();
				throw new Error(opts.stage(`invalid redirect Location: ${JSON.stringify(location)}`));
			}

			let nextUrl: string;
			try {
				nextUrl = new URL(location, currentUrl).href;
			} catch {
				clearTimer();
				throw new Error(opts.stage(`invalid redirect Location: ${JSON.stringify(location)}`));
			}

			let nextParsed: URL;
			try {
				nextParsed = new URL(nextUrl);
			} catch {
				clearTimer();
				throw new Error(opts.stage(`invalid redirect URL: ${JSON.stringify(nextUrl)}`));
			}

			// Reject embedded credentials (userinfo) on every redirect target.
			if (nextParsed.username || nextParsed.password) {
				clearTimer();
				throw new Error(opts.stage(`redirect target must not contain credentials`));
			}

			// Stay on the allowed origin.
			if (nextParsed.origin !== origin) {
				clearTimer();
				throw new Error(opts.stage(`redirect leaves registry origin: ${nextParsed.origin}`));
			}

			if (nextParsed.protocol !== "https:") {
				clearTimer();
				throw new Error(opts.stage(`redirect must stay HTTPS: ${JSON.stringify(nextUrl)}`));
			}

			// Query/fragment are allowed on redirect hops (signed CDN URLs);
			// the initial URL is validated strictly by the caller.
			currentUrl = nextUrl;
			continue;
		}

		return { response, clearTimer };
	}

	clearTimer();
	throw new Error(opts.stage(`exceeded ${opts.maxRedirects} redirects`));
}

/**
 * Download a tarball to a file path while enforcing byte and time limits.
 * Streams the body under the single deadline from fetchWithRedirects, feeds
 * each chunk to an incremental SHA-512 hasher, and returns the 64-byte digest
 * so the caller can verify SRI integrity without re-reading the file.
 */
async function downloadTarball(
	tarballUrl: string,
	destPath: string,
	tarballOrigin: string,
	stage: (s: string) => string,
	lim: NpmFetchLimits,
): Promise<Uint8Array> {
	const { response, clearTimer } = await fetchWithRedirects(tarballUrl, tarballOrigin, {
		timeoutMs: lim.tarballTimeoutMs,
		maxRedirects: lim.maxRedirects,
		stage,
	});

	try {
		if (!response.ok) {
			throw new Error(stage(`tarball download failed: HTTP ${response.status}`));
		}

		const contentLength = response.headers.get("content-length");
		if (contentLength && parseInt(contentLength, 10) > lim.tarballMaxBytes) {
			throw new Error(stage(`tarball exceeds ${lim.tarballMaxBytes} bytes`));
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error(stage(`tarball response has no body`));
		}

		const file = Bun.file(destPath);
		const writer = file.writer();
		const hasher = crypto.createHash("sha512");
		let totalBytes = 0;

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > lim.tarballMaxBytes) {
					throw new Error(stage(`tarball exceeds ${lim.tarballMaxBytes} compressed bytes`));
				}
				hasher.update(value);
				writer.write(value);
			}
			await writer.end();
		} finally {
			reader.releaseLock();
		}

		return new Uint8Array(hasher.digest());
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error(stage(`tarball download timed out after ${lim.tarballTimeoutMs}ms`));
		}
		throw err;
	} finally {
		clearTimer();
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
