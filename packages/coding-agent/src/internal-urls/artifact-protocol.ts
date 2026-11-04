/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against the artifacts directories of every active
 * session. Unlike agent://, artifacts are raw text with no JSON extraction.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import artifactDoc from "../prompts/internal-urls/artifact.md" with { type: "text" };
import { whenArtifactCopiesSettle } from "../session/session-manager";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;

/**
 * Sorted artifact ids for `complete()`, keyed by the scanned dir set.
 * Completion runs per keystroke; a short reuse window avoids re-reading every
 * artifacts dir on each key.
 */
const completionIds = new LRUCache<string, Promise<string[]>>({ max: 8, ttl: 2000 });

async function scanArtifactIds(dirs: string[]): Promise<string[]> {
	const listings = await Promise.all(
		dirs.map(async dir => {
			try {
				return await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) return [];
				throw err;
			}
		}),
	);
	const ids = new Set<string>();
	for (const files of listings) {
		for (const f of files) {
			const m = f.match(/^(\d+)\./);
			if (m) ids.add(m[1]!);
		}
	}
	return [...ids].sort((a, b) => Number(a) - Number(b));
}

function artifactIdsForCompletion(): Promise<string[]> {
	const dirs = artifactsDirsFromRegistry();
	const key = dirs.join("\0");
	const cached = completionIds.get(key);
	if (cached) return cached;
	const ids = scanArtifactIds(dirs);
	completionIds.set(key, ids);
	ids.catch(() => completionIds.delete(key));
	return ids;
}

/** Filesystem location for a session artifact, resolved without materializing its content. */
interface ResolvedArtifactFile {
	id: string;
	path: string;
	size: number;
}

function parseArtifactId(url: InternalUrl): string {
	const id = url.rawHost || url.hostname;
	if (!id) {
		throw new Error("artifact:// URL requires a numeric ID: artifact://0");
	}
	if (!/^\d+$/.test(id)) {
		throw new Error(`artifact:// ID must be numeric, got: ${id}`);
	}
	return id;
}

/** An artifact id no session artifacts dir backs; `locate` maps it to null, `resolve` surfaces it. */
class MissingArtifactError extends Error {}

/**
 * The caller's own in-memory spill for `id`, when the caller has no artifacts
 * dir (`--no-session`, SDK). It wins over registry-backed files: ids are
 * per-session counters, so another session's `<id>.*` file is not this one.
 */
function callerInMemoryArtifact(id: string, context?: ResolveContext): string | null {
	if (context?.localProtocolOptions?.getArtifactsDir?.()) return null;
	if (context?.session?.seanceSourceArtifactsDir) return null;
	return context?.session?.sessionManager?.getArtifactContent?.(id) ?? null;
}

/**
 * Wait for any artifact copy still filling the directories about to be read.
 *
 * A fork's artifacts arrive in the background, and `ArtifactManager` waits for
 * them — but every public `artifact://` read goes straight to the filesystem,
 * so without this a read landing mid-copy sees a directory that is not yet the
 * session's own.
 */
async function awaitArtifactsSettled(dirs: readonly string[], context?: ResolveContext): Promise<void> {
	const signal = context?.signal;
	await context?.session?.sessionManager?.whenArtifactsSettled?.(signal);
	// Most readers hold no session object — an export, a subagent's own
	// options, a bare protocol call — so the wait is also keyed by directory,
	// and only by the directories this read could be answered from: waiting on
	// an unrelated session's copy is a stall, not a safeguard. A caller that
	// can be cancelled is: a pending answer is better than a wrong one, but
	// not better than the caller's own abort.
	for (const dir of dirs) await whenArtifactCopiesSettle(dir, signal);
}

/** Resolve an `artifact://` URL to its backing file without reading artifact bytes. */
async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const id = parseArtifactId(url);

	// Artifact ids are per-session counters, so an id this session does not
	// have is not another session's to answer with: a caller with an artifacts
	// directory of its own reads that one and nothing else. Falling through to
	// the registry would hand a fork that lost (or has not yet received) its
	// artifacts the bytes of whatever live session happens to hold the same
	// number.
	const pinnedDir = context?.localProtocolOptions?.getArtifactsDir?.() ?? null;
	// A seance reads only its own artifacts plus the consulted source's, in
	// place; its own ids are allocated past the source's, so neither shadows.
	const seanceDir = context?.session?.seanceSourceArtifactsDir;
	const dirs = seanceDir
		? [...(pinnedDir ? [pinnedDir] : []), seanceDir]
		: pinnedDir
			? [pinnedDir]
			: artifactsDirsFromRegistry();

	if (dirs.length === 0) {
		throw new MissingArtifactError("No session - artifacts unavailable");
	}
	await awaitArtifactsSettled(dirs, context);

	let foundPath: string | undefined;
	let anyDirExists = false;
	const availableIds = new Set<string>();

	for (const dir of dirs) {
		let files: string[];
		try {
			files = await fs.readdir(dir);
			anyDirExists = true;
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		const match = files.find(f => f.startsWith(`${id}.`));
		if (match) {
			foundPath = path.join(dir, match);
			break;
		}
		for (const f of files) {
			const m = f.match(/^(\d+)\./);
			if (m) availableIds.add(m[1]);
		}
	}

	if (!anyDirExists) {
		throw new MissingArtifactError("No artifacts directory found");
	}

	if (!foundPath) {
		const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
		const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
		throw new MissingArtifactError(`Artifact ${id} not found. Available: ${availableStr}`);
	}

	const stat = await Bun.file(foundPath).stat();
	if (stat.isDirectory()) {
		throw new Error(`Artifact ${id} resolved to a directory, not a file`);
	}
	return { id, path: foundPath, size: stat.size };
}

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly spec: SchemeSpec = {
		backing: "file",
		selectors: "lines",
		immutable: true,
		artifactStore: true,
		linkable: true,
	};

	promptDoc(): string {
		return artifactDoc.trim();
	}

	/** Backing artifact file; null for unknown ids, throws the resolve errors for malformed ones. */
	async locate(url: InternalUrl, context?: ResolveContext): Promise<string | null> {
		// No backing file: the read tool falls through to `resolve` and applies selectors in memory.
		if (callerInMemoryArtifact(parseArtifactId(url), context) !== null) return null;
		try {
			return (await resolveArtifactFile(url, context)).path;
		} catch (error) {
			if (error instanceof MissingArtifactError) return null;
			throw error;
		}
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		// A non-persistent session (`--no-session`, SDK) spills into memory
		// instead of an artifacts dir; the `artifact://` link the truncation
		// footer advertises must read that copy. The bytes are already resident,
		// so the size gate below (which avoids loading a large file) does not
		// apply; the read tool pages and limits the content it returns.
		const inMemory = callerInMemoryArtifact(parseArtifactId(url), context);
		if (inMemory !== null) {
			return {
				url: url.href,
				content: inMemory,
				contentType: "text/plain",
				size: Buffer.byteLength(inMemory, "utf8"),
			};
		}
		const artifact = await resolveArtifactFile(url, context);

		// Path consumers (search, the shell filesystem) use `locate`, which never
		// reads the bytes; only content materialization is size-gated.
		if (artifact.size > MAX_INLINE_ARTIFACT_BYTES) {
			throw new Error(
				`Artifact ${artifact.id} is ${artifact.size} bytes; full internal resolution is blocked. Use read selectors such as artifact://${artifact.id}:1-3000 or artifact://${artifact.id}:raw:1-3000, and use the artifact file path for search/copy workflows: ${artifact.path}`,
			);
		}

		const content = await Bun.file(artifact.path).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: artifact.size,
			sourcePath: artifact.path,
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		return (await artifactIdsForCompletion()).map(value => ({ value }));
	}
}
