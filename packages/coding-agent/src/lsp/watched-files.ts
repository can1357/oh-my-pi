import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { type FSWatcher, watch } from "chokidar";

export const WATCHED_FILES_METHOD = "workspace/didChangeWatchedFiles";

export interface FileEvent {
	uri: string;
	type: 1 | 2 | 3;
}

interface Pattern {
	root: string;
	glob: Bun.Glob;
	absolute: boolean;
	kind: number;
}

interface RootWatcher {
	watcher: FSWatcher;
	ready: Promise<void>;
	cancel(): void;
}

// Prune before descent, not merely at notification time. In particular, nested
// checkouts must not consume an inotify watch for every file they contain.
const EXCLUDED_DIRECTORIES: Record<string, true> = { ".git": true, node_modules: true, ".worktrees": true };
const READY_TIMEOUT_MS = 10_000;
// Chokidar coalesces change events for 50 ms. Notify after that window so the
// server reads the final contents, rather than missing a subsequent suppressed write.
const FILE_EVENT_BATCH_MS = 75;

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function excluded(root: string, target: string): boolean {
	return path
		.relative(root, target)
		.split(path.sep)
		.some(segment => Object.hasOwn(EXCLUDED_DIRECTORIES, segment));
}

function compilePattern(cwd: string, value: unknown): Pattern {
	if (!isRecord(value)) throw new Error("Invalid watched-file watcher");
	const kind = value.kind ?? 7;
	if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind > 7) {
		throw new Error("Invalid watched-file kind");
	}
	const pattern = value.globPattern;
	let root = cwd;
	let text: string;
	let absolute = false;
	if (typeof pattern === "string") {
		text = pattern;
		absolute = path.isAbsolute(text);
		if (absolute) {
			// Watch the literal directory prefix, not the filesystem root, for
			// absolute patterns referring to dependencies outside the workspace.
			const magic = text.search(/[?*[{]/);
			const prefix = magic < 0 ? text : text.slice(0, magic);
			const directory = path.dirname(prefix.endsWith(path.sep) ? `${prefix}_` : prefix);
			root = inside(cwd, directory) || inside(directory, cwd) ? cwd : directory;
		}
	} else if (isRecord(pattern) && typeof pattern.pattern === "string") {
		const baseUri = isRecord(pattern.baseUri) ? pattern.baseUri.uri : pattern.baseUri;
		if (typeof baseUri !== "string") throw new Error("Invalid watched-file base URI");
		root = fileURLToPath(baseUri);
		text = pattern.pattern;
		if (path.isAbsolute(text) || text.split("/").includes("..")) {
			throw new Error("Watched-file relative pattern must stay within its base URI");
		}
	} else {
		throw new Error("Invalid watched-file glob pattern");
	}
	if (!text) throw new Error("Empty watched-file glob pattern");
	return { root: path.resolve(root), glob: new Bun.Glob(text.split(path.sep).join("/")), absolute, kind };
}

/** One owner per language-server process, including when that process is muxed. */
export class WatchedFiles {
	readonly #cwd: string;
	readonly #notify: (changes: FileEvent[]) => Promise<void>;
	readonly #registrations = new Map<string, Pattern[]>();
	readonly #roots = new Map<string, RootWatcher>();
	readonly #pending: FileEvent[] = [];
	readonly #lastPendingType = new Map<string, FileEvent["type"]>();
	#timer?: NodeJS.Timeout;
	#closed = false;

	constructor(cwd: string, notify: (changes: FileEvent[]) => Promise<void>) {
		this.#cwd = path.resolve(cwd);
		this.#notify = notify;
	}

	/** Validate the entire batch and establish watches before acknowledging it. */
	async register(registrations: readonly unknown[]): Promise<void> {
		if (this.#closed) throw new Error("Watched-file owner is closed");
		const additions = new Map<string, Pattern[]>();
		for (const registration of registrations) {
			if (!isRecord(registration) || registration.method !== WATCHED_FILES_METHOD) continue;
			const options = registration.registerOptions;
			if (typeof registration.id !== "string" || !isRecord(options) || !Array.isArray(options.watchers)) {
				throw new Error("Invalid watched-file registration");
			}
			additions.set(
				registration.id,
				options.watchers.map(value => compilePattern(this.#cwd, value)),
			);
		}
		try {
			const ready: Promise<void>[] = [];
			for (const patterns of additions.values()) {
				for (const pattern of patterns) ready.push(this.#watchRoot(pattern.root).ready);
			}
			await Promise.all(ready);
			if (this.#closed) throw new Error("Watched-file owner is closed");
			for (const [id, patterns] of additions) this.#registrations.set(id, patterns);
		} finally {
			await this.#releaseUnusedRoots();
		}
	}

	async unregister(ids: readonly string[]): Promise<void> {
		for (const id of ids) this.#registrations.delete(id);
		await this.#releaseUnusedRoots();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#registrations.clear();
		this.#pending.length = 0;
		this.#lastPendingType.clear();
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#releaseUnusedRoots();
	}

	#watchRoot(root: string): RootWatcher {
		const existing = this.#roots.get(root);
		if (existing) return existing;
		const watcher = watch(root, {
			ignoreInitial: true,
			persistent: false,
			followSymlinks: false,
			ignored: target =>
				excluded(root, path.resolve(target)) ||
				(inside(this.#cwd, path.resolve(target)) && excluded(this.#cwd, path.resolve(target))),
		});
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(
			() => reject(new Error(`Watched-file initialization timed out: ${root}`)),
			READY_TIMEOUT_MS,
		);
		watcher.once("ready", () => {
			clearTimeout(timer);
			resolve();
		});
		watcher.on("error", error => {
			clearTimeout(timer);
			reject(error);
			logger.warn("LSP filesystem watcher failed", { root, error: String(error) });
		});
		watcher.on("add", target => this.#enqueue(target, 1));
		watcher.on("change", target => this.#enqueue(target, 2));
		watcher.on("unlink", target => this.#enqueue(target, 3));
		const entry = {
			watcher,
			ready: promise.finally(() => clearTimeout(timer)),
			cancel: () => {
				clearTimeout(timer);
				reject(new Error("Watched-file owner is closed"));
			},
		};
		this.#roots.set(root, entry);
		return entry;
	}

	#matches(target: string, type: FileEvent["type"]): boolean {
		const mask = type === 3 ? 4 : type;
		for (const patterns of this.#registrations.values()) {
			for (const pattern of patterns) {
				if (!(pattern.kind & mask) || !inside(pattern.root, target) || excluded(pattern.root, target)) continue;
				if (inside(this.#cwd, target) && excluded(this.#cwd, target)) continue;
				const candidate = pattern.absolute ? target : path.relative(pattern.root, target);
				if (pattern.glob.match(candidate.split(path.sep).join("/"))) return true;
			}
		}
		return false;
	}

	#enqueue(target: string, type: FileEvent["type"]): void {
		if (this.#closed || !this.#matches(target, type)) return;
		const uri = pathToFileURL(target).href;
		// Overlapping roots and registrations still produce one event per change.
		if (this.#lastPendingType.get(uri) !== type) {
			this.#lastPendingType.set(uri, type);
			this.#pending.push({ uri, type });
		}
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const changes = this.#pending.filter(change => this.#matches(fileURLToPath(change.uri), change.type));
			this.#pending.length = 0;
			this.#lastPendingType.clear();
			if (this.#closed || changes.length === 0) return;
			void this.#notify(changes).catch(error => {
				logger.warn("LSP external file notification failed", { error: String(error) });
			});
		}, FILE_EVENT_BATCH_MS);
	}

	async #releaseUnusedRoots(): Promise<void> {
		const used = new Set<string>();
		for (const patterns of this.#registrations.values()) for (const pattern of patterns) used.add(pattern.root);
		const closing: Promise<void>[] = [];
		for (const [root, entry] of this.#roots) {
			if (used.has(root)) continue;
			this.#roots.delete(root);
			entry.cancel();
			closing.push(entry.watcher.close());
		}
		await Promise.all(closing);
	}
}
