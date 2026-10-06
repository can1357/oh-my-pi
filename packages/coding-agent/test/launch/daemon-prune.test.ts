import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";
import {
	hasLiveDaemonProjectPresence,
	pruneDeadDaemonRuntimeDirs,
	registerDaemonProjectPresence,
} from "../../src/launch/presence";

const STALE = new Date(Date.now() - 30 * 60_000);
/** Namespace identity no process on this host records: a different boot and PID namespace. */
const FOREIGN_DOMAIN = "00000000-0000-0000-0000-000000000000/pid:[1]";
const PRESENCE_WRITER = path.join(import.meta.dir, "..", "fixtures", "daemon-presence-writer.ts");
let deadPid = 0;

beforeAll(async () => {
	// A definitely-dead PID: spawn a process and reap it.
	const proc = Bun.spawn(["true"]);
	await proc.exited;
	deadPid = proc.pid;
});

/** A presence record exactly as this process registers one. */
async function ownPresenceRecord(tempRoot: string): Promise<Record<string, unknown>> {
	const template = path.join(tempRoot, "template");
	const registered = await registerDaemonProjectPresence(tempRoot, template);
	const [entry] = await fs.readdir(path.join(template, "clients"));
	const record = (await Bun.file(path.join(template, "clients", entry)).json()) as Record<string, unknown>;
	await registered.close();
	return record;
}

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
		const own = await ownPresenceRecord(tempDir.path());

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

	it("keeps a scope registered by a process on another platform", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-platform-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		const current = path.join(daemons, "aaaaaaaaaaaaaaaa");
		const other = path.join(daemons, "bbbbbbbbbbbbbbbb");
		await fs.mkdir(current, { recursive: true });
		// A macOS host and a Linux container sharing one home, say: a pid written
		// on the other platform names nothing here. The writer is killed so its
		// entry stays behind, as it would for a process this sweeper cannot see.
		const platform = process.platform === "darwin" ? "win32" : "darwin";
		const writer = Bun.spawn([process.execPath, PRESENCE_WRITER, platform, tempDir.path(), other], {
			stdout: "pipe",
			stderr: "inherit",
		});
		try {
			await (writer.stdout as ReadableStream<Uint8Array>).getReader().read();
		} finally {
			writer.kill("SIGKILL");
			await writer.exited;
		}
		await fs.utimes(other, STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.readdir(path.join(other, "clients"))).toHaveLength(1);
	});

	// Mode bits do not bind root, and on Windows the endpoint is a named pipe, not this socket.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps a scope whose endpoint fails the probe for a reason other than nothing listening",
		async () => {
			using tempDir = TempDir.createSync("@omp-daemon-prune-busy-");
			const daemons = path.join(tempDir.path(), "run", "daemons");
			const current = path.join(daemons, "aaaaaaaaaaaaaaaa");
			await fs.mkdir(current, { recursive: true });
			const busy = await scope(daemons, "bbbbbbbbbbbbbbbb", { pid: "dead", clients: [deadPid] });
			const endpoint = path.join(busy, "broker.sock");
			const server = net.createServer(socket => socket.destroy());
			const listening = Promise.withResolvers<void>();
			server.listen(endpoint, () => listening.resolve());
			await listening.promise;
			try {
				// A live listener this process may not connect to (EACCES), which says
				// nothing about whether the broker is gone. (A full accept queue is no
				// such case: Bun reports it as ECONNREFUSED, which reads as dead.)
				await fs.chmod(endpoint, 0o000);
				await fs.utimes(busy, STALE, STALE);

				await pruneDeadDaemonRuntimeDirs(current);

				expect(await fs.exists(busy)).toBe(true);
			} finally {
				server.close();
			}
		},
	);

	// EPERM does not bind root, and Windows never assigns pid 1.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps a scope whose recorded process runs under another user",
		async () => {
			using tempDir = TempDir.createSync("@omp-daemon-prune-uid-");
			const daemons = path.join(tempDir.path(), "run", "daemons");
			const current = path.join(daemons, "aaaaaaaaaaaaaaaa");
			await fs.mkdir(current, { recursive: true });
			const own = await ownPresenceRecord(tempDir.path());
			const otherUser = await scope(daemons, "bbbbbbbbbbbbbbbb", {});
			// pid 1 runs as root: `process.kill(1, 0)` fails with EPERM, which means it exists.
			const entry = path.join(otherUser, "clients", "1-x.json");
			await Bun.write(entry, JSON.stringify({ ...own, pid: 1 }));
			await fs.utimes(otherUser, STALE, STALE);

			await pruneDeadDaemonRuntimeDirs(current);

			expect(await fs.exists(entry)).toBe(true);
		},
	);

	// Mode bits do not bind root, and Windows has no POSIX modes.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps scopes whose broker lease or presence entry this process cannot read",
		async () => {
			using tempDir = TempDir.createSync("@omp-daemon-prune-unreadable-");
			const daemons = path.join(tempDir.path(), "run", "daemons");
			const current = path.join(daemons, "aaaaaaaaaaaaaaaa");
			await fs.mkdir(current, { recursive: true });
			// Records of this live process that the sweeper may not read, as when a
			// read fails for any reason but a missing file: their process can be
			// proven neither alive nor dead.
			const own = await ownPresenceRecord(tempDir.path());
			const presenceScope = await scope(daemons, "bbbbbbbbbbbbbbbb", {});
			const entry = path.join(presenceScope, "clients", `${process.pid}-x.json`);
			await Bun.write(entry, JSON.stringify(own));
			await fs.chmod(entry, 0o000);
			const leaseScope = await scope(daemons, "cccccccccccccccc", {});
			const lease = path.join(leaseScope, "broker.pid");
			await Bun.write(lease, JSON.stringify({ pid: process.pid, domain: own.domain }));
			await fs.chmod(lease, 0o000);
			for (const dir of [presenceScope, leaseScope]) await fs.utimes(dir, STALE, STALE);

			await pruneDeadDaemonRuntimeDirs(current);

			expect({ entry: await fs.exists(entry), lease: await fs.exists(lease) }).toEqual({ entry: true, lease: true });
		},
	);

	it("does nothing when the runtime root does not exist", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-missing-");
		const current = path.join(tempDir.path(), "run", "daemons", "hash0000000000000");
		await expect(pruneDeadDaemonRuntimeDirs(current)).resolves.toBeUndefined();
	});
});

describe("hasLiveDaemonProjectPresence", () => {
	it("leaves presence from another PID namespace in place without counting it, and removes its own dead entries", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-presence-idle-");
		const own = await ownPresenceRecord(tempDir.path());
		const runtimeDir = path.join(tempDir.path(), "scope");
		const foreignEntry = path.join(runtimeDir, "clients", `${deadPid}-foreign.json`);
		const ownDeadEntry = path.join(runtimeDir, "clients", `${deadPid}-own.json`);
		await Bun.write(foreignEntry, JSON.stringify({ ...own, pid: deadPid, domain: FOREIGN_DOMAIN }));
		await Bun.write(ownDeadEntry, JSON.stringify({ ...own, pid: deadPid }));

		// The broker's idle check: an entry it cannot prove alive does not keep it up,
		expect(await hasLiveDaemonProjectPresence(runtimeDir)).toBe(false);
		// but one it cannot prove dead stays for later sweeps, which keep its scope.
		expect(await fs.exists(foreignEntry)).toBe(true);
		expect(await fs.exists(ownDeadEntry)).toBe(false);
	});
});
