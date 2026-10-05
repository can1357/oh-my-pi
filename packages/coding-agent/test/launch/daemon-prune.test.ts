import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { pruneDeadDaemonRuntimeDirs, registerDaemonProjectPresence } from "../../src/launch/presence";

const STALE = new Date(Date.now() - 30 * 60_000);
/** Namespace identity no process on this host records: a different boot and PID namespace. */
const FOREIGN_DOMAIN = "00000000-0000-0000-0000-000000000000/pid:[1]";
let deadPid = 0;

async function scope(
	root: string,
	name: string,
	init: { pid?: number | "dead"; clients?: number[]; stale?: boolean },
): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(path.join(dir, "clients"), { recursive: true });
	if (init.pid !== undefined) {
		const pid = init.pid === "dead" ? deadPid : init.pid;
		await Bun.write(path.join(dir, "broker.pid"), JSON.stringify({ pid, instanceId: name }));
	}
	for (const clientPid of init.clients ?? []) {
		await Bun.write(
			path.join(dir, "clients", `${clientPid}-x.json`),
			JSON.stringify({ pid: clientPid, id: `${clientPid}-x`, projectDir: dir }),
		);
	}
	if (init.stale) await fs.utimes(dir, STALE, STALE);
	return dir;
}

describe("pruneDeadDaemonRuntimeDirs", () => {
	beforeAll(async () => {
		// A definitely-dead PID: spawn a process and reap it.
		const proc = Bun.spawn(["true"]);
		await proc.exited;
		deadPid = proc.pid;
	});

	it("removes only scopes with a dead broker, no live clients, and past the stale grace", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });

		const current = await scope(daemons, "aaaaaaaaaaaaaaaa", { pid: "dead", stale: true });
		await scope(daemons, "bbbbbbbbbbbbbbbb", { pid: "dead", stale: true });
		await scope(daemons, "cccccccccccccccc", { pid: process.pid, stale: true });
		await scope(daemons, "dddddddddddddddd", { clients: [process.pid], stale: true });
		await scope(daemons, "eeeeeeeeeeeeeeee", { pid: "dead" });
		// Machine-global daemon container must never be swept as a project scope.
		await fs.mkdir(path.join(daemons, "global", "some-service"), { recursive: true });
		await fs.utimes(path.join(daemons, "global"), STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		const remaining = new Set(await fs.readdir(daemons));
		expect(remaining.has("bbbbbbbbbbbbbbbb")).toBe(false); // pruned
		expect(remaining.has("aaaaaaaaaaaaaaaa")).toBe(true); // never prunes itself
		expect(remaining.has("cccccccccccccccc")).toBe(true); // live broker
		expect(remaining.has("dddddddddddddddd")).toBe(true); // live client presence
		expect(remaining.has("eeeeeeeeeeeeeeee")).toBe(true); // within stale grace
		expect(remaining.has("global")).toBe(true); // non-scope name skipped
	});

	it("does not sweep sibling machine-global service runtimes", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-global-");
		const globalRoot = path.join(tempDir.path(), "run", "daemons", "global");
		const current = await scope(globalRoot, "current-service", { pid: "dead", stale: true });
		const sibling = await scope(globalRoot, "persistent-service", { pid: "dead", stale: true });

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(sibling)).toBe(true);
	});

	it("never sweeps outside the daemons container when a runtime dir is relocated (issue #8721)", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-tmpdir-");
		// Simulate the smoke test relocating its runtime dir directly under a
		// shared temp root full of unrelated, aged directories.
		const fakeTmp = tempDir.path();
		for (const name of ["tmux-1000", "ssh-XVn1oP", "my-build-tree"]) {
			await fs.mkdir(path.join(fakeTmp, name, "src"), { recursive: true });
			await fs.utimes(path.join(fakeTmp, name), STALE, STALE);
		}
		const runtimeDir = path.join(fakeTmp, "omp-daemon-smoke-run-xxxx");
		await fs.mkdir(runtimeDir, { recursive: true });

		await pruneDeadDaemonRuntimeDirs(runtimeDir);

		const remaining = new Set(await fs.readdir(fakeTmp));
		expect(remaining.has("tmux-1000")).toBe(true);
		expect(remaining.has("ssh-XVn1oP")).toBe(true);
		expect(remaining.has("my-build-tree")).toBe(true);
	});

	it("keeps a scope whose broker answers on its endpoint although its recorded pids are not visible here", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-live-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		const projectDir = path.join(tempDir.path(), "project");
		const live = path.join(daemons, "aaaaaaaaaaaaaaaa");
		const current = path.join(daemons, "bbbbbbbbbbbbbbbb");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(current, { recursive: true });
		const owner = await createDaemonBrokerClient(projectDir, { runtimeDir: live, idleGraceMs: 5_000 });
		try {
			await owner.request({ op: "ping" });
			// Seen from another PID namespace sharing this directory, the broker's
			// and its session's pids name no process: `process.kill(pid, 0)` fails
			// exactly as it does for a reaped pid. Records without a namespace
			// identity are what older builds write.
			await Bun.write(path.join(live, "broker.pid"), JSON.stringify({ pid: deadPid }));
			const presence = path.join(live, "clients", `${deadPid}-x.json`);
			await Bun.write(presence, JSON.stringify({ pid: deadPid, id: `${deadPid}-x`, projectDir }));
			await fs.utimes(live, STALE, STALE);

			await pruneDeadDaemonRuntimeDirs(current);

			const fresh = await createDaemonBrokerClient(projectDir, { runtimeDir: live });
			try {
				const ping = await fresh.request({ op: "ping" });
				if (ping.op !== "ping") throw new Error(`unexpected daemon result ${ping.op}`);
				expect(ping.projectDir).toBe(fresh.projectDir);
			} finally {
				fresh.close();
			}
			expect(await fs.exists(presence)).toBe(true);
		} finally {
			try {
				await owner.request({ op: "shutdown" });
			} catch {
				// The broker may already be gone.
			}
			owner.close();
		}
	}, 30_000);

	it("keeps scopes holding records from another PID namespace and still reclaims dead ones from its own", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-foreign-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		const current = path.join(daemons, "aaaaaaaaaaaaaaaa");
		await fs.mkdir(current, { recursive: true });
		// A presence record exactly as this process registers one.
		const template = path.join(tempDir.path(), "template");
		const registered = await registerDaemonProjectPresence(tempDir.path(), template);
		const [entry] = await fs.readdir(path.join(template, "clients"));
		const own = (await Bun.file(path.join(template, "clients", entry)).json()) as Record<string, unknown>;
		await registered.close();

		// A session in another namespace registered before any broker started.
		const foreignPresence = await scope(daemons, "bbbbbbbbbbbbbbbb", {});
		const foreignEntry = path.join(foreignPresence, "clients", `${deadPid}-x.json`);
		await Bun.write(foreignEntry, JSON.stringify({ ...own, pid: deadPid, domain: FOREIGN_DOMAIN }));
		// A broker in another namespace that holds the lease but is not reachable here.
		const foreignBroker = await scope(daemons, "cccccccccccccccc", {});
		await Bun.write(path.join(foreignBroker, "broker.pid"), JSON.stringify({ pid: deadPid, domain: FOREIGN_DOMAIN }));
		// The same records from this namespace, with their processes gone.
		const ownDead = await scope(daemons, "dddddddddddddddd", {});
		await Bun.write(path.join(ownDead, "clients", `${deadPid}-x.json`), JSON.stringify({ ...own, pid: deadPid }));
		await Bun.write(path.join(ownDead, "broker.pid"), JSON.stringify({ pid: deadPid, domain: own.domain }));
		for (const dir of [foreignPresence, foreignBroker, ownDead]) await fs.utimes(dir, STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(foreignEntry)).toBe(true);
		expect(await fs.exists(path.join(foreignBroker, "broker.pid"))).toBe(true);
		expect(await fs.exists(ownDead)).toBe(false);
	});

	it("does nothing when the runtime root does not exist", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-missing-");
		const current = path.join(tempDir.path(), "run", "daemons", "hash0000000000000");
		await expect(pruneDeadDaemonRuntimeDirs(current)).resolves.toBeUndefined();
	});
});
