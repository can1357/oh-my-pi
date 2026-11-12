/**
 * IDA under the OS sandbox. The Python worker is where a database is opened and saved and where
 * `exec` runs agent code, so while the sandbox is active it runs inside the container, like any
 * contained command. Only the process that owns the session's `SandboxRuntime` (policy, grants)
 * can spawn it, which is why a contained database is hosted in the omp process (`client.ts`)
 * instead of the broker-supervised daemon.
 */
import * as path from "node:path";
import { pythonReadRoots } from "../eval/py/runtime";
import { containedEnv } from "../sandbox/env";
import type { SandboxRuntime, SandboxSpawnRequest } from "../sandbox/runtime";
import type { IdaRuntime } from "./runtime";
import type { IdbLocation } from "./store";
import type { IdaWorkerSpawner } from "./supervisor";

/**
 * The contained spawn of the worker for `loc`: `worker.py` (staged at `script`), the interpreter's
 * roots, the IDA install (`IDADIR`) and user directories (`IDAUSR`) are readable; a store database's
 * directory is writable. An in-place `.i64` is writable only if the sandbox policy lets the
 * workspace write there, so IDA's open and save fail when it does not.
 */
export async function containedIdaSpawnRequest(
	loc: IdbLocation,
	runtime: IdaRuntime,
	script: string,
): Promise<SandboxSpawnRequest> {
	const extraRead = await pythonReadRoots({ ...runtime, venvPath: runtime.env.VIRTUAL_ENV }, script);
	if (runtime.env.IDADIR) extraRead.push(runtime.env.IDADIR);
	if (runtime.env.IDAUSR) extraRead.push(...runtime.env.IDAUSR.split(path.delimiter).filter(Boolean));
	return {
		argv: [runtime.pythonPath, "-u", script],
		cwd: loc.dir,
		// The sandbox wrapper cannot be sent SIGINT, so the worker takes interrupts as stdin frames.
		env: containedEnv(runtime.env, { OMP_IDA_FRAME_INTERRUPTS: "1" }),
		extraRead,
		extraWrite: loc.kind === "store" ? [loc.dir] : undefined,
	};
}

/** Spawner that starts the worker inside `sandbox`'s container. */
export function containedIdaWorkerSpawner(sandbox: SandboxRuntime): IdaWorkerSpawner {
	return async (loc, runtime, script) => {
		const proc = await sandbox.spawn(await containedIdaSpawnRequest(loc, runtime, script));
		return { proc, interrupt: "frame" };
	};
}
