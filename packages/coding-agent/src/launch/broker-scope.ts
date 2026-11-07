/**
 * Moves a dedicated daemon broker process into a transient systemd user scope
 * of its own, so that no omp session owns its lifetime.
 *
 * The broker serves every omp process in its scope and is the parent of their
 * services. It is spawned `detached` (its own session and process group), so a
 * hang-up or signal to the omp process that started it never reaches it. Under
 * systemd that is not enough: a child stays in its parent's cgroup, and
 * whatever ends that cgroup kills every process in it — a terminal's, tmux's
 * or launcher's per-session scope being stopped, `systemd-oomd`, a session
 * memory ceiling's OOM handling, logind ending the login session. The broker
 * and every other session's services went with it, and they all counted
 * against the starting session's memory limit.
 *
 * The broker moves itself instead of being started inside a scope
 * (`systemd-run --scope`) because the user manager can be slow: under heavy
 * load its bus calls time out after 25 s. Starting inside a scope would make
 * every client wait for the manager before any broker exists, and a manager
 * that failed once would leave the broker in the starting session's cgroup for
 * its whole life. Moving itself, the broker serves at once and keeps retrying
 * until the manager answers; daemons it started meanwhile move with it.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/** Unit name prefix of the transient scopes brokers move into. */
export const BROKER_SCOPE_UNIT_PREFIX = "omp-daemon-broker-";
/** Per-call bus timeout handed to `busctl`, in seconds. */
const BUS_CALL_TIMEOUT_S = 25;
/** How long a queued scope job may take to move the broker before the attempt counts as failed. */
const MOVE_SETTLE_MS = 10_000;
const MOVE_POLL_MS = 50;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 300_000;

/**
 * The `busctl` command prefix that calls the systemd user manager, or
 * undefined where none can be reached: not Linux, no user bus socket, or no
 * `busctl` on `PATH`.
 */
export function userManagerBusctl(
	env: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform = process.platform,
): string[] | undefined {
	if (platform !== "linux") return undefined;
	if (!env.DBUS_SESSION_BUS_ADDRESS && !(env.XDG_RUNTIME_DIR && fs.existsSync(path.join(env.XDG_RUNTIME_DIR, "bus"))))
		return undefined;
	const busctl = Bun.which("busctl", { PATH: env.PATH ?? "" });
	if (!busctl) return undefined;
	return [
		busctl,
		"--user",
		`--timeout=${BUS_CALL_TIMEOUT_S}`,
		"call",
		"org.freedesktop.systemd1",
		"/org/freedesktop/systemd1",
		"org.freedesktop.systemd1.Manager",
	];
}

/** `StartTransientUnit` arguments for a scope holding `pid`. */
export function startScopeArgs(unit: string, pid: number, oomPolicy: boolean): string[] {
	const properties = [
		["PIDs", "au", "1", String(pid)],
		["Description", "s", "omp daemon broker"],
		["CollectMode", "s", "inactive-or-failed"],
		// The user manager refuses AttachProcessesToUnit, which moves daemons
		// the broker started before it moved, on a scope that is not delegated.
		["Delegate", "b", "true"],
		// One daemon's OOM kill must not stop the scope, and with it every
		// other session's daemons; systemd's default for a scope is `stop`.
		...(oomPolicy ? [["OOMPolicy", "s", "continue"]] : []),
	];
	return [
		"StartTransientUnit",
		"ssa(sv)a(sa(sv))",
		unit,
		"fail",
		String(properties.length),
		...properties.flat(),
		"0",
	];
}

interface BusResult {
	ok: boolean;
	error: string;
}

async function busCall(prefix: readonly string[], args: readonly string[], signal: AbortSignal): Promise<BusResult> {
	if (signal.aborted) return { ok: false, error: "aborted" };
	const child = Bun.spawn([...prefix, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	// Never leave a call waiting on a stalled manager behind the broker.
	const kill = (): void => child.kill("SIGKILL");
	signal.addEventListener("abort", kill, { once: true });
	try {
		const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		return { ok: code === 0, error: error.trim() || `busctl exited with ${code}` };
	} finally {
		signal.removeEventListener("abort", kill);
	}
}

/** The cgroup v2 path of `pid`, or undefined when it is gone. */
export async function cgroupOf(pid: number): Promise<string | undefined> {
	try {
		const text = await fsp.readFile(`/proc/${pid}/cgroup`, "utf8");
		for (const line of text.split("\n")) if (line.startsWith("0::")) return line.slice(3).trim();
	} catch {
		// Gone.
	}
	return undefined;
}

interface ProcEntry {
	ppid: number;
	sid: number;
}

/** Parent and session of every process, from `/proc/<pid>/stat`. */
async function processTable(): Promise<Map<number, ProcEntry>> {
	const table = new Map<number, ProcEntry>();
	for (const entry of await fsp.readdir("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		let stat: string;
		try {
			stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
		} catch {
			continue;
		}
		// `pid (comm) state ppid pgrp session ...`; comm may hold spaces,
		// parentheses and newlines, so read the fields after the last `)`.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		table.set(pid, { ppid: Number(fields[1]), sid: Number(fields[3]) });
	}
	return table;
}

/**
 * This broker's processes still in a cgroup it has left: its descendants, and
 * any process in its session or in the session of one of its children (a
 * service started detached leads its own session). The session test finds a
 * service's worker that was reparented when its parent exited.
 */
export async function leftBehind(self: number, left: ReadonlySet<string>): Promise<number[]> {
	const table = await processTable();
	const children = new Map<number, number[]>();
	for (const [pid, { ppid }] of table) {
		const siblings = children.get(ppid);
		if (siblings) siblings.push(pid);
		else children.set(ppid, [pid]);
	}
	const ours = new Set<number>();
	const stack = [...(children.get(self) ?? [])];
	while (stack.length > 0) {
		const pid = stack.pop() as number;
		ours.add(pid);
		stack.push(...(children.get(pid) ?? []));
	}
	const sessions = new Set([self, ...(children.get(self) ?? [])]);
	for (const [pid, { sid }] of table) if (pid !== self && sessions.has(sid)) ours.add(pid);
	const found: number[] = [];
	for (const pid of ours) {
		const cgroup = await cgroupOf(pid);
		if (cgroup !== undefined && left.has(cgroup)) found.push(pid);
	}
	return found;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = (): void => {
		clearTimeout(timer);
		signal.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	signal.addEventListener("abort", done, { once: true });
	return promise;
}

/** Ask the manager to start `unit` holding this process, and wait until the process is in it. */
async function moveSelf(
	prefix: readonly string[],
	unit: string,
	oomPolicy: boolean,
	signal: AbortSignal,
): Promise<BusResult> {
	const started = await busCall(prefix, startScopeArgs(unit, process.pid, oomPolicy), signal);
	if (!started.ok) return started;
	const deadline = Date.now() + MOVE_SETTLE_MS;
	while (!(await cgroupOf(process.pid))?.endsWith(`/${unit}`)) {
		if (signal.aborted) return { ok: false, error: "aborted" };
		if (Date.now() >= deadline) return { ok: false, error: `the ${unit} job did not move the broker` };
		await sleepUnlessAborted(MOVE_POLL_MS, signal);
	}
	return started;
}

/**
 * Move one left-behind process into the broker's scope: through the manager
 * first, then by writing the scope's delegated `cgroup.procs` directly, which
 * also works for a process the manager refuses (systemd cannot read the stat
 * of a process whose name holds a newline).
 */
async function attach(
	prefix: readonly string[],
	unit: string,
	cgroup: string,
	pid: number,
	signal: AbortSignal,
): Promise<BusResult> {
	const viaManager = await busCall(prefix, ["AttachProcessesToUnit", "ssau", unit, "", "1", String(pid)], signal);
	if (viaManager.ok) return viaManager;
	try {
		await fsp.writeFile(path.join("/sys/fs/cgroup", cgroup, "cgroup.procs"), String(pid));
		return { ok: true, error: "" };
	} catch (error) {
		return {
			ok: false,
			error: `${viaManager.error}; cgroup.procs: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Move this process — a dedicated broker that holds its scope's lease — into a
 * fresh transient systemd user scope, then move every process of its own that
 * is still in a cgroup it has left ({@link leftBehind}). Both steps retry with
 * backoff until they finish or `signal` aborts. Every cgroup the broker was in
 * when an attempt began counts as left, so a move whose reply was lost (the
 * broker landed in an earlier attempt's scope) still reconciles its daemons.
 * Undefined where no user manager can be reached; the broker then stays where
 * it started, as on other platforms.
 */
export function moveBrokerIntoOwnScope(signal: AbortSignal): Promise<void> | undefined {
	const prefix = userManagerBusctl(process.env);
	if (!prefix) return undefined;
	return (async () => {
		const left = new Set<string>();
		let unit: string | undefined;
		let oomPolicy = true;
		let delay = RETRY_BASE_MS;
		let warned = false;
		const retryLater = async (message: string, error: string): Promise<void> => {
			(warned ? logger.debug : logger.warn)(message, { error, retryInMs: delay });
			warned = true;
			await sleepUnlessAborted(delay, signal);
			delay = Math.min(delay * 2, RETRY_MAX_MS);
		};
		while (!signal.aborted && unit === undefined) {
			const current = await cgroupOf(process.pid);
			if (current !== undefined) left.add(current);
			const candidate = `${BROKER_SCOPE_UNIT_PREFIX}${process.pid}-${crypto.randomUUID().slice(0, 8)}.scope`;
			const result = await moveSelf(prefix, candidate, oomPolicy, signal);
			if (result.ok) {
				unit = candidate;
				break;
			}
			if (signal.aborted) return;
			// systemd before 253 cannot set OOMPolicy on a scope.
			if (oomPolicy && result.error.includes("OOMPolicy")) {
				oomPolicy = false;
				continue;
			}
			await retryLater("Daemon broker could not move into a systemd scope of its own; retrying", result.error);
		}
		if (unit === undefined) return;
		delay = RETRY_BASE_MS;
		warned = false;
		// Daemons started before the move stayed behind, and a process forked
		// there while this runs lands there too: sweep until none is left. The
		// broker's own cgroup is read every round, because a scope request whose
		// reply was lost can still be carried out after a later one.
		while (!signal.aborted) {
			const target = await cgroupOf(process.pid);
			if (target === undefined) return;
			left.delete(target);
			const stragglers = await leftBehind(process.pid, left);
			if (stragglers.length === 0) {
				logger.debug("Daemon broker moved into a systemd scope of its own", { cgroup: target });
				return;
			}
			const errors: string[] = [];
			for (const pid of stragglers) {
				const attached = await attach(prefix, path.basename(target), target, pid, signal);
				if (!attached.ok) errors.push(`${pid}: ${attached.error}`);
			}
			left.add(target);
			if (errors.length > 0)
				await retryLater("Daemon broker could not move its daemons into its scope; retrying", errors.join("\n"));
		}
	})();
}
