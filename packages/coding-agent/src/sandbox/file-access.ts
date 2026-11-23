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
import { handleByteSource } from "@oh-my-pi/pi-utils/ar";
import { peekFile } from "@oh-my-pi/pi-utils/peek-file";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import type { Settings } from "../config/settings";
import { sessionSandboxWritableRoots } from "../internal-urls/context";
import type { ToolSession } from "../tools";
import { applyFileMutation, OPEN_READ_NONBLOCK } from "./file-mutation-ops";
import type { HostFileMutation, HostRequest, HostResults } from "./host-protocol";
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

/** The natives a contained call runs in its host, by their request op. */
const NATIVE_OPS = { grep: "search.grep", glob: "search.glob", astGrep: "ast.grep", astEdit: "ast.edit" } as const;
type RoutedNative = keyof typeof NATIVE_OPS;
type NativeOp = (typeof NATIVE_OPS)[RoutedNative];

/** The options of a routed native that stay in the parent: the URL filesystem, the signal, streaming. */
interface NativeCallOptions {
	filesystem?: natives.ShellFilesystem | null;
	signal?: unknown;
	onMatches?: (matches: natives.GrepMatch[]) => void;
}

function abortSignal(signal: unknown): AbortSignal | undefined {
	return signal instanceof AbortSignal ? signal : undefined;
}

/** The filesystem work of one tool call, performed by a contained host. */
export class ContainedFileAccess {
	readonly #runtime: SandboxRuntime;
	readonly #scope: SandboxHostScope;
	/**
	 * The call's own host, for a caller without a session id (no pool owner would ever release it).
	 * Work the call started that outlives it (a timer, an unawaited promise) keeps its context: a
	 * pooled host stays the session's, so that work stays contained; a call's own host is retired by
	 * {@link release}, so that work's requests reject instead of running uncontained in omp.
	 */
	#ownHost: Promise<SandboxHostConnection> | undefined;

	constructor(runtime: SandboxRuntime, scope: SandboxHostScope) {
		this.#runtime = runtime;
		this.#scope = scope;
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

	/** Lets the call's own host exit; later requests of the call reject. Pooled hosts belong to their session. */
	release(): void {
		if (this.#scope.agentSessionKey !== undefined) return;
		// Never started: refuse any later request rather than start a host nobody would retire.
		this.#ownHost ??= Promise.reject(new Error("Sandbox file access ended with its tool call"));
		void this.#ownHost.then(
			connection => connection.retire(),
			() => {},
		);
	}

	/** Rejects with the syscall's errno (`code`), as the in-process call would. */
	async mutate(mutation: HostFileMutation): Promise<void> {
		if (mutation.kind !== "write") {
			await this.request({ op: "file.mutate", mutation });
			return;
		}
		const bytes = typeof mutation.data === "string" ? Buffer.from(mutation.data) : mutation.data;
		await this.request({
			op: "file.mutate",
			mutation: { kind: "write", path: mutation.path, data: bytes.subarray(0, WRITE_CHUNK_BYTES) },
		});
		for (let offset = WRITE_CHUNK_BYTES; offset < bytes.length; offset += WRITE_CHUNK_BYTES) {
			await this.request({
				op: "file.mutate",
				mutation: { kind: "append", path: mutation.path, data: bytes.subarray(offset, offset + WRITE_CHUNK_BYTES) },
			});
		}
	}

	/**
	 * `message` run in the host: `file.identify` opens a path in the container (rejecting with its
	 * errno), `dir.list` walks a workspace, `sqlite.read`/`sqlite.write` run the `read`/`write`
	 * tools' SQLite work whole there.
	 */
	async request<M extends Parameters<SandboxHostConnection["request"]>[0]>(message: M): Promise<HostResults[M["op"]]> {
		return (await this.#connection()).request(message);
	}

	/**
	 * A native search or rewrite run in the host: local paths natively there, URL paths through
	 * `options.filesystem`. `onMatches` streams; `onMatch` runs per returned match once the search
	 * ends. An applied `astEdit`'s `changes` is empty (see `HostResults["ast.edit"]`); a dry run keeps them.
	 */
	async native<Op extends NativeOp>(
		op: Op,
		options: NativeCallOptions,
		onMatch?: MatchCallback<unknown>,
	): Promise<HostResults[Op]> {
		const { filesystem, signal, onMatches, ...rest } = options;
		const message = {
			op,
			options: rest,
			fs: filesystem ? { nativeLocalPaths: filesystem.nativeLocalPaths } : null,
			stream: onMatches !== undefined,
		} as Omit<Extract<HostRequest, { op: "search.grep" }>, "id">;
		const result = (await (
			await this.#connection()
		).request(message, {
			filesystem: filesystem ?? undefined,
			onMatches,
			signal: abortSignal(signal),
		})) as HostResults[Op];
		if (onMatch && "matches" in result) for (const match of result.matches) onMatch(null, match);
		return result;
	}
}

const storage = new AsyncLocalStorage<ContainedFileAccess>();

/** The running tool call's contained file access; `undefined` when its file work runs in-process. */
export function containedFileAccess(): ContainedFileAccess | undefined {
	return storage.getStore();
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

/** The error for a read of `filePath`, which is not a regular file (a FIFO, device or directory). */
function notRegularFileError(filePath: string, isDirectory: boolean): NodeJS.ErrnoException {
	const code = isDirectory ? "EISDIR" : "EINVAL";
	return Object.assign(new Error(`${code}: ${filePath} is not a regular file`), { code, path: filePath });
}

/**
 * Opens `filePath` for reading. Contained, the host opens it first (the container decides: a
 * refusal rejects with its errno), then omp opens it without blocking and requires the same
 * regular file (device and file id); a file swapped in between rejects with `EACCES`, and a
 * FIFO, device or directory with `EINVAL`/`EISDIR`. Read every byte through the returned handle,
 * never by path again.
 */
export async function openReadableFile(filePath: string): Promise<fs.FileHandle> {
	const contained = containedFileAccess();
	if (!contained) return fs.open(filePath, "r");
	const expected = await contained.request({ op: "file.identify", path: filePath });
	const handle = await fs.open(filePath, OPEN_READ_NONBLOCK);
	try {
		const actual = await handle.stat({ bigint: true });
		if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
			throw Object.assign(new Error(`EACCES: ${filePath} changed while the sandbox checked it`), {
				code: "EACCES",
				path: filePath,
			});
		}
		if (!actual.isFile()) throw notRegularFileError(filePath, actual.isDirectory());
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

/** `peekFile(filePath, maxBytes, op)`; contained, the header is read through {@link openReadableFile}. */
export async function peekReadableFile<T>(
	filePath: string,
	maxBytes: number,
	op: (header: Uint8Array) => T,
): Promise<T> {
	if (!containedFileAccess()) return peekFile(filePath, maxBytes, op);
	return withReadableFile(filePath, async handle => {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return op(buffer.subarray(0, bytesRead));
	});
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

/** Largest file `EditStore.recordSnapshotFile` records (its native cap). */
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;

/**
 * `store.recordSnapshotFile`, reading through {@link openReadableFile} when the running call is
 * contained (the native method reads by path in omp). Same contract: `null` for an unreadable
 * (a FIFO, device or directory included), non-UTF-8 or over-4-MiB file.
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
export async function openReadableByteSource(filePath: string) {
	const handle = await openReadableFile(filePath);
	try {
		const { size } = await handle.stat();
		return { source: handleByteSource(handle, size), close: () => handle.close() };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/**
 * A private copy named `name` of `filePath`'s bytes, read through {@link openReadableFile}, in a
 * temp dir of its own: the path a program that opens files itself (jq, Chromium, an old ffmpeg)
 * may open. Disposing it removes the copy; a failed copy is removed before this rejects.
 */
export async function openReadableCopy(filePath: string, name: string): Promise<{ path: string } & AsyncDisposable> {
	const dir = await TempDir.create("@omp-readable-copy-");
	const copy = dir.join(name);
	try {
		await copyReadableFile(filePath, copy);
	} catch (error) {
		await dir[Symbol.asyncDispose]();
		throw error;
	}
	return { path: copy, [Symbol.asyncDispose]: () => dir[Symbol.asyncDispose]() };
}

/**
 * `fn` over a path that a program opening files itself (jq, Chromium, an old ffmpeg) may open:
 * `filePath` when nothing is contained; contained, an {@link openReadableCopy} of it (the
 * container never decided the program's own open), removed afterwards.
 */
export async function withReadableCopy<T>(
	filePath: string,
	name: string,
	fn: (path: string) => Promise<T>,
): Promise<T> {
	if (!containedFileAccess()) return fn(filePath);
	await using copy = await openReadableCopy(filePath, name);
	return await fn(copy.path);
}

/** `natives[name]`, run in the contained host when the running call is contained. */
function routed<K extends RoutedNative>(name: K): (typeof natives)[K] {
	type Call = (options: NativeCallOptions, onMatch?: MatchCallback<unknown>) => Promise<unknown>;
	const call: Call = (options, onMatch) => {
		const contained = containedFileAccess();
		return contained
			? contained.native(NATIVE_OPS[name], options, onMatch)
			: (natives[name] as Call)(options, onMatch);
	};
	return call as (typeof natives)[K];
}

export const containedGrep = routed("grep");
export const containedGlob = routed("glob");
export const containedAstGrep = routed("astGrep");
/** `natives.astEdit` (preview or apply). */
export const containedAstEdit = routed("astEdit");

/** `natives.listWorkspace`, in the contained host when the running call is contained. */
export function containedListWorkspace(options: natives.ListWorkspaceOptions): Promise<natives.ListWorkspaceResult> {
	const contained = containedFileAccess();
	return contained ? contained.request({ op: "dir.list", options }) : natives.listWorkspace(options);
}

/** Who a contained call acts for: a tool session, or a bare workspace (a language server's edit). */
export type ContainedFileAccessOwner = ToolSession | { cwd: string };

function isToolSession(owner: ContainedFileAccessOwner): owner is ToolSession {
	return "getSessionId" in owner || "getArtifactsDir" in owner;
}

/** Options of {@link containingSandbox}. */
interface ContainingSandboxOptions {
	/** The settings that enable the sandbox; the process settings when omitted. */
	settings?: Settings;
	/** `false`: report no runtime instead of throwing when `fallback: block` has no backend. Default `true`. */
	throwWhenBlocked?: boolean;
}

/**
 * The runtime that contains omp's own file work for `cwd`, or `undefined` when the sandbox is off or
 * has no backend under `fallback: warn`; under `fallback: block` without a backend it throws
 * `SandboxUnavailableError`, as contained commands do, unless `throwWhenBlocked` is `false`.
 */
export async function containingSandbox(
	cwd: string,
	{ settings, throwWhenBlocked = true }: ContainingSandboxOptions = {},
): Promise<SandboxRuntime | undefined> {
	const effective = settings ?? (await SandboxRuntime.settings());
	if (!effective || !sandboxEnabled(effective)) return undefined;
	const runtime = await SandboxRuntime.for(cwd);
	const status = runtime.status();
	if (throwWhenBlocked && status.state === "unavailable" && status.fallback === "block") {
		throw new SandboxUnavailableError(status.reason);
	}
	return status.state === "active" ? runtime : undefined;
}

/**
 * Runs `fn` with `owner`'s file access contained when the OS sandbox is active for its workspace.
 * With the sandbox off, or no backend under `fallback: warn`, runs it as is; with no backend under
 * `fallback: block`, throws `SandboxUnavailableError`, as contained commands do. Inside a call that
 * is already contained, `fn` joins that call's host instead of starting another.
 */
export async function withContainedFileAccess<T>(owner: ContainedFileAccessOwner, fn: () => Promise<T>): Promise<T> {
	if (storage.getStore()) return fn();
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

type Execute = (...args: never[]) => Promise<AgentToolResult<unknown>>;

/**
 * Runs every `execute` of a file tool class with its session's file access contained
 * ({@link withContainedFileAccess}), however the tool is constructed or called. Call it from the
 * class's static block, where a private `session` is reachable.
 */
export function containToolExecute<T extends { execute: Execute }>(
	tool: { prototype: T },
	session: (tool: T) => ToolSession,
): void {
	const execute = tool.prototype.execute;
	tool.prototype.execute = function (this: T, ...args: never[]) {
		return withContainedFileAccess(session(this), () => execute.apply(this, args));
	} as T["execute"];
}
