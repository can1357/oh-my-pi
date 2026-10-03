import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PsScope } from "@oh-my-pi/pi-tui/apps/ps-data";
import { TempDir } from "@oh-my-pi/pi-utils";
import { collectScope } from "../../src/cli/ps-data";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function startBroker(projectDir: string, runtimeDir: string): { listening: Promise<boolean>; finished: Promise<void> } {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	if (previousProjectDir === undefined) delete process.env[DAEMON_PROJECT_DIR_ENV];
	else process.env[DAEMON_PROJECT_DIR_ENV] = previousProjectDir;
	if (previousRuntimeDir === undefined) delete process.env[DAEMON_RUNTIME_DIR_ENV];
	else process.env[DAEMON_RUNTIME_DIR_ENV] = previousRuntimeDir;
	if (previousGrace === undefined) delete process.env[DAEMON_IDLE_GRACE_ENV];
	else process.env[DAEMON_IDLE_GRACE_ENV] = previousGrace;
	return { listening: listening.promise, finished };
}

describe("daemon metadata writes", () => {
	it("does not rewrite settled history on subscriber changes or broker restart", async () => {
		using tempDir = TempDir.createSync("@omp-broker-metadata-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const metadataPath = path.join(runtimeDir, "daemons", "historical", "meta.json");
		await fs.mkdir(projectDir);
		await Bun.write(
			metadataPath,
			JSON.stringify({
				daemon: {
					name: "historical",
					id: "historical",
					state: "exited",
					owner: "shared-session",
					createdAt: 1,
					startedAt: 1,
					exitedAt: 2,
					restartCount: 0,
					outputBytes: 0,
					persist: false,
					detached: false,
				},
				spec: {
					name: "historical",
					application: process.execPath,
					args: [],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			}),
		);
		const initialClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const initialBroker = startBroker(projectDir, runtimeDir);
		try {
			await initialBroker.listening;
			await initialClient.request({ op: "ping" });
		} finally {
			await initialClient.request({ op: "shutdown" }).catch(() => undefined);
			initialClient.close();
			await initialBroker.finished;
		}
		// The initial recovery migrates the legacy layout (spec embedded in
		// meta.json) to spec.json + small metadata. Shutdown flushes all queued
		// metadata writes before establishing the stable inode baseline.
		const specPath = path.join(runtimeDir, "daemons", "historical", "spec.json");
		expect(await Bun.file(metadataPath).json()).not.toHaveProperty("spec");
		expect(await Bun.file(specPath).json()).toMatchObject({ cwd: projectDir });
		const inode = (await fs.stat(metadataPath)).ino;
		const specInode = (await fs.stat(specPath)).ino;
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			first.onCompletion("shared-session", () => undefined);
			second.onCompletion("shared-session", () => undefined);
			for (let index = 0; index < 3; index++) {
				await first.request({ op: "ping" });
				await second.request({ op: "ping" });
			}
			await first.request({ op: "shutdown" });
			first.close();
			second.close();
			await broker.finished;
		} finally {
			await first.request({ op: "shutdown" }).catch(() => undefined);
			first.close();
			second.close();
			await broker.finished;
		}
		expect((await fs.stat(metadataPath)).ino).toBe(inode);
		expect((await fs.stat(specPath)).ino).toBe(specInode);

		const restartClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const restarted = startBroker(projectDir, runtimeDir);
		try {
			await restarted.listening;
			await restartClient.request({ op: "ping" });
			await restartClient.request({ op: "shutdown" });
			await restarted.finished;
			expect((await fs.stat(metadataPath)).ino).toBe(inode);
		} finally {
			restartClient.close();
			await restarted.finished;
		}

		const relaunchClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const relaunchBroker = startBroker(projectDir, runtimeDir);
		try {
			await relaunchBroker.listening;
			relaunchClient.onCompletion("shared-session", () => undefined);
			await relaunchClient.request({ op: "restart", name: "historical" });
			const metadata = (await Bun.file(metadataPath).json()) as { completionEvents: boolean };
			expect(metadata.completionEvents).toBe(true);
		} finally {
			await relaunchClient.request({ op: "shutdown" }).catch(() => undefined);
			relaunchClient.close();
			await relaunchBroker.finished;
		}
	}, 20_000);

	it("writes the launch spec once and keeps lifecycle metadata free of it", async () => {
		using tempDir = TempDir.createSync("@omp-broker-spec-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const daemonDir = path.join(runtimeDir, "daemons", "lifecycle");
		const specPath = path.join(daemonDir, "spec.json");
		const metadataPath = path.join(daemonDir, "meta.json");
		await fs.mkdir(projectDir);
		const marker = "SPEC_ONLY_MARKER_".repeat(64);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		let specStat: { ino: number; mtimeMs: number } | undefined;
		try {
			await broker.listening;
			const started = await client.request({
				op: "start",
				spec: {
					name: "lifecycle",
					application: process.execPath,
					args: ["-e", "setTimeout(() => {}, 200)"],
					env: { OMP_SPEC_TEST_MARKER: marker },
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			specStat = await fs.stat(specPath);
			// starting -> running (pid) -> exited: each transition persists metadata only.
			const waited = await client.request({ op: "wait", name: "lifecycle", for: "exit", timeoutMs: 10_000 });
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.daemon.state).toBe("exited");
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
		}
		const after = await fs.stat(specPath);
		expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: specStat!.ino, mtimeMs: specStat!.mtimeMs });
		expect(await Bun.file(specPath).json()).toMatchObject({ env: { OMP_SPEC_TEST_MARKER: marker } });
		const metadata = await Bun.file(metadataPath).text();
		expect(metadata).not.toContain("SPEC_ONLY_MARKER_");
		expect(JSON.parse(metadata)).toMatchObject({ daemon: { state: "exited" } });
	}, 20_000);

	it("lists split-layout and legacy records in `omp ps` offline and while the broker is live", async () => {
		using tempDir = TempDir.createSync("@omp-broker-ps-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const writeRecord = async (name: string, layout: "split" | "legacy") => {
			const daemon = {
				name,
				id: name,
				state: "exited",
				owner: "ps-session",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				restartCount: 0,
				outputBytes: 0,
				persist: false,
				detached: false,
			};
			const spec = {
				name,
				application: process.execPath,
				args: ["-e", name],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			};
			const dir = path.join(runtimeDir, "daemons", name);
			if (layout === "legacy") {
				await Bun.write(path.join(dir, "meta.json"), JSON.stringify({ daemon, spec }));
				return;
			}
			await Bun.write(path.join(dir, "spec.json"), JSON.stringify(spec));
			await Bun.write(path.join(dir, "meta.json"), JSON.stringify({ daemon }));
		};
		await writeRecord("split", "split");
		await writeRecord("legacy", "legacy");
		const rows = async (brokerPid: number | undefined) => {
			const scope: PsScope = { kind: "project", runtimeDir, projectDir, brokerPid };
			const report = await collectScope(scope);
			return report.daemons
				.map(row => ({ name: row.snapshot.name, command: row.command, cwd: row.cwd, supervised: row.supervised }))
				.sort((a, b) => a.name.localeCompare(b.name));
		};
		const expected = (supervised: boolean) =>
			["legacy", "split"].map(name => ({
				name,
				command: `${process.execPath} -e ${name}`,
				cwd: projectDir,
				supervised,
			}));

		expect(await rows(undefined)).toEqual(expected(false));

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			await client.request({ op: "ping" });
			// The in-process broker serves the scope; recovery migrated "legacy" to the split layout.
			expect(await rows(process.pid)).toEqual(expected(true));
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
		}
		expect(await Bun.file(path.join(runtimeDir, "daemons", "legacy", "meta.json")).json()).not.toHaveProperty("spec");
		expect(await rows(undefined)).toEqual(expected(false));
	}, 20_000);
});
