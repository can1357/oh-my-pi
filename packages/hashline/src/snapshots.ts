/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file content that minted them.
 *
 * A section tag is a content-derived hash of the *whole file* (see
 * {@link computeFileHash}). Any read of byte-identical content mints the same
 * tag, so reads of one file state fuse onto one anchor and a follow-up edit
 * anchored at any line validates whenever the live file still hashes to it.
 *
 * Producers (typically `read` / `search` / `write` tools) call
 * {@link SnapshotStore.record} with the full normalized text they observed.
 * The store hashes it, dedups against the per-path history, and returns the
 * tag. Consumers (the patcher) resolve a stale tag back to the recorded full
 * text via {@link SnapshotStore.byHash} and 3-way-merge the would-be edit onto
 * the live content.
 *
 * The abstract base class lets callers plug in whatever storage they like
 * (LRU, persistent SQLite, etc.). {@link InMemorySnapshotStore} ships as a
 * sensible default backed by `lru-cache`: a bounded set of paths, each with a
 * short history of full-file versions so in-session edit chains can still
 * recover against the version a stale tag names.
 */
import { LRUCache } from "lru-cache/raw";
import { computeFileHash } from "./format";

/**
 * One full-file version observed at a point in time. The tag the model sees is
 * {@link Snapshot.hash}; recovery replays edits against {@link Snapshot.text}.
 */
export interface Snapshot {
	/** Canonical path this version belongs to. */
	readonly path: string;
	/** Full normalized (LF, no BOM) file text as observed. */
	readonly text: string;
	/** Content-derived tag for {@link Snapshot.text} (see {@link computeFileHash}). */
	readonly hash: string;
	/** Timestamp (ms since epoch) the version was recorded. */
	recordedAt: number;
	/**
	 * 1-indexed file lines a producer (read/search) actually *displayed* under
	 * this tag. A partial read (range, or a structural summary that collapsed
	 * bodies) leaves this sparse; a whole-file read fills every line. Multiple
	 * reads of the same content union into one set. `undefined` means "no
	 * provenance recorded" — the patcher then skips the seen-line check and
	 * applies as before. Mutated in place as more of the same content is read.
	 */
	seenLines?: Set<number>;
}

/**
 * Storage seam for full-file version snapshots. The patcher calls {@link head}
 * for the latest version of a path and {@link byHash} when it needs the
 * specific historical version a section's stale tag names.
 */
export abstract class SnapshotStore {
	/** Most-recently recorded version for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/** Recorded version for `path` whose tag equals `hash`, or `null`. */
	abstract byHash(path: string, hash: string): Snapshot | null;

	/**
	 * Every retained version whose tag equals `hash`, across all tracked
	 * paths. The patcher uses this to recover the intended file when a section
	 * names a path that does not exist on disk but carries a tag the store
	 * minted — the model mistyped the path of a file it read this session.
	 *
	 * The base returns no matches (recovery disabled); stores that can
	 * enumerate their contents override it to enable tag-based path recovery.
	 */
	findByHash(_hash: string): Snapshot[] {
		return [];
	}

	/**
	 * Record the full normalized text of `path` and return its content tag.
	 * `seenLines` (optional) are the 1-indexed lines the producer displayed;
	 * they merge into {@link Snapshot.seenLines} across reads of identical text.
	 */
	abstract record(path: string, fullText: string, seenLines?: Iterable<number>): string;

	/**
	 * Merge `lines` into the {@link Snapshot.seenLines} of the version whose tag
	 * equals `hash`. No-op when no such version is retained (the content aged
	 * out or was overwritten). Lets producers attach displayed lines after the
	 * tag was already minted (the body is formatted after the hash is computed).
	 */
	abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;

	/** Drop the version history for a single path. */
	abstract invalidate(path: string): void;

	/**
	 * Move retained version history (and read provenance) from `from` to `to`.
	 * No-op when `from` has no history. Used by file moves so tags minted from
	 * reads of the source path stay valid at the destination.
	 */
	abstract relocate(from: string, to: string): void;

	/** Drop every version history. */
	abstract clear(): void;
}

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
/** Global ceiling on retained snapshot text across all paths (UTF-16 code units). */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Union `lines` into `snapshot.seenLines`, lazily creating the set. */
function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
	for (const line of lines) snapshot.seenLines.add(line);
}

export interface InMemorySnapshotStoreOptions {
	/** Maximum number of distinct paths tracked at once (default 30). LRU eviction. */
	maxPaths?: number;
	/** Maximum full-file versions retained per path (default 4). Oldest dropped first. */
	maxVersionsPerPath?: number;
	/**
	 * Global ceiling on retained snapshot text summed across every path's
	 * version history, measured in UTF-16 code units (default 64 MiB).
	 * Least-recently-used path histories are evicted to stay under it.
	 */
	maxTotalBytes?: number;
}

/**
 * In-memory {@link SnapshotStore} backed by `lru-cache`. Per-path history is a
 * short ring of full-file versions (oldest dropped first); per-session path
 * tracking is LRU-bounded so cold paths age out automatically.
 *
 * Recording byte-identical content again refreshes recency and reuses the
 * existing tag (read fusion); recording new content unshifts a fresh version
 * onto the front of the path history.
 */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #versions: LRUCache<string, Snapshot[]>;
	readonly #maxVersionsPerPath: number;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		super();
		this.#versions = new LRUCache<string, Snapshot[]>({
			max: options.maxPaths ?? DEFAULT_MAX_PATHS,
			maxSize: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			sizeCalculation: history => {
				let total = 1;
				for (const version of history) total += version.text.length;
				return total;
			},
		});
		this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
	}

	head(path: string): Snapshot | null {
		return this.#versions.get(path)?.[0] ?? null;
	}

	byHash(path: string, hash: string): Snapshot | null {
		const history = this.#versions.get(path);
		return history?.find(version => version.hash === hash) ?? null;
	}

	findByHash(hash: string): Snapshot[] {
		const matches: Snapshot[] = [];
		for (const history of this.#versions.values()) {
			for (const version of history) {
				if (version.hash === hash) matches.push(version);
			}
		}
		return matches;
	}

	record(path: string, fullText: string, seenLines?: Iterable<number>): string {
		const hash = computeFileHash(fullText);
		// `get` refreshes LRU recency for `path`.
		const history = this.#versions.get(path) ?? [];
		const existing = history.find(version => version.hash === hash);
		if (existing) {
			// Same content state observed again: refresh recency and promote to
			// head (it is the current file content), then reuse the tag. Union any
			// newly-displayed lines so re-reading more of the file widens coverage.
			existing.recordedAt = Date.now();
			mergeSeenLines(existing, seenLines);
			if (history[0] !== existing) {
				this.#versions.set(path, [existing, ...history.filter(version => version !== existing)]);
			}
			return hash;
		}

		const snapshot: Snapshot = { path, text: fullText, hash, recordedAt: Date.now() };
		mergeSeenLines(snapshot, seenLines);
		this.#versions.set(path, [snapshot, ...history].slice(0, this.#maxVersionsPerPath));
		return hash;
	}

	recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find(snapshot => snapshot.hash === hash);
		if (version) mergeSeenLines(version, lines);
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
	}

	relocate(from: string, to: string): void {
		const sourceHistory = this.#versions.get(from);
		if (sourceHistory === undefined || sourceHistory.length === 0) return;
		const relocated = sourceHistory.map(version => ({ ...version, path: to }));
		const destHistory = this.#versions.get(to);
		if (destHistory === undefined) {
			this.#versions.set(to, relocated);
		} else {
			const seen = new Set<string>();
			const merged: Snapshot[] = [];
			for (const version of [...relocated, ...destHistory]) {
				if (seen.has(version.hash)) continue;
				seen.add(version.hash);
				merged.push(version);
			}
			this.#versions.set(to, merged.slice(0, this.#maxVersionsPerPath));
		}
		this.#versions.delete(from);
	}

	clear(): void {
		this.#versions.clear();
	}
}
