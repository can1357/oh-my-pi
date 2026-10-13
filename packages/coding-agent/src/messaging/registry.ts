import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { isEnoent, isFsError } from "@oh-my-pi/pi-utils";
import { mapWithConcurrencyLimit } from "../task/parallel";
import { isMailboxSessionId, MESSAGING_WIRE_VERSION } from "./protocol";

export interface InboxEntry {
	readonly sessionId: string;
	readonly version: number;
	readonly entryId: string;
	readonly pid: number;
	readonly endpoint: string;
	readonly createdAt: number;
}

export interface RegistryPublication {
	readonly entryId: string;
	readonly endpoint: string;
	/** Idempotent: destroys live connections, removes the metadata row, closes the listener, removes endpoint files. */
	close(): Promise<void>;
}

const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

function isForeignTransport(endpoint: string): boolean {
	return process.platform === "win32" ? endpoint.startsWith("/") : endpoint.toLowerCase().startsWith("\\\\.\\pipe\\");
}

function parseMetadata(text: string, entryId: string): InboxEntry | "foreign_transport" | "invalid_session" | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const meta = raw as Record<string, unknown>;
	if (typeof meta.endpoint === "string" && isForeignTransport(meta.endpoint)) return "foreign_transport";
	if (typeof meta.version !== "number") return null;
	if (typeof meta.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(meta.instanceId)) return null;
	if (typeof meta.pid !== "number" || !Number.isInteger(meta.pid) || meta.pid <= 0) return null;
	if (typeof meta.endpoint !== "string" || meta.endpoint.length === 0) return null;
	if (typeof meta.createdAt !== "number") return null;
	if (!isMailboxSessionId(meta.sessionId)) return "invalid_session";
	return {
		sessionId: meta.sessionId,
		version: meta.version,
		entryId,
		pid: meta.pid,
		endpoint: meta.endpoint,
		createdAt: meta.createdAt,
	};
}

/** Refuses symlinks / non-directories; POSIX also requires current-uid ownership and tightens to 0700. */
export async function assertPrivateDir(dir: string): Promise<void> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`messaging registry directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`messaging registry path is not a directory: ${dir}`);
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`messaging registry directory is not owned by the current user: ${dir}`);
	}
	if ((stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

/** mkdir -p 0700, then assertPrivateDir. */
export async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	await assertPrivateDir(dir);
}

/** True when `endpoint` is a location this registry could have created for `entryId`. */
export function ownsEndpoint(dir: string, entryId: string, endpoint: string): boolean {
	return (
		process.platform !== "win32" && (endpoint.startsWith(dir + path.sep) || endpoint === ipcEndpoint(dir, entryId))
	);
}

function endpointFiles(endpoint: string): string[] {
	return process.platform === "win32" ? [] : [endpoint, `${endpoint}.bind.lock`];
}

function removeFilesSync(files: string[]): void {
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Best-effort; discovery can prune surviving artifacts.
		}
	}
}

/** Binds `ipcEndpoint(dir, entryId)` with native line framing and atomically writes `<dir>/<entryId>.json`. */
export async function publishEntry(
	dir: string,
	options: {
		entryId: string;
		sessionId: string;
		maxConnections: number;
		maxFrameBytes: number;
		/** Called once per accepted connection under the cap; the handler MUST call `onClose` from its `start()` close callback. */
		onConnection: (connection: IpcConnection, onClose: () => void) => void;
	},
): Promise<RegistryPublication> {
	await ensurePrivateDir(dir);
	const { entryId } = options;
	const endpoint = ipcEndpoint(dir, entryId);
	const metaPath = path.join(dir, `${entryId}.json`);
	const tmpPath = `${metaPath}.tmp`;
	const liveConnections = new Set<IpcConnection>();
	let server: IpcServer | undefined;
	try {
		server = await IpcServer.listen(
			endpoint,
			{ framing: "lines", maxFrameBytes: options.maxFrameBytes },
			connection => {
				if (liveConnections.size >= options.maxConnections) {
					connection.destroy();
					return;
				}
				liveConnections.add(connection);
				options.onConnection(connection, () => liveConnections.delete(connection));
			},
		);
		const meta = {
			version: MESSAGING_WIRE_VERSION,
			instanceId: entryId,
			pid: process.pid,
			endpoint,
			createdAt: Date.now(),
			entryId,
			sessionId: options.sessionId,
		};
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(meta), "utf8");
		} finally {
			await handle.close();
		}
		await fs.promises.rename(tmpPath, metaPath);
	} catch (err) {
		for (const connection of liveConnections) connection.destroy();
		removeFilesSync([tmpPath]);
		try {
			await server?.close();
		} finally {
			removeFilesSync(endpointFiles(endpoint));
		}
		throw err;
	}
	const listener = server;
	const removeArtifactsOnExit = (): void => removeFilesSync([metaPath, ...endpointFiles(endpoint)]);
	process.once("exit", removeArtifactsOnExit);
	let closing: Promise<void> | undefined;
	return {
		entryId,
		endpoint,
		close(): Promise<void> {
			closing ??= (async () => {
				process.off("exit", removeArtifactsOnExit);
				for (const connection of liveConnections) connection.destroy();
				removeFilesSync([metaPath]);
				try {
					await listener.close();
				} finally {
					removeFilesSync(endpointFiles(endpoint));
				}
			})();
			return closing;
		},
	};
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return isFsError(err) && err.code === "EPERM";
	}
}

/** Each publication has its own artifacts, so pruning never removes its successor. */
async function pruneEntry(dir: string, name: string, meta: InboxEntry | null): Promise<void> {
	try {
		if (meta && isForeignTransport(meta.endpoint)) return;
		if (meta && meta.version !== MESSAGING_WIRE_VERSION && pidAlive(meta.pid)) return;
		const metaPath = path.join(dir, name);
		if (process.platform !== "win32") {
			const stat = await fs.promises.lstat(metaPath);
			if (!stat.isFile() || stat.uid !== process.getuid?.()) return;
		}
		await fs.promises.rm(metaPath, { force: true });
		if (meta && ownsEndpoint(dir, meta.entryId, meta.endpoint)) {
			for (const file of endpointFiles(meta.endpoint)) await fs.promises.rm(file, { force: true });
		}
	} catch {
		// Best-effort; another process may already have pruned it.
	}
}

async function readRegistryEntries(dir: string, prune: boolean, signal?: AbortSignal): Promise<InboxEntry[]> {
	let names: string[];
	try {
		await assertPrivateDir(dir);
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries: InboxEntry[] = [];
	for (const name of names.filter(name => name.endsWith(".json")).sort()) {
		if (signal?.aborted) break;
		let text: string;
		try {
			const metaPath = path.join(dir, name);
			if (process.platform !== "win32") {
				const stat = await fs.promises.lstat(metaPath);
				if (!stat.isFile() || stat.uid !== process.getuid?.()) continue;
			}
			text = await Bun.file(metaPath).text();
		} catch {
			continue;
		}
		const meta = parseMetadata(text, name.slice(0, -".json".length));
		if (meta === "foreign_transport" || meta === "invalid_session") continue;
		if (!meta) {
			if (prune && !signal?.aborted) await pruneEntry(dir, name, null);
			continue;
		}
		if (!pidAlive(meta.pid)) {
			if (prune && !signal?.aborted) await pruneEntry(dir, name, meta);
			continue;
		}
		entries.push(meta);
	}
	return entries;
}

/** Metadata-only rows of every wire version (no socket opened, no pruning); rows with a non-mailbox sessionId are dropped. */
export async function readEntries(dir: string, options?: { signal?: AbortSignal }): Promise<InboxEntry[]> {
	return readRegistryEntries(dir, false, options?.signal);
}

type ProbeResult = "live" | "dead" | "skip";

function probe(entry: InboxEntry, timeoutMs: number, signal: AbortSignal): Promise<ProbeResult> {
	if (signal.aborted) return Promise.resolve("skip");
	const { promise, resolve } = Promise.withResolvers<ProbeResult>();
	let settled = false;
	const finish = (result: ProbeResult): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		resolve(result);
	};
	const timer = setTimeout(() => finish("skip"), timeoutMs);
	const abort = (): void => finish("skip");
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	IpcConnection.connect(entry.endpoint, { framing: "lines", timeoutMs }).then(
		connection => {
			connection.destroy();
			if (!settled) finish("live");
		},
		(err: unknown) => {
			const code = isFsError(err) ? err.code : undefined;
			finish(code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip");
		},
	);
	return promise;
}

/** Rows of every wire version whose endpoint accepts a native connect; prunes malformed, dead-PID and refused/missing rows. */
export async function listLiveEntries(
	dir: string,
	options: { timeoutMs: number; signal?: AbortSignal },
): Promise<InboxEntry[]> {
	if (options.signal?.aborted) return [];
	const entries = await readRegistryEntries(dir, true, options.signal);
	const { results } = await mapWithConcurrencyLimit(
		entries,
		8,
		async (entry, _index, signal) => {
			const result = await probe(entry, options.timeoutMs, signal);
			if (signal.aborted) return undefined;
			if (result === "live") return entry;
			if (result === "dead") await pruneEntry(dir, `${entry.entryId}.json`, entry);
			return undefined;
		},
		options.signal,
	);
	return results.filter((entry): entry is InboxEntry => entry !== undefined);
}
