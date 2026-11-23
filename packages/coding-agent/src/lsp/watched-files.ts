/**
 * Client side of LSP file watching (`workspace/didChangeWatchedFiles`).
 *
 * OMP advertises dynamic registration for watched files, so language servers
 * hand watching to the client instead of running their own watchers (whose
 * failure modes, such as tsgo's re-arm loop on SMB drives, the client cannot
 * contain). A forwarder belongs to whoever owns the server process: the mux
 * for shared servers, the client for servers it spawned itself.
 *
 * Windows watches through the native `DirectoryWatcher` (libuv's watcher
 * behind Bun's `fs.watch` drops most changes of a burst there and costs a
 * core). Linux watches a tree one directory at a time: a recursive `fs.watch`
 * there puts an inotify watch on every directory below, package contents and
 * VCS object stores included, and can use up the user's inotify watch limit;
 * an {@link InotifyBudget} bounds what the trees of a process hold.
 * Elsewhere a recursive `fs.watch` is lossless and cheap.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { DirectoryChangeAction, type DirectoryChanges, DirectoryWatcher } from "@oh-my-pi/pi-natives";
import { hasFsCode, logger } from "@oh-my-pi/pi-utils";
import { mapWithConcurrencyLimit } from "../task/parallel";
import { FileChangeType, type FileEvent } from "./types";
import { fileToUri, uriToFile } from "./utils";

/** Method a server registers to have the client watch files for it. */
export const WATCHED_FILES_METHOD = "workspace/didChangeWatchedFiles";

/** `WatchKind` default: Create | Change | Delete. Bit `1 << (type - 1)` selects a `FileChangeType`. */
const WATCH_ALL = 7;
/** `WatchKind` bit of `FileChangeType.Deleted`. */
const WATCH_DELETE = 1 << (FileChangeType.Deleted - 1);
/** Quiet time before a batch of changes is sent, and the longest a change waits. */
const FLUSH_QUIET_MS = 50;
const FLUSH_MAX_MS = 250;
/** Delay before re-resolving watched directories after entries were created, removed or renamed. */
const RESYNC_MS = 100;
/** After lost changes, files touched this long before the last delivered change are re-reported. */
const RESCAN_SLACK_MS = 2_000;
/** Stats in flight at once while a rescan checks which files changed (each is a round trip on network drives). */
const RESCAN_STAT_CONCURRENCY = 32;
/** How long a change the client reported itself suppresses the watcher's echo of it. */
const ANNOUNCED_TTL_MS = 10_000;
/** How long a path's last reported creation or deletion makes a repeat of it redundant. */
const REPORTED_TTL_MS = 10_000;
/** Largest lag of the file system's clock behind ours that rescans make up for; more is a preserved mtime. */
const CLOCK_LAG_MAX_MS = 10 * 60_000;
/** Directories read at once while walking a tree (each is a round trip on network drives). */
const WALK_CONCURRENCY = 16;
/** Share of the user's inotify watch limit one process's directory trees may hold; other programs keep the rest. */
const INOTIFY_SHARE = 0.25;
/** `fs.inotify.max_user_watches` when it cannot be read: the kernel default before Linux 5.11. */
const DEFAULT_MAX_USER_WATCHES = 8192;

/** Matches the servers' view: tsgo and friends treat Windows and macOS file names case-insensitively. */
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const GLOB_CHARS = /[*?[{]/;

/** `DidChangeWatchedFilesRegistrationOptions`: a server's watchers, as sent in registerCapability. */
const RegisterOptions = type({
	watchers: type({
		globPattern: type("string").or({ baseUri: type("string").or({ uri: "string" }), pattern: "string" }),
		"kind?": "number",
	}).array(),
});

/** `InitializeParams` that ask the server to hand watching to the client. */
const AdvertisesWatching = type({
	capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: "true" } } },
});

/** Whether `initialize` params advertise `workspace/didChangeWatchedFiles` dynamic registration. */
export function advertisesWatchedFiles(initializeParams: unknown): boolean {
	return !(AdvertisesWatching(initializeParams) instanceof type.errors);
}

/** `DidChangeWatchedFilesParams`, as the client sends them for its own writes. */
const ChangeParams = type({ changes: type({ uri: "string", type: "number" }).array() });

/**
 * Whether `rel` (relative to a watched base, case-folded, `/`-separated) lies
 * where VS Code's default `files.watcherExclude` stops watching: package
 * contents (everything below `node_modules`) and VCS object stores. A base registered
 * inside such a place is watched normally; only paths below a base count.
 */
function excludedWithin(rel: string): boolean {
	const segments = rel.split("/");
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		const next = segments[i + 1];
		if (segment === "node_modules") return true;
		if (segment === ".git" && (next === "objects" || next === "subtree-cache")) return true;
		if (segment === ".hg" && next === "store") return true;
	}
	return false;
}

/**
 * What decides which directories a per-directory tree watches
 * ({@link WatchedFilesForwarder}'s `#wantsBeneath`): each spec's base and
 * whether it is deep. Registrations that only change globs or kinds leave it
 * the same, so the tree needs no new walk.
 */
function treeLayout(specs: readonly WatchSpec[]): string {
	return [...new Set(specs.map(({ base, deep }) => `${foldCase(base)}\0${deep}`))].sort().join("\n");
}

/** Size and modification time of a path, or undefined when it does not exist. */
function snapshotOf(stat: fs.Stats | null | undefined): string | undefined {
	return stat ? `${stat.mtimeMs}:${stat.size}` : undefined;
}

/** One watcher of a registration: a glob relative to `base`. */
interface WatchSpec {
	base: string;
	glob: Bun.Glob;
	kind: number;
	/** The glob can match below `base`'s direct children, so `base` is watched recursively. */
	deep: boolean;
}

export interface WatchedFilesForwarderOptions {
	/** Workspace folder paths; plain relative glob patterns are resolved against each. */
	roots: () => readonly string[];
	/** Delivers one `workspace/didChangeWatchedFiles` batch to the server. */
	send: (changes: FileEvent[]) => Promise<void> | void;
	/** Bounds the Linux per-directory watches; defaults to the budget every forwarder of the process shares. */
	inotifyBudget?: InotifyBudget;
}

/**
 * Existence of a changed path before and after the pending batch, as the
 * events say; `undefined` when they do not (an `fs.watch` "rename"), so the
 * disk decides at delivery.
 */
interface PendingChange {
	before: boolean | undefined;
	after: boolean | undefined;
	/** The path is known to be a directory: a vanished one stands for every file below it. */
	directory?: boolean;
	/** Recorded by a rescan, not an event: its mtime says nothing about the file system's clock. */
	rescanned?: boolean;
}

/** Linux watch of a tree: one inotify watch per directory, excluded directories skipped. */
interface DirectoryTree {
	/** Watch one more directory (its subdirectories are added by the caller's walk). */
	watch(dir: string): void;
	/** Whether `dir`'s parent is watched, so `dir` belongs in this tree. */
	covers(dir: string): boolean;
	/** Stop watching `dir` and everything below it. */
	remove(dir: string): void;
	/** Reconcile watches after the tree layout changed, without closing the tree root. */
	refresh(): Promise<void>;
	/** {@link treeLayout} of the registrations the tree was last walked for. */
	layout: string;
}

interface Watch {
	/** Set by `close`; callbacks the watcher had already queued are ignored. */
	closed: boolean;
	close(): void;
	/** When the last change from this watch was seen; lost changes are looked for since then. */
	seenAt: number;
	/** Earliest change time still to rescan for; set while losses wait behind a running rescan. */
	lostSince?: number;
	rescanning: boolean;
	tree?: DirectoryTree;
}

function newWatch(stop: () => void): Watch {
	const watch: Watch = {
		closed: false,
		close: () => {
			watch.closed = true;
			stop();
		},
		seenAt: Date.now(),
		rescanning: false,
	};
	return watch;
}

function foldCase(p: string): string {
	return caseInsensitive ? p.toLowerCase() : p;
}

/** `target` relative to `dir` with `/` separators, or undefined when it lies outside `dir`. */
function relativeWithin(dir: string, target: string): string | undefined {
	const rel = path.relative(foldCase(dir), foldCase(target));
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
	return rel.replaceAll("\\", "/");
}

/**
 * A map keyed by resolved, case-folded paths that can drop a directory and
 * everything below it in time proportional to what it removes.
 */
class PathMap<V> {
	readonly #values = new Map<string, V>();
	/** Entries of each directory above a key that are keys or lead to one. */
	readonly #children = new Map<string, Set<string>>();

	get(key: string): V | undefined {
		return this.#values.get(key);
	}

	has(key: string): boolean {
		return this.#values.has(key);
	}

	set(key: string, value: V): void {
		if (!this.#values.has(key)) {
			// Link `key` up to the first ancestor already linked.
			for (
				let child = key, parent = path.dirname(key);
				parent !== child;
				child = parent, parent = path.dirname(parent)
			) {
				const entries = this.#children.get(parent);
				if (entries) {
					entries.add(child);
					break;
				}
				this.#children.set(parent, new Set([child]));
			}
		}
		this.#values.set(key, value);
	}

	delete(key: string): void {
		if (this.#values.delete(key) && !this.#children.has(key)) this.#unlink(key);
	}

	/** Remove `dir` and every key below it, passing each removed value and its key to `removed`. */
	deleteWithin(dir: string, removed?: (value: V, key: string) => void): void {
		const stack = [dir];
		for (let key = stack.pop(); key !== undefined; key = stack.pop()) {
			const value = this.#values.get(key);
			if (value !== undefined && this.#values.delete(key)) removed?.(value, key);
			const entries = this.#children.get(key);
			if (!entries) continue;
			this.#children.delete(key);
			for (const entry of entries) stack.push(entry);
		}
		this.#unlink(dir);
	}

	clear(): void {
		this.#values.clear();
		this.#children.clear();
	}

	values(): MapIterator<V> {
		return this.#values.values();
	}

	[Symbol.iterator](): MapIterator<[string, V]> {
		return this.#values.entries();
	}

	/** Detach `key`, no longer a key nor above one, from its ancestors, dropping those left empty. */
	#unlink(key: string): void {
		for (
			let child = key, parent = path.dirname(key);
			parent !== child;
			child = parent, parent = path.dirname(parent)
		) {
			const entries = this.#children.get(parent);
			if (!entries?.delete(child) || entries.size > 0) return;
			this.#children.delete(parent);
			// A key stays linked to its own ancestors.
			if (this.#values.has(parent)) return;
		}
	}
}

/** A directory tree's claim on its directory watches, which an {@link InotifyBudget} can take back. */
interface WatchHolder {
	/** Stop watching `key` because the budget sheds it; false keeps it (a tree root). */
	shed(key: string): boolean;
}

/**
 * The inotify watches of the Linux directory trees of a process, across all
 * its forwarders. The kernel's watch limit is per user, so a process that used
 * it up would break unrelated programs (`tail -f`, systemd, CI containers):
 * trees stop adding watches once the budget is spent, and when the kernel
 * refuses a watch anyway (other processes hold the rest), the budget halves and
 * gives back its newest, deepest directories. Bun shares one inotify watch per
 * path, so a directory counts once however many trees watch it.
 */
export class InotifyBudget {
	/** Holders by watched directory, oldest first. */
	readonly #held = new Map<string, Set<WatchHolder>>();
	#limit: number;

	/** At most `limit` directories are watched, tree roots aside. */
	constructor(limit: number) {
		this.#limit = limit;
	}

	/** Directories the budget allows. */
	get limit(): number {
		return this.#limit;
	}

	/** Claim a watch of `key` for `holder`; false when the budget is spent, unless `force` (a tree root). */
	claim(key: string, holder: WatchHolder, options: { force: boolean }): boolean {
		const holders = this.#held.get(key);
		if (holders) {
			holders.add(holder);
			return true;
		}
		if (!options.force && this.#held.size >= this.#limit) return false;
		this.#held.set(key, new Set([holder]));
		return true;
	}

	/** Drop `holder`'s claim on `key`; the directory frees up once no tree watches it. */
	release(key: string, holder: WatchHolder): void {
		const holders = this.#held.get(key);
		if (holders?.delete(holder) && holders.size === 0) this.#held.delete(key);
	}

	/**
	 * The kernel refused a watch (`ENOSPC`): the user's limit is reached. Halve
	 * what is held and shed the newest directories down to that, for good, so
	 * other programs get watches again and the trees do not re-add them.
	 */
	exhausted(): void {
		const held = this.#held.size;
		this.#limit = Math.min(this.#limit, Math.floor(held / 2));
		const keys = [...this.#held.keys()];
		for (let i = keys.length - 1; i >= 0 && this.#held.size > this.#limit; i--) {
			const holders = this.#held.get(keys[i]);
			if (!holders) continue;
			for (const holder of holders) if (holder.shed(keys[i])) holders.delete(holder);
			if (holders.size === 0) this.#held.delete(keys[i]);
		}
		logger.warn("LSP watched-files hit the user's inotify watch limit; released watches", {
			held,
			released: held - this.#held.size,
			limit: this.#limit,
		});
	}
}

let processBudget: InotifyBudget | undefined;

/** The budget forwarders share by default: a share of `fs.inotify.max_user_watches`, read once. */
function sharedInotifyBudget(): InotifyBudget {
	if (processBudget) return processBudget;
	let maxUserWatches = DEFAULT_MAX_USER_WATCHES;
	try {
		// Read synchronously: trees claim watches from synchronous callbacks, and only once per process.
		const read = Number.parseInt(fs.readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8"), 10);
		if (read > 0) maxUserWatches = read;
	} catch {
		// No procfs (some containers): assume the old kernel default.
	}
	processBudget = new InotifyBudget(Math.floor(maxUserWatches * INOTIFY_SHARE));
	return processBudget;
}

function spec(base: string, pattern: string, kind: number): WatchSpec {
	const glob = foldCase(pattern.replaceAll("\\", "/"));
	return { base: path.resolve(base), glob: new Bun.Glob(glob), kind, deep: glob.includes("/") || glob.includes("**") };
}

/** Resolve the `watchers` of a registration to directory-relative globs; malformed options watch nothing. */
function compileWatchers(registerOptions: unknown, roots: readonly string[]): WatchSpec[] {
	const options = RegisterOptions(registerOptions);
	if (options instanceof type.errors) return [];
	return options.watchers.flatMap(({ globPattern, kind }) => {
		const mask = kind !== undefined && kind > 0 ? kind & WATCH_ALL : WATCH_ALL;
		if (mask === 0) return [];
		if (typeof globPattern !== "string") {
			const { baseUri, pattern } = globPattern;
			return [spec(uriToFile(typeof baseUri === "string" ? baseUri : baseUri.uri), pattern, mask)];
		}
		if (!path.isAbsolute(globPattern)) return roots.map(root => spec(root, globPattern, mask));
		// Absolute: the literal directory prefix is the base, the rest (or the last name) the glob.
		const segments = globPattern.replaceAll("\\", "/").split("/");
		const firstGlob = segments.findIndex(segment => GLOB_CHARS.test(segment));
		const split = firstGlob === -1 ? segments.length - 1 : firstGlob;
		return [spec(segments.slice(0, split).join("/") || "/", segments.slice(split).join("/"), mask)];
	});
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(target)).isDirectory();
	} catch {
		return false;
	}
}

/** `isDirectory` that stats each path once. */
function cachedIsDirectory(): (target: string) => Promise<boolean> {
	const known = new Map<string, Promise<boolean>>();
	return target => {
		let result = known.get(target);
		if (!result) {
			result = isDirectory(target);
			known.set(target, result);
		}
		return result;
	};
}

/** `base` if it is a directory, else its nearest ancestor that is. */
async function nearestDirectory(base: string, isDir: (target: string) => Promise<boolean>): Promise<string> {
	let dir = base;
	while (!(await isDir(dir))) {
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dir;
}

/**
 * Watches the files a language server registered through
 * `client/registerCapability` and forwards their changes as batched
 * `workspace/didChangeWatchedFiles` notifications.
 */
export class WatchedFilesForwarder {
	readonly #roots: () => readonly string[];
	readonly #send: WatchedFilesForwarderOptions["send"];
	readonly #inotifyBudget?: InotifyBudget;
	/** Raw registerOptions by registration id, recompiled when roots change. */
	readonly #registrations = new Map<string, unknown>();
	#specs: WatchSpec[] = [];
	/** Open watchers, keyed `r:<dir>` (recursive) or `d:<dir>` (that directory only). */
	readonly #watches = new Map<string, Watch>();
	/** Watches that failed on a directory that still exists; not reopened while they stay wanted. */
	readonly #failed = new Set<string>();
	readonly #pending = new Map<string, PendingChange>();
	#flushTimer?: NodeJS.Timeout;
	#flushDeadline?: NodeJS.Timeout;
	#resyncTimer?: NodeJS.Timeout;
	#closed = false;
	/** The running sync passes; a request during them runs one more pass before it settles. */
	#syncRun?: Promise<void>;
	#syncAgain = false;
	/** Spec bases that did not exist at the last sync pass. */
	#missing = new Set<string>();
	/**
	 * Case-folded spec bases and all their ancestors: the only paths whose
	 * appearing or vanishing can change where bases are watched.
	 */
	#layoutPaths = new Set<string>();
	/** Batches go out one after another, so a later batch's disk state never precedes an earlier one's. */
	#delivery: Promise<void> = Promise.resolve();
	/** Paths the client reported itself, with their size and mtime then (undefined: absent). */
	readonly #announced = new Map<string, { at: number; snapshot: Promise<string | undefined> }>();
	/**
	 * Creations and deletions delivered lately, by case-folded path, with when the server last heard
	 * of the path: a repeat of one is redundant, and a created file touched since has changed.
	 */
	readonly #reported = new PathMap<{ type: FileChangeType; at: number }>();
	#reportedPrunedAt = 0;
	/** How far the file system's clock was last seen behind ours (network drives); rescans look back that much further. */
	#clockLag = 0;

	constructor(options: WatchedFilesForwarderOptions) {
		this.#roots = options.roots;
		this.#send = options.send;
		this.#inotifyBudget = options.inotifyBudget;
	}

	/** Start watching for one `workspace/didChangeWatchedFiles` registration; settles once watched. */
	register(id: string, registerOptions: unknown): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#registrations.set(id, registerOptions);
		return this.refresh();
	}

	/** Stop watching for a registration; unknown ids (other capabilities) are ignored. */
	unregister(id: string): Promise<void> {
		if (this.#closed || !this.#registrations.delete(id)) return Promise.resolve();
		return this.refresh();
	}

	/** Recompile every registration, e.g. after the workspace folders changed; settles once watched. */
	refresh(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		const roots = this.#roots();
		this.#specs = [...this.#registrations.values()].flatMap(options => compileWatchers(options, roots));
		this.#layoutPaths = new Set();
		for (const { base } of this.#specs) {
			for (let dir = foldCase(base); !this.#layoutPaths.has(dir); dir = path.dirname(dir)) {
				this.#layoutPaths.add(dir);
				if (path.dirname(dir) === dir) break;
			}
		}
		return this.#sync();
	}

	/**
	 * Note a `workspace/didChangeWatchedFiles` the client sent for its own
	 * writes: while the paths stay as they were then, the watcher's echo of
	 * them is not sent again.
	 */
	announced(params: unknown): void {
		if (this.#closed) return;
		const parsed = ChangeParams(params);
		if (parsed instanceof type.errors) return;
		const now = Date.now();
		for (const [key, entry] of this.#announced) if (now - entry.at > ANNOUNCED_TTL_MS) this.#announced.delete(key);
		for (const { uri, type: changeType } of parsed.changes) {
			const target = uriToFile(uri);
			const snapshot =
				changeType === FileChangeType.Deleted
					? Promise.resolve(undefined)
					: fs.promises.lstat(target).then(snapshotOf, () => undefined);
			this.#announced.set(foldCase(path.resolve(target)), { at: now, snapshot });
		}
	}

	/** Stop every watcher and drop changes not yet sent. */
	close(): void {
		this.#closed = true;
		clearTimeout(this.#flushTimer);
		clearTimeout(this.#flushDeadline);
		clearTimeout(this.#resyncTimer);
		for (const watcher of this.#watches.values()) watcher.close();
		this.#watches.clear();
		this.#pending.clear();
		this.#registrations.clear();
		this.#specs = [];
		this.#layoutPaths.clear();
		this.#announced.clear();
		this.#reported.clear();
	}

	/**
	 * Bring the watchers in line with the specs, one pass at a time (stats are
	 * asynchronous: on network drives each is a round trip). A request during a
	 * pass runs one more; the promise settles when no pass is left.
	 */
	#sync(): Promise<void> {
		if (this.#syncRun) {
			this.#syncAgain = true;
			return this.#syncRun;
		}
		this.#syncRun = (async () => {
			do {
				this.#syncAgain = false;
				await this.#syncOnce().catch(error => {
					logger.debug("LSP watched-files sync failed", { error: String(error) });
				});
			} while (this.#syncAgain && !this.#closed);
			this.#syncRun = undefined;
		})();
		return this.#syncRun;
	}

	/**
	 * Watch the specs as the tree exists now. An existing base is watched itself,
	 * recursively when its glob is deep; a missing one through its nearest
	 * existing ancestor, non-recursively, until it appears (a recursive watch
	 * there could cover a whole drive). Each path is stat'ed once per pass.
	 */
	async #syncOnce(): Promise<void> {
		const specs = this.#specs;
		const isDir = cachedIsDirectory();
		const resolved = await Promise.all(
			specs.map(async ({ base, deep }) => ({ base, deep, dir: await nearestDirectory(base, isDir) })),
		);
		if (specs !== this.#specs) this.#syncAgain = true;
		if (this.#closed || specs !== this.#specs) return;

		const recursive = new Set<string>();
		const flat = new Set<string>();
		/** Missing base → the ancestor it waits on. */
		const missing = new Map<string, string>();
		const appeared = new Map<string, boolean>();
		for (const { base, deep, dir } of resolved) {
			if (dir !== base) missing.set(base, dir);
			else if (this.#missing.has(base)) appeared.set(base, deep || appeared.get(base) === true);
			if (dir === base && deep) recursive.add(dir);
			else flat.add(dir);
		}
		this.#missing = new Set(missing.keys());
		// Shortest first, so a directory listed twice (in different case) keeps one watch.
		const kept: string[] = [];
		const covered = (dir: string) => kept.some(outer => relativeWithin(outer, dir) !== undefined);
		const wanted = new Map<string, { dir: string; recursive: boolean }>();
		for (const dir of [...recursive].sort((a, b) => a.length - b.length)) {
			if (covered(dir)) continue;
			kept.push(dir);
			wanted.set(`r:${dir}`, { dir, recursive: true });
		}
		for (const dir of flat) if (!covered(dir)) wanted.set(`d:${dir}`, { dir, recursive: false });
		// A base that was below an open recursive watch had its new files reported
		// by that watch; only one waited on through a flat ancestor watch needs a rescan.
		const recursivelyWatched = [...this.#watches.keys()].filter(key => key.startsWith("r:")).map(key => key.slice(2));
		const rescanned = [...appeared].filter(
			([base]) => !recursivelyWatched.some(dir => relativeWithin(dir, base) !== undefined),
		);

		for (const key of this.#failed) if (!wanted.has(key)) this.#failed.delete(key);
		for (const [key, watcher] of this.#watches) {
			if (wanted.has(key)) continue;
			watcher.close();
			this.#watches.delete(key);
		}
		await Promise.all(
			[...wanted]
				.filter(([key]) => !this.#watches.has(key) && !this.#failed.has(key))
				.map(([key, target]) => this.#open(key, target.dir, target.recursive)),
		);
		const layout = treeLayout(specs);
		for (const [key] of wanted) {
			const tree = this.#watches.get(key)?.tree;
			if (!tree || tree.layout === layout) continue;
			tree.layout = layout;
			await tree.refresh();
		}
		if (this.#closed) return;
		// A base that appeared since the last pass was watched only through an
		// ancestor until now; now that its own watch is armed, report what was
		// created in it meanwhile.
		for (const [base, deep] of rescanned) {
			void this.#rescan(base, deep, 0).catch(error => {
				logger.debug("LSP watched-files rescan failed", { dir: base, error: String(error) });
			});
		}
		// A directory created between this pass's stats and the waiting watch
		// opening raised no event; look once more now that the watch is up.
		const recheck = cachedIsDirectory();
		const moved = await Promise.all(
			[...missing].map(async ([base, dir]) => (await nearestDirectory(base, recheck)) !== dir),
		);
		if (moved.includes(true)) this.#syncAgain = true;
	}

	/** Open one watch; settles once it reports changes (or failed). */
	#open(key: string, dir: string, recursive: boolean): Promise<void> {
		const fail = (error: unknown) => {
			logger.warn("LSP watched-files watcher failed; changes below it go unreported", { dir, error: String(error) });
			// A watch that fails on a directory that still exists stays off while it
			// is wanted, so a failing watch cannot become a re-arm loop; one whose
			// directory went away is resolved again by the resync.
			this.#failed.add(key);
			void isDirectory(dir).then(exists => {
				if (this.#closed) return;
				if (!exists) this.#failed.delete(key);
				this.#scheduleResync();
			});
		};
		const ended = (watch: Watch, error: unknown) => {
			watch.close();
			if (this.#watches.get(key) === watch) this.#watches.delete(key);
			if (!this.#closed) fail(error);
		};
		try {
			if (process.platform === "win32") {
				const opening = this.#openNative(dir, recursive, error => ended(opening.watch, error));
				this.#watches.set(key, opening.watch);
				return opening.armed;
			}
			if (recursive && process.platform === "linux") {
				const opening = this.#openTree(dir, error => ended(opening.watch, error));
				this.#watches.set(key, opening.watch);
				return opening.armed;
			}
			const watch: Watch = this.#openFsWatch(dir, recursive, error => ended(watch, error));
			this.#watches.set(key, watch);
		} catch (error) {
			fail(error);
		}
		return Promise.resolve();
	}

	/** The native watch is registered at once; `armed` settles when it reports changes or has failed. */
	#openNative(
		dir: string,
		recursive: boolean,
		ended: (error: unknown) => void,
	): { watch: Watch; armed: Promise<void> } {
		let watcher: DirectoryWatcher | undefined;
		const watch = newWatch(() => watcher?.close());
		const armed = DirectoryWatcher.start(dir, recursive, (error: Error | null, batch: DirectoryChanges) => {
			if (this.#closed || watch.closed) return;
			if (error) return ended(error);
			if (batch.overflow) return this.#lost(watch, dir, recursive);
			watch.seenAt = Date.now();
			/** A directory's old name, until the new name that follows it in the batch. */
			let renamedFrom: string | undefined;
			for (const { path: name, action, directory } of batch.changes) {
				const target = path.join(dir, name);
				if (action === DirectoryChangeAction.Modified) {
					this.#record(target, true, true);
					continue;
				}
				// Entries appearing or vanishing can move where bases are watched.
				this.#layoutChanged(target);
				const added = action === DirectoryChangeAction.Added || action === DirectoryChangeAction.RenamedTo;
				this.#record(target, !added, added, directory || undefined);
				if (!directory) continue;
				if (action === DirectoryChangeAction.RenamedFrom) {
					renamedFrom = target;
				} else if (added) {
					// Moved in, its files report nothing; created, they report themselves too (the repeat is dropped).
					this.#directoryAppeared(target, action === DirectoryChangeAction.RenamedTo ? renamedFrom : undefined);
					renamedFrom = undefined;
				}
			}
		}).then(
			started => {
				// Closed while it was starting: stop it now.
				if (watch.closed) started.close();
				else watcher = started;
			},
			error => {
				if (!watch.closed && !this.#closed) ended(error);
			},
		);
		return { watch, armed };
	}

	#openFsWatch(dir: string, recursive: boolean, ended: (error: unknown) => void): Watch {
		const watcher = fs.watch(dir, { recursive, persistent: false }, (eventType, filename) =>
			this.#fsEvent(watch, dir, recursive, dir, eventType, filename, false),
		);
		const watch = newWatch(() => watcher.close());
		watcher.on("error", ended);
		return watch;
	}

	/**
	 * Watch `root` and the directories below it one by one, skipping those no
	 * spec wants anything below (Linux). Throws when `root` itself cannot be
	 * watched; a subdirectory that cannot (the inotify watch limit, or the
	 * process's {@link InotifyBudget} is spent) is skipped. Directories are
	 * claimed breadth first, so a spent budget leaves the deepest unwatched.
	 * `armed` settles once the existing tree is watched.
	 */
	#openTree(root: string, ended: (error: unknown) => void): { watch: Watch; armed: Promise<void> } {
		const budget = this.#inotifyBudget ?? sharedInotifyBudget();
		const rootKey = foldCase(root);
		const watchers = new PathMap<fs.FSWatcher>();
		const holder: WatchHolder = {
			shed: key => {
				if (key === rootKey) return false;
				watchers.get(key)?.close();
				watchers.delete(key);
				return true;
			},
		};
		const drop = (watcher: fs.FSWatcher, key: string) => {
			watcher.close();
			budget.release(key, holder);
		};
		let skipped = false;
		const skip = (dir: string, error: unknown) => {
			if (skipped) return;
			skipped = true;
			logger.warn("LSP watched-files could not watch every directory; changes below them go unreported", {
				dir,
				error: String(error),
			});
		};
		const watch = newWatch(() => {
			for (const [key, watcher] of watchers) drop(watcher, key);
			watchers.clear();
		});
		const watchOne = (dir: string) => {
			const key = foldCase(dir);
			if (watch.closed || watchers.has(key)) return;
			if (!budget.claim(key, holder, { force: key === rootKey })) {
				return skip(dir, `the process's budget of ${budget.limit} inotify watches is spent`);
			}
			let watcher: fs.FSWatcher;
			try {
				watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
					const known = filename !== null && watchers.has(foldCase(path.join(dir, filename.toString())));
					this.#fsEvent(watch, root, true, dir, eventType, filename, known);
				});
			} catch (error) {
				budget.release(key, holder);
				if (hasFsCode(error, "ENOSPC")) budget.exhausted();
				if (key === rootKey) throw error;
				return skip(dir, error);
			}
			watcher.on("error", error => {
				watchers.delete(key);
				drop(watcher, key);
				if (key === rootKey) ended(error);
			});
			watchers.set(key, watcher);
		};
		watch.tree = {
			watch: watchOne,
			covers: dir => watchers.has(foldCase(path.dirname(dir))),
			remove: dir => watchers.deleteWithin(foldCase(path.resolve(dir)), drop),
			layout: treeLayout(this.#specs),
			refresh: async () => {
				const wanted = new Set<string>();
				await this.#walk(root, true, {
					onDirectory: dir => {
						wanted.add(foldCase(dir));
						watchOne(dir);
					},
					files: false,
				});
				for (const [key, watcher] of watchers) {
					if (wanted.has(key)) continue;
					watchers.delete(key);
					drop(watcher, key);
				}
			},
		};
		watchOne(root);
		return { watch, armed: this.#walk(root, true, { onDirectory: watchOne, files: false }).then(() => {}) };
	}

	/** One `fs.watch` event of `dir`, part of the watch of `root`; `known`: the entry is a watched directory. */
	#fsEvent(
		watch: Watch,
		root: string,
		recursive: boolean,
		dir: string,
		eventType: string,
		filename: string | Buffer | null,
		known: boolean,
	): void {
		if (this.#closed || watch.closed) return;
		// A missing name means the watcher lost changes.
		if (filename === null) return this.#lost(watch, root, recursive);
		watch.seenAt = Date.now();
		const target = path.join(dir, filename.toString());
		if (eventType === "change") return this.#record(target, true, true);
		this.#layoutChanged(target);
		// A watched directory existed; the disk says whether it still does.
		if (known) this.#record(target, true, undefined, true);
		else this.#record(target, undefined, undefined);
	}

	/**
	 * The watcher lost changes below `dir`: re-report the files touched since
	 * its last delivered change (deletions in that window stay unknown) and
	 * re-resolve the watched directories. Losses during a rescan join the next
	 * one, so repeated overflows cost one walk at a time, not one each.
	 */
	#lost(watch: Watch, dir: string, recursive: boolean): void {
		// File times come from the file system's clock, which can lag ours on a network drive.
		const since = watch.seenAt - RESCAN_SLACK_MS - this.#clockLag;
		watch.seenAt = Date.now();
		watch.lostSince = Math.min(watch.lostSince ?? since, since);
		this.#scheduleResync();
		if (watch.rescanning) return;
		watch.rescanning = true;
		logger.debug("LSP watched-files watcher lost changes; rescanning", { dir });
		void (async () => {
			while (watch.lostSince !== undefined && !this.#closed) {
				const from = watch.lostSince;
				watch.lostSince = undefined;
				await this.#rescan(dir, recursive, from).catch(error => {
					logger.debug("LSP watched-files rescan failed", { dir, error: String(error) });
				});
			}
			watch.rescanning = false;
		})();
	}

	/**
	 * Report the files below `dir` modified since `since` (0: every file, as
	 * created, without a stat). `renamedFrom`: `dir` was moved from there, so
	 * each file's old path is reported deleted. `onDirectory` sees every
	 * directory walked, before it is read.
	 */
	async #rescan(
		dir: string,
		recursive: boolean,
		since: number,
		options: { renamedFrom?: string; onDirectory?: (dir: string) => void } = {},
	): Promise<void> {
		const files = await this.#walk(dir, recursive, { onDirectory: options.onDirectory });
		if (this.#closed) return;
		const { renamedFrom } = options;
		if (since === 0) {
			for (const target of files) {
				if (renamedFrom) this.#record(path.join(renamedFrom, path.relative(dir, target)), true, false);
				if (this.#wantedKinds(target) !== 0) this.#record(target, false, true, undefined, true);
			}
			return;
		}
		const targets = files.filter(target => this.#wantedKinds(target) !== 0);
		const { results: stats } = await mapWithConcurrencyLimit(targets, RESCAN_STAT_CONCURRENCY, target =>
			fs.promises.lstat(target).catch(() => undefined),
		);
		if (this.#closed) return;
		for (const [index, target] of targets.entries()) {
			const stat = stats[index];
			if (!stat || stat.mtimeMs < since) continue;
			// Without a birth time (some Linux file systems) the file may be new: report it as created,
			// which a server handles for a file it already knew, unlike a change to one it never saw.
			this.#record(target, stat.birthtimeMs > 0 ? stat.birthtimeMs < since : undefined, true, undefined, true);
		}
	}

	/**
	 * The files below `dir` (directly, unless `recursive`), skipping directories
	 * no spec wants anything below. `onDirectory` sees each directory before it
	 * is read. With `files: false` only directories are visited and nothing is
	 * collected, as a tree walk needs on a large repository.
	 */
	async #walk(
		dir: string,
		recursive: boolean,
		options: { onDirectory?: (dir: string) => void; files?: boolean } = {},
	): Promise<string[]> {
		const { onDirectory, files: collect = true } = options;
		const files: string[] = [];
		let level = [dir];
		while (level.length > 0 && !this.#closed) {
			if (onDirectory) for (const entry of level) onDirectory(entry);
			const { results } = await mapWithConcurrencyLimit(level, WALK_CONCURRENCY, entry =>
				fs.promises.readdir(entry, { withFileTypes: true }).catch(() => []),
			);
			const next: string[] = [];
			for (const [index, entries] of results.entries()) {
				for (const entry of entries ?? []) {
					const target = path.join(level[index], entry.name);
					if (!entry.isDirectory()) {
						if (collect) files.push(target);
					} else if (recursive && this.#wantsBeneath(target)) next.push(target);
				}
			}
			level = next;
		}
		return files;
	}

	/** Whether some spec watches paths below `dir`. */
	#wantsBeneath(dir: string): boolean {
		for (const { base, deep } of this.#specs) {
			const rel = relativeWithin(base, dir);
			if (rel === undefined) {
				if (relativeWithin(dir, base) !== undefined) return true;
				continue;
			}
			if (rel === "" || (deep && !excludedWithin(`${rel}/_`))) return true;
		}
		return false;
	}

	/**
	 * A directory appeared below a watch. Moved in, it raised no event for the
	 * files it holds; created, its files may have been written before a
	 * per-directory watch reached it. Report what it holds (repeats of events
	 * are dropped at delivery) and extend a per-directory tree to it.
	 */
	#directoryAppeared(dir: string, renamedFrom?: string): void {
		if (!this.#wantsBeneath(dir) && !renamedFrom) return;
		const tree = [...this.#watches.values()].find(watch => watch.tree?.covers(dir))?.tree;
		void this.#rescan(dir, true, 0, { renamedFrom, onDirectory: tree?.watch }).catch(error => {
			logger.debug("LSP watched-files rescan failed", { dir, error: String(error) });
		});
	}

	/** A directory went away: its files went with it, reported or not. */
	#directoryVanished(dir: string): void {
		for (const watch of this.#watches.values()) watch.tree?.remove(dir);
		this.#reported.deleteWithin(foldCase(path.resolve(dir)));
	}

	/** Re-resolve the watched directories when `target` is a spec base or one of its ancestors. */
	#layoutChanged(target: string): void {
		if (this.#layoutPaths.has(foldCase(target))) this.#scheduleResync();
	}

	#scheduleResync(): void {
		this.#resyncTimer ??= setTimeout(() => {
			this.#resyncTimer = undefined;
			if (!this.#closed) void this.#sync();
		}, RESYNC_MS);
	}

	/** Note a change of `target`; the first event of a batch tells whether it existed before, the last whether after. */
	#record(
		target: string,
		before: boolean | undefined,
		after: boolean | undefined,
		directory?: boolean,
		rescanned?: boolean,
	): void {
		const pending = this.#pending.get(target);
		if (pending) {
			pending.after = after;
			pending.directory ||= directory;
			pending.rescanned &&= rescanned;
		} else {
			this.#pending.set(target, { before, after, directory, rescanned });
		}
		clearTimeout(this.#flushTimer);
		this.#flushTimer = setTimeout(() => this.#flush(), FLUSH_QUIET_MS);
		this.#flushDeadline ??= setTimeout(() => this.#flush(), FLUSH_MAX_MS);
	}

	/**
	 * The `WatchKind` bits of every spec whose glob matches `target`. A
	 * `directory` also takes the deletion bit of every spec watching below it:
	 * its deletion stands for theirs.
	 */
	#wantedKinds(target: string, directory?: boolean): number {
		let kinds = 0;
		for (const { base, glob, kind, deep } of this.#specs) {
			if ((kinds | kind) === kinds) continue;
			const rel = relativeWithin(base, target);
			if (rel === undefined || rel === "") {
				if (directory && (rel === "" || relativeWithin(target, base) !== undefined)) kinds |= kind & WATCH_DELETE;
				continue;
			}
			if (excludedWithin(rel)) continue;
			if (glob.match(rel)) kinds |= kind;
			else if (directory && deep) kinds |= kind & WATCH_DELETE;
		}
		return kinds;
	}

	#flush(): void {
		clearTimeout(this.#flushTimer);
		clearTimeout(this.#flushDeadline);
		this.#flushTimer = undefined;
		this.#flushDeadline = undefined;
		if (this.#closed) return;
		const batch: Array<[target: string, change: PendingChange, kinds: number]> = [];
		for (const [target, change] of this.#pending) {
			const kinds = this.#wantedKinds(target, change.directory);
			// An `fs.watch` "rename" of an unknown entry may be a directory that
			// appeared with files in it; delivery finds out.
			if (kinds !== 0 || (change.after === undefined && !change.directory && this.#wantsBeneath(target))) {
				batch.push([target, change, kinds]);
			}
		}
		this.#pending.clear();
		if (batch.length === 0) return;
		this.#delivery = this.#delivery
			.then(() => this.#deliver(batch))
			.catch(error => {
				logger.debug("LSP watched-files notification failed", { error: String(error) });
			});
	}

	async #deliver(batch: Array<[target: string, change: PendingChange, kinds: number]>): Promise<void> {
		// The disk answers what the events leave open: whether an `fs.watch`
		// "rename" left the path present, whether a changed path is a
		// directory, which "changes" whenever its entries do (they report
		// themselves), and whether a file reported created was touched since.
		const stats = await Promise.all(
			batch.map(([target, { before, after }]) =>
				after === undefined ||
				(before && after) ||
				(after && this.#reported.get(foldCase(path.resolve(target)))?.type === FileChangeType.Created) ||
				this.#announcement(target)
					? fs.promises.lstat(target).catch(() => null)
					: undefined,
			),
		);
		const now = Date.now();
		if (now - this.#reportedPrunedAt > REPORTED_TTL_MS) {
			this.#reportedPrunedAt = now;
			for (const [key, entry] of this.#reported) if (now - entry.at > REPORTED_TTL_MS) this.#reported.delete(key);
		}
		const changes: FileEvent[] = [];
		for (const [index, [target, change, kinds]] of batch.entries()) {
			const stat = stats[index];
			const key = foldCase(path.resolve(target));
			const reported = this.#reported.get(key);
			const last = reported && now - reported.at <= REPORTED_TTL_MS ? reported : undefined;
			const after = change.after ?? !!stat;
			// The server was told lately that this file was created: touched since, it changed, whatever
			// the events guess (FSEvents keeps a new file's creation flag on its later events, so macOS
			// reports writes to it as "rename"; a rescan takes every file it finds for new). Untouched,
			// the event repeats the creation.
			const touchedSinceCreated =
				last?.type === FileChangeType.Created && !!stat && !stat.isDirectory() && stat.ctimeMs > last.at;
			// A "rename" seen first: present now means it appeared, gone means it went.
			const before = touchedSinceCreated || (change.before ?? !after);
			if (after && !before && change.directory === undefined && stat?.isDirectory()) this.#directoryAppeared(target);
			if (!after && change.directory) this.#directoryVanished(target);
			if (kinds === 0) continue;
			let type: FileChangeType;
			if (before && after) {
				if (stat?.isDirectory()) continue;
				type = FileChangeType.Changed;
				// Just written: its mtime is the file system's "now".
				if (stat && !change.rescanned) {
					const lag = now - stat.mtimeMs;
					if (lag < CLOCK_LAG_MAX_MS) this.#clockLag = Math.max(0, lag);
				}
			} else if (after) type = FileChangeType.Created;
			else if (before) type = FileChangeType.Deleted;
			else continue;
			// A creation after a creation (a rescan repeating an event, or the reverse) says nothing new.
			if (type !== FileChangeType.Changed) {
				if (last?.type === type) continue;
				this.#reported.set(key, { type, at: now });
			} else if (last?.type === FileChangeType.Created) {
				last.at = now;
			}
			if (!(kinds & (1 << (type - 1)))) continue;
			if (await this.#alreadyAnnounced(target, stat)) continue;
			changes.push({ uri: fileToUri(target), type });
		}
		if (changes.length > 0 && !this.#closed) await this.#send(changes);
	}

	/** The fresh announcement covering `target`, if any; expired ones are dropped. */
	#announcement(target: string): Promise<string | undefined> | undefined {
		const key = foldCase(path.resolve(target));
		const entry = this.#announced.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.at > ANNOUNCED_TTL_MS) {
			this.#announced.delete(key);
			return undefined;
		}
		return entry.snapshot;
	}

	/**
	 * Whether the client already reported `target` as it is now (`stat` as
	 * looked up at delivery, null when absent). A path that moved on since is
	 * reported again and its announcement dropped.
	 */
	async #alreadyAnnounced(target: string, stat: fs.Stats | null | undefined): Promise<boolean> {
		const announced = this.#announcement(target);
		if (!announced || stat === undefined) return false;
		if ((await announced) === snapshotOf(stat)) return true;
		this.#announced.delete(foldCase(path.resolve(target)));
		return false;
	}
}
