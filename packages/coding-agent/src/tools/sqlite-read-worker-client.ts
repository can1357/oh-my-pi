import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { SQLITE_READ_WORKER_ARG } from "../cli/worker-selectors";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import type { ResolvedSqliteReadPath } from "./read-sqlite";
import { ToolAbortError, throwIfAborted, type WorkerErrorPayload } from "./tool-errors";

const SQLITE_READ_DEADLINE_MS = 30_000;

/** Request sent to the worker that owns the SQLite connection. */
export interface SqliteReadWorkerRequest {
	path: ResolvedSqliteReadPath;
}

/** Cloneable result or error returned after the isolated read completes. */
export type SqliteReadWorkerResponse =
	| { ok: true; result: AgentToolResult<ReadToolDetails> }
	| { ok: false; error: WorkerErrorPayload };

/** Run a SQLite read in a killable subprocess with an abortable wall-clock deadline. */
export async function readSqliteIsolated(
	path: ResolvedSqliteReadPath,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	throwIfAborted(signal);
	const spawned = createWorkerSubprocess<SqliteReadWorkerResponse>({
		spawnCommand: resolveWorkerSpawnCmd(SQLITE_READ_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "SQLite read subprocess",
		unref: false,
		reportCleanExit: true,
	});
	const worker = createWorkerHandle<SqliteReadWorkerRequest, SqliteReadWorkerResponse>(spawned, message =>
		safeSend(spawned.proc, message, "sqlite-read"),
	);
	const pending = Promise.withResolvers<AgentToolResult<ReadToolDetails>>();
	const offMessage = worker.onMessage(response => {
		if (response.ok) {
			pending.resolve(response.result);
			return;
		}
		const { error } = response;
		pending.reject(
			error.isAbort
				? new ToolAbortError(error.message)
				: error.isToolError
					? new ToolError(error.message)
					: new Error(error.message),
		);
	});
	const offError = worker.onError(pending.reject);
	const onAbort = (): void => pending.reject(new ToolAbortError());
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => pending.reject(new ToolError("SQLite read timed out after 30 seconds")),
		SQLITE_READ_DEADLINE_MS,
	);
	try {
		throwIfAborted(signal);
		worker.send({ path });
		return await pending.promise;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		offMessage();
		offError();
		await worker.terminate();
	}
}

/** Exercise SQLite worker routing in source, bundle, and compiled CLI distributions. */
export async function smokeTestSqliteReadWorker(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sqlite-worker-smoke-"));
	const filePath = path.join(dir, "smoke.sqlite");
	const db = new Database(":memory:");
	try {
		db.run("CREATE TABLE entries (id INTEGER PRIMARY KEY); INSERT INTO entries VALUES (1)");
		await Bun.write(filePath, db.serialize());
		const result = await readSqliteIsolated({ absolutePath: filePath, sqliteSubPath: "", queryString: "" });
		if (!result.content.some(block => block.type === "text" && block.text.includes("entries (1 rows)"))) {
			throw new Error("SQLite read worker smoke mismatch");
		}
	} finally {
		db.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}
