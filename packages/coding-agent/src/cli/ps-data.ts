/**
 * Data layer shared by the `omp ps` renderers (plain CLI and interactive TUI):
 * the single daemon's board.
 *
 * Listing never spawns the daemon: a running one is asked for its units over
 * a non-spawning probe connection; otherwise the units are read from the
 * daemon's sqlite store, and every live row that could not have outlived the
 * daemon is shown as exited.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import type { DaemonClient, UnitSnapshot } from "../daemon/protocol";
import { canonicalProjectDir, daemonDbPath } from "../daemon/paths";
import { readStoredUnits } from "../daemon/store";
import { groupUnits, type PsBoard, type PsTarget, TERMINAL_STATES, unitName } from "@oh-my-pi/pi-tui/apps/ps-data";

/** Hard SIGTERM->SIGKILL grace used by `kill`; effectively immediate. */
export const KILL_GRACE_MS = 100;

/** Canonical directory of the targeted project. */
export function targetProjectDir(target: PsTarget): Promise<string> {
	return canonicalProjectDir(target.dir ?? getProjectDir());
}

/** Default view: global units and the targeted project's; `all` keeps every scope. */
function inView(unit: UnitSnapshot, all: boolean, projectDir: string): boolean {
	if (all || unit.scope.kind === "global") return true;
	return unit.scope.kind === "project" && unit.scope.dir === projectDir;
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
 * Units persisted by a daemon that is no longer running. Only detached units
 * whose main process is still alive survive the daemon; everything else it
 * took down with it.
 */
export async function readOfflineUnits(): Promise<UnitSnapshot[]> {
	const stored = readStoredUnits(daemonDbPath());
	return stored.map(({ snapshot: unit }) => {
		if (TERMINAL_STATES[unit.state]) return { ...unit, supervised: false };
		const survivor = unit.policy.survive === "detached" && unit.state !== "stopping" && processAlive(unit.pids[0]);
		if (survivor) return { ...unit, supervised: false, leases: 0, idleAt: undefined };
		return {
			...unit,
			state: "exited",
			exitReason: unit.exitReason ?? "daemon exited",
			supervised: false,
			leases: 0,
			idleAt: undefined,
		};
	});
}

/**
 * Collect the board selected by `all`/`target` from `client`, or from the
 * store when no daemon answers (`client` undefined).
 */
export async function collectBoard(client: DaemonClient | undefined, all: boolean, target: PsTarget): Promise<PsBoard> {
	const projectDir = await targetProjectDir(target);
	const units = client ? (await client.request({ op: "list" })).units : await readOfflineUnits();
	return {
		daemon: client?.welcome.daemon,
		reports: groupUnits(units.filter(unit => inView(unit, all, projectDir))),
	};
}

/**
 * Resolve a user-typed unit reference: an exact unit id, else a unit whose
 * key or label matches, preferring the targeted project and global scope.
 */
export async function resolveUnit(client: DaemonClient, name: string, target: PsTarget): Promise<UnitSnapshot> {
	const { units } = await client.request({ op: "list" });
	const byId = units.find(unit => unit.id === name);
	if (byId) return byId;
	const matches = units.filter(unit => unit.key === name || unitName(unit) === name);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) throw new Error(`No unit named ${name}. Run \`omp ps --all\` to list units.`);
	const projectDir = await targetProjectDir(target);
	const preferred = matches.filter(unit => inView(unit, false, projectDir));
	if (preferred.length === 1) return preferred[0];
	throw new Error(
		`${name} is ambiguous; use a unit id: ${matches.map(unit => `${unit.id} (${unit.kind}, ${unit.scope.kind})`).join(", ")}`,
	);
}
