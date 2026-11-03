/**
 * How a daemon broker is started so that it lives independently of the omp
 * session that happened to need it first.
 *
 * The broker serves every omp process in its scope and is the parent of their
 * services, so no one session may own its lifetime. `detached` already gives it
 * a session and process group of its own: a hang-up or process-group signal to
 * the starting session never reaches it, and it outlives that process. Under
 * systemd that is not enough, because a child stays in its parent's cgroup, and
 * whatever ends that cgroup kills every process in it: a terminal's, tmux's or
 * launcher's per-session scope being stopped, `systemd-oomd`, a session memory
 * ceiling's OOM handling, logind ending the login session. The broker and every
 * other session's services went with it, and the broker counted against the
 * starting session's memory limit.
 *
 * So on Linux, when a systemd user manager is reachable, the broker starts
 * through `systemd-run --user --scope` in a transient scope of its own, which
 * its daemons inherit. `systemd-run --scope` execs the broker in place, so it
 * keeps this process's environment, working directory and stdio. When the
 * scope cannot be made (no user manager, an old systemd, a bus timeout) the
 * caller falls back to a plain detached spawn.
 */
import * as fs from "node:fs/promises";

/** Unit name prefix of the transient scopes brokers run in. */
export const BROKER_SCOPE_UNIT_PREFIX = "omp-daemon-broker-";

/**
 * How long `systemd-run` may take to create the scope before the client stops
 * waiting for it and starts the broker without one. A healthy user manager
 * answers in milliseconds; under heavy load its bus calls can stall until the
 * 25-second D-Bus timeout.
 */
export const BROKER_SCOPE_LAUNCH_GRACE_MS = 5_000;

/**
 * The command that starts `command` in a transient systemd user scope of its
 * own, or undefined when no user manager can be asked: not Linux, no
 * `XDG_RUNTIME_DIR` (the user manager's sockets live there), or no
 * `systemd-run` on `PATH`.
 */
export function brokerScopeCommand(
	command: readonly string[],
	env: Readonly<Record<string, string>>,
	platform: NodeJS.Platform = process.platform,
): string[] | undefined {
	if (platform !== "linux" || !env.XDG_RUNTIME_DIR) return undefined;
	const systemdRun = Bun.which("systemd-run", { PATH: env.PATH ?? "" });
	if (!systemdRun) return undefined;
	const unit = `${BROKER_SCOPE_UNIT_PREFIX}${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	return [
		systemdRun,
		"--user",
		"--scope",
		"--quiet",
		"--collect",
		`--unit=${unit}`,
		"--description=omp daemon broker",
		// One daemon's OOM kill must not stop the scope, and with it every
		// other session's daemons; systemd's default for a scope is `stop`.
		"--property=OOMPolicy=continue",
		"--",
		...command,
	];
}

/** The parts of a spawned scope launcher {@link scopeLaunchFailed} reads. */
export interface ScopeLauncher {
	readonly pid: number;
	readonly exitCode: number | null;
	readonly signalCode: string | number | null;
}

/**
 * Whether a scoped broker launch failed to become the broker, so the caller
 * should start one without a scope. True when the launcher ended by a signal
 * or with a non-zero status (`systemd-run` could not create the scope, or the
 * broker it became crashed), or when, after the grace, the process has still
 * not exec'd into `brokerExecutable` (`systemd-run` is waiting on the user
 * manager). A zero exit is a broker that found the scope's lease held by
 * another broker, which the client then reaches.
 */
export async function scopeLaunchFailed(
	launcher: ScopeLauncher,
	brokerExecutable: string,
	graceExpired: boolean,
): Promise<boolean> {
	if (launcher.signalCode !== null) return true;
	if (launcher.exitCode !== null) return launcher.exitCode !== 0;
	if (!graceExpired) return false;
	try {
		return (await fs.readlink(`/proc/${launcher.pid}/exe`)) !== brokerExecutable;
	} catch {
		// Gone between the checks: its exit status settles it on the next poll.
		return false;
	}
}
