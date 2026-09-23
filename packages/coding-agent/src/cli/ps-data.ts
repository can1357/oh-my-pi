/**
 * Data layer shared by the `omp ps` renderers (plain CLI and interactive TUI):
 * broker-scope discovery and daemon snapshot collection.
 *
 * Collection never spawns a broker: live scopes are queried over the broker
 * socket, dead scopes are read from the persisted per-daemon `meta.json`
 * snapshots.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getDaemonRuntimeRoot,
	getGlobalDaemonRuntimeDir,
	getGlobalDaemonRuntimeRoot,
	getProjectDir,
	isEnoent,
} from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../launch/client";
import { canonicalProjectDir, daemonRuntimeDir, readDaemonScopeMeta } from "../launch/paths";
import { readLiveDaemonBrokerPid } from "../launch/presence";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/hub";
import {
	formatCommand,
	TERMINAL_STATES,
	type PsScope,
	type PsDaemonRow,
	type PsScopeReport,
	type PsTarget,
} from "@oh-my-pi/pi-tui/apps/ps-data";
import { parseDaemonSnapshot, parseDaemonSpec } from "../launch/protocol";

const PROJECT_SCOPE_KEY = /^[0-9a-f]{16}$/;
/** Hard SIGTERM->SIGKILL grace used by `kill`; effectively immediate. */
export const KILL_GRACE_MS = 100;

// ---------------------------------------------------------------------------
// Scope discovery
// ---------------------------------------------------------------------------

/** The single scope named by `target` (defaults to the current project). */
export async function targetScope(target: PsTarget): Promise<PsScope> {
	if (target.global) {
		const runtimeDir = await canonicalRuntimeDir(getGlobalDaemonRuntimeDir(target.global));
		return {
			kind: "global",
			runtimeDir,
			service: target.global,
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		};
	}
	const projectDir = await canonicalProjectDir(target.dir ?? getProjectDir());
	const runtimeDir = daemonRuntimeDir(projectDir);
	return { kind: "project", runtimeDir, projectDir, brokerPid: await readLiveDaemonBrokerPid(runtimeDir) };
}

async function canonicalRuntimeDir(dir: string): Promise<string> {
	try {
		return await fs.realpath(dir);
	} catch {
		return path.resolve(dir);
	}
}

/** Every scope on this machine: hash-keyed project scopes plus global service scopes. */
export async function discoverScopes(): Promise<PsScope[]> {
	const scopes: PsScope[] = [];
	for (const entry of await readdirQuiet(getDaemonRuntimeRoot())) {
		if (!entry.isDirectory() || !PROJECT_SCOPE_KEY.test(entry.name)) continue;
		const runtimeDir = path.join(getDaemonRuntimeRoot(), entry.name);
		scopes.push({
			kind: "project",
			runtimeDir,
			projectDir: await resolveScopeProjectDir(runtimeDir),
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		});
	}
	for (const entry of await readdirQuiet(getGlobalDaemonRuntimeRoot())) {
		if (!entry.isDirectory()) continue;
		const runtimeDir = await canonicalRuntimeDir(path.join(getGlobalDaemonRuntimeRoot(), entry.name));
		scopes.push({
			kind: "global",
			runtimeDir,
			service: entry.name,
			brokerPid: await readLiveDaemonBrokerPid(runtimeDir),
		});
	}
	return scopes;
}

async function readdirQuiet(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

/**
 * Map a hash-keyed project runtime dir back to its project directory:
 * broker-written `scope.json` first, then any registered client presence file
 * (covers brokers started before scope metadata existed).
 */
async function resolveScopeProjectDir(runtimeDir: string): Promise<string | undefined> {
	const recorded = await readDaemonScopeMeta(runtimeDir);
	if (recorded) return recorded;
	for (const entry of await readdirQuiet(path.join(runtimeDir, "clients"))) {
		try {
			const decoded: unknown = await Bun.file(path.join(runtimeDir, "clients", entry.name)).json();
			if (
				typeof decoded === "object" &&
				decoded !== null &&
				"projectDir" in decoded &&
				typeof decoded.projectDir === "string"
			) {
				return decoded.projectDir;
			}
		} catch {
			// Unreadable presence files are skipped; the scope stays unlabeled.
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Snapshot collection
// ---------------------------------------------------------------------------

/**
 * Connect to a scope's broker. Undefined when the scope cannot be addressed
 * (Windows pipe names derive from the project dir, which may be unknown for
 * discovered scopes). The caller owns the returned client and must close it.
 */
export async function scopeClient(scope: PsScope): Promise<DaemonBrokerClient | undefined> {
	const connectDir = scope.projectDir ?? (process.platform === "win32" ? undefined : scope.runtimeDir);
	if (connectDir === undefined) return undefined;
	return createDaemonBrokerClient(connectDir, { runtimeDir: scope.runtimeDir });
}

/** Persisted `{snapshot, spec}` pairs from `<runtimeDir>/daemons/<name>/meta.json`. */
async function readPersistedDaemons(
	runtimeDir: string,
): Promise<Map<string, { snapshot: DaemonSnapshot; spec: DaemonSpec }>> {
	const persisted = new Map<string, { snapshot: DaemonSnapshot; spec: DaemonSpec }>();
	const root = path.join(runtimeDir, "daemons");
	for (const entry of await readdirQuiet(root)) {
		if (!entry.isDirectory()) continue;
		try {
			const decoded: unknown = await Bun.file(path.join(root, entry.name, "meta.json")).json();
			if (typeof decoded !== "object" || decoded === null || !("daemon" in decoded) || !("spec" in decoded))
				continue;
			const snapshot = parseDaemonSnapshot(decoded.daemon);
			persisted.set(snapshot.name, { snapshot, spec: parseDaemonSpec(decoded.spec) });
		} catch {
			// Malformed or torn metadata is skipped; the broker rewrites it on next start.
		}
	}
	return persisted;
}

function processAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Collect daemons for one scope. Live brokers are authoritative; dead scopes
 * fall back to persisted snapshots, downgrading non-detached "running" records
 * to exited (their broker took them down with it) and flagging detached
 * survivors as unsupervised.
 */
export async function collectScope(scope: PsScope): Promise<PsScopeReport> {
	const persisted = await readPersistedDaemons(scope.runtimeDir);
	if (scope.brokerPid !== undefined) {
		try {
			const client = await scopeClient(scope);
			if (client) {
				try {
					if (scope.projectDir === undefined) {
						const ping = await client.request({ op: "ping" });
						if (ping.op === "ping") scope.projectDir = ping.projectDir;
					}
					const result = await client.request({ op: "list" });
					if (result.op !== "list") throw new Error(`Unexpected broker response ${result.op}`);
					return {
						scope,
						daemons: result.daemons.map(snapshot => ({
							snapshot,
							command: formatCommand(persisted.get(snapshot.name)?.spec),
							cwd: persisted.get(snapshot.name)?.spec.cwd,
							supervised: true,
						})),
					};
				} finally {
					client.close();
				}
			}
		} catch {
			// Broker died or refused mid-query; fall through to the offline view.
		}
	}
	const daemons: PsDaemonRow[] = [];
	for (const { snapshot, spec } of persisted.values()) {
		const row: PsDaemonRow = { snapshot, command: formatCommand(spec), cwd: spec.cwd, supervised: false };
		if (!TERMINAL_STATES[snapshot.state]) {
			const survivor = spec.detached && snapshot.state !== "stopping" && processAlive(snapshot.pid);
			if (!survivor) {
				// The broker died and took its non-detached children with it.
				row.snapshot = { ...snapshot, state: "exited", exitReason: snapshot.exitReason ?? "broker exited" };
			}
		}
		daemons.push(row);
	}
	daemons.sort(compareRows);
	return { scope, daemons };
}

function compareRows(a: PsDaemonRow, b: PsDaemonRow): number {
	const aTerminal = TERMINAL_STATES[a.snapshot.state] === true;
	const bTerminal = TERMINAL_STATES[b.snapshot.state] === true;
	if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
	return a.snapshot.name.localeCompare(b.snapshot.name);
}

/** Collect the scopes selected by `all`/`target`, hiding empty dead scopes in the all view. */
export async function collectReports(all: boolean, target: PsTarget): Promise<PsScopeReport[]> {
	const scopes = all ? await discoverScopes() : [await targetScope(target)];
	const reports = await Promise.all(scopes.map(collectScope));
	return reports.filter(report => !all || report.daemons.length > 0 || report.scope.brokerPid !== undefined);
}
