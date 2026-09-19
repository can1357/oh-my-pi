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
import { readArtifactProvenance } from "../session/artifacts";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const ARTIFACT_FILENAME_RE = /^(\d+)\.[A-Za-z0-9_-]+\.log$/;

function artifactIdFromFilename(filename: string): string | undefined {
	return ARTIFACT_FILENAME_RE.exec(filename)?.[1];
}

function isArtifactFilenameForId(filename: string, id: string): boolean {
	return artifactIdFromFilename(filename) === id;
}

/** Filesystem location for a session artifact, resolved without materializing its content. */
export interface ResolvedArtifactFile {
	id: string;
	path: string;
	size: number;
	producerSessionId?: string;
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

/** Resolve an `artifact://` URL to its backing file without reading artifact bytes. */
export async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const id = parseArtifactId(url);
	const producerScoped = context?.localProtocolOptions?.artifactResolutionScope === "producer";
	const callerSessionId = context?.sessionId ?? context?.localProtocolOptions?.getSessionId?.() ?? null;
	if (producerScoped && !callerSessionId) {
		throw new Error("Producer-scoped artifact resolution requires a calling session ID");
	}

	// Artifact ids are per-session counters; in multi-session hosts the same
	// id exists in several dirs. Pin resolution to the calling session's
	// artifacts dir first so `artifact://3` means *this* session's #3.
	let dirs = artifactsDirsFromRegistry();
	const pinnedDir = context?.localProtocolOptions?.getArtifactsDir?.() ?? null;
	if (producerScoped) {
		dirs = pinnedDir ? [pinnedDir] : [];
	}
	if (pinnedDir) {
		const pinnedIndex = dirs.indexOf(pinnedDir);
		if (pinnedIndex >= 0) dirs.splice(pinnedIndex, 1);
		dirs.unshift(pinnedDir);
	}

	if (dirs.length === 0) {
		throw new Error("No session - artifacts unavailable");
	}

	let foundPath: string | undefined;
	let producerSessionId: string | undefined;
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
		const match = files.find(f => isArtifactFilenameForId(f, id));
		if (match) {
			const provenance = await readArtifactProvenance(dir, id);
			if (!producerScoped || provenance?.producerSessionId === callerSessionId) {
				foundPath = path.join(dir, match);
				producerSessionId = provenance?.producerSessionId;
				break;
			}
		}
		if (!producerScoped) {
			for (const f of files) {
				const artifactId = artifactIdFromFilename(f);
				if (artifactId) availableIds.add(artifactId);
			}
		}
	}

	if (!anyDirExists) {
		throw new Error("No artifacts directory found");
	}

	if (!foundPath) {
		if (producerScoped) {
			throw new Error(`Artifact ${id} not found`);
		}
		const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
		const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
		throw new Error(`Artifact ${id} not found. Available: ${availableStr}`);
	}

	const stat = await Bun.file(foundPath).stat();
	if (stat.isDirectory()) {
		throw new Error(`Artifact ${id} resolved to a directory, not a file`);
	}
	return { id, path: foundPath, size: stat.size, producerSessionId };
}

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const artifact = await resolveArtifactFile(url, context);

		// Path-only callers (search/grep, bash URL expansion) never touch the
		// artifact bytes. Return the resource shape so those flows keep working
		// on artifacts of any size — only content materialization is gated.
		if (context?.pathOnly) {
			return {
				url: url.href,
				content: "",
				contentType: "text/plain",
				size: artifact.size,
				sourcePath: artifact.path,
			};
		}

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

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		const producerScoped = context?.localProtocolOptions?.artifactResolutionScope === "producer";
		const callerSessionId = context?.sessionId ?? context?.localProtocolOptions?.getSessionId?.() ?? null;
		const pinnedDir = context?.localProtocolOptions?.getArtifactsDir?.() ?? null;
		const dirs = producerScoped ? (pinnedDir ? [pinnedDir] : []) : artifactsDirsFromRegistry();
		if (producerScoped && !callerSessionId) return [];
		for (const dir of dirs) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				const artifactId = artifactIdFromFilename(f);
				if (!artifactId) continue;
				if (
					!producerScoped ||
					(await readArtifactProvenance(dir, artifactId))?.producerSessionId === callerSessionId
				) {
					ids.add(artifactId);
				}
			}
		}
		return [...ids].sort((a, b) => Number(a) - Number(b)).map(value => ({ value }));
	}
}
