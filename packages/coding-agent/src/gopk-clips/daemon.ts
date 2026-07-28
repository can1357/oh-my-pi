/**
 * Always-on Activity Memory ingest daemon.
 *
 * This is the fix for the "See my day is empty" defect: historically the only
 * thing that turned the sampler's handoff JSON into the activity ledger was
 * {@link createGopkClipsHost} built inside an `AgentSession` and torn down in
 * its `dispose()`. So unless a coding-agent session happened to be open with
 * `gopkClips.enabled`, the sampler wrote handoffs forever and the ledger — and
 * therefore the report and recall — stayed permanently empty.
 *
 * This daemon runs the exact same host (poll handoffs -> sanitizing ingest ->
 * retention purge) as a standalone, lifecycle-independent process that setup
 * autostarts alongside the sampler. No duplicated ingest/retention logic: it
 * reuses `createGopkClipsHost` wholesale. The agent-session host remains as an
 * optional extra consumer for in-session recall.
 *
 * Single instance per ledger via an `ingest.pid` lock next to the capture
 * root; graceful shutdown on SIGINT/SIGTERM. Paths come from the shared
 * gopk-clips config.json when present, else the historical agent-dir default.
 *
 * Usage: bun packages/coding-agent/src/gopk-clips/daemon.ts [--stop] [--once]
 *   --stop  terminate a running daemon via its pid file
 *   --once  run a single poll+cleanup pass and exit (smoke test)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// Subpath imports keep the compiled gopk-ingest.exe free of the pi_natives
// native addon (which the pi-utils barrel eagerly loads). See session-state.ts.
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import * as logger from "@pk-nerdsaver-ai/pi-utils/logger";
import { createGopkClipsHost, type GopkClipsHostState } from "./session-state";

const POLL_INTERVAL_MS = 15_000;
const CLEANUP_INTERVAL_MS = 600_000;

/** Well-known config.json shared with the gopk-clips capture side. */
function sharedConfigPath(): string {
	if (process.platform === "win32") {
		const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
		return path.join(base, "gopk-clips", "config.json");
	}
	const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(base, "gopk-clips", "config.json");
}

interface ResolvedPaths {
	captureRoot: string;
	ledgerPath: string;
}

/** Prefer setup's config.json; else the same defaults createGopkClipsHost uses. */
function resolvePaths(): ResolvedPaths {
	const agentRoot = path.join(getAgentDir(), "gopk-clips");
	const fallback: ResolvedPaths = {
		captureRoot: path.join(agentRoot, "capture"),
		ledgerPath: path.join(agentRoot, "activity-ledger.sqlite"),
	};
	try {
		const parsed = JSON.parse(fs.readFileSync(sharedConfigPath(), "utf8")) as Partial<ResolvedPaths>;
		return {
			captureRoot: parsed.captureRoot || fallback.captureRoot,
			ledgerPath: parsed.ledgerPath || fallback.ledgerPath,
		};
	} catch {
		return fallback;
	}
}

function pidFilePath(captureRoot: string): string {
	return path.join(captureRoot, "ingest.pid");
}

/**
 * On Windows, confirm the pid is a bun process (our daemon runs as `bun run`),
 * so a recycled pid from a stale lock after a reboot is not mistaken for a
 * live daemon and doesn't block restart. On other platforms, existence stands.
 */
function isOurProcess(pid: number): boolean {
	if (process.platform !== "win32") return true;
	try {
		const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		// bun.exe (dev) or gopk-ingest.exe / gopk-clips.exe (compiled).
		const image = result.stdout.toString().toLowerCase();
		return image.includes("bun.exe") || image.includes("gopk");
	} catch {
		return true;
	}
}

/** The pid recorded in the lock when that process is still alive AND ours, else undefined. */
function readAlivePid(pidPath: string): number | undefined {
	let pid: number;
	try {
		pid = Number(fs.readFileSync(pidPath, "utf8").trim());
	} catch {
		return undefined;
	}
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
	} catch {
		return undefined;
	}
	return isOurProcess(pid) ? pid : undefined;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const stop = argv.includes("--stop");
	const once = argv.includes("--once");
	const { captureRoot, ledgerPath } = resolvePaths();
	fs.mkdirSync(captureRoot, { recursive: true });
	const pidPath = pidFilePath(captureRoot);

	if (stop) {
		const running = readAlivePid(pidPath);
		if (running === undefined) {
			console.log("ingest daemon: not running");
			return;
		}
		process.kill(running, "SIGTERM");
		console.log(`ingest daemon: stopped (pid ${running})`);
		return;
	}

	if (!once) {
		const running = readAlivePid(pidPath);
		if (running !== undefined) {
			console.log(`ingest daemon: already running (pid ${running}); exiting`);
			return;
		}
	}

	let host: GopkClipsHostState;
	try {
		host = createGopkClipsHost({ captureRoot, ledgerPath, pollIntervalMs: POLL_INTERVAL_MS, cleanupIntervalMs: CLEANUP_INTERVAL_MS });
	} catch (error) {
		logger.warn("ingest daemon: failed to start", { error: String(error) });
		process.exitCode = 1;
		return;
	}

	if (once) {
		await host.pollOnce();
		await host.cleanupOnce();
		await host.dispose();
		console.log("ingest daemon: single pass complete");
		return;
	}

	fs.writeFileSync(pidPath, String(process.pid));
	const cleanupPid = (): void => {
		try {
			if (fs.readFileSync(pidPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(pidPath);
		} catch {
			// already gone
		}
	};
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		void host.dispose().finally(() => {
			cleanupPid();
			process.exit(0);
		});
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	process.on("exit", cleanupPid);

	logger.info("ingest daemon: running", { captureRoot, ledgerPath, pollIntervalMs: POLL_INTERVAL_MS });
	console.log(`ingest daemon: running (pid ${process.pid}) — ledger ${ledgerPath}`);
	// Keep the event loop alive; the host's own timers drive the work.
	await new Promise<void>(() => {});
}

await main();
