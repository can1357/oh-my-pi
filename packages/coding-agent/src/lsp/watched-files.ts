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
 * core); elsewhere `fs.watch` is lossless and cheap.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { DirectoryChangeAction, type DirectoryChanges, DirectoryWatcher } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { FileChangeType, type FileEvent } from "./types";
import { fileToUri, uriToFile } from "./utils";

/** Method a server registers to have the client watch files for it. */
export const WATCHED_FILES_METHOD = "workspace/didChangeWatchedFiles";

/** `WatchKind` default: Create | Change | Delete. Bit `1 << (type - 1)` selects a `FileChangeType`. */
const WATCH_ALL = 7;
/** Quiet time before a batch of changes is sent, and the longest a change waits. */
const FLUSH_QUIET_MS = 50;
const FLUSH_MAX_MS = 250;
/** Delay before re-resolving watched directories after entries were created, removed or renamed. */
const RESYNC_MS = 100;
/** After lost changes, files touched this long before the last delivered change are re-reported. */
const RESCAN_SLACK_MS = 2_000;

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
}

/**
 * Existence of a changed path before and after the pending batch, as the
 * events say; `undefined` when they do not (an `fs.watch` "rename"), so the
 * disk decides at delivery.
 */
interface PendingChange {
	before: boolean | undefined;
	after: boolean | undefined;
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
	/** Batches go out one after another, so a later batch's disk state never precedes an earlier one's. */
	#delivery: Promise<void> = Promise.resolve();

	constructor(options: WatchedFilesForwarderOptions) {
		this.#roots = options.roots;
		this.#send = options.send;
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
		return this.#sync();
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

		for (const key of this.#failed) if (!wanted.has(key)) this.#failed.delete(key);
		for (const [key, watcher] of this.#watches) {
			if (wanted.has(key)) continue;
			watcher.close();
			this.#watches.delete(key);
		}
		for (const [key, target] of wanted) {
			if (!this.#watches.has(key) && !this.#failed.has(key)) this.#open(key, target.dir, target.recursive);
		}
		// A base that appeared since the last pass was watched only through an
		// ancestor until now; report what was created in it meanwhile.
		for (const [base, deep] of appeared) {
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

	#open(key: string, dir: string, recursive: boolean): void {
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
			fail(error);
		};
		try {
			const watch: Watch =
				process.platform === "win32"
					? this.#openNative(dir, recursive, error => ended(watch, error))
					: this.#openFsWatch(dir, recursive, error => ended(watch, error));
			this.#watches.set(key, watch);
		} catch (error) {
			fail(error);
		}
	}

	#openNative(dir: string, recursive: boolean, ended: (error: unknown) => void): Watch {
		const watch = newWatch(() => watcher.close());
		const watcher = DirectoryWatcher.start(dir, recursive, (error: Error | null, batch: DirectoryChanges) => {
			if (this.#closed || watch.closed) return;
			if (error) return ended(error);
			if (batch.overflow) return this.#lost(watch, dir, recursive);
			watch.seenAt = Date.now();
			for (const { path: name, action } of batch.changes) {
				const target = path.join(dir, name);
				if (action === DirectoryChangeAction.Modified) {
					this.#record(target, true, true);
					continue;
				}
				// Entries appearing or vanishing can move where bases are watched.
				this.#scheduleResync();
				const added = action === DirectoryChangeAction.Added || action === DirectoryChangeAction.RenamedTo;
				this.#record(target, !added, added);
			}
		});
		return watch;
	}

	#openFsWatch(dir: string, recursive: boolean, ended: (error: unknown) => void): Watch {
		const watcher = fs.watch(dir, { recursive, persistent: false }, (eventType, filename) => {
			if (this.#closed || watch.closed) return;
			// A missing name means the watcher lost changes.
			if (filename === null) return this.#lost(watch, dir, recursive);
			watch.seenAt = Date.now();
			const target = path.join(dir, filename.toString());
			if (eventType === "change") return this.#record(target, true, true);
			this.#scheduleResync();
			this.#record(target, undefined, undefined);
		});
		const watch = newWatch(() => watcher.close());
		watcher.on("error", ended);
		return watch;
	}

	/**
	 * The watcher lost changes below `dir`: re-report the files touched since
	 * its last delivered change (deletions in that window stay unknown) and
	 * re-resolve the watched directories. Losses during a rescan join the next
	 * one, so repeated overflows cost one walk at a time, not one each.
	 */
	#lost(watch: Watch, dir: string, recursive: boolean): void {
		const since = watch.seenAt - RESCAN_SLACK_MS;
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

	async #rescan(dir: string, recursive: boolean, since: number): Promise<void> {
		const entries = await fs.promises.readdir(dir, { recursive, withFileTypes: true });
		const targets = entries
			.filter(entry => !entry.isDirectory())
			.map(entry => path.join(entry.parentPath, entry.name))
			.filter(target => this.#wantedKinds(target) !== 0);
		const stats = await Promise.all(targets.map(target => fs.promises.lstat(target).catch(() => undefined)));
		if (this.#closed) return;
		for (const [index, target] of targets.entries()) {
			const stat = stats[index];
			if (!stat || stat.mtimeMs < since) continue;
			this.#record(target, stat.birthtimeMs < since, true);
		}
	}

	#scheduleResync(): void {
		this.#resyncTimer ??= setTimeout(() => {
			this.#resyncTimer = undefined;
			if (!this.#closed) void this.#sync();
		}, RESYNC_MS);
	}

	/** Note a change of `target`; the first event of a batch tells whether it existed before, the last whether after. */
	#record(target: string, before: boolean | undefined, after: boolean | undefined): void {
		const pending = this.#pending.get(target);
		if (pending) pending.after = after;
		else this.#pending.set(target, { before, after });
		clearTimeout(this.#flushTimer);
		this.#flushTimer = setTimeout(() => this.#flush(), FLUSH_QUIET_MS);
		this.#flushDeadline ??= setTimeout(() => this.#flush(), FLUSH_MAX_MS);
	}

	/** The `WatchKind` bits of every spec whose glob matches `target`. */
	#wantedKinds(target: string): number {
		let kinds = 0;
		for (const { base, glob, kind } of this.#specs) {
			if ((kinds | kind) === kinds) continue;
			const rel = relativeWithin(base, target);
			if (rel && glob.match(rel)) kinds |= kind;
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
			const kinds = this.#wantedKinds(target);
			if (kinds !== 0) batch.push([target, change, kinds]);
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
		// "rename" left the path present, and whether a changed path is a
		// directory, which "changes" whenever its entries do (they report themselves).
		const stats = await Promise.all(
			batch.map(([target, { before, after }]) =>
				after === undefined || (before && after) ? fs.promises.lstat(target).catch(() => null) : undefined,
			),
		);
		const changes: FileEvent[] = [];
		for (const [index, [target, change, kinds]] of batch.entries()) {
			const stat = stats[index];
			const after = change.after ?? !!stat;
			// A "rename" seen first: present now means it appeared, gone means it went.
			const before = change.before ?? !after;
			let type: FileChangeType;
			if (before && after) {
				if (stat?.isDirectory()) continue;
				type = FileChangeType.Changed;
			} else if (after) type = FileChangeType.Created;
			else if (before) type = FileChangeType.Deleted;
			else continue;
			if (kinds & (1 << (type - 1))) changes.push({ uri: fileToUri(target), type });
		}
		if (changes.length > 0 && !this.#closed) await this.#send(changes);
	}
}
