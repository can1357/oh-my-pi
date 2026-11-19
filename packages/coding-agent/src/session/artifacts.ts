/**
 * Session-scoped spill storage for truncated tool outputs and shaped originals.
 *
 * Spill `N` is the file `<N>.log` at the session's `local://` root, read back as
 * `local://<N>.log` (see `spillUrl` in `@oh-my-pi/pi-utils`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist, logger, spillFileName, spillIdOfFileName, toError } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";

/**
 * Persist an artifact only when the filesystem confirms the complete payload is
 * readable, then swap it into place atomically.
 *
 * Content is staged to a temporary sibling and verified (byte count, on-disk
 * size, readability) before an atomic `rename` publishes it. `agent://<id>`
 * discovers `${id}.md` by scanning the artifacts directory rather than reading
 * `result.outputPath`, so a direct in-place write that fell short would leave a
 * truncated file resolvable as incomplete output and a failed follow-up write
 * would destroy the prior valid artifact. Staging keeps both hazards out: on
 * any failure the temp file is removed and the existing artifact at `path` is
 * untouched.
 *
 * Returns the verified UTF-8 byte count.
 */
export async function writeArtifact(path: string, content: string): Promise<number> {
	const expectedBytes = Buffer.byteLength(content);
	const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
	try {
		const writtenBytes = await Bun.write(tempPath, content);
		if (writtenBytes !== expectedBytes) {
			throw new Error(`Artifact write incomplete: wrote ${writtenBytes} of ${expectedBytes} bytes`);
		}
		const file = Bun.file(tempPath);
		if (file.size !== expectedBytes) {
			throw new Error(`Artifact size mismatch: found ${file.size} of ${expectedBytes} bytes`);
		}
		await file.slice(0, Math.min(expectedBytes, 1)).arrayBuffer();
		await replaceFileAtomically(tempPath, path);
	} catch (error) {
		// Best-effort cleanup: the write or publication error is the one to report.
		await fs.rm(tempPath, { force: true }).catch(cleanupError => {
			logger.warn("Failed to remove staged artifact", { tempPath, error: toError(cleanupError).message });
		});
		throw error;
	}
	return expectedBytes;
}

/**
 * Spill surface shared by a session and the subagents that adopt its manager.
 * {@link ArtifactManager} implements it on the owning thread; a subagent worker
 * holds a remote implementation whose ids come from the owner
 * (`thread/services/runtime-remote.ts`), so ids stay unique across the tree.
 */
export interface ArtifactManagerApi {
	/** The `local://` root spills live in; may not exist until the first spill is saved. */
	readonly dir: string;
	/**
	 * The owning session's directory (`<session>` beside `<session>.jsonl`), which
	 * `getArtifactsDir()` and `resolveLocalRoot` key off; null without a session file.
	 */
	readonly sessionDir: string | null;
	/** Claim the next spill id and its file without writing content. */
	allocatePath(): Promise<{ id: string; path: string }>;
	/** Save `content` as a new spill; returns its id. */
	save(content: string): Promise<string>;
	exists(id: string): Promise<boolean>;
	/** Full path of a spill file, or null when it does not exist. */
	getPath(id: string): Promise<string | null>;
}

/**
 * Manages spill storage for a session.
 *
 * Spills get sequential ids at the session's `local://` root. That root is
 * shared with the agent's own `local://` writes, so each id's file is claimed
 * exclusively before content lands: a model-written `7.log` is skipped, never
 * clobbered. The directory is created lazily on first write.
 *
 * Subagents do not own their own `ArtifactManager`. The parent's instance is
 * adopted via `SessionManager.adoptArtifactManager`, so the whole parent +
 * subagent tree shares one id space and one root.
 */
export class ArtifactManager implements ArtifactManagerApi {
	#nextId = 0;
	readonly #dir: string;
	readonly #sessionDir: string | null;
	#dirCreated = false;
	#initPromise: Promise<void> | null = null;
	readonly #ready: Promise<void> | undefined;

	/**
	 * @param dir The `local://` root that holds spill files. Created lazily on first save.
	 * @param sessionDir The owning session's directory, carried for adopting subagents.
	 * @param ready Settles once `dir` is seeded (a session move copying the previous
	 *   session's files in the background). Id scans and lookups wait for it,
	 *   so new ids never collide with copied ones. Must not reject.
	 */
	constructor(dir: string, sessionDir: string | null, ready?: Promise<void>) {
		this.#dir = dir;
		this.#sessionDir = sessionDir;
		this.#ready = ready;
	}

	get dir(): string {
		return this.#dir;
	}

	get sessionDir(): string | null {
		return this.#sessionDir;
	}

	async #ensureDir(): Promise<void> {
		await this.#ready;
		if (!this.#dirCreated) {
			await fs.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		// Memoize the first-use scan so it runs exactly once. Concurrent callers
		// share the in-flight promise instead of each re-seeding #nextId across
		// the readdir yield in #scanExistingIds (which would hand duplicate ids).
		this.#initPromise ??= this.#scanExistingIds();
		await this.#initPromise;
	}

	/** Start ids past every `<N>.log` already at the root, so a resumed session never reuses one. */
	async #scanExistingIds(): Promise<void> {
		let maxId = -1;
		for (const file of await this.#listFiles()) {
			const id = spillIdOfFileName(file);
			if (id !== undefined && id > maxId) maxId = id;
		}
		this.#nextId = maxId + 1;
	}

	/**
	 * Claim the next free spill id: create its file exclusively (`wx`), bumping
	 * past any `<N>.log` that appeared since the scan. The empty placeholder is
	 * replaced atomically by {@link writeArtifact}.
	 */
	async allocatePath(): Promise<{ id: string; path: string }> {
		await this.#ensureDir();
		for (;;) {
			const id = String(this.#nextId++);
			const filePath = path.join(this.#dir, spillFileName(id));
			try {
				const handle = await fs.open(filePath, "wx");
				await handle.close();
				return { id, path: filePath };
			} catch (err) {
				if (!isEexist(err)) throw err;
			}
		}
	}

	/** Save content as a new spill and return its id. */
	async save(content: string): Promise<string> {
		const { id, path } = await this.allocatePath();
		await writeArtifact(path, content);
		return id;
	}

	async exists(id: string): Promise<boolean> {
		return (await this.getPath(id)) !== null;
	}

	async #listFiles(): Promise<string[]> {
		await this.#ready;
		try {
			return await fs.readdir(this.#dir);
		} catch {
			return [];
		}
	}

	/** Full path of spill `id`, or null when its file does not exist. */
	async getPath(id: string): Promise<string | null> {
		await this.#ready;
		const filePath = path.join(this.#dir, spillFileName(id));
		try {
			return (await fs.stat(filePath)).isFile() ? filePath : null;
		} catch {
			return null;
		}
	}
}
