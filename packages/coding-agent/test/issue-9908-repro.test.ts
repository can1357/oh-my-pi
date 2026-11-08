/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/9908
 *
 * Every omp process used to spawn its own `__omp_worker_mnemopi_embed` child
 * and keep the embedding model resident for the whole process lifetime
 * (0.8–1.6 GB per session). Embeddings now go through one machine-shared
 * server per (model, cache dir) that exits once idle. This test spawns the
 * real server through the CLI entry; it only pings, so no model is loaded.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { mnemopiEmbedLaunch, mnemopiEmbedServerName } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import {
	MNEMOPI_EMBED_IDLE_MS_ENV,
	type MnemopiEmbedServerRequest,
	type MnemopiEmbedServerResponse,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";
import {
	connectSharedWorker,
	type SharedWorkerLaunch,
	type SpawnedWorker,
} from "@oh-my-pi/pi-coding-agent/subprocess/shared-worker";

const MODEL = "fast-bge-small-en-v1.5";

describe("issue #9908 — one embedding server per model, freed once idle", () => {
	it("serves every client from a single server process that exits after the idle window", async () => {
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-embed-9908-"));
		const spawned: SpawnedWorker[] = [];
		const base = mnemopiEmbedLaunch(MODEL, { [MNEMOPI_EMBED_IDLE_MS_ENV]: "2000" });
		const launch: SharedWorkerLaunch = {
			...base,
			async spawn(endpoint, logPath) {
				const worker = await base.spawn(endpoint, logPath);
				spawned.push(worker);
				return worker;
			},
		};
		const name = mnemopiEmbedServerName(MODEL, path.join(runtimeDir, "cache"));
		try {
			const sessionA = await connectSharedWorker<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>(
				launch,
				runtimeDir,
				name,
			);
			const sessionB = await connectSharedWorker<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>(
				launch,
				runtimeDir,
				name,
			);
			expect(spawned).toHaveLength(1);

			await sessionA.terminate();
			await sessionB.terminate();
			const server = spawned[0]!;
			// Spawned detached and unref'd; hold the loop while awaiting its idle exit.
			server.proc.ref();
			expect(await server.proc.exited).toBe(0);
			if (process.platform !== "win32") {
				await expect(fs.stat(ipcEndpoint(runtimeDir, name))).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			for (const worker of spawned) worker.proc.kill();
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	}, 30_000);
});
