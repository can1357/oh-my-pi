/**
 * GitHub source adapter: spec parsing, ref resolution, tree listing, file reads.
 *
 * Only the provider side lives here. Caching and version pinning belong to
 * `store.ts`, so this module stays usable from the CLI and from tests with an
 * injected `fetch`.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { RemoteSkillError } from "./types";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Default per-request deadline (doc §14: 15 s). */
export const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
/** Default retries beyond the first attempt (doc §14: at most 2). */
export const REMOTE_MAX_RETRIES = 2;
/** `SKILL.md` cap (doc §14). */
export const MAX_SKILL_DOCUMENT_BYTES = 256 * 1024;
/** Single resource cap. */
export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface RemoteSourceSpec {
	readonly repository: string;
	readonly ref: string;
	/** Skill root inside the repository; empty means the repository root. */
	readonly directory: string;
}

/**
 * Parse `owner/repo[@ref][#directory]`.
 *
 * Ref and directory are optional; `ref` defaults to the repository's default
 * branch (`HEAD` via the commits API). Only GitHub is accepted: a URL scheme is
 * rejected so the model can never turn a skill into an arbitrary fetch.
 */
export function parseRemoteSourceSpec(spec: string): RemoteSourceSpec {
	const raw = spec.trim();
	if (!raw) throw new RemoteSkillError("INVALID_SOURCE", "empty skill source");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		throw new RemoteSkillError("INVALID_SOURCE", `expected owner/repo, got a URL: ${raw}`);
	}
	// `#` first: a ref may itself contain `/` (branch names) but not `#`.
	const hash = raw.indexOf("#");
	const directory = hash === -1 ? "" : raw.slice(hash + 1);
	const rest = hash === -1 ? raw : raw.slice(0, hash);
	const at = rest.indexOf("@");
	const repository = (at === -1 ? rest : rest.slice(0, at)).trim();
	const ref = at === -1 ? "" : rest.slice(at + 1).trim();
	if (!REPOSITORY_RE.test(repository)) {
		throw new RemoteSkillError("INVALID_SOURCE", `expected owner/repo, got "${repository}"`);
	}
	return { repository, ref, directory: normalizeRelativeDirectory(directory) };
}

/** Validate and normalize a POSIX directory relative to the repository root. */
export function normalizeRelativeDirectory(raw: string): string {
	const normalized = raw.replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
	if (normalized === "") return "";
	for (const segment of normalized.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new RemoteSkillError("INVALID_SOURCE", `unsafe directory segment in "${raw}"`);
		}
	}
	return normalized;
}

/** Validate a POSIX path relative to a skill root. */
export function assertSkillRelativePath(raw: string): string {
	const normalized = raw.replace(/\\/g, "/");
	if (normalized.startsWith("/") || normalized === "" || normalized.split("/").includes("..")) {
		throw new RemoteSkillError("PATH_DENIED", `path escapes the skill root: ${raw}`);
	}
	return normalized;
}

/** True when `value` is already an immutable commit id. */
export function isCommitId(value: string): boolean {
	return COMMIT_RE.test(value);
}

/**
 * Resolve a mutable ref (or the default branch) to a commit id.
 *
 * A 40-hex input is returned unchanged: an explicit commit needs no network and
 * must never be re-resolved into a different revision.
 */
export async function resolveRemoteCommit(
	repository: string,
	ref: string,
	options: { fetch?: FetchFn; signal?: AbortSignal } = {},
): Promise<string> {
	if (isCommitId(ref)) return ref;
	const endpoint = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref || "HEAD")}`;
	const payload = await githubJson(endpoint, options);
	const commit = isRecord(payload) && typeof payload.sha === "string" ? payload.sha : "";
	if (!isCommitId(commit)) {
		throw new RemoteSkillError("NETWORK", `commits API returned no commit id for ${repository}@${ref || "HEAD"}`);
	}
	return commit;
}

/**
 * List `SKILL.md` files under `directory` at `commit`.
 *
 * Uses one recursive tree listing. A skill is a directory containing
 * `SKILL.md`; the spec requires the frontmatter name to equal the directory
 * name, so no repository-side manifest is needed.
 */
export async function listRemoteSkillFiles(
	repository: string,
	commit: string,
	directory: string,
	options: { fetch?: FetchFn; signal?: AbortSignal } = {},
): Promise<string[]> {
	const endpoint = `https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`;
	const payload = await githubJson(endpoint, options);
	const tree = isRecord(payload) && Array.isArray(payload.tree) ? payload.tree : undefined;
	if (!tree) throw new RemoteSkillError("NETWORK", `tree API returned no tree for ${repository}@${commit}`);
	const prefix = directory === "" ? "" : `${directory}/`;
	const files: string[] = [];
	for (const entry of tree) {
		if (!isRecord(entry) || typeof entry.path !== "string" || entry.type !== "blob") continue;
		if (!entry.path.startsWith(prefix) || !entry.path.endsWith("/SKILL.md")) continue;
		files.push(entry.path);
	}
	return files.sort();
}

/** Read one file at an exact commit. Returns `null` when the path does not exist. */
export async function readRemoteFile(
	repository: string,
	commit: string,
	file: string,
	options: { fetch?: FetchFn; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<Uint8Array | null> {
	if (!isCommitId(commit)) throw new RemoteSkillError("INVALID_SOURCE", `not a commit id: ${commit}`);
	const maxBytes = options.maxBytes ?? MAX_RESOURCE_BYTES;
	const raw = `https://raw.githubusercontent.com/${repository}/${commit}/${file}`;
	const response = await requestWithRetry(raw, options.fetch ?? fetch, options.signal);
	if (response.status === 404) return null;
	assertStatus(response, `${repository}@${commit}:${file}`);
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new RemoteSkillError("RESOURCE_LIMIT_EXCEEDED", `${file} is ${declared} bytes; the limit is ${maxBytes}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) {
		throw new RemoteSkillError(
			"RESOURCE_LIMIT_EXCEEDED",
			`${file} is ${bytes.byteLength} bytes; the limit is ${maxBytes}`,
		);
	}
	return bytes;
}

// ─── HTTP plumbing ──────────────────────────────────────────────────────────

async function githubJson(endpoint: string, options: { fetch?: FetchFn; signal?: AbortSignal }): Promise<unknown> {
	const response = await requestWithRetry(endpoint, options.fetch ?? fetch, options.signal, {
		Accept: "application/vnd.github+json",
	});
	assertStatus(response, endpoint);
	return await response.json();
}

async function requestWithRetry(
	url: string,
	run: FetchFn,
	signal: AbortSignal | undefined,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	let lastError: unknown;
	for (let attempt = 0; attempt <= REMOTE_MAX_RETRIES; attempt++) {
		let response: Response | undefined;
		try {
			response = await run(url, {
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS)])
					: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS),
				headers: {
					"User-Agent": "oh-my-pi",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...extraHeaders,
				},
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = error;
		}
		if (response && response.status !== 429 && response.status < 500) return response;
		lastError ??= new RemoteSkillError("RATE_LIMITED", `${url} responded ${response?.status ?? "no response"}`);
		await Bun.sleep(response ? (retryAfterMs(response) ?? backoffMs(attempt)) : backoffMs(attempt));
	}
	const detail = lastError instanceof Error ? lastError.message : String(lastError);
	throw new RemoteSkillError("NETWORK", `${url} failed after ${REMOTE_MAX_RETRIES + 1} attempts: ${detail}`);
}

/** Exponential backoff for retriable provider errors, capped well below the request timeout. */
function backoffMs(attempt: number): number {
	return Math.min(2_000, 250 * 2 ** attempt);
}

function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.min(5_000, seconds * 1_000) : undefined;
}

function assertStatus(response: Response, what: string): void {
	if (response.ok) return;
	if (response.status === 401) {
		throw new RemoteSkillError("AUTH_REQUIRED", `${what}: GitHub credentials are required`);
	}
	if (response.status === 403) {
		throw new RemoteSkillError("ACCESS_DENIED", `${what}: GitHub denied access`);
	}
	if (response.status === 404) {
		throw new RemoteSkillError("NOT_FOUND", `${what}: not found`);
	}
	if (response.status === 429) {
		throw new RemoteSkillError("RATE_LIMITED", `${what}: GitHub rate limit exceeded`);
	}
	throw new RemoteSkillError("NETWORK", `${what}: HTTP ${response.status}`);
}
