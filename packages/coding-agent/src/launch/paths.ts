import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getDaemonRuntimeDir, hasFsCode, isEacces, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** File in a broker runtime dir recording which project (or global service dir) owns the scope. */
const SCOPE_FILE = "scope.json";
/**
 * Small mutable lifecycle state (snapshot, completion bookkeeping) in
 * `<runtimeDir>/daemons/<name>/`. Rewritten on transitions, and only when its
 * serialized form changes.
 */
export const DAEMON_META_FILE = "meta.json";
/**
 * The launch spec, including its environment (often the whole parent env,
 * tens of KB). Written when the record is created or its mode changes, never
 * on lifecycle transitions. Older brokers embedded it in `meta.json`; readers
 * still accept that layout and broker recovery migrates it.
 */
export const DAEMON_SPEC_FILE = "spec.json";
/** Connect budget for the endpoint probe that answers "is a broker serving this scope?". */
const ENDPOINT_PROBE_TIMEOUT_MS = 250;

/**
 * Canonicalize a project directory the same way every broker client does, so
 * hash-keyed runtime dirs and Windows pipe names agree across processes.
 * Missing paths and permission-denied lookups (EPERM/EACCES on protected
 * parent directories) resolve without realpath instead of failing.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error) || isEacces(error) || hasFsCode(error, "EPERM")) return resolved;
		throw error;
	}
}

/**
 * Record the scope's canonical project directory inside its runtime dir.
 * Written by the broker at startup so out-of-process inspectors (`omp ps`)
 * can map a hash-keyed runtime dir back to its project.
 */
export async function writeDaemonScopeMeta(runtimeDir: string, projectDir: string): Promise<void> {
	await Bun.write(path.join(runtimeDir, SCOPE_FILE), JSON.stringify({ projectDir }));
}

/** Read the project directory recorded for a runtime dir; undefined when absent or malformed. */
export async function readDaemonScopeMeta(runtimeDir: string): Promise<string | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, SCOPE_FILE)).json();
		if (typeof raw === "object" && raw !== null && "projectDir" in raw && typeof raw.projectDir === "string") {
			return raw.projectDir;
		}
	} catch {
		// Missing or malformed scope metadata reads as unknown.
	}
	return undefined;
}

/** One daemon record dir as stored on disk, before parsing. */
export interface StoredDaemonRecord {
	/** Decoded `meta.json`. */
	meta: object & { daemon: unknown };
	/** Decoded launch spec, from `meta.json` (legacy layout) or `spec.json`. */
	spec: unknown;
	/** The spec was embedded in `meta.json` by an older broker. */
	legacyLayout: boolean;
}

/**
 * Read a daemon record dir in either layout. Undefined when `meta.json` has no
 * daemon snapshot; throws when a file is missing or malformed.
 */
export async function readStoredDaemonRecord(dir: string): Promise<StoredDaemonRecord | undefined> {
	const meta: unknown = await Bun.file(path.join(dir, DAEMON_META_FILE)).json();
	if (typeof meta !== "object" || meta === null || !("daemon" in meta)) return undefined;
	if ("spec" in meta) return { meta, spec: meta.spec, legacyLayout: true };
	const spec: unknown = await Bun.file(path.join(dir, DAEMON_SPEC_FILE)).json();
	return { meta, spec, legacyLayout: false };
}

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(runtimeDir: string): string {
	return ipcEndpoint(runtimeDir, "broker");
}

/**
 * What a connect to a scope endpoint says about its broker. `absent` (ENOENT):
 * no socket exists there, so nothing can serve the scope. `refused`
 * (ECONNREFUSED): normally nothing listens on the socket, but a live broker can
 * be refused too: between its bind and listen, or where a full accept queue is
 * reported this way (Bun's `node:net` does on Linux). `unknown`: any other
 * error (EACCES, say, or the EAGAIN this transport gets from a full accept
 * queue on Linux) or the timeout, after which the listener may still be alive.
 */
export type BrokerEndpointState = "live" | "absent" | "refused" | "unknown";

/**
 * Whether a broker is accepting connections on the scope endpoint right now
 * (see {@link BrokerEndpointState}). Unlike a recorded pid, this answers the
 * same in every PID namespace that shares the runtime directory.
 */
export async function probeBrokerEndpoint(endpoint: string): Promise<BrokerEndpointState> {
	try {
		const connection = await IpcConnection.connect(endpoint, {
			framing: "lines",
			timeoutMs: ENDPOINT_PROBE_TIMEOUT_MS,
		});
		connection.destroy();
		return "live";
	} catch (error) {
		if (hasFsCode(error, "ENOENT")) return "absent";
		if (hasFsCode(error, "ECONNREFUSED")) return "refused";
		return "unknown";
	}
}
