/**
 * Disassembler workers under the OS sandbox. The Python worker is where a database is opened and
 * saved and where `exec` runs agent code, so while the sandbox is active it runs inside the
 * container, like any contained command. Only the process that owns the session's
 * `SandboxRuntime` (policy, grants) can spawn it, which is why a contained database is hosted in the
 * omp process (`client.ts`) instead of the shared daemon's `disasm` module.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "../tools/tool-errors";
import { getAgentDir, settleWithin } from "@oh-my-pi/pi-utils";
import { pythonReadRoots } from "../eval/py/runtime";
import { containedEnv } from "../sandbox/env";
import type { SandboxRuntime, SandboxSpawnRequest } from "../sandbox/runtime";
import { StderrTail } from "../subprocess/worker-client";
import { WORKER_OUTPUT_TAIL_BYTES, type WorkerSpawner, type WorkerSpawnSpec } from "./supervisor";

/** How long a contained worker's exit waits for the rest of its output to reach the kept tail. */
const OUTPUT_DRAIN_MS = 1_000;

/** The backend install roots named in a worker runtime's environment: IDA's, or Ghidra's and its JDK. */
function installReadRoots(env: Record<string, string>): string[] {
	const roots: string[] = [];
	for (const name of ["IDADIR", "GHIDRA_INSTALL_DIR", "JAVA_HOME"]) {
		const value = env[name];
		if (value) roots.push(value);
	}
	if (env.IDAUSR) roots.push(...env.IDAUSR.split(path.delimiter).filter(Boolean));
	return roots;
}

/**
 * A fresh directory for one contained worker's socket (Windows: port file), made by omp outside
 * every root contained processes may write, their private temp dir included: only that worker, whose
 * spawn request alone grants it, can create, rename or replace entries there, so no other contained
 * process can stand in for it and receive its connection token. The caller removes it.
 */
export async function workerEndpointDir(sandbox: SandboxRuntime): Promise<string> {
	for (const parent of [os.tmpdir(), getAgentDir()]) {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(parent, "omp-dsm-")));
		if (sandbox.accessDenial([{ kind: "write", target: dir }])) return dir;
		await fs.rm(dir, { recursive: true, force: true });
	}
	throw new ToolError(
		`Contained commands may write both ${os.tmpdir()} and ${getAgentDir()}; the disassembler worker needs a directory they cannot write for its socket`,
	);
}

/**
 * The contained spawn of the worker for `spec`: the staged worker script, the interpreter's roots
 * and the backend install are readable; its endpoint's directory ({@link workerEndpointDir}) and a
 * store database's directory are writable. An in-place database is writable only if the sandbox
 * policy lets the workspace write there, so its open and save fail when it does not.
 */
export async function containedWorkerSpawnRequest({
	loc,
	runtime,
	script,
	args,
	endpoint,
	env,
}: WorkerSpawnSpec): Promise<SandboxSpawnRequest> {
	const extraRead = await pythonReadRoots({ ...runtime, venvPath: runtime.env.VIRTUAL_ENV }, script);
	extraRead.push(...installReadRoots(runtime.env));
	const extraWrite = [path.dirname(endpoint)];
	if (loc.kind === "store") extraWrite.push(loc.dir);
	return {
		argv: [runtime.pythonPath, "-u", script, ...args],
		cwd: loc.dir,
		env: containedEnv(env),
		extraRead,
		extraWrite,
	};
}

/**
 * Spawner that starts the worker inside `sandbox`'s container. The sandbox wrapper cannot be sent
 * SIGINT, so the worker takes interrupts as frames; it is killed through the sandbox (its whole tree).
 * Its output is kept in memory only: omp never re-opens a file by a path contained code can replace.
 */
export function containedWorkerSpawner(sandbox: SandboxRuntime): WorkerSpawner {
	return async spec => {
		const child = await sandbox.spawn(await containedWorkerSpawnRequest(spec));
		child.stdin.end();
		const output = new StderrTail(WORKER_OUTPUT_TAIL_BYTES);
		const drained = Promise.all(
			[child.stdout, child.stderr].map(async stream => {
				for await (const chunk of stream) output.append(chunk);
			}),
		).catch(() => undefined);
		return {
			pid: child.pid,
			// Never re-adopted: the worker lives and dies with this omp process.
			startedAt: null,
			// The exit error quotes the output tail: let the last output reach it first.
			exited: child.exited.then(async code => {
				await settleWithin(drained, OUTPUT_DRAIN_MS);
				return code;
			}),
			kill: () => child.kill(),
			interrupt: "frame",
			output: () => output.text(),
		};
	};
}
