// Integration test - real timers are required (ts-no-test-timers exception):
// every broker assertion below observes a real broker-launched process, its real
// Unix socket and its persisted discovery sidecar. The awaited signals are file
// markers, process liveness and socket frames, never fixed delays.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { SESSION_OWNER_WORKER_ARG } from "../../src/cli/worker-selectors";
import type { DaemonRpcResult } from "../../src/launch/protocol";
import {
	consumeSessionOwnerContext,
	SESSION_OWNER_CONTEXT_ENV,
	sessionOwnerContext,
	sessionOwnerSpec,
} from "../../src/launch/session-owner";
import { terminalSpec, withTerminalBroker } from "./terminal-fixture";

const OWNER_CHILD = path.join(import.meta.dir, "../fixtures/session-owner-child.ts");
const LAUNCHER = path.join(import.meta.dir, "../fixtures/session-owner-launcher.ts");
const CLI_ENTRY = path.join(import.meta.dir, "../../src/cli.ts");
const PACKAGE_ROOT = path.resolve(import.meta.dir, "../..");

interface OwnerReport {
	pid: number;
	context: { projectDir: string; name: string; id: string };
	liveContext: { projectDir: string; name: string; id: string } | null;
	endpoint: string | null;
	sidecarPath: string | null;
	sessionId: string;
	envConsumed: boolean;
	grandchildEnv: string;
}

async function yieldTask(): Promise<void> {
	const yielded = Promise.withResolvers<void>();
	setTimeout(yielded.resolve, 10);
	await yielded.promise;
}

async function waitForJson<T>(file: string, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			try {
				return JSON.parse(fs.readFileSync(file, "utf8")) as T;
			} catch {}
		}
		await yieldTask();
	}
	throw new Error(`timed out waiting for ${file}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await yieldTask();
	}
	throw new Error(message);
}

async function readReady(endpoint: string): Promise<Record<string, unknown>> {
	const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 4_000 });
	const ready = Promise.withResolvers<Record<string, unknown>>();
	conn.start(
		line => {
			const frame = JSON.parse(line) as Record<string, unknown>;
			if (frame.type === "ready") ready.resolve(frame);
		},
		() => {},
	);
	try {
		return await withTimeout(ready.promise, 5_000, "session owner socket never sent ready");
	} finally {
		conn.destroy();
	}
}

describe("session owner context", () => {
	it("consumes the launch context and erases it from the inherited environment", () => {
		const env: Record<string, string | undefined> = {
			[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: "/p", name: "mind-a", id: "generation-a" }),
		};

		expect(consumeSessionOwnerContext(env)).toEqual({ projectDir: "/p", name: "mind-a", id: "generation-a" });
		expect(env[SESSION_OWNER_CONTEXT_ENV]).toBeUndefined();
		expect(sessionOwnerContext()).toEqual({ projectDir: "/p", name: "mind-a", id: "generation-a" });
	});

	it("rejects malformed context and still removes the private variable", () => {
		const env: Record<string, string | undefined> = { [SESSION_OWNER_CONTEXT_ENV]: "not json" };

		expect(() => consumeSessionOwnerContext(env)).toThrow(TypeError);
		expect(env[SESSION_OWNER_CONTEXT_ENV]).toBeUndefined();
	});

	it("rejects context without every coordinate", () => {
		const env: Record<string, string | undefined> = {
			[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({ projectDir: "/p" }),
		};

		expect(() => consumeSessionOwnerContext(env)).toThrow("no daemon name");
	});

	it("builds a persistent PTY spec that re-enters the CLI with the hidden selector", () => {
		const spec = sessionOwnerSpec({
			name: "mind-a",
			projectDir: "/p",
			argv: ["--resume", "sess-1"],
			env: { [SESSION_OWNER_CONTEXT_ENV]: "stale", KEEP: "1" },
		});

		expect(spec).toMatchObject({
			name: "mind-a",
			cwd: "/p",
			pty: true,
			persist: true,
			detached: false,
			restart: "no",
			env: { KEEP: "1" },
		});
		expect(spec.args.slice(-3)).toEqual([SESSION_OWNER_WORKER_ARG, "--resume", "sess-1"]);
	});
});

describe("session owner CLI dispatch", () => {
	it("restarts the normal CLI once from the hidden owner selector", async () => {
		using tempDir = TempDir.createSync("@omp-owner-cli-");
		const child = Bun.spawn([process.execPath, CLI_ENTRY, SESSION_OWNER_WORKER_ARG, "--version"], {
			cwd: tempDir.path(),
			env: {
				...process.env,
				[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({
					projectDir: tempDir.path(),
					name: "mind-a",
					id: "generation-a",
				}),
				PI_CODING_AGENT_DIR: tempDir.path(),
			},
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain(VERSION);
	}, 30_000);

	it("refuses the hidden worker selector without broker launch context", async () => {
		using tempDir = TempDir.createSync("@omp-owner-cli-");
		const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: tempDir.path() };
		delete env[SESSION_OWNER_CONTEXT_ENV];
		const child = Bun.spawn([process.execPath, CLI_ENTRY, SESSION_OWNER_WORKER_ARG], {
			cwd: tempDir.path(),
			env,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("session owner");
	}, 30_000);
});

describe("session owner through the broker", () => {
	it("publishes the owning process's pid and broker coordinates", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			using tempDir = TempDir.createSync("@omp-owner-publish-");
			const endpointDir = path.join(tempDir.path(), "endpoints");
			const reportFile = path.join(tempDir.path(), "report.json");
			const name = `mind-${Snowflake.next()}`;
			const forged = { projectDir: "/forged/project", name: "not-this-mind", id: "not-this-generation" };
			const subscriptionId = `view-${Snowflake.next()}`;
			const spec = terminalSpec(projectDir, "", {
				name,
				args: [OWNER_CHILD, endpointDir, reportFile],
				env: {
					[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify(forged),
					FIXTURE_SESSION_ID: `sess-${Snowflake.next()}`,
				},
			});
			const off = client.subscribeTerminal(subscriptionId, () => {});
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 100,
					rows: 30,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				const report = await waitForJson<OwnerReport>(reportFile);

				expect(report.context).toEqual({ projectDir, name, id: started.daemon.id });
				expect(report.liveContext).toEqual(report.context);
				expect(started.daemon.pid).toBe(report.pid);
				expect(report.pid).not.toBe(process.pid);
				expect(Process.fromPid(report.pid)?.status()).toBe(ProcessStatus.Running);

				const sidecarPath = report.sidecarPath;
				const endpoint = report.endpoint;
				if (sidecarPath === null || endpoint === null) throw new Error("owner published no discovery");
				const metadata = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
				expect(metadata).toMatchObject({
					pid: report.pid,
					sessionId: report.sessionId,
					terminal: { protocolVersion: 1, ...report.context },
				});
				expect(await readReady(endpoint)).toMatchObject({ type: "ready", protocolVersion: 1 });
			} finally {
				off();
				await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			}
		});
	}, 30_000);

	it("survives the launcher exiting and keeps its discovery record", async () => {
		await withTerminalBroker(async ({ client, projectDir, runtimeDir }) => {
			using tempDir = TempDir.createSync("@omp-owner-survive-");
			const endpointDir = path.join(tempDir.path(), "endpoints");
			const reportFile = path.join(tempDir.path(), "report.json");
			const name = `mind-${Snowflake.next()}`;
			const launchSubscription = `launch-${Snowflake.next()}`;
			const spec = terminalSpec(projectDir, "", {
				name,
				args: [OWNER_CHILD, endpointDir, reportFile],
				env: { FIXTURE_SESSION_ID: `sess-${Snowflake.next()}` },
			});
			const launcher = Bun.spawn(
				[
					process.execPath,
					LAUNCHER,
					projectDir,
					runtimeDir,
					JSON.stringify({
						op: "terminal_start",
						subscriptionId: launchSubscription,
						spec,
						columns: 100,
						rows: 30,
					}),
				],
				{ cwd: projectDir, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(launcher.stdout).text(),
				new Response(launcher.stderr).text(),
				launcher.exited,
			]);
			expect(stderr.trim()).toBe("");
			expect(exitCode).toBe(0);
			const started = JSON.parse(stdout) as Extract<DaemonRpcResult, { op: "terminal_start" }>;
			const report = await waitForJson<OwnerReport>(reportFile);
			expect(started.daemon.pid).toBe(report.pid);

			const described = await client.request({ op: "describe", name });
			if (described.op !== "describe") throw new Error("unexpected describe result");
			expect(described.daemon.state).toBe("running");
			expect(described.daemon.pid).toBe(report.pid);
			expect(Process.fromPid(report.pid)?.status()).toBe(ProcessStatus.Running);
			expect(report.sidecarPath === null ? false : fs.existsSync(report.sidecarPath)).toBe(true);
			expect(report.endpoint === null ? false : fs.existsSync(report.endpoint)).toBe(true);

			const frames: string[] = [];
			const attachSubscription = `attach-${Snowflake.next()}`;
			const off = client.subscribeTerminal(attachSubscription, frame => {
				if (frame.event === "terminal_output") frames.push(frame.data);
			});
			try {
				const attached = await client.request({
					op: "terminal_attach",
					subscriptionId: attachSubscription,
					name,
					id: report.context.id,
					columns: 80,
					rows: 24,
				});
				expect(attached.op).toBe("terminal_attach");
				await waitUntil(
					() => frames.join("").includes("OWNER_TICK"),
					5_000,
					"surviving owner never streamed a heartbeat",
				);
			} finally {
				off();
				await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			}
		});
	}, 30_000);

	it("never exposes or inherits the owner role", async () => {
		await withTerminalBroker(async ({ client, projectDir }) => {
			using tempDir = TempDir.createSync("@omp-owner-role-");
			const endpointDir = path.join(tempDir.path(), "endpoints");
			const reportFile = path.join(tempDir.path(), "report.json");
			const name = `mind-${Snowflake.next()}`;
			const subscriptionId = `view-${Snowflake.next()}`;
			const forged = { projectDir: "/forged/project", name: "not-this-mind", id: "not-this-generation" };
			const spec = terminalSpec(projectDir, "", {
				name,
				args: [OWNER_CHILD, endpointDir, reportFile],
				env: {
					[SESSION_OWNER_CONTEXT_ENV]: JSON.stringify(forged),
					FIXTURE_SESSION_ID: `sess-${Snowflake.next()}`,
				},
			});
			const off = client.subscribeTerminal(subscriptionId, () => {});
			try {
				const started = await client.request({
					op: "terminal_start",
					subscriptionId,
					spec,
					columns: 100,
					rows: 30,
				});
				if (started.op !== "terminal_start") throw new Error("unexpected terminal_start result");
				const report = await waitForJson<OwnerReport>(reportFile);
				expect(report.context).not.toEqual(forged);
				expect(report.envConsumed).toBe(true);
				expect(report.grandchildEnv).toBe("absent");

				const probe = Bun.spawn(
					[
						process.execPath,
						"-e",
						'const m = await import("@oh-my-pi/pi-coding-agent/launch/session-owner"); process.stdout.write(String(m.isSessionOwnerProcess() === false && m.sessionOwnerContext() === undefined));',
					],
					{
						cwd: PACKAGE_ROOT,
						env: { ...process.env, [SESSION_OWNER_CONTEXT_ENV]: JSON.stringify(forged) },
						stdout: "pipe",
						stderr: "pipe",
						stdin: "ignore",
					},
				);
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(probe.stdout).text(),
					new Response(probe.stderr).text(),
					probe.exited,
				]);
				expect(stderr).toBe("");
				expect(exitCode).toBe(0);
				expect(stdout.trim()).toBe("true");
			} finally {
				off();
				await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			}
		});
	}, 30_000);
});
