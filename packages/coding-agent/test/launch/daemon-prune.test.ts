import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { placeRuntimeData, removeRelocatedRuntimeData } from "../../src/launch/paths";
import { pruneDeadDaemonRuntimeDirs } from "../../src/launch/presence";

const STALE = new Date(Date.now() - 30 * 60_000);
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

	it("reclaims a dead scope's relocated Snap profile but keeps live and foreign targets", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-relocated-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		const snapOmp = path.join(tempDir.path(), "snap", "chromium", "common", "omp");
		const current = await scope(daemons, "aaaaaaaaaaaaaaaa", { pid: "dead", stale: true });
		const relocate = async (dir: string, target?: string): Promise<string> => {
			const profile = path.join(dir, "omp.browser.headless.profile");
			const relocated = target ?? path.join(snapOmp, profile);
			await fs.mkdir(path.join(relocated, "Default"), { recursive: true });
			await placeRuntimeData(profile, relocated);
			await fs.utimes(dir, STALE, STALE);
			return relocated;
		};
		// A real profile from an earlier non-Snap Chromium is shadowed by the link.
		const deadScope = await scope(daemons, "bbbbbbbbbbbbbbbb", { pid: "dead", stale: true });
		await fs.mkdir(path.join(deadScope, "omp.browser.headless.profile", "Default"), { recursive: true });
		const dead = await relocate(deadScope);
		expect(await fs.readlink(path.join(deadScope, "omp.browser.headless.profile"))).toBe(dead);
		const live = await relocate(await scope(daemons, "cccccccccccccccc", { pid: process.pid, stale: true }));
		// A link whose target does not mirror the scope path is never followed into a delete.
		const foreign = await relocate(
			await scope(daemons, "dddddddddddddddd", { pid: "dead", stale: true }),
			path.join(tempDir.path(), "user-data"),
		);

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(dead)).toBe(false);
		expect(await fs.exists(path.join(daemons, "bbbbbbbbbbbbbbbb"))).toBe(false);
		expect(await fs.exists(live)).toBe(true);
		expect(await fs.exists(foreign)).toBe(true);
		expect(await fs.exists(path.join(daemons, "dddddddddddddddd"))).toBe(false);
	});

	it("reclaims both Snap profiles after a dead scope retargets to another snap", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-retarget-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		const current = await scope(daemons, "aaaaaaaaaaaaaaaa", { pid: "dead", stale: true });
		const dead = await scope(daemons, "bbbbbbbbbbbbbbbb", { pid: "dead", stale: true });
		const live = await scope(daemons, "cccccccccccccccc", { pid: process.pid, stale: true });
		const profiles = async (dir: string) => {
			const original = path.join(dir, "omp.browser.headless.profile");
			const chromium = path.join(tempDir.path(), "snap", "chromium", "common", "omp", original);
			const other = path.join(tempDir.path(), "snap", "other", "common", "omp", original);
			await fs.mkdir(chromium, { recursive: true });
			await fs.mkdir(other, { recursive: true });
			await placeRuntimeData(original, chromium);
			await placeRuntimeData(original, other);
			await fs.utimes(dir, STALE, STALE);
			return { chromium, other };
		};
		const old = await profiles(dead);
		const active = await profiles(live);

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(old.chromium)).toBe(false);
		expect(await fs.exists(old.other)).toBe(false);
		expect(await fs.exists(active.chromium)).toBe(true);
		expect(await fs.exists(active.other)).toBe(true);
	});

	it("retains the Snap target for pruning when the profile returns to the standard path", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-relocation-return-");
		const profile = path.join(tempDir.path(), "run", "daemons", "aaaaaaaaaaaaaaaa", "omp.browser.headless.profile");
		const relocated = path.join(tempDir.path(), "snap", "chromium", "common", "omp", profile);
		await fs.mkdir(path.join(relocated, "Default"), { recursive: true });
		await fs.mkdir(path.dirname(profile), { recursive: true });
		await placeRuntimeData(profile, relocated);

		await placeRuntimeData(profile, profile);
		await fs.mkdir(profile, { recursive: true });

		expect((await fs.lstat(profile)).isDirectory()).toBe(true);
		expect(await fs.exists(relocated)).toBe(true); // Kept until the scope has no live broker.
		await removeRelocatedRuntimeData(path.dirname(profile));
		expect(await fs.exists(relocated)).toBe(false);
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

	it("does nothing when the runtime root does not exist", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-missing-");
		const current = path.join(tempDir.path(), "run", "daemons", "hash0000000000000");
		await expect(pruneDeadDaemonRuntimeDirs(current)).resolves.toBeUndefined();
	});
});
