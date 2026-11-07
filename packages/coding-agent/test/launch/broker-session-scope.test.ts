// Integration test — real processes and real timers are required (ts-no-test-timers exception): the
// client spawns the real broker through the CLI worker entry, and the behaviour under test is which
// cgroup that process and its daemons end up in, moved by the real systemd user manager, and that a
// stalled `busctl` is not left behind. Fake timers cannot drive the OS processes or the manager.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { BROKER_SCOPE_UNIT_PREFIX, cgroupOf, startScopeArgs, userManagerBusctl } from "../../src/launch/broker-scope";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";

const isLinux = process.platform === "linux";
const realBusctl = isLinux ? Bun.which("busctl") : null;

async function fakeBusctl(dir: string, script: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "busctl");
	await Bun.write(file, `#!/bin/sh\n${script}\n`);
	await fs.chmod(file, 0o755);
	return dir;
}

async function brokerPid(runtimeDir: string): Promise<number> {
	const lease = JSON.parse(await fs.readFile(path.join(runtimeDir, "broker.pid"), "utf8")) as { pid: number };
	return lease.pid;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(100);
	}
	return check();
}

/** Run `body` with environment overrides inherited by the broker the client spawns. */
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

interface SpawnedBroker {
	client: DaemonBrokerClient;
	pid: number;
	projectDir: string;
}

/** Start a real broker process through the real client, run `check`, then shut it down. */
async function withSpawnedBroker(check: (broker: SpawnedBroker) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@omp-broker-scope-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	try {
		expect(await client.request({ op: "ping" })).toEqual({ op: "ping", projectDir: client.projectDir });
		await check({ client, pid: await brokerPid(runtimeDir), projectDir });
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
	}
}

async function startSleeper(broker: SpawnedBroker, script = "sleep 60"): Promise<number> {
	const started = await broker.client.request({
		op: "start",
		spec: {
			name: "sleeper",
			application: "/bin/sh",
			args: ["-c", script],
			env: {},
			cwd: broker.projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		},
	});
	if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("daemon did not start");
	return started.daemon.pid;
}

function userManagerAnswers(): boolean {
	const prefix = userManagerBusctl(process.env);
	if (!prefix) return false;
	return Bun.spawnSync([...prefix.slice(0, 3), "status"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

describe("userManagerBusctl", () => {
	it("calls the user manager through busctl only on Linux with a user bus and busctl", async () => {
		using tempDir = TempDir.createSync("@omp-broker-scope-cmd-");
		const bin = await fakeBusctl(path.join(tempDir.path(), "bin"), "exit 0");
		await Bun.write(path.join(tempDir.path(), "bus"), "");
		const env = { XDG_RUNTIME_DIR: tempDir.path(), PATH: bin };
		expect(userManagerBusctl(env, "linux")?.slice(0, 3)).toEqual([
			path.join(bin, "busctl"),
			"--user",
			"--timeout=25",
		]);
		expect(userManagerBusctl({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/x", PATH: bin }, "linux")).toBeDefined();
		expect(userManagerBusctl(env, "darwin")).toBeUndefined();
		expect(userManagerBusctl(env, "win32")).toBeUndefined();
		expect(userManagerBusctl({ XDG_RUNTIME_DIR: bin, PATH: bin }, "linux")).toBeUndefined();
		expect(userManagerBusctl({ ...env, PATH: path.join(bin, "none") }, "linux")).toBeUndefined();
	});

	it("asks for a scope that holds the broker and survives one daemon's OOM kill", () => {
		expect(startScopeArgs("omp-daemon-broker-1-a.scope", 42, true)).toEqual([
			"StartTransientUnit",
			"ssa(sv)a(sa(sv))",
			"omp-daemon-broker-1-a.scope",
			"fail",
			"5",
			"PIDs",
			"au",
			"1",
			"42",
			"Description",
			"s",
			"omp daemon broker",
			"CollectMode",
			"s",
			"inactive-or-failed",
			"Delegate",
			"b",
			"true",
			"OOMPolicy",
			"s",
			"continue",
			"0",
		]);
		expect(startScopeArgs("u", 42, false)).not.toContain("OOMPolicy");
	});
});

describe.skipIf(!isLinux)("daemon broker scope", () => {
	it("does not leave a stalled busctl behind when the broker exits", async () => {
		using tempDir = TempDir.createSync("@omp-broker-scope-stall-");
		const pids = path.join(tempDir.path(), "busctl.pids");
		const bin = await fakeBusctl(path.join(tempDir.path(), "bin"), `echo $$ >> '${pids}'; exec sleep 600`);
		await Bun.write(path.join(tempDir.path(), "bus"), "");
		let stalled: number[] = [];
		try {
			await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, XDG_RUNTIME_DIR: tempDir.path() }, () =>
				withSpawnedBroker(async broker => {
					stalled = (await fs.readFile(pids, "utf8")).trim().split("\n").map(Number);
					expect(stalled.length).toBe(1);
					expect(alive(stalled[0])).toBe(true);
					// The broker serves while its move is pending.
					expect(alive(await startSleeper(broker))).toBe(true);
				}),
			);
			expect(await until(async () => !alive(stalled[0]), 10_000)).toBe(true);
		} finally {
			for (const pid of stalled) if (alive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 30_000);

	it.skipIf(!userManagerAnswers())(
		"moves the broker into a systemd scope of its own, where its daemons start",
		async () => {
			await withSpawnedBroker(async broker => {
				// Normally moved before it listens; under load the first attempt may outlast the 2 s wait.
				const moved = await until(
					async () => path.basename((await cgroupOf(broker.pid)) ?? "").startsWith(BROKER_SCOPE_UNIT_PREFIX),
					20_000,
				);
				expect(moved).toBe(true);
				const brokerCgroup = await cgroupOf(broker.pid);
				expect(brokerCgroup).not.toBe(await cgroupOf(process.pid));
				expect(await cgroupOf(await startSleeper(broker))).toBe(brokerCgroup);
			});
		},
		30_000,
	);

	it.skipIf(!userManagerAnswers() || !realBusctl)(
		"retries a failed move and takes the daemons started meanwhile with it",
		async () => {
			using tempDir = TempDir.createSync("@omp-broker-scope-retry-");
			const count = path.join(tempDir.path(), "calls");
			// The first call fails as a timed-out manager would; later calls reach the real one.
			const bin = await fakeBusctl(
				path.join(tempDir.path(), "bin"),
				`echo x >> '${count}'; [ "$(wc -l < '${count}')" -gt 1 ] && exec '${realBusctl}' "$@"; echo 'Connection timed out' >&2; exit 1`,
			);
			await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }, () =>
				withSpawnedBroker(async broker => {
					const own = await cgroupOf(process.pid);
					expect(await cgroupOf(broker.pid)).toBe(own);
					const sleeper = await startSleeper(broker);
					expect(await cgroupOf(sleeper)).toBe(own);
					const moved = await until(
						async () => path.basename((await cgroupOf(broker.pid)) ?? "").startsWith(BROKER_SCOPE_UNIT_PREFIX),
						20_000,
					);
					expect(moved).toBe(true);
					const brokerCgroup = await cgroupOf(broker.pid);
					expect(await until(async () => (await cgroupOf(sleeper)) === brokerCgroup, 5_000)).toBe(true);
				}),
			);
		},
		40_000,
	);

	it.skipIf(!userManagerAnswers() || !realBusctl)(
		"moves a service's reparented worker, and moves processes the manager refuses through cgroup.procs",
		async () => {
			using tempDir = TempDir.createSync("@omp-broker-scope-orphan-");
			const count = path.join(tempDir.path(), "calls");
			// The first move fails; every AttachProcessesToUnit fails as it does for a process systemd
			// cannot read; other calls reach the real manager.
			const bin = await fakeBusctl(
				path.join(tempDir.path(), "bin"),
				[
					`echo x >> '${count}'`,
					`case "$*" in *AttachProcessesToUnit*) echo 'Invalid argument' >&2; exit 1;; esac`,
					`[ "$(wc -l < '${count}')" -gt 1 ] && exec '${realBusctl}' "$@"`,
					"echo 'Connection timed out' >&2; exit 1",
				].join("\n"),
			);
			await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }, () =>
				withSpawnedBroker(async broker => {
					const own = await cgroupOf(process.pid);
					// The subshell exits at once, so its `sleep 61` is reparented away from the service.
					const leader = await startSleeper(broker, "(sleep 61 &); exec sleep 60");
					const orphan = await until(
						async () => (await sessionMember(leader, "sleep\u000061\u0000")) !== undefined,
						5_000,
					);
					expect(orphan).toBe(true);
					const worker = (await sessionMember(leader, "sleep\u000061\u0000")) as number;
					expect(await cgroupOf(worker)).toBe(own);
					const moved = await until(
						async () => path.basename((await cgroupOf(broker.pid)) ?? "").startsWith(BROKER_SCOPE_UNIT_PREFIX),
						20_000,
					);
					expect(moved).toBe(true);
					const brokerCgroup = await cgroupOf(broker.pid);
					expect(await until(async () => (await cgroupOf(leader)) === brokerCgroup, 5_000)).toBe(true);
					expect(await until(async () => (await cgroupOf(worker)) === brokerCgroup, 5_000)).toBe(true);
					process.kill(worker, "SIGKILL");
				}),
			);
		},
		40_000,
	);

	it.skipIf(!userManagerAnswers() || !realBusctl)(
		"reconciles daemons when a move was carried out but its reply was lost",
		async () => {
			using tempDir = TempDir.createSync("@omp-broker-scope-lost-");
			const count = path.join(tempDir.path(), "calls");
			// The first call stalls, then reaches the real manager but reports a timeout.
			const bin = await fakeBusctl(
				path.join(tempDir.path(), "bin"),
				[
					`echo x >> '${count}'`,
					`[ "$(wc -l < '${count}')" -gt 1 ] && exec '${realBusctl}' "$@"`,
					`sleep 6; '${realBusctl}' "$@" >/dev/null 2>&1; echo 'Connection timed out' >&2; exit 1`,
				].join("\n"),
			);
			await withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }, () =>
				withSpawnedBroker(async broker => {
					const own = await cgroupOf(process.pid);
					// The broker serves at once, before the stalled call lands.
					const sleeper = await startSleeper(broker);
					expect(await cgroupOf(sleeper)).toBe(own);
					const settled = await until(async () => {
						const brokerCgroup = await cgroupOf(broker.pid);
						return (
							(await fs.readFile(count, "utf8")).trim().split("\n").length > 1 &&
							path.basename(brokerCgroup ?? "").startsWith(BROKER_SCOPE_UNIT_PREFIX) &&
							(await cgroupOf(sleeper)) === brokerCgroup
						);
					}, 30_000);
					expect(settled).toBe(true);
				}),
			);
		},
		50_000,
	);
});

/** A process in `leader`'s session whose command line is `cmdline`. */
async function sessionMember(leader: number, cmdline: string): Promise<number | undefined> {
	for (const entry of await fs.readdir("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid === leader) continue;
		try {
			if ((await fs.readFile(`/proc/${pid}/cmdline`, "utf8")) !== cmdline) continue;
			const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
			if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]) === leader) return pid;
		} catch {
			// Gone.
		}
	}
	return undefined;
}
