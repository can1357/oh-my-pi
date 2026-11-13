/**
 * Contained file access. While the OS sandbox is active, omp's in-process file tools hand their
 * filesystem work to a sandbox host, so the container decides each syscall where it happens instead
 * of omp deciding from a path check made beforehand:
 *
 * - Mutations (`write`, `edit`, `ast_edit`, the `lsp` tool's edits and moves) run in the host:
 *   {@link mutateFile}. An applied `ast_edit` and a SQLite row write run whole there.
 * - Tree walks (`grep`, `glob`, `find`, `ast_grep`, the `ast_edit` preview, directory listings) run
 *   their native search in the host; only results cross: {@link containedGrep} and siblings.
 * - A single-file read is decided by the host and performed by omp: {@link openReadableFile} has
 *   the host open the path inside the container, then opens it here and requires the very file the
 *   container opened (same device and file id). Every byte is then read through omp's handle, so
 *   a symlink or junction swapped in after the check cannot redirect it. SQLite reads run whole in
 *   the host, since SQLite opens its `-wal`/`-shm` sidecars itself.
 *
 * A session's host is pooled under the `files:` namespace, apart from the hosts that run its
 * shells (a different scope would retire those), and `releaseShellSessions` retires it with them.
 * A caller without a session id gets a host of its own for the call, retired when the call ends.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as natives from "@oh-my-pi/pi-natives";
import { ArchiveError, assertValidRange, type ByteSource } from "@oh-my-pi/pi-utils/ar";
import { peekFile } from "@oh-my-pi/pi-utils/peek-file";
import { Settings } from "../config/settings";
import { sessionSandboxWritableRoots } from "../internal-urls/context";
import type { ToolSession } from "../tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import type { ResolvedSqliteReadPath } from "../tools/read-sqlite";
import { applyFileMutation } from "./file-mutation-ops";
import type { HostFileIdentity, HostFileMutation, HostRunFs, HostSqliteWrite } from "./host-protocol";
import { sandboxEnabled } from "./policy";
import { SandboxRuntime, SandboxUnavailableError } from "./runtime";
import {
	acquireSandboxHost,
	type SandboxHostConnection,
	type SandboxHostScope,
	startSandboxHost,
} from "./shell-client";

/**
 * Largest write payload sent in one request. Bytes travel base64-encoded (4/3), so a chunk stays
 * well under the protocol's line cap; larger writes continue with `append` requests.
 */
const WRITE_CHUNK_BYTES = 16 * 1024 * 1024;

/** Per-match callback of `natives.grep` / `natives.glob`. */
type MatchCallback<T> = ((error: Error | null, match: T) => void) | undefined | null;

/** The bridged URL filesystem of a native call: its descriptor, and the parent-side handler. */
function bridged(filesystem: natives.ShellFilesystem | undefined): {
	fs: HostRunFs | null;
	filesystem: natives.ShellFilesystem | undefined;
} {
	return filesystem ? { fs: { nativeLocalPaths: filesystem.nativeLocalPaths }, filesystem } : { fs: null, filesystem };
}

function abortSignal(signal: unknown): AbortSignal | undefined {
	return signal instanceof AbortSignal ? signal : undefined;
}

/** The filesystem work of one tool call, performed by a contained host. */
export class ContainedFileAccess {
	readonly #runtime: SandboxRuntime;
	readonly #scope: SandboxHostScope;
	/** The call's own host, for a caller without a session id (no pool owner would ever release it). */
	#ownHost: Promise<SandboxHostConnection> | undefined;
	#released = false;

	constructor(runtime: SandboxRuntime, scope: SandboxHostScope) {
		this.#runtime = runtime;
		this.#scope = scope;
	}

	/**
	 * True once the call that set this up ended. Work it started that outlives it (a language
	 * server's message pump, a watcher) no longer runs contained under it.
	 */
	get released(): boolean {
		return this.#released;
	}

	/**
	 * The host for the next request. Pooled hosts are looked up each time: a policy change or a
	 * session switch retires the host a call started with, and its next step must not land there.
	 */
	#connection(): Promise<SandboxHostConnection> {
		if (this.#scope.agentSessionKey !== undefined) return acquireSandboxHost(this.#runtime, this.#scope);
		this.#ownHost ??= startSandboxHost(this.#runtime, this.#scope);
		return this.#ownHost;
	}

	/** Lets the call's own host exit; pooled hosts belong to their session. */
	release(): void {
		this.#released = true;
		void this.#ownHost?.then(
			connection => connection.retire(),
			() => {},
		);
	}

	/** Rejects with the syscall's errno (`code`), as the in-process call would. */
	async mutate(mutation: HostFileMutation): Promise<void> {
		if (mutation.kind !== "write") {
			await (await this.#connection()).request({ op: "file.mutate", mutation });
			return;
		}
		const bytes = typeof mutation.data === "string" ? Buffer.from(mutation.data) : mutation.data;
		await (
			await this.#connection()
		).request({
			op: "file.mutate",
			mutation: { kind: "write", path: mutation.path, data: bytes.subarray(0, WRITE_CHUNK_BYTES) },
		});
		for (let offset = WRITE_CHUNK_BYTES; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
			await (
				await this.#connection()
			).request({
				op: "file.mutate",
				mutation: { kind: "append", path: mutation.path, data: bytes.subarray(offset, offset + WRITE_CHUNK_BYTES) },
			});
		}
	}

	/** Opens `filePath` for reading in the container; rejects with its errno (`EACCES`, `ENOENT`, …). */
	async identify(filePath: string): Promise<HostFileIdentity> {
		return (await this.#connection()).request({ op: "file.identify", path: filePath });
	}

	/** `listWorkspace`, walked in the host. */
	async listWorkspace(options: natives.ListWorkspaceOptions): Promise<natives.ListWorkspaceResult> {
		return (await this.#connection()).request({ op: "dir.list", options });
	}

	/**
	 * `grep` run in the host: local paths natively there, URL paths through `options.filesystem`.
	 * `onMatches` streams; `onMatch` runs per returned match once the search ends.
	 */
	async grep(options: natives.GrepOptions, onMatch?: MatchCallback<natives.GrepMatch>): Promise<natives.GrepResult> {
		const { filesystem: urlFs, signal, onMatches, ...rest } = options;
		const { fs, filesystem } = bridged(urlFs);
		const result = await (
			await this.#connection()
		).request(
			{ op: "search.grep", options: rest, fs, stream: onMatches !== undefined },
			{ filesystem, onMatches, signal: abortSignal(signal) },
		);
		if (onMatch) for (const match of result.matches) onMatch(null, match);
		return result;
	}

	/** `glob` run in the host; `onMatch` runs per returned match once the walk ends. */
	async glob(options: natives.GlobOptions, onMatch?: MatchCallback<natives.GlobMatch>): Promise<natives.GlobResult> {
		const { filesystem: urlFs, signal, ...rest } = options;
		const { fs, filesystem } = bridged(urlFs);
		const result = await (
			await this.#connection()
		).request({ op: "search.glob", options: rest, fs }, { filesystem, signal: abortSignal(signal) });
		if (onMatch) for (const match of result.matches) onMatch(null, match);
		return result;
	}

	/** `astGrep` run in the host. */
	async astGrep(options: natives.AstFindOptions): Promise<natives.AstFindResult> {
		const { filesystem: urlFs, signal, ...rest } = options;
		const { fs, filesystem } = bridged(urlFs);
		return (await this.#connection()).request(
			{ op: "ast.grep", options: rest, fs },
			{ filesystem, signal: abortSignal(signal) },
		);
	}

	/**
	 * `astEdit` run in the host: local paths natively there, URL paths through `options.filesystem`.
	 * An applied rewrite's `changes` is empty (see `HostResults["ast.edit"]`); a dry run keeps them.
	 */
	async astEdit(options: natives.AstReplaceOptions): Promise<natives.AstReplaceResult> {
		const { filesystem: urlFs, signal, ...rest } = options;
		const { fs, filesystem } = bridged(urlFs);
		return (await this.#connection()).request(
			{ op: "ast.edit", options: rest, fs },
			{ filesystem, signal: abortSignal(signal) },
		);
	}

	/** The `read` tool's SQLite read, run in the host. */
	async sqliteRead(target: ResolvedSqliteReadPath): Promise<AgentToolResult<ReadToolDetails>> {
		return (await this.#connection()).request({ op: "sqlite.read", target });
	}

	/** The `write` tool's SQLite row write, run in the host; resolves to its result line. */
	async sqliteWrite(write: HostSqliteWrite): Promise<string> {
		return (await this.#connection()).request({ op: "sqlite.write", write });
	}
}

const storage = new AsyncLocalStorage<ContainedFileAccess>();

/** The running tool call's contained file access; `undefined` when its file work runs in-process. */
export function containedFileAccess(): ContainedFileAccess | undefined {
	const contained = storage.getStore();
	return contained?.released ? undefined : contained;
}

/**
 * Runs `fn` outside any contained file access: for work that outlives the call it starts in (a
 * language server's message pump), which must not inherit that call's host.
 */
export function outsideContainedFileAccess<T>(fn: () => T): T {
	return storage.exit(fn);
}

/** Performs `mutation` in the contained host when the running tool call is contained, else here. */
export async function mutateFile(mutation: HostFileMutation): Promise<void> {
	const contained = containedFileAccess();
	if (contained) await contained.mutate(mutation);
	else await applyFileMutation(mutation);
}

/**
 * Opens `filePath` for reading. Contained, the host opens it first (the container decides: a
 * refusal rejects with its errno), then omp opens it and requires the same file (device and file
 * id); a file swapped in between rejects with `EACCES`. Read every byte through the returned
 * handle, never by path again.
 */
export async function openReadableFile(filePath: string): Promise<fs.FileHandle> {
	const contained = containedFileAccess();
	if (!contained) return fs.open(filePath, "r");
	const expected = await contained.identify(filePath);
	const handle = await fs.open(filePath, "r");
	try {
		const actual = await handle.stat({ bigint: true });
		if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
			throw Object.assign(new Error(`EACCES: ${filePath} changed while the sandbox checked it`), {
				code: "EACCES",
				path: filePath,
			});
		}
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/** `fn` over {@link openReadableFile}'s handle, closed afterwards. */
export async function withReadableFile<T>(filePath: string, fn: (handle: fs.FileHandle) => Promise<T>): Promise<T> {
	const handle = await openReadableFile(filePath);
	try {
		return await fn(handle);
	} finally {
		await handle.close();
	}
}

/** `fs.readFile(filePath)`; contained, read through {@link openReadableFile}. */
export function readFileBytes(filePath: string): Promise<Buffer> {
	if (!containedFileAccess()) return fs.readFile(filePath);
	return withReadableFile(filePath, handle => handle.readFile());
}

/**
 * The whole file as UTF-8 text without a BOM, like `Bun.file(filePath).text()` (which it is when
 * nothing is contained); contained, read through {@link openReadableFile}.
 */
export async function readFileText(filePath: string): Promise<string> {
	if (!containedFileAccess()) return Bun.file(filePath).text();
	return new TextDecoder().decode(await readFileBytes(filePath));
}

/** Up to `length` bytes at `offset`, read through {@link openReadableFile} (fewer at end of file). */
export function readFileRange(filePath: string, offset: number, length: number): Promise<Uint8Array> {
	return withReadableFile(filePath, async handle => {
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		return buffer.subarray(0, bytesRead);
	});
}

/** `peekFile(filePath, maxBytes, op)`; contained, the header is read through {@link openReadableFile}. */
export async function peekReadableFile<T>(
	filePath: string,
	maxBytes: number,
	op: (header: Uint8Array) => T,
): Promise<T> {
	if (!containedFileAccess()) return peekFile(filePath, maxBytes, op);
	return op(await readFileRange(filePath, 0, maxBytes));
}

/** Largest chunk {@link copyReadableFile} moves at a time. */
const COPY_CHUNK_BYTES = 1024 * 1024;

/**
 * Copies `filePath` (or `range` of it), read through {@link openReadableFile}, to `destPath`: the
 * private copy a program that opens files by path itself (jq, Chromium, old ffmpeg, IDA) gets
 * instead of the path. A partial copy is removed.
 */
export async function copyReadableFile(
	filePath: string,
	destPath: string,
	range?: { offset: number; size: number },
): Promise<void> {
	await withReadableFile(filePath, async source => {
		const fileSize = (await source.stat()).size;
		let offset = range?.offset ?? 0;
		let remaining = range?.size ?? fileSize;
		if (offset + remaining > fileSize) throw new RangeError(`${filePath}: range extends past end of file`);
		const target = await fs.open(destPath, "w");
		try {
			const chunk = Buffer.allocUnsafe(Math.min(Math.max(remaining, 1), COPY_CHUNK_BYTES));
			while (remaining > 0) {
				const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, remaining), offset);
				if (bytesRead === 0) throw new Error(`${filePath} shrank while it was copied`);
				await target.write(chunk, 0, bytesRead);
				offset += bytesRead;
				remaining -= bytesRead;
			}
		} catch (error) {
			await target.close();
			await fs.rm(destPath, { force: true });
			throw error;
		}
		await target.close();
	});
}

/** `natives.grep`, in the contained host when the running call is contained. */
export function containedGrep(
	options: natives.GrepOptions,
	onMatch?: MatchCallback<natives.GrepMatch>,
): Promise<natives.GrepResult> {
	const contained = containedFileAccess();
	return contained ? contained.grep(options, onMatch) : natives.grep(options, onMatch);
}

/** Largest file `EditStore.recordSnapshotFile` records (its native cap). */
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;

/**
 * `store.recordSnapshotFile`, reading through {@link openReadableFile} when the running call is
 * contained (the native method reads by path in omp). Same contract: `null` for an unreadable,
 * non-UTF-8 or over-4-MiB file.
 */
export async function recordFileSnapshot(
	store: natives.EditStore,
	absolutePath: string,
	seenLines?: number[],
): Promise<string | null> {
	if (!containedFileAccess()) return store.recordSnapshotFile(absolutePath, seenLines);
	let text: string;
	try {
		text = await withReadableFile(absolutePath, async handle => {
			if ((await handle.stat()).size > MAX_SNAPSHOT_FILE_BYTES) throw new RangeError("too large");
			return new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile());
		});
	} catch {
		return null;
	}
	return store.recordSnapshot(absolutePath, text, seenLines);
}

/**
 * A random-access byte source over {@link openReadableFile}'s handle (for `openArchive`), and its
 * `close`. Reads past the size it had when opened are refused, as `fileByteSource` refuses them.
 */
export async function openReadableByteSource(
	filePath: string,
): Promise<{ source: ByteSource; close(): Promise<void> }> {
	const handle = await openReadableFile(filePath);
	try {
		const { size } = await handle.stat();
		const source: ByteSource = {
			size,
			async read(start, end) {
				assertValidRange(start, end);
				if (end > size) throw new ArchiveError("Invalid archive: truncated data");
				const buffer = Buffer.allocUnsafe(end - start);
				let filled = 0;
				while (filled < buffer.length) {
					const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
					if (bytesRead === 0) throw new ArchiveError("Invalid archive: truncated data");
					filled += bytesRead;
				}
				return buffer;
			},
		};
		return { source, close: () => handle.close() };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/** `natives.glob`, in the contained host when the running call is contained. */
export function containedGlob(
	options: natives.GlobOptions,
	onMatch?: MatchCallback<natives.GlobMatch>,
): Promise<natives.GlobResult> {
	const contained = containedFileAccess();
	return contained ? contained.glob(options, onMatch) : natives.glob(options, onMatch);
}

/** `natives.astGrep`, in the contained host when the running call is contained. */
export function containedAstGrep(options: natives.AstFindOptions): Promise<natives.AstFindResult> {
	const contained = containedFileAccess();
	return contained ? contained.astGrep(options) : natives.astGrep(options);
}

/** `natives.astEdit` (preview or apply), in the contained host when the running call is contained. */
export function containedAstEdit(options: natives.AstReplaceOptions): Promise<natives.AstReplaceResult> {
	const contained = containedFileAccess();
	return contained ? contained.astEdit(options) : natives.astEdit(options);
}

/** `natives.listWorkspace`, in the contained host when the running call is contained. */
export function containedListWorkspace(options: natives.ListWorkspaceOptions): Promise<natives.ListWorkspaceResult> {
	const contained = containedFileAccess();
	return contained ? contained.listWorkspace(options) : natives.listWorkspace(options);
}

/** Who a contained call acts for: a tool session, or a bare workspace (a language server's edit). */
export type ContainedFileAccessOwner = ToolSession | { cwd: string };

function isToolSession(owner: ContainedFileAccessOwner): owner is ToolSession {
	return "getSessionId" in owner || "getArtifactsDir" in owner;
}

/**
 * The runtime that contains omp's own file work for `cwd`, or `undefined` when the sandbox is off or
 * has no backend under `fallback: warn`; throws `SandboxUnavailableError` under `fallback: block`
 * without a backend, as contained commands do.
 */
export async function containingSandbox(cwd: string): Promise<SandboxRuntime | undefined> {
	if (!sandboxEnabled(await Settings.init())) return undefined;
	const runtime = await SandboxRuntime.for(cwd);
	const status = runtime.status();
	if (status.state === "unavailable" && status.fallback === "block") throw new SandboxUnavailableError(status.reason);
	return status.state === "active" ? runtime : undefined;
}

/**
 * Runs `fn` with `owner`'s file access contained when the OS sandbox is active for its workspace.
 * With the sandbox off, or no backend under `fallback: warn`, runs it as is; with no backend under
 * `fallback: block`, throws `SandboxUnavailableError`, as contained commands do.
 */
export async function withContainedFileAccess<T>(owner: ContainedFileAccessOwner, fn: () => Promise<T>): Promise<T> {
	const runtime = await containingSandbox(owner.cwd);
	if (!runtime) return fn();
	const session = isToolSession(owner) ? owner : undefined;
	const sessionId = session?.getSessionId?.() ?? undefined;
	const access = new ContainedFileAccess(runtime, {
		agentSessionKey: sessionId ? `files:${sessionId}` : undefined,
		cwd: owner.cwd,
		// The session's `local://` root (and any other sandbox-scope URL root): omp-owned, writable in
		// every sandbox mode.
		extraWrite: session ? sessionSandboxWritableRoots(session) : [],
		// File work needs no network; `allowlist` would also start the egress proxy for nothing.
		network: "deny",
	});
	try {
		return await storage.run(access, fn);
	} finally {
		access.release();
	}
}
