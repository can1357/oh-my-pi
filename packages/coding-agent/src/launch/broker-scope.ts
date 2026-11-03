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
/** Rounds of moving descendants that were forked while an earlier round ran. */
const DESCENDANT_ROUNDS = 5;
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

/** Descendants of `root` that are still in `cgroup`. */
async function descendantsIn(root: number, cgroup: string): Promise<number[]> {
	const children = new Map<number, number[]>();
	for (const entry of await fsp.readdir("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		let stat: string;
		try {
			stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
		} catch {
			continue;
		}
		// `pid (comm) state ppid ...`; comm may hold spaces and parentheses.
		const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		const siblings = children.get(ppid);
		if (siblings) siblings.push(pid);
		else children.set(ppid, [pid]);
	}
	const found: number[] = [];
	const stack = [...(children.get(root) ?? [])];
	while (stack.length > 0) {
		const pid = stack.pop() as number;
		if ((await cgroupOf(pid)) === cgroup) found.push(pid);
		stack.push(...(children.get(pid) ?? []));
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

/** One attempt to move this process, and its descendants left in its old cgroup, into `unit`. */
async function moveOnce(
	prefix: readonly string[],
	unit: string,
	oomPolicy: boolean,
	signal: AbortSignal,
): Promise<BusResult> {
	const self = process.pid;
	const before = await cgroupOf(self);
	if (!before) return { ok: false, error: "cannot read /proc/self/cgroup" };
	const started = await busCall(prefix, startScopeArgs(unit, self, oomPolicy), signal);
	if (!started.ok) return started;
	const deadline = Date.now() + MOVE_SETTLE_MS;
	while (!(await cgroupOf(self))?.endsWith(`/${unit}`)) {
		if (signal.aborted) return { ok: false, error: "aborted" };
		if (Date.now() >= deadline) return { ok: false, error: `the ${unit} job did not move the broker` };
		await sleepUnlessAborted(MOVE_POLL_MS, signal);
	}
	// Daemons the broker started before the move stayed in the old cgroup. A
	// daemon forked during a round lands in the old cgroup too, so sweep again.
	for (let round = 0; round < DESCENDANT_ROUNDS; round++) {
		const left = await descendantsIn(self, before);
		if (left.length === 0) break;
		const attached = await busCall(
			prefix,
			["AttachProcessesToUnit", "ssau", unit, "", String(left.length), ...left.map(String)],
			signal,
		);
		if (!attached.ok)
			logger.debug("Daemon broker could not move a daemon into its scope", { unit, error: attached.error });
	}
	return { ok: true, error: "" };
}

/** A running move of the broker into its own scope; see {@link moveBrokerIntoOwnScope}. */
export interface BrokerScopeMove {
	/** Settles when the first attempt has succeeded or failed. */
	firstAttempt: Promise<void>;
	/** Settles when the broker has moved, or the signal stopped the retries. */
	done: Promise<void>;
}

/**
 * Move this process — a dedicated broker that holds its scope's lease — into a
 * fresh transient systemd user scope, retrying with backoff until the user
 * manager answers or `signal` aborts. Undefined where no user manager can be
 * reached; the broker then stays where it started, as on other platforms.
 */
export function moveBrokerIntoOwnScope(signal: AbortSignal): BrokerScopeMove | undefined {
	const prefix = userManagerBusctl(process.env);
	if (!prefix) return undefined;
	const first = Promise.withResolvers<void>();
	const done = (async () => {
		let oomPolicy = true;
		let delay = RETRY_BASE_MS;
		let warned = false;
		try {
			while (!signal.aborted) {
				const unit = `${BROKER_SCOPE_UNIT_PREFIX}${process.pid}-${crypto.randomUUID().slice(0, 8)}.scope`;
				const result = await moveOnce(prefix, unit, oomPolicy, signal);
				first.resolve();
				if (result.ok) {
					logger.debug("Daemon broker moved into a systemd scope of its own", { unit });
					return;
				}
				if (signal.aborted) return;
				// systemd before 253 cannot set OOMPolicy on a scope.
				if (oomPolicy && result.error.includes("OOMPolicy")) {
					oomPolicy = false;
					continue;
				}
				const log = warned ? logger.debug : logger.warn;
				log("Daemon broker could not move into a systemd scope of its own; retrying", {
					error: result.error,
					retryInMs: delay,
				});
				warned = true;
				await sleepUnlessAborted(delay, signal);
				delay = Math.min(delay * 2, RETRY_MAX_MS);
			}
		} finally {
			first.resolve();
		}
	})();
	return { firstAttempt: first.promise, done };
}
