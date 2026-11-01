import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

/** LSP file change types and registration mask bits have different values for deletion. */
export type WatchedChange = { filePath: string; type: 1 | 2 | 3 };

type GlobPattern = string | { baseUri: string | { uri: string }; pattern: string };
type FileWatcher = { globPattern: GlobPattern; kind?: number };
type Registration = { id: string; registerOptions?: { watchers?: FileWatcher[] } };
type Pattern = { glob: Bun.Glob; base: string; watchRoot: string; mask: number; absolute: boolean };

const IGNORED_DIRS: Record<string, true> = { ".git": true, node_modules: true, ".worktrees": true };
const FLUSH_DELAY_MS = 150;

function patternsFor(root: string, registration: Registration): Pattern[] {
	const watchers = registration.registerOptions?.watchers;
	if (!Array.isArray(watchers)) throw new Error("Watched-file registration has no watchers");
	return watchers.map(watcher => {
		const pattern = watcher.globPattern;
		const baseUri = typeof pattern === "string" ? undefined : pattern?.baseUri;
		const base = typeof baseUri === "string" ? baseUri : typeof baseUri?.uri === "string" ? baseUri.uri : undefined;
		if (typeof pattern !== "string" && (typeof pattern?.pattern !== "string" || !base))
			throw new Error("Invalid watched-file glob pattern");
		const source = typeof pattern === "string" ? pattern : pattern.pattern;
		const absolute = path.isAbsolute(source);
		const directory = base ? Bun.fileURLToPath(base) : root;
		const wildcard = source.search(/[*?{[]/);
		const prefix = wildcard === -1 ? source : source.slice(0, wildcard);
		const watchRoot = absolute
			? path.resolve(wildcard === -1 || !prefix.endsWith("/") ? path.dirname(prefix) : prefix)
			: directory;
		return { glob: new Bun.Glob(source), base: directory, watchRoot, absolute, mask: watcher.kind ?? 7 };
	});
}

/** Watches registered LSP globs, excluding dependency and VCS trees before allocating watches. */
export class WatchedFiles {
	readonly #root: string;
	readonly #deliver: (changes: WatchedChange[]) => Promise<void>;
	readonly #registrations = new Map<string, Pattern[]>();
	readonly #directories = new Map<string, fs.FSWatcher>();
	readonly #known = new Set<string>();
	readonly #pending = new Map<string, WatchedChange["type"]>();
	#timer?: Timer;
	#closed = false;

	constructor(root: string, deliver: (changes: WatchedChange[]) => Promise<void>) {
		this.#root = path.resolve(root);
		this.#deliver = deliver;
	}

	/** Install each registration before acknowledging it, including paths outside the workspace root. */
	async register(registrations: Registration[]): Promise<void> {
		const additions = registrations.map(registration => ({
			id: registration.id,
			patterns: patternsFor(this.#root, registration),
		}));
		if (this.#closed) return;
		const replaced = additions.map(({ id }) => ({ id, previous: this.#registrations.get(id) }));
		for (const { id, patterns } of additions) this.#registrations.set(id, patterns);
		try {
			for (const { patterns } of additions) {
				for (const pattern of patterns) {
					let dir = pattern.watchRoot;
					while (true) {
						try {
							await this.#watch(dir);
							pattern.watchRoot = dir;
							break;
						} catch (error) {
							if (!isEnoent(error) || path.dirname(dir) === dir) throw error;
							dir = path.dirname(dir);
						}
					}
				}
			}
		} catch (error) {
			for (const { id, previous } of replaced) {
				if (previous) this.#registrations.set(id, previous);
				else this.#registrations.delete(id);
			}
			this.#trimWatches();
			throw error;
		}
		this.#trimWatches();
	}

	/** Drop registrations and close directories no remaining glob needs. */
	unregister(ids: string[]): void {
		for (const id of ids) this.#registrations.delete(id);
		this.#trimWatches();
	}

	/** Release every OS watcher and pending notification when the server exits. */
	close(): void {
		this.#closed = true;
		this.#registrations.clear();
		this.#stopWatching();
	}

	#trimWatches(): void {
		const roots = new Set<string>();
		for (const patterns of this.#registrations.values()) for (const pattern of patterns) roots.add(pattern.watchRoot);
		if (roots.size === 0) {
			this.#stopWatching();
			return;
		}
		let removed = false;
		for (const [dir, watcher] of this.#directories) {
			let needed = false;
			for (const root of roots) {
				if (dir === root || dir.startsWith(`${root}${path.sep}`)) {
					needed = true;
					break;
				}
			}
			if (needed) continue;
			watcher.close();
			this.#directories.delete(dir);
			removed = true;
		}
		if (!removed) return;
		for (const file of this.#known) {
			let needed = false;
			for (const root of roots) {
				if (file === root || file.startsWith(`${root}${path.sep}`)) {
					needed = true;
					break;
				}
			}
			if (!needed) this.#known.delete(file);
		}
	}

	#stopWatching(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#pending.clear();
		this.#known.clear();
		for (const watcher of this.#directories.values()) watcher.close();
		this.#directories.clear();
	}

	async #watch(dir: string, created = false): Promise<void> {
		if (this.#closed || this.#directories.has(dir)) return;
		const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
			if (name)
				void this.#changed(path.join(dir, name.toString())).catch(error => {
					logger.debug("LSP watched-file event failed", { dir, error: String(error) });
				});
		});
		watcher.on("error", error => {
			logger.debug("LSP filesystem watcher failed", { dir, error: String(error) });
			watcher.close();
			this.#directories.delete(dir);
		});
		this.#directories.set(dir, watcher);
		try {
			for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
				if (this.#closed) return;
				const file = path.join(dir, entry.name);
				if (entry.isDirectory() && IGNORED_DIRS[entry.name]) continue;
				this.#known.add(file);
				if (entry.isDirectory()) await this.#watch(file, created);
				else if (created) this.#enqueue(file, 1);
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}

	async #changed(file: string): Promise<void> {
		if (this.#closed || IGNORED_DIRS[path.basename(file)]) return;
		let stats: fs.Stats | undefined;
		try {
			stats = await fs.promises.stat(file);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const known = this.#known.has(file);
		const type = stats ? (known ? 2 : 1) : 3;
		if (stats) {
			this.#known.add(file);
			if (stats.isDirectory()) await this.#watch(file, !known);
		} else {
			this.#known.delete(file);
			let removedDirectory = false;
			for (const [dir, watcher] of this.#directories) {
				if (dir === file || dir.startsWith(`${file}${path.sep}`)) {
					watcher.close();
					this.#directories.delete(dir);
					removedDirectory = true;
				}
			}
			if (removedDirectory)
				for (const knownFile of this.#known)
					if (knownFile.startsWith(`${file}${path.sep}`)) this.#known.delete(knownFile);
		}
		this.#enqueue(file, type);
	}

	#enqueue(file: string, type: WatchedChange["type"]): void {
		if (this.#closed || !this.#matches(file, type)) return;
		const previous = this.#pending.get(file);
		this.#pending.set(file, previous === 1 && type === 2 ? 1 : previous === 3 && type === 1 ? 2 : type);
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const changes = Array.from(this.#pending, ([filePath, changeType]) => ({ filePath, type: changeType }));
			this.#pending.clear();
			if (!this.#closed && changes.length)
				void this.#deliver(changes).catch(error => {
					logger.debug("LSP watched-file delivery failed", { error: String(error) });
				});
		}, FLUSH_DELAY_MS);
		this.#timer.unref();
	}

	#matches(file: string, type: WatchedChange["type"]): boolean {
		const bit = type === 3 ? 4 : type;
		for (const patterns of this.#registrations.values()) {
			for (const { glob, base, mask, absolute } of patterns) {
				if (!(mask & bit)) continue;
				if (absolute) {
					if (glob.match(file.replaceAll(path.sep, "/"))) return true;
					continue;
				}
				const relative = path.relative(base, file);
				if (
					relative !== ".." &&
					!relative.startsWith(`..${path.sep}`) &&
					!path.isAbsolute(relative) &&
					glob.match(relative.replaceAll(path.sep, "/"))
				)
					return true;
			}
		}
		return false;
	}
}
