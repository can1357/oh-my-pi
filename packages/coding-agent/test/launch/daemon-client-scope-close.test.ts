// Integration test — real timers are required (ts-no-test-timers exception): the brokers are real
// in-process daemon brokers on real IPC endpoints, and a closed scope is observed by awaiting the
// broker's own run() promise, which resolves once its last client is gone for the idle grace (no
// polling, no fixed sleep). A regression keeps a broker alive, so the test's own timeout surfaces it.
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { closeDaemonClientsUnder, type DaemonBrokerClient, daemonClientForProject } from "../../src/launch/client";
import { daemonRuntimeDir } from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { restoreEnvValue } from "../helpers/settings-test-state";

/** Long enough for every client to connect before the broker's startup idle check. */
const IDLE_GRACE_MS = 1_000;
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_PROFILE", "XDG_STATE_HOME"] as const;

/** Serve `client`'s scope from an in-process broker, so no broker child process is spawned. */
function startBroker(client: DaemonBrokerClient): { listening: Promise<void>; finished: Promise<void> } {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		key => [key, process.env[key]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = client.projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = daemonRuntimeDir(client.projectDir);
	process.env[DAEMON_IDLE_GRACE_ENV] = String(IDLE_GRACE_MS);
	const listening = Promise.withResolvers<void>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: listening.resolve });
	for (const [key, value] of saved) restoreEnvValue(key, value);
	return { listening: listening.promise, finished };
}

describe("closeDaemonClientsUnder", () => {
	let tempDir: TempDir;
	let savedEnv: Array<readonly [string, string | undefined]>;
	let previousTitle: string;
	let homedir: Mock<typeof os.homedir>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-daemon-scope-close-");
		savedEnv = ENV_KEYS.map(key => [key, process.env[key]] as const);
		previousTitle = process.title;
		// Broker runtime dirs live under the config root: keep them inside the temp home.
		homedir = spyOn(os, "homedir").mockReturnValue(tempDir.path());
		process.env.XDG_STATE_HOME = path.join(tempDir.path(), "state");
		setAgentDir(path.join(tempDir.path(), ".omp", "agent"));
	});

	afterEach(async () => {
		process.title = previousTitle;
		homedir.mockRestore();
		for (const [key, value] of savedEnv) restoreEnvValue(key, value);
		__resetDirsFromEnvForTests();
		await tempDir.remove();
	});

	it("closes the scopes at and under a directory and keeps a sibling scope connected", async () => {
		const root = path.join(tempDir.path(), "work", "root");
		const sub = path.join(root, "sub");
		// Shares `root` as a string prefix; must not count as inside it.
		const sibling = `${root}-sibling`;
		await fs.mkdir(sub, { recursive: true });
		await fs.mkdir(sibling);

		const rootClient = await daemonClientForProject(root);
		const subClient = await daemonClientForProject(sub);
		const siblingClient = await daemonClientForProject(sibling);
		const rootBroker = startBroker(rootClient);
		const subBroker = startBroker(subClient);
		const siblingBroker = startBroker(siblingClient);
		try {
			await Promise.all([rootBroker.listening, subBroker.listening, siblingBroker.listening]);
			const pings = await Promise.all([rootClient, subClient, siblingClient].map(c => c.request({ op: "ping" })));
			expect(pings.map(ping => ping.op)).toEqual(["ping", "ping", "ping"]);

			await closeDaemonClientsUnder(root);

			// Each broker lost its only client, so it shuts down after its idle grace.
			await Promise.all([rootBroker.finished, subBroker.finished]);
			await expect(rootClient.request({ op: "ping" })).rejects.toThrow("closed");
			await expect(subClient.request({ op: "ping" })).rejects.toThrow("closed");
			expect((await siblingClient.request({ op: "ping" })).op).toBe("ping");
			expect(await daemonClientForProject(sibling)).toBe(siblingClient);
		} finally {
			await closeDaemonClientsUnder(path.join(tempDir.path(), "work"));
			await Promise.all([rootBroker.finished, subBroker.finished, siblingBroker.finished]);
		}
	}, 30_000);
});
