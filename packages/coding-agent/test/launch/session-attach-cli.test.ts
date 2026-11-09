// Integration test — real child processes and a real broker are required
// (ts-no-test-timers exception): the CLI attaches to a live owner over the
// broker's PTY stream, and the assertion counts real session files. Awaited
// signals are child exits and socket frames, never fixed delays.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { probeSessionAttach } from "../../src/launch/session-attach";
import { readSessionInfo } from "../../src/session/session-listing";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const CLI_ENTRY = path.join(import.meta.dir, "../../src/cli.ts");
const LAUNCHER = path.join(import.meta.dir, "../fixtures/session-attach-cli-broker.ts");
const CLI_TIMEOUT_MS = 45_000;
const SINGLETON_BROKER_CLI = process.env.OMP_TEST_SINGLETON_BROKER_CLI;

interface OwnerReport {
	readonly name: string;
	readonly id: string;
	readonly pid: number;
	readonly runtimeDir: string;
	readonly brokerCli: string;
	readonly brokerTerminalProtocol: number;
}

interface RefreshEndpoint {
	readonly frames: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

function sessionDirNames(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.sort();
}

async function createSession(sessionsDir: string, cwd: string): Promise<{ sessionId: string; sessionPath: string }> {
	const manager = SessionManager.create(cwd, sessionsDir, new FileSessionStorage());
	await manager.ensureOnDisk();
	manager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
	await manager.flush();
	const sessionPath = manager.getSessionFile();
	if (!sessionPath) throw new Error("expected a session file");
	await manager.close();
	const session = await readSessionInfo(sessionPath);
	if (!session) throw new Error("expected a readable session header");
	return { sessionId: session.id, sessionPath };
}

async function waitForJson<T>(file: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return JSON.parse(fs.readFileSync(file, "utf8")) as T;
		} catch {}
		await Bun.sleep(20);
	}
	throw new Error(`timed out waiting for ${file}`);
}

function cliEnvironment(homeDir: string, agentDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "TERM", "LANG", "USER"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	env.HOME = homeDir;
	env.USERPROFILE = homeDir;
	env.PI_CODING_AGENT_DIR = agentDir;
	env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
	return env;
}

interface CliResult {
	readonly exitCode: number;
	readonly output: string;
}

async function runCli(homeDir: string, agentDir: string, projectDir: string, args: string[]): Promise<CliResult> {
	const chunks: Uint8Array[] = [];
	await using terminal = new Bun.Terminal({
		cols: 120,
		rows: 40,
		data(_terminal, data) {
			chunks.push(data);
		},
	});
	const child = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
		cwd: projectDir,
		env: cliEnvironment(homeDir, agentDir),
		terminal,
	});
	try {
		const exitCode = await withTimeout(child.exited, CLI_TIMEOUT_MS, `omp ${args.join(" ")} did not exit`);
		return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
	} catch (error) {
		child.kill("SIGKILL");
		const output = Buffer.concat(chunks).toString("utf8");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n--- output ---\n${output.slice(-4000)}`,
		);
	}
}

class CliViewer {
	readonly terminal: Bun.Terminal;
	readonly child: Bun.Subprocess;
	readonly #chunks: Uint8Array[] = [];
	readonly #listeners = new Set<() => void>();

	constructor(homeDir: string, agentDir: string, projectDir: string, sessionPath: string) {
		this.terminal = new Bun.Terminal({
			cols: 120,
			rows: 40,
			data: (_terminal, data) => {
				this.#chunks.push(data);
				for (const listener of this.#listeners) listener();
			},
		});
		this.child = Bun.spawn([process.execPath, CLI_ENTRY, "--attach", sessionPath], {
			cwd: projectDir,
			env: cliEnvironment(homeDir, agentDir),
			terminal: this.terminal,
		});
		void this.child.exited.then(() => {
			for (const listener of this.#listeners) listener();
		});
	}

	get output(): string {
		return Buffer.concat(this.#chunks).toString("utf8");
	}

	async waitForText(text: string, occurrences = 1): Promise<void> {
		const settled = Promise.withResolvers<void>();
		const observe = (): void => {
			if (this.output.split(text).length - 1 >= occurrences) settled.resolve();
			else if (this.child.exitCode !== null) settled.reject(new Error(`Viewer exited: ${this.output}`));
		};
		this.#listeners.add(observe);
		observe();
		try {
			await withTimeout(settled.promise, CLI_TIMEOUT_MS, `viewer did not show ${text}: ${this.output}`);
		} finally {
			this.#listeners.delete(observe);
		}
	}

	async close(): Promise<number> {
		if (this.child.exitCode === null) this.child.kill("SIGTERM");
		try {
			return await withTimeout(this.child.exited, 10_000, "viewer did not detach");
		} finally {
			if (this.child.exitCode === null) this.child.kill("SIGKILL");
			this.terminal.close();
		}
	}
}

function serveSessionEndpoint(
	endpoint: string,
	sessionId: string,
	generation: string,
	onRefresh: () => void,
	options: { sessionPath?: string; beforeState?: () => Promise<void> } = {},
): Promise<RefreshEndpoint> {
	const frames: Array<Record<string, unknown>> = [];
	const connections = new Set<IpcConnection>();
	const listening = IpcServer.listen(endpoint, { framing: "lines" }, connection => {
		connections.add(connection);
		connection.start(
			async line => {
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}
				frames.push(frame);
				if (frame.type === "get_state") {
					await options.beforeState?.();
					connection.send(
						JSON.stringify({
							type: "response",
							id: frame.id,
							command: "get_state",
							success: true,
							data: { sessionId, sessionFile: options.sessionPath, isStreaming: false },
						}),
					);
					return;
				}
				if (frame.type === "terminal_refresh") {
					if (frame.sessionId !== sessionId || frame.generation !== generation) {
						connection.send(
							JSON.stringify({ type: "terminal_refresh_error", id: frame.id, message: "not this attachment" }),
						);
						return;
					}
					connection.send(JSON.stringify({ type: "terminal_refreshed", id: frame.id, sessionId, generation }));
					onRefresh();
				}
			},
			() => {
				connections.delete(connection);
			},
		);
		connection.send(JSON.stringify({ type: "ready", protocolVersion: 1 }));
	});
	return listening.then(server => ({
		frames,
		async close() {
			for (const connection of connections) connection.destroy();
			await server.close();
		},
	}));
}

describe("CLI --resume against a live owner", () => {
	it("attaches and never creates a sibling transcript, then refuses a stale publication", async () => {
		using tempDir = TempDir.createSync("@omp-cli-attach-");
		const homeDir = path.join(tempDir.path(), "home");
		const agentDir = path.join(homeDir, "agent");
		const projectDir = path.join(tempDir.path(), "project");
		const sessionsDir = path.join(tempDir.path(), "sessions");
		const runDir = path.join(homeDir, ".omp", "run");
		for (const dir of [agentDir, projectDir, sessionsDir, runDir]) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		const project = fs.realpathSync(projectDir);

		const { sessionId, sessionPath } = await createSession(sessionsDir, project);
		const before = sessionDirNames(sessionsDir);
		expect(before).toEqual([path.basename(sessionPath)]);

		const reportFile = path.join(tempDir.path(), "owner.json");
		const stopFile = path.join(tempDir.path(), "stop");
		const launcher = Bun.spawn([process.execPath, LAUNCHER, project, reportFile, stopFile], {
			cwd: project,
			env: cliEnvironment(homeDir, agentDir),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		let endpoint: RefreshEndpoint | undefined;
		let owner: OwnerReport | undefined;
		try {
			owner = await waitForJson<OwnerReport>(reportFile, 60_000);
			const endpointPath = ipcEndpoint(runDir, sessionId);
			endpoint = await serveSessionEndpoint(endpointPath, sessionId, owner.id, () => {
				setTimeout(() => {
					try {
						process.kill(owner!.pid, "SIGTERM");
					} catch {}
				}, 100);
			});
			fs.writeFileSync(
				path.join(runDir, `${sessionId}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId,
					sessionFile: sessionPath,
					terminal: { protocolVersion: 1, projectDir: project, name: owner.name, id: owner.id },
				}),
				{ mode: 0o600 },
			);

			const live = await runCli(homeDir, agentDir, project, ["--resume", sessionId, "--session-dir", sessionsDir]);

			expect(live.exitCode, live.output).toBe(42);
			expect(live.output).toContain("OWNER-BANNER");
			expect(endpoint.frames.some(frame => frame.type === "terminal_refresh")).toBe(true);
			expect(sessionDirNames(sessionsDir)).toEqual(before);

			const stale = await createSession(sessionsDir, project);
			const staleId = stale.sessionId;
			fs.writeFileSync(
				path.join(runDir, `${staleId}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId: staleId,
					sessionFile: null,
					terminal: { protocolVersion: 1, projectDir: project, name: "mind-stale", id: "generation-stale" },
				}),
				{ mode: 0o600 },
			);

			const refusal = await runCli(homeDir, agentDir, project, ["--resume", staleId, "--session-dir", sessionsDir]);

			expect(refusal.exitCode).not.toBe(0);
			expect(refusal.output).toContain("refusing to open a second transcript");
			expect(sessionDirNames(sessionsDir)).toEqual([...before, path.basename(stale.sessionPath)]);
		} finally {
			if (owner) {
				try {
					process.kill(owner.pid, "SIGTERM");
				} catch {}
			}
			fs.writeFileSync(stopFile, "");
			await withTimeout(launcher.exited, 20_000, "broker launcher did not stop").catch(() =>
				launcher.kill("SIGKILL"),
			);
			await endpoint?.close();
		}
	}, 180_000);
});

describe("CLI --attach without a live owner", () => {
	it("refuses a cold transcript with exit 2 before model or owner startup", async () => {
		using tempDir = TempDir.createSync("@omp-cli-attach-only-");
		const homeDir = path.join(tempDir.path(), "home");
		const agentDir = path.join(homeDir, "agent");
		const projectDir = path.join(tempDir.path(), "project");
		const sessionsDir = path.join(tempDir.path(), "sessions");
		for (const dir of [agentDir, projectDir, sessionsDir]) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			JSON.stringify({
				modelRoles: { default: "unavailable-provider/no-model" },
				marketplace: { autoUpdate: "off" },
			}),
		);
		const { sessionPath } = await createSession(sessionsDir, projectDir);
		const empty = path.join(sessionsDir, "empty.jsonl");
		const malformed = path.join(sessionsDir, "malformed.jsonl");
		fs.writeFileSync(empty, "");
		fs.writeFileSync(malformed, "not a session\n");
		const before = fs.readFileSync(sessionPath, "utf8");
		const files = fs.readdirSync(tempDir.path(), { recursive: true }).sort();

		const result = await runCli(homeDir, agentDir, projectDir, ["--attach", sessionPath]);

		expect(result.exitCode, result.output).toBe(2);
		expect(result.output).toContain("no live owner");
		const rejected: string[][] = [
			["--attach", path.join(sessionsDir, "missing.jsonl")],
			["--attach", empty],
			["--attach", malformed],
			["--attach"],
			["--attach", "relative.jsonl"],
			["--attach", sessionPath, "--model", "unavailable-provider/no-model"],
			["--attach", sessionPath, "--resume", sessionPath],
			["--attach", sessionPath, "--session-dir", sessionsDir],
			["--attach", sessionPath, "--mode", "rpc"],
			["--attach", sessionPath, "must not submit a turn"],
			["--attach", sessionPath, "--attach", sessionPath],
		];
		for (const args of rejected) {
			const refusal = await runCli(homeDir, agentDir, projectDir, args);
			expect(refusal.exitCode, refusal.output).toBe(2);
			expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
			expect(fs.readdirSync(tempDir.path(), { recursive: true }).sort()).toEqual(files);
		}
		expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
		expect(fs.readdirSync(tempDir.path(), { recursive: true }).sort()).toEqual(files);
	}, 60_000);
});

describe("CLI --attach exact live owner", () => {
	it("shares one owner interactively, refuses copies and races, and never starts another owner", async () => {
		using tempDir = TempDir.createSync("@omp-cli-exact-viewer-");
		const homeDir = path.join(tempDir.path(), "home");
		const agentDir = path.join(homeDir, "agent");
		const projectDir = path.join(tempDir.path(), "project");
		const sessionsDir = path.join(tempDir.path(), "sessions");
		const runDir = path.join(homeDir, ".omp", "run");
		for (const dir of [agentDir, projectDir, sessionsDir, runDir]) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), "modelRoles:\n  default: unavailable-provider/no-model\n");
		const project = fs.realpathSync(projectDir);
		const { sessionId, sessionPath } = await createSession(sessionsDir, project);
		const before = fs.readFileSync(sessionPath, "utf8");
		const reportFile = path.join(tempDir.path(), "owner.json");
		const stopFile = path.join(tempDir.path(), "stop");
		const launcher = Bun.spawn([process.execPath, LAUNCHER, project, reportFile, stopFile], {
			cwd: project,
			env: cliEnvironment(homeDir, agentDir),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const viewers: CliViewer[] = [];
		let endpoint: RefreshEndpoint | undefined;
		let web: IpcConnection | undefined;
		let inspectionClient: DaemonBrokerClient | undefined;
		try {
			const owner = await waitForJson<OwnerReport>(reportFile, 60_000);
			expect(owner.brokerCli).toBe(CLI_ENTRY);
			expect(owner.brokerTerminalProtocol).toBe(1);
			const client = await createDaemonBrokerClient(project, { runtimeDir: owner.runtimeDir, existingOnly: true });
			inspectionClient = client;
			let disappearBeforeState = false;
			let rebindBeforeState = false;
			let stateCalls = 0;
			const publication = path.join(runDir, `${sessionId}.json`);
			const metadata = {
				pid: owner.pid,
				sessionId,
				sessionFile: sessionPath,
				terminal: { protocolVersion: 1, projectDir: project, name: owner.name, id: owner.id },
			};
			endpoint = await serveSessionEndpoint(
				ipcEndpoint(runDir, sessionId),
				sessionId,
				owner.id,
				() => process.kill(owner.pid, "SIGUSR1"),
				{
					sessionPath,
					beforeState: async () => {
						stateCalls++;
						if (rebindBeforeState && stateCalls === 2) {
							rebindBeforeState = false;
							fs.writeFileSync(
								publication,
								JSON.stringify({ ...metadata, terminal: { ...metadata.terminal, id: "replaced" } }),
							);
						}
						if (disappearBeforeState && stateCalls === 2) {
							disappearBeforeState = false;
							await client.request({ op: "shutdown" });
							await withTimeout(finalViewer.child.exited, 20_000, "fixture owner did not exit during probe");
						}
					},
				},
			);
			fs.writeFileSync(publication, JSON.stringify(metadata), { mode: 0o600 });
			web = await IpcConnection.connect(ipcEndpoint(runDir, sessionId), { framing: "lines" });
			web.start(
				() => {},
				() => {},
			);
			const first = new CliViewer(homeDir, agentDir, project, sessionPath);
			viewers.push(first);
			await first.waitForText("OWNER-REFRESH");
			expect(first.output).not.toContain("unavailable-provider");
			expect(endpoint.frames.map(frame => frame.type)).toEqual(["get_state", "get_state", "terminal_refresh"]);

			const second = new CliViewer(homeDir, agentDir, project, sessionPath);
			viewers.push(second);
			await second.waitForText("OWNER-REFRESH");
			second.terminal.write("exact-viewer-input-1\n");
			await Promise.all([
				first.waitForText("OWNER-INPUT:exact-viewer-input-1"),
				second.waitForText("OWNER-INPUT:exact-viewer-input-1"),
			]);
			const resizeCount = second.output.split("OWNER-RESIZE").length;
			second.terminal.resize(101, 33);
			second.child.kill("SIGWINCH");
			await second.waitForText("OWNER-RESIZE", resizeCount);
			expect(await first.close()).toBe(143);
			expect(web.closed).toBe(false);
			second.terminal.write("exact-viewer-input-2\n");
			await second.waitForText("OWNER-INPUT:exact-viewer-input-2");
			expect((await probeSessionAttach(sessionId, { endpointDir: runDir, sessionPath })).status).toBe("live");
			expect(await second.close()).toBe(143);
			expect(web.closed).toBe(false);

			const copy = path.join(sessionsDir, "distinct-copy.jsonl");
			fs.copyFileSync(sessionPath, copy);
			const copied = await runCli(homeDir, agentDir, project, ["--attach", copy]);
			expect(copied.exitCode, copied.output).toBe(2);
			expect(copied.output).toContain("owner-unreachable");
			fs.writeFileSync(publication, JSON.stringify({ ...metadata, sessionId: "different-sid" }));
			const mismatched = await runCli(homeDir, agentDir, project, ["--attach", sessionPath]);
			expect(mismatched.exitCode, mismatched.output).toBe(2);
			fs.writeFileSync(publication, JSON.stringify(metadata));
			rebindBeforeState = true;
			stateCalls = 0;
			const rebound = await runCli(homeDir, agentDir, project, ["--attach", sessionPath]);
			expect(rebound.exitCode, rebound.output).toBe(2);
			fs.writeFileSync(publication, JSON.stringify(metadata));
			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error("expected broker list");
			expect(listed.daemons.map(daemon => [daemon.name, daemon.id, daemon.pid])).toEqual([
				[owner.name, owner.id, owner.pid],
			]);
			const runtimeFiles = fs.readdirSync(owner.runtimeDir, { recursive: true, encoding: "utf8" }).sort();
			const finalViewer = new CliViewer(homeDir, agentDir, project, sessionPath);
			viewers.push(finalViewer);
			await finalViewer.waitForText("OWNER-REFRESH");
			disappearBeforeState = true;
			stateCalls = 0;
			const vanished = await runCli(homeDir, agentDir, project, ["--attach", sessionPath]);
			expect(vanished.exitCode, vanished.output).toBe(2);
			expect(await withTimeout(finalViewer.child.exited, 20_000, "attached viewer did not observe owner exit")).toBe(
				42,
			);
			expect(
				fs
					.readdirSync(owner.runtimeDir, { recursive: true, encoding: "utf8" })
					.filter(file => !runtimeFiles.includes(file)),
			).toEqual([]);
			client.close();
			expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
			expect(fs.readFileSync(copy, "utf8")).toBe(before);
			expect(sessionDirNames(sessionsDir)).toEqual([path.basename(sessionPath), path.basename(copy)].sort());
			expect(endpoint.frames.every(frame => frame.type === "get_state" || frame.type === "terminal_refresh")).toBe(
				true,
			);
			expect(fs.readdirSync(agentDir)).toEqual(["config.yml"]);
		} finally {
			inspectionClient?.close();
			await Promise.all(viewers.map(viewer => viewer.close().catch(() => -1)));
			web?.destroy();
			await endpoint?.close();
			fs.writeFileSync(stopFile, "");
			await withTimeout(launcher.exited, 20_000, "broker launcher did not stop").catch(() =>
				launcher.kill("SIGKILL"),
			);
		}
	}, 180_000);
});

describe("CLI --attach legacy singleton broker", () => {
	it.skipIf(!SINGLETON_BROKER_CLI)(
		"attaches a free slot and refuses an occupied slot without takeover",
		async () => {
			if (!SINGLETON_BROKER_CLI) throw new Error("OMP_TEST_SINGLETON_BROKER_CLI is required");
			using tempDir = TempDir.createSync("@omp-cli-singleton-viewer-");
			const homeDir = path.join(tempDir.path(), "home");
			const agentDir = path.join(homeDir, "agent");
			const projectDir = path.join(tempDir.path(), "project");
			const sessionsDir = path.join(tempDir.path(), "sessions");
			const runDir = path.join(homeDir, ".omp", "run");
			for (const dir of [agentDir, projectDir, sessionsDir, runDir]) fs.mkdirSync(dir, { recursive: true });
			const config = "modelRoles:\n  default: unavailable-provider/no-model\n";
			fs.writeFileSync(path.join(agentDir, "config.yml"), config);
			const project = fs.realpathSync(projectDir);
			const { sessionId, sessionPath } = await createSession(sessionsDir, project);
			const before = fs.readFileSync(sessionPath, "utf8");
			const reportFile = path.join(tempDir.path(), "owner.json");
			const stopFile = path.join(tempDir.path(), "stop");
			const launcher = Bun.spawn([process.execPath, LAUNCHER, project, reportFile, stopFile, SINGLETON_BROKER_CLI], {
				cwd: project,
				env: cliEnvironment(homeDir, agentDir),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			let endpoint: RefreshEndpoint | undefined;
			let viewer: CliViewer | undefined;
			let web: IpcConnection | undefined;
			let client: DaemonBrokerClient | undefined;
			try {
				const owner = await waitForJson<OwnerReport>(reportFile, 60_000);
				expect(owner.brokerCli).toBe(SINGLETON_BROKER_CLI);
				expect(owner.brokerTerminalProtocol).toBe(1);
				client = await createDaemonBrokerClient(project, { runtimeDir: owner.runtimeDir, existingOnly: true });
				endpoint = await serveSessionEndpoint(
					ipcEndpoint(runDir, sessionId),
					sessionId,
					owner.id,
					() => process.kill(owner.pid, "SIGUSR1"),
					{ sessionPath },
				);
				fs.writeFileSync(
					path.join(runDir, `${sessionId}.json`),
					JSON.stringify({
						pid: owner.pid,
						sessionId,
						sessionFile: sessionPath,
						terminal: { protocolVersion: 1, projectDir: project, name: owner.name, id: owner.id },
					}),
				);
				web = await IpcConnection.connect(ipcEndpoint(runDir, sessionId), { framing: "lines" });
				web.start(
					() => {},
					() => {},
				);
				viewer = new CliViewer(homeDir, agentDir, project, sessionPath);
				await viewer.waitForText("OWNER-REFRESH");
				const refusal = await runCli(homeDir, agentDir, project, ["--attach", sessionPath]);
				expect(refusal.exitCode, refusal.output).toBe(2);
				expect(refusal.output).toContain("already attached");
				viewer.terminal.write("after-refusal");
				await viewer.waitForText("OWNER-INPUT:after-refusal");
				expect(await viewer.close()).toBe(143);
				viewer = undefined;
				expect(web.closed).toBe(false);
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") throw new Error("expected broker list");
				expect(listed.daemons.map(daemon => [daemon.name, daemon.id, daemon.pid])).toEqual([
					[owner.name, owner.id, owner.pid],
				]);
				expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
				expect(sessionDirNames(sessionsDir)).toEqual([path.basename(sessionPath)]);
				expect(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")).toBe(config);
				expect(fs.readdirSync(agentDir)).toEqual(["config.yml"]);
			} finally {
				client?.close();
				await viewer?.close();
				web?.destroy();
				await endpoint?.close();
				fs.writeFileSync(stopFile, "");
				await withTimeout(launcher.exited, 20_000, "legacy broker fixture did not stop").catch(() =>
					launcher.kill("SIGKILL"),
				);
			}
		},
		180_000,
	);
});
