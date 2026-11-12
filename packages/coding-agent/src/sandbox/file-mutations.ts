/**
 * Contained file mutations. While the OS sandbox is active, the destructive in-process file tools
 * (`write`, `edit`, `ast_edit`) hand their writes, deletes, renames, mode changes and directory
 * creation to a sandbox host, so the container decides each syscall where it happens instead of
 * omp deciding from a path check made beforehand. An applied `ast_edit` and a SQLite row write
 * run whole in the host, their reads included; every other read stays in omp.
 *
 * A session's host is pooled under the `files:` namespace, apart from the hosts that run its
 * shells (a different scope would retire those), and `releaseShellSessions` retires it with them.
 * A session without an id gets a host of its own for the call, retired when the call ends.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AstReplaceOptions, AstReplaceResult } from "@oh-my-pi/pi-natives";
import { Settings } from "../config/settings";
import { sessionSandboxWritableRoots } from "../internal-urls/context";
import type { ToolSession } from "../tools";
import { applyFileMutation } from "./file-mutation-ops";
import type { HostFileMutation, HostSqliteWrite } from "./host-protocol";
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

/** The mutations of one tool call, performed by a contained host. */
export class ContainedFileMutations {
	readonly #runtime: SandboxRuntime;
	readonly #scope: SandboxHostScope;
	/** The call's own host, for a session without an id (no pool owner would ever release it). */
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

	/** Lets the call's own host exit; pooled hosts belong to their session. */
	release(): void {
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

	/**
	 * `astEdit` run in the host: local paths natively there, URL paths through `options.filesystem`.
	 * The result's `changes` is empty (see `HostResults["ast.edit"]`). The signal does not cross the
	 * protocol; the one caller (a `resolve`d apply) passes none.
	 */
	async astEdit(options: AstReplaceOptions): Promise<AstReplaceResult> {
		const { filesystem, signal: _signal, ...rest } = options;
		return (await this.#connection()).request(
			{ op: "ast.edit", options: rest, fs: filesystem ? { nativeLocalPaths: filesystem.nativeLocalPaths } : null },
			filesystem ? { filesystem } : undefined,
		);
	}

	/** The `write` tool's SQLite row write, run in the host; resolves to its result line. */
	async sqliteWrite(write: HostSqliteWrite): Promise<string> {
		return (await this.#connection()).request({ op: "sqlite.write", write });
	}
}

const storage = new AsyncLocalStorage<ContainedFileMutations>();

/** The running tool call's contained mutations; `undefined` when its file writes run in-process. */
export function containedFileMutations(): ContainedFileMutations | undefined {
	return storage.getStore();
}

/** Performs `mutation` in the contained host when the running tool call is contained, else here. */
export async function mutateFile(mutation: HostFileMutation): Promise<void> {
	const contained = storage.getStore();
	if (contained) await contained.mutate(mutation);
	else await applyFileMutation(mutation);
}

/**
 * Runs `fn` with `session`'s file mutations contained when the OS sandbox is active for its
 * workspace. With the sandbox off, or no backend under `fallback: warn`, runs it as is; with no
 * backend under `fallback: block`, throws `SandboxUnavailableError`, as contained commands do.
 */
export async function withContainedFileMutations<T>(session: ToolSession, fn: () => Promise<T>): Promise<T> {
	if (!sandboxEnabled(await Settings.init())) return fn();
	const runtime = await SandboxRuntime.for(session.cwd);
	const status = runtime.status();
	if (status.state === "unavailable" && status.fallback === "block") throw new SandboxUnavailableError(status.reason);
	if (status.state !== "active") return fn();
	const sessionId = session.getSessionId?.() ?? undefined;
	const mutations = new ContainedFileMutations(runtime, {
		agentSessionKey: sessionId ? `files:${sessionId}` : undefined,
		cwd: session.cwd,
		// The session's `local://` root (and any other sandbox-scope URL root): omp-owned, writable in
		// every sandbox mode.
		extraWrite: sessionSandboxWritableRoots(session),
	});
	try {
		return await storage.run(mutations, fn);
	} finally {
		mutations.release();
	}
}
