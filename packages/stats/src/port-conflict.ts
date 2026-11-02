import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

/**
 * Upper bound on the identity probe. A live dashboard ingests on its main thread
 * (serially on macOS), which stalls its responses for over a second on large
 * histories; giving up sooner mistakes a busy dashboard for a hung listener.
 */
const STATS_PROBE_TIMEOUT_MS = 3_000;
const PROCESS_EXIT_POLL_MS = 50;
const PROCESS_EXIT_POLLS = 10;
const STATS_RUNTIME_IMAGES: Record<string, true> = { bun: true, node: true, omp: true, "omp-stats": true };

interface PortHolder {
	pid: number;
	image: string;
	commandLine: string;
}

/** Header stamped on every dashboard response so reuse probes can identify us. */
export const STATS_DASHBOARD_HEADER = "x-omp-stats-dashboard";
/** Header recording the server's requested bind host so reuse cannot change its exposure scope. */
export const STATS_DASHBOARD_HOSTNAME_HEADER = "x-omp-stats-hostname";

/** Identity-header value for dashboards enforcing an explicit bind host and same-origin access. */
export const STATS_DASHBOARD_SECURITY_VERSION = "3";

/** IPv4 loopback address shared by the dashboard server and reuse probe. */
export const STATS_DASHBOARD_HOSTNAME = "127.0.0.1";

/**
 * What answers on the dashboard port:
 * - `reusable`: a current dashboard bound to the requested host.
 * - `replaceable`: an older dashboard this version may upgrade.
 * - `occupied`: any other HTTP answer.
 * - `unresponsive`: accepted the connection but did not answer in time (busy or hung).
 * - `unreachable`: the connection failed, typically because nothing listens there.
 */
type StatsDashboardProbe = "reusable" | "replaceable" | "occupied" | "unresponsive" | "unreachable";

/**
 * How {@link startServer} proceeds with the requested port: bind it, reuse the
 * dashboard already serving it, or fall back to an ephemeral port because the
 * holder is neither reusable nor safe to stop.
 */
export type StatsPortClaim = "bind" | "reuse" | "fallback";

async function probeStatsDashboard(port: number, hostname: string): Promise<StatsDashboardProbe> {
	const probeHostname = hostname === "0.0.0.0" ? STATS_DASHBOARD_HOSTNAME : hostname === "::" ? "::1" : hostname;
	const urlHostname = probeHostname.includes(":") ? `[${probeHostname}]` : probeHostname;
	const signal = AbortSignal.timeout(STATS_PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`http://${urlHostname}:${port}/api/stats/models`, { signal });
		const dashboardVersionHeader = response.headers.get(STATS_DASHBOARD_HEADER);
		const dashboardVersion = dashboardVersionHeader === null ? Number.NaN : Number(dashboardVersionHeader);
		// Never replace a newer dashboard: an older CLI must not downgrade it.
		const replaceable =
			response.status === 200 &&
			Number.isSafeInteger(dashboardVersion) &&
			dashboardVersion > 0 &&
			dashboardVersion <= Number(STATS_DASHBOARD_SECURITY_VERSION);
		const reusable =
			response.status === 200 &&
			dashboardVersionHeader === STATS_DASHBOARD_SECURITY_VERSION &&
			response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER) === hostname &&
			!response.headers.has("Access-Control-Allow-Origin");
		await response.body?.cancel();
		if (reusable) return "reusable";
		return replaceable ? "replaceable" : "occupied";
	} catch {
		return signal.aborted ? "unresponsive" : "unreachable";
	}
}

async function findLinuxPortHolder(port: number): Promise<PortHolder | null> {
	const socketInodes = new Set<string>();
	for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let table: string;
		try {
			table = await Bun.file(tablePath).text();
		} catch {
			continue;
		}

		for (const line of table.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			const localAddress = fields[1];
			const state = fields[3];
			const inode = fields[9];
			if (!localAddress || state !== "0A" || !inode) continue;
			const encodedPort = localAddress.slice(localAddress.lastIndexOf(":") + 1);
			if (Number.parseInt(encodedPort, 16) === port) socketInodes.add(inode);
		}
	}
	if (socketInodes.size === 0) return null;

	let processes: Dirent[];
	try {
		processes = await fs.readdir("/proc", { withFileTypes: true });
	} catch {
		return null;
	}

	for (const entry of processes) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number.parseInt(entry.name, 10);
		let descriptors: string[];
		try {
			descriptors = await fs.readdir(`/proc/${pid}/fd`);
		} catch {
			continue;
		}

		let ownsSocket = false;
		for (const descriptor of descriptors) {
			try {
				const target = await fs.readlink(`/proc/${pid}/fd/${descriptor}`);
				const match = /^socket:\[(\d+)]$/.exec(target);
				if (match?.[1] && socketInodes.has(match[1])) {
					ownsSocket = true;
					break;
				}
			} catch {}
		}
		if (!ownsSocket) continue;

		let commandLine = "";
		try {
			const rawCommandLine = await Bun.file(`/proc/${pid}/cmdline`).text();
			commandLine = rawCommandLine.split("\0").filter(Boolean).join(" ");
		} catch {}

		try {
			const executable = await fs.readlink(`/proc/${pid}/exe`);
			return { pid, image: path.basename(executable), commandLine };
		} catch {
			const executable = commandLine.split(" ", 1)[0];
			return { pid, image: executable ? path.basename(executable) : "unknown", commandLine };
		}
	}
	return null;
}

async function findMacPortHolder(port: number): Promise<PortHolder | null> {
	const lsof = $which("lsof") ?? ((await Bun.file("/usr/sbin/lsof").exists()) ? "/usr/sbin/lsof" : null);
	if (!lsof) return null;

	const selector = `-iTCP:${port}`;
	const result = await $`${lsof} -nP ${selector} -sTCP:LISTEN -Fpc`.quiet().nothrow();
	if (result.exitCode !== 0) return null;

	let pid: number | null = null;
	let image = "unknown";
	for (const line of result.text().split("\n")) {
		if (line.startsWith("p")) {
			const parsed = Number.parseInt(line.slice(1), 10);
			pid = Number.isSafeInteger(parsed) ? parsed : null;
		} else if (line.startsWith("c") && pid !== null) {
			image = line.slice(1) || "unknown";
			break;
		}
	}
	if (pid === null) return null;

	const ps = $which("ps");
	if (!ps) return { pid, image, commandLine: "" };
	const processInfo = await $`${ps} -ww -p ${pid} -o command=`.quiet().nothrow();
	return { pid, image, commandLine: processInfo.exitCode === 0 ? processInfo.text().trim() : "" };
}

async function findWindowsPortHolder(port: number): Promise<PortHolder | null> {
	const netstat = $which("netstat");
	if (!netstat) return null;

	const result = await $`${netstat} -ano -p TCP`.quiet().nothrow();
	if (result.exitCode !== 0) return null;

	let pid: number | null = null;
	for (const line of result.text().split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[0]?.toUpperCase() !== "TCP" || fields[3]?.toUpperCase() !== "LISTENING") continue;
		const localAddress = fields[1];
		if (!localAddress || Number.parseInt(localAddress.slice(localAddress.lastIndexOf(":") + 1), 10) !== port) {
			continue;
		}
		const parsed = Number.parseInt(fields[4] ?? "", 10);
		if (Number.isSafeInteger(parsed)) {
			pid = parsed;
			break;
		}
	}
	if (pid === null) return null;

	let image = "unknown";
	const tasklist = $which("tasklist");
	if (tasklist) {
		const filter = `PID eq ${pid}`;
		const task = await $`${tasklist} /FI ${filter} /FO CSV /NH`.quiet().nothrow();
		if (task.exitCode === 0) {
			const imageMatch = /^"((?:[^"]|"")*)"/.exec(task.text().trim());
			image = imageMatch?.[1]?.replaceAll('""', '"') || "unknown";
		}
	}

	const powershell = $which("powershell") ?? $which("pwsh");
	if (!powershell) return { pid, image, commandLine: "" };
	const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
	const processInfo = await $`${powershell} -NoProfile -NonInteractive -Command ${command}`.quiet().nothrow();
	return { pid, image, commandLine: processInfo.exitCode === 0 ? processInfo.text().trim() : "" };
}

async function findPortHolder(port: number): Promise<PortHolder | null> {
	if (process.platform === "linux") return findLinuxPortHolder(port);
	if (process.platform === "darwin") return findMacPortHolder(port);
	if (process.platform === "win32") return findWindowsPortHolder(port);
	return null;
}

async function terminatePortHolder(holder: PortHolder): Promise<void> {
	try {
		process.kill(holder.pid, "SIGTERM");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
		throw new Error(`Failed to stop ${holder.image} (PID ${holder.pid})`, { cause: error });
	}

	for (let attempt = 0; attempt < PROCESS_EXIT_POLLS; attempt++) {
		await Bun.sleep(PROCESS_EXIT_POLL_MS);
		try {
			process.kill(holder.pid, 0);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
			throw new Error(`Failed to inspect ${holder.image} (PID ${holder.pid})`, { cause: error });
		}
	}

	try {
		process.kill(holder.pid, "SIGKILL");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
		throw new Error(`Failed to kill ${holder.image} (PID ${holder.pid})`, { cause: error });
	}
	await Bun.sleep(PROCESS_EXIT_POLL_MS);
}

/**
 * Stop the stats dashboard answering `probe` on `port` so it can be rebound.
 * Holders that cannot be positively identified as an omp stats dashboard, or
 * that refuse to stop, are left running and yield `"fallback"`.
 */
async function reclaimStatsPort(port: number, probe: "replaceable" | "occupied"): Promise<StatsPortClaim> {
	const holder = await findPortHolder(port);
	if (!holder || holder.pid === process.pid) {
		logger.debug("Stats dashboard port holder not reclaimable", { port, holder });
		return "fallback";
	}

	const normalizedImage = holder.image
		.toLowerCase()
		.replace(/\.exe$/, "")
		.replace(/ \(deleted\)$/, "");
	const normalizedCommand = holder.commandLine.toLowerCase().replaceAll("\\", "/");
	const hasStatsIdentity =
		normalizedImage === "omp-stats" ||
		/(?:^|[/"'\s])omp-stats(?:\.exe)?(?:["'\s]|$)/.test(normalizedCommand) ||
		/\/packages\/stats\/src\/index\.ts(?:["'\s]|$)/.test(normalizedCommand) ||
		(normalizedImage === "omp" && /(?:^|\s)stats(?:\s|$)/.test(normalizedCommand)) ||
		/(?:^|\/)omp(?:\.exe)?["'\s]+stats(?:["'\s]|$)/.test(normalizedCommand);
	const hasDashboardIdentity = probe === "replaceable";
	if (!STATS_RUNTIME_IMAGES[normalizedImage] || (!hasStatsIdentity && !hasDashboardIdentity)) {
		logger.debug("Stats dashboard port held by an unidentified process", { port, holder });
		return "fallback";
	}

	try {
		await terminatePortHolder(holder);
	} catch (error) {
		logger.warn("Failed to stop stale stats dashboard", { port, pid: holder.pid, error: String(error) });
		return "fallback";
	}
	return "bind";
}

async function claimStatsPort(port: number, hostname: string, ifUnreachable: StatsPortClaim): Promise<StatsPortClaim> {
	const probe = await probeStatsDashboard(port, hostname);
	switch (probe) {
		case "reusable":
			return "reuse";
		case "replaceable":
		case "occupied":
			return reclaimStatsPort(port, probe);
		case "unresponsive":
			// Busy or hung: a dashboard stalled mid-ingest must never be stopped.
			return "fallback";
		case "unreachable":
			return ifUnreachable;
	}
}

/**
 * Reuse a current dashboard, or upgrade an older one, before binding.
 * The preflight is needed on platforms that permit wildcard and loopback-specific
 * listeners to coexist on one port.
 */
export async function prepareStatsPort(port: number, hostname = STATS_DASHBOARD_HOSTNAME): Promise<StatsPortClaim> {
	if (port === 0) return "bind";
	return claimStatsPort(port, hostname, "bind");
}

/** Reuse or reclaim a listener found after the server bind reports EADDRINUSE. */
export async function recoverStatsPort(port: number, hostname = STATS_DASHBOARD_HOSTNAME): Promise<StatsPortClaim> {
	return claimStatsPort(port, hostname, "fallback");
}
