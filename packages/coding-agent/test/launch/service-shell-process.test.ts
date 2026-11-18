/**
 * A named service runs as a shell process: the bash tool's shell in a process
 * of its own, started by the broker. A real broker socket and the worker entry
 * drive these.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { shellMounts } from "../../src/exec/shell-process";
import { resolveLocalRoot } from "../../src/internal-urls";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import * as brokerClients from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { serviceLogs, startService, stopService } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";

/**
 * Start the in-process broker and wait until it accepts connections. `finished` settles once it
 * has shut down; it is wrapped because an async function returning it bare would await it.
 */
async function startBroker(projectDir: string, runtimeDir: string): Promise<{ finished: Promise<void> }> {
	const previous = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (!(await Promise.race([listening.promise, finished.then(() => false)]))) {
		throw new Error("In-process daemon broker did not claim its scope");
	}
	return { finished };
}

describe("service shell process", () => {
	it.skipIf(process.platform === "win32")(
		"runs omp's jq on a local:// file with no jq on PATH, on pipes and on a terminal",
		async () => {
			using tempDir = TempDir.createSync("@omp-service-shell-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			const empty = path.join(tempDir.path(), "empty");
			const localProtocolOptions = { getArtifactsDir: () => tempDir.path(), getSessionId: () => "session" };
			const localRoot = resolveLocalRoot(localProtocolOptions);
			await Promise.all([fs.mkdir(projectDir), fs.mkdir(empty), fs.mkdir(localRoot, { recursive: true })]);
			await fs.writeFile(path.join(localRoot, "data.json"), '{"a":[40,2]}\n');
			const client = await brokerClients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const previousTitle = process.title;
			const broker = await startBroker(projectDir, runtimeDir);
			const session: ToolSession = {
				cwd: projectDir,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getAgentId: () => "Main",
				getSessionId: () => "session",
				queueLaunchCompletion: () => Promise.resolve(),
			};
			// No directory on the search path has a jq: the one that runs is omp's. The last
			// line holds the service open until it is stopped.
			const sum = `PATH='${empty}'; jq '.a | add' local://data.json; echo "status $?"`;
			// What the bash tool hands a service: the mounts behind the session's URL paths.
			const mounts = await shellMounts({ localProtocolOptions }, "exec");
			try {
				vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);

				const piped = await startService(session, {
					name: "piped",
					command: `label() { echo "$1 on pipes"; }; ${sum}; label "$GREETING"; read hold`,
					pty: false,
					env: { GREETING: "hello" },
					ready: { log: "on pipes", timeout: 60 },
					seed: mounts,
				});
				const terminal = await startService(session, {
					name: "terminal",
					command: `${sum}; [ -t 0 ] && [ -t 1 ] && echo "on a terminal"; read hold`,
					ready: { log: "on a terminal", timeout: 60 },
					seed: `${mounts}shopt -s expand_aliases\n`,
				});
				const [pipedLogs, terminalLogs] = await Promise.all([
					serviceLogs(session, "piped"),
					serviceLogs(session, "terminal"),
				]);
				const stopped = await stopService(session, "terminal");

				expect(piped.readyTimedOut).toBe(false);
				expect(pipedLogs.split("\n").slice(0, 3)).toEqual(["42", "status 0", "hello on pipes"]);
				expect(terminal.readyTimedOut).toBe(false);
				expect(terminalLogs.split("\n").slice(0, 3)).toEqual(["42", "status 0", "on a terminal"]);
				expect(stopped.state).toBe("exited");
			} finally {
				vi.restoreAllMocks();
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				await broker.finished;
				process.title = previousTitle;
			}
		},
		120_000,
	);
});
