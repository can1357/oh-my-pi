// Integration test — real processes and real timers are required (ts-no-test-timers exception): the
// client spawns the real broker through the CLI worker entry, optionally through `systemd-run`, and
// the behaviour under test is which cgroup that process lands in and how the client recovers when
// the scope launcher fails or stalls. Fake timers cannot drive the OS process exit or the socket
// connect the client polls.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { BROKER_SCOPE_UNIT_PREFIX, brokerScopeCommand, scopeLaunchFailed } from "../../src/launch/broker-launch";
import { createDaemonBrokerClient } from "../../src/launch/client";

const BROKER_CMD = ["/opt/omp/bin/omp", "__omp_worker_daemon_broker"];
const isLinux = process.platform === "linux";

async function fakeLauncher(dir: string, script: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "systemd-run");
	await Bun.write(file, `#!/bin/sh\n${script}\n`);
	await fs.chmod(file, 0o755);
	return dir;
}

function cgroupOf(pid: number | "self"): Promise<string> {
	return fs.readFile(`/proc/${pid}/cgroup`, "utf8").then(text => text.trim().replace(/^0::/, ""));
}

async function brokerPid(runtimeDir: string): Promise<number> {
	const lease = JSON.parse(await fs.readFile(path.join(runtimeDir, "broker.pid"), "utf8")) as { pid: number };
	return lease.pid;
}

/** Run `body` with `PATH` (and `XDG_RUNTIME_DIR`) overridden for the broker the client spawns. */
async function withEnv(overrides: Record<string, string>, body: () => Promise<void>): Promise<void> {
	const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
	Object.assign(process.env, overrides);
	try {
		await body();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Start a broker through the real client, run `check` on its pid, then shut it down. */
async function withSpawnedBroker(
	check: (pid: number, runtimeDir: string, projectDir: string) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-broker-scope-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	try {
		const ping = await client.request({ op: "ping" });
		expect(ping).toEqual({ op: "ping", projectDir: client.projectDir });
		await check(await brokerPid(runtimeDir), runtimeDir, projectDir);
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
	}
}

function userScopeAvailable(): boolean {
	if (!isLinux || !process.env.XDG_RUNTIME_DIR || !Bun.which("systemd-run")) return false;
	return Bun.spawnSync(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", "true"]).exitCode === 0;
}

describe("brokerScopeCommand", () => {
	it("starts the broker in a transient user scope of its own on Linux with a user manager", async () => {
		using tempDir = TempDir.createSync("@omp-broker-scope-cmd-");
		const bin = await fakeLauncher(tempDir.path(), "exit 0");
		const env = { XDG_RUNTIME_DIR: "/run/user/1000", PATH: bin };
		const first = brokerScopeCommand(BROKER_CMD, env, "linux");
		const second = brokerScopeCommand(BROKER_CMD, env, "linux");
		expect(first?.slice(0, 5)).toEqual([path.join(bin, "systemd-run"), "--user", "--scope", "--quiet", "--collect"]);
		expect(first).toContain("--property=OOMPolicy=continue");
		expect(first?.slice(-3)).toEqual(["--", ...BROKER_CMD]);
		const unit = first?.find(arg => arg.startsWith("--unit="));
		expect(unit?.startsWith(`--unit=${BROKER_SCOPE_UNIT_PREFIX}`)).toBe(true);
		// A detached daemon keeps an earlier broker's scope alive, so every launch needs a fresh name.
		expect(second?.find(arg => arg.startsWith("--unit="))).not.toBe(unit);
	});

	it("leaves the command alone where no user manager can be asked", async () => {
		using tempDir = TempDir.createSync("@omp-broker-scope-cmd-");
		const bin = await fakeLauncher(tempDir.path(), "exit 0");
		expect(
			brokerScopeCommand(BROKER_CMD, { XDG_RUNTIME_DIR: "/run/user/1000", PATH: bin }, "darwin"),
		).toBeUndefined();
		expect(brokerScopeCommand(BROKER_CMD, { XDG_RUNTIME_DIR: "/run/user/1000", PATH: bin }, "win32")).toBeUndefined();
		expect(brokerScopeCommand(BROKER_CMD, { PATH: bin }, "linux")).toBeUndefined();
		expect(
			brokerScopeCommand(BROKER_CMD, { XDG_RUNTIME_DIR: "/run/user/1000", PATH: path.join(bin, "none") }, "linux"),
		).toBeUndefined();
	});
});

describe("scopeLaunchFailed", () => {
	it("treats a non-zero or signalled launcher as failed and a zero exit as a lease loser", async () => {
		const launcher = { pid: 1, signalCode: null };
		expect(await scopeLaunchFailed({ ...launcher, exitCode: 1 }, "/bin/omp", false)).toBe(true);
		expect(await scopeLaunchFailed({ ...launcher, exitCode: 0 }, "/bin/omp", true)).toBe(false);
		expect(await scopeLaunchFailed({ pid: 1, exitCode: null, signalCode: "SIGKILL" }, "/bin/omp", false)).toBe(true);
		expect(await scopeLaunchFailed({ ...launcher, exitCode: null }, "/bin/omp", false)).toBe(false);
	});
});

describe.skipIf(!isLinux)("daemon broker launch", () => {
	it("starts a broker without a scope when systemd-run refuses", async () => {
		using tempDir = TempDir.createSync("@omp-broker-scope-refuse-");
		const bin = await fakeLauncher(tempDir.path(), "echo 'Failed to connect to bus' >&2; exit 1");
		await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, XDG_RUNTIME_DIR: tempDir.path() }, () =>
			withSpawnedBroker(async pid => {
				expect(await cgroupOf(pid)).toBe(await cgroupOf("self"));
			}),
		);
	}, 30_000);

	it("stops waiting for a stalled systemd-run and starts a broker without a scope", async () => {
		using tempDir = TempDir.createSync("@omp-broker-scope-stall-");
		const pidFile = path.join(tempDir.path(), "launcher.pid");
		const bin = await fakeLauncher(path.join(tempDir.path(), "bin"), `echo $$ > '${pidFile}'; exec sleep 600`);
		try {
			await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, XDG_RUNTIME_DIR: tempDir.path() }, () =>
				withSpawnedBroker(async pid => {
					const launcher = Number((await fs.readFile(pidFile, "utf8")).trim());
					expect(pid).not.toBe(launcher);
					expect(await cgroupOf(pid)).toBe(await cgroupOf("self"));
				}),
			);
		} finally {
			const launcher = Number((await fs.readFile(pidFile, "utf8").catch(() => "0")).trim());
			if (launcher > 0) process.kill(launcher, "SIGKILL");
		}
	}, 30_000);

	it.skipIf(!userScopeAvailable())(
		"runs the broker and its daemons in a systemd scope of its own, not the starting session's",
		async () => {
			await withSpawnedBroker(async (pid, runtimeDir, projectDir) => {
				const brokerCgroup = await cgroupOf(pid);
				expect(path.basename(brokerCgroup)).toStartWith(BROKER_SCOPE_UNIT_PREFIX);
				expect(brokerCgroup).not.toBe(await cgroupOf("self"));
				const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
				try {
					const started = await client.request({
						op: "start",
						spec: {
							name: "scoped-child",
							application: "/bin/sh",
							args: ["-c", "sleep 30"],
							env: {},
							cwd: projectDir,
							pty: false,
							restart: "no",
							persist: false,
							detached: false,
						},
					});
					if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("daemon did not start");
					expect(await cgroupOf(started.daemon.pid)).toBe(brokerCgroup);
				} finally {
					client.close();
				}
			});
		},
		30_000,
	);
});
