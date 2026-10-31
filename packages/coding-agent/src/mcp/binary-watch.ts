/**
 * Detects when the code behind a stdio MCP server changes on disk, so the
 * manager can respawn it and pick up the new build without `/mcp reload`.
 *
 * Watched files per server: the resolved `command` executable plus every
 * argument that names an existing regular file (`node server.js`,
 * `bun run /path/index.ts`). Polling `stat` is the trigger, since an atomic
 * replace (`mv`, `brew upgrade`, a linker writing a fresh inode) is not
 * reliably seen by `fs.watch` on a file path. A changed stat only counts once
 * it is the same on two consecutive polls (the writer is done), and only a
 * changed content digest fires: a `touch` or a rebuild producing identical
 * bytes does not respawn the server.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { MCPServerConfig, MCPStdioServerConfig } from "./types";

/** How often watched files are stat-ed. */
export const MCP_BINARY_POLL_MS = 2000;
/** Bound on arguments probed as script paths, so a long argv costs nothing. */
const MAX_PROBED_ARGS = 16;
/** BLAKE-family digest: Bun has no blake3, and `blake2b256` is its fast BLAKE variant. */
const DIGEST_ALGORITHM = "blake2b256";

interface FileSignature {
	size: number;
	mtimeMs: number;
	ino: number;
}

interface WatchedFile {
	path: string;
	/** Last stat the digest corresponds to. */
	signature: FileSignature;
	digest: string | undefined;
	/** A differing stat seen once, awaiting confirmation on the next poll. */
	pending: FileSignature | undefined;
}

interface WatchedServer {
	files: WatchedFile[];
}

export type McpBinaryChangeHandler = (serverName: string, changedPaths: string[]) => void;

function sameSignature(a: FileSignature | undefined, b: FileSignature | undefined): boolean {
	return a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

async function signatureOf(file: string): Promise<FileSignature | undefined> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) return undefined;
		return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
	} catch {
		// Missing mid-replace: the next poll sees the new file.
		return undefined;
	}
}

async function digestOf(file: string): Promise<string | undefined> {
	try {
		const hasher = new Bun.CryptoHasher(DIGEST_ALGORITHM);
		for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
		return hasher.digest("hex");
	} catch {
		return undefined;
	}
}

function isStdio(config: MCPServerConfig): config is MCPStdioServerConfig {
	return config.type === undefined || config.type === "stdio";
}

/** Executable and script files a stdio server's behavior depends on, absolute and de-duplicated. */
export async function resolveWatchedPaths(config: MCPStdioServerConfig): Promise<string[]> {
	const cwd = config.cwd ? path.resolve(config.cwd) : getProjectDir();
	const found = new Set<string>();

	const command = config.command.includes("/")
		? path.resolve(cwd, config.command)
		: Bun.which(config.command, { PATH: config.env?.PATH ?? process.env.PATH, cwd });
	if (command) found.add(command);

	for (const arg of (config.args ?? []).slice(0, MAX_PROBED_ARGS)) {
		if (arg.startsWith("-") || arg.includes("://")) continue;
		const candidate = path.resolve(cwd, arg);
		if (await signatureOf(candidate)) found.add(candidate);
	}
	return [...found];
}

export class McpBinaryWatcher {
	#servers = new Map<string, WatchedServer>();
	/** Bumped by every watch/unwatch so a baseline still hashing can tell it was superseded. */
	#generations = new Map<string, number>();
	#timer: NodeJS.Timeout | undefined;
	#polling = false;

	constructor(
		private readonly onChange: McpBinaryChangeHandler,
		private readonly pollMs: number = MCP_BINARY_POLL_MS,
	) {}

	/** Number of servers currently watched. */
	get size(): number {
		return this.#servers.size;
	}

	/** (Re)baseline a server: its current on-disk bytes are the version it is about to run. */
	async watch(name: string, config: MCPServerConfig): Promise<void> {
		const generation = this.#bump(name);
		this.#servers.delete(name);
		if (!isStdio(config)) {
			this.#settle();
			return;
		}
		const files: WatchedFile[] = [];
		for (const file of await resolveWatchedPaths(config)) {
			const signature = await signatureOf(file);
			if (!signature) continue;
			files.push({ path: file, signature, digest: await digestOf(file), pending: undefined });
		}
		// unwatch() or a newer watch() during the awaits above supersedes this baseline.
		if (this.#generations.get(name) !== generation || files.length === 0) return;
		this.#servers.set(name, { files });
		this.#ensureTimer();
	}

	unwatch(name: string): void {
		this.#bump(name);
		this.#servers.delete(name);
		this.#settle();
	}

	dispose(): void {
		for (const name of this.#generations.keys()) this.#bump(name);
		this.#servers.clear();
		this.#settle();
	}

	#bump(name: string): number {
		const generation = (this.#generations.get(name) ?? 0) + 1;
		this.#generations.set(name, generation);
		return generation;
	}

	/** Stop polling once nothing is watched. */
	#settle(): void {
		if (this.#servers.size === 0) this.#stopTimer();
	}

	#ensureTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => void this.#poll(), this.pollMs);
		this.#timer.unref();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async #poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			for (const [name, server] of this.#servers) {
				const changed = await this.#pollServer(server);
				// Dropped while hashing: the manager no longer runs this server.
				if (changed.length > 0 && this.#servers.get(name) === server) {
					logger.debug("MCP server binary changed", { path: `mcp:${name}`, changed });
					this.onChange(name, changed);
				}
			}
		} finally {
			this.#polling = false;
		}
	}

	async #pollServer(server: WatchedServer): Promise<string[]> {
		const changed: string[] = [];
		for (const file of server.files) {
			const signature = await signatureOf(file.path);
			if (!signature || sameSignature(signature, file.signature)) {
				file.pending = undefined;
				continue;
			}
			if (!sameSignature(signature, file.pending)) {
				file.pending = signature;
				continue;
			}
			const digest = await digestOf(file.path);
			file.signature = signature;
			file.pending = undefined;
			if (digest === undefined) continue;
			if (file.digest !== undefined && digest !== file.digest) changed.push(file.path);
			file.digest = digest;
		}
		return changed;
	}
}
