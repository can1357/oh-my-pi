import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { ptree, readLines, untilAborted } from "@oh-my-pi/pi-utils";
import { DisasmDatabase } from "../../src/disasm/client";
import {
	DISASM_HOST_CONFIG_ENV,
	DISASM_HOST_WORKER_ARG,
	type HostConfig,
	hostReadyPattern,
} from "../../src/disasm/protocol";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../src/subprocess/worker-client";
import { createIdaWorkerRuntime } from "../helpers/ida-worker";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function hostFixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disasm-host-"));
	const saved = path.join(dir, "saved.txt");
	const endpoint = ipcEndpoint(dir, "host");
	const config: HostConfig = {
		backend: "ida",
		projectDir: dir,
		endpoint,
		loc: {
			id: "references",
			dir,
			sourcePath: path.join(dir, "stub.i64"),
			stagedPath: path.join(dir, "stub.i64"),
			kind: "inplace",
			openPath: path.join(dir, "stub.i64"),
			isNew: false,
			lockTarget: path.join(dir, "stub.i64"),
		},
		runtime: await createIdaWorkerRuntime(dir, { savePath: saved }),
		idleCloseMs: 1000,
	};
	const spawn = resolveWorkerSpawnCmd(DISASM_HOST_WORKER_ARG);
	const start = () => {
		const child = ptree.spawn(spawn.cmd, {
			cwd: spawn.cwd,
			env: workerEnvFromParent({ [DISASM_HOST_CONFIG_ENV]: JSON.stringify(config) }),
		});
		const ready = Promise.withResolvers<void>();
		const pattern = new RegExp(hostReadyPattern("ida"));
		const decoder = new TextDecoder();
		void (async () => {
			for await (const line of readLines(child.stdout)) {
				if (pattern.test(decoder.decode(line))) ready.resolve();
			}
			ready.reject(new Error(`Disassembler host exited before listening: ${child.peekStderr()}`));
		})().catch(ready.reject);
		void ready.promise.catch(() => {});
		return { child, ready: ready.promise };
	};
	let running = start();
	const clients: DisasmDatabase[] = [];
	cleanups.push(async () => {
		for (const client of clients) client.disconnect();
		if (running.child.exitCode === null) running.child.kill();
		await running.child.exited;
		await fs.rm(dir, { recursive: true, force: true });
	});
	const connect = async () => {
		await untilAborted(AbortSignal.timeout(10_000), running.ready);
		const client = await DisasmDatabase.attach("omp.ida.references", endpoint, "open");
		if (!client)
			throw new Error(`Listening disassembler host did not accept a connection: ${running.child.peekStderr()}`);
		clients.push(client);
		return client;
	};
	return {
		connect,
		saved,
		async exited() {
			await untilAborted(AbortSignal.timeout(10_000), running.child.exited);
		},
		restart() {
			running = start();
		},
	};
}

describe("disassembler host retained references", () => {
	it("keeps a child's reference alive across parent close and idle timeout, then saves on the last release", async () => {
		const host = await hostFixture();
		const parent = await host.connect();
		const child = await host.connect();
		const parentReference = await parent.retain();
		const childReference = await child.retain(parentReference.handle);
		expect((await child.refresh()).references).toBe(2);
		await parent.request("exec", { code: "db.persisted = 6 * 7" });
		await expect(child.release(parentReference.lease, { save: false })).rejects.toThrow("not owned");
		await parent.release(parentReference.lease, { save: true });
		await expect(parent.close({ save: false })).rejects.toThrow("active dsm references");
		// The worker's timers run in another process; exercise real idle-close pinning beyond its deadline.
		await Bun.sleep(1200);
		expect(await child.request("exec", { code: "6 * 7" })).toMatchObject({ value: "42", error: null });
		expect((await child.refresh()).references).toBe(1);
		await child.release(childReference.lease, { save: false });
		await host.exited();
		expect(await Bun.file(host.saved).text()).toBe("42");
	}, 30_000);

	it("reclaims a disconnected owner's references without dropping another owner's live database", async () => {
		const host = await hostFixture();
		const parent = await host.connect();
		const child = await host.connect();
		const parentReference = await parent.retain();
		const childReference = await child.retain(parentReference.handle);
		await child.request("exec", { code: "db.persisted = 7 * 6" });
		parent.disconnect();
		expect(await child.request("exec", { code: "6 * 7" })).toMatchObject({ value: "42", error: null });
		await child.release(childReference.lease, { save: false });
		await host.exited();
		expect(await Bun.file(host.saved).text()).toBe("42");
	}, 30_000);

	it("does not attach an old portable handle to a reopened database incarnation", async () => {
		const host = await hostFixture();
		const first = await host.connect();
		const old = await first.retain();
		await first.release(old.lease, { save: false });
		await host.exited();
		host.restart();
		const replacement = await host.connect();
		await expect(replacement.retain(old.handle)).rejects.toThrow("expired");
		expect((await replacement.refresh()).references).toBe(0);
		const current = await replacement.retain();
		expect(await replacement.request("exec", { code: "6 * 7" })).toMatchObject({ value: "42", error: null });
		await replacement.release(current.lease, { save: false });
		await host.exited();
		expect(await Bun.file(host.saved).exists()).toBe(false);
	}, 30_000);
});
