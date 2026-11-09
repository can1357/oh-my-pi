// Integration test — real timers are required (ts-no-test-timers exception):
// the mirror is a real process killed by SIGKILL while a real broker PTY owner
// runs a delayed turn. Every awaited signal is process liveness, a file marker
// or a socket frame; fake timers cannot deliver a kernel SIGKILL or drive the
// cross-process RPC/PTY path.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection, Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type { DaemonTerminalNotification } from "../../src/launch/protocol";
import { terminalSpec, withTerminalBroker } from "./terminal-fixture";

const OWNER_FIXTURE = path.join(import.meta.dir, "../fixtures/session-terminal-owner.ts");
const MIRROR_FIXTURE = path.join(import.meta.dir, "../fixtures/session-terminal-mirror.ts");
const OWNER_READY_TIMEOUT_MS = 30_000;
const CONDITION_TIMEOUT_MS = 20_000;
const COMPLETION_TIMEOUT_MS = 30_000;

type Frame = Record<string, unknown> & {
	type?: string;
	id?: string;
	success?: boolean;
	status?: string;
	name?: string;
	exitCode?: number;
	detached?: boolean;
	message?: string;
};

interface OwnerEvent extends Frame {
	id: string;
	pid: number;
	generation: string;
	sessionId: string;
	sessionFile: string;
	endpoint: string;
	backgroundPid: number;
}

function delay(ms = 10): Promise<void> {
	return Bun.sleep(ms);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, message: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message());
		await delay();
	}
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function waitForJson<T>(file: string, timeoutMs: number, what: string): Promise<T> {
	let last: T | undefined;
	await waitFor(
		() => {
			last = readJson<T>(file);
			return last !== undefined;
		},
		timeoutMs,
		() => `timed out waiting for ${what} at ${file}; last ${JSON.stringify(last)}`,
	);
	return last!;
}

function readEvents(file: string): Frame[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.length > 0)
		.flatMap(line => {
			try {
				return [JSON.parse(line) as Frame];
			} catch {
				return [];
			}
		});
}

async function waitForEvent(file: string, name: string, timeoutMs = CONDITION_TIMEOUT_MS): Promise<Frame> {
	let found: Frame | undefined;
	await waitFor(
		() => {
			found = readEvents(file).find(event => event.name === name);
			return found !== undefined;
		},
		timeoutMs,
		() => `owner never emitted ${name}; saw ${JSON.stringify(readEvents(file))}`,
	);
	return found!;
}

function alive(pid: number): boolean {
	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

class SocketPeer {
	readonly #frames: Frame[] = [];
	#wake: (() => void) | undefined;
	#closed = false;

	private constructor(private readonly conn: IpcConnection) {}

	static async connect(endpoint: string): Promise<SocketPeer> {
		const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 5_000 });
		const peer = new SocketPeer(conn);
		conn.start(
			line => {
				let frame: Frame;
				try {
					frame = JSON.parse(line) as Frame;
				} catch {
					return;
				}
				peer.#frames.push(frame);
				peer.#wake?.();
			},
			() => {
				peer.#closed = true;
			},
		);
		return peer;
	}

	send(frame: object): void {
		this.conn.send(JSON.stringify(frame));
	}

	has(predicate: (frame: Frame) => boolean): boolean {
		return this.#frames.some(predicate);
	}

	snapshot(): Frame[] {
		return [...this.#frames];
	}

	async next(predicate: (frame: Frame) => boolean, timeoutMs = COMPLETION_TIMEOUT_MS): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.#frames.find(predicate);
			if (found) return found;
			if (this.#closed)
				throw new Error(`socket closed before a matching frame; saw ${JSON.stringify(this.#frames)}`);
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for a frame; saw ${JSON.stringify(this.#frames)}`);
			}
			const arrived = Promise.withResolvers<void>();
			this.#wake = arrived.resolve;
			await Promise.race([arrived.promise, delay(25)]);
			this.#wake = undefined;
		}
	}

	close(): void {
		this.conn.destroy();
	}
}

interface MirrorProcess {
	readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	readonly subscriptionId: string;
	readonly statusFile: string;
	readonly outputFile: string;
	readonly stderr: () => string;
	waitForStatus(name: string, timeoutMs?: number): Promise<Frame>;
	waitForText(marker: string, timeoutMs?: number): Promise<void>;
	kill(): void;
}

interface LifetimeFixture {
	readonly client: DaemonBrokerClient;
	readonly name: string;
	readonly id: string;
	readonly generation: string;
	readonly ownerPid: number;
	readonly backgroundPid: number;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly sessionDir: string;
	readonly eventsFile: string;
	readonly web: SocketPeer;
	mirror(options?: { refresh?: boolean }): MirrorProcess;
	resumeMirror(options?: { refresh?: boolean }): MirrorProcess;
	sendInput(data: string): Promise<void>;
	waitForTurnStart(): Promise<void>;
	waitForCompletion(id: string): Promise<Frame>;
	readExitEntries(): Frame[];
	listJsonl(): string[];
	readTranscript(): string;
	close(): Promise<void>;
}

async function startLifetimeFixture(
	client: DaemonBrokerClient,
	projectDir: string,
	runtimeDir: string,
): Promise<LifetimeFixture> {
	const tempDir = TempDir.createSync("@omp-lifetime-");
	const controlDir = path.join(tempDir.path(), "control");
	const endpointDir = path.join(tempDir.path(), "endpoints");
	const sessionDir = path.join(tempDir.path(), "sessions");
	fs.mkdirSync(controlDir, { recursive: true });
	fs.mkdirSync(endpointDir, { recursive: true });
	const eventsFile = path.join(controlDir, "owner-events.jsonl");
	const name = `mind-${Snowflake.next()}`;
	const bootstrapSubscription = `bootstrap-${Snowflake.next()}`;

	const ack = (frame: DaemonTerminalNotification): void => {
		if (frame.event !== "terminal_output") return;
		void client
			.request({
				op: "terminal_ack",
				subscriptionId: bootstrapSubscription,
				name: frame.name,
				id: frame.id,
				sequence: frame.sequence,
			})
			.catch(() => undefined);
	};
	const bootstrapOff = client.subscribeTerminal(bootstrapSubscription, ack);
	const spec = terminalSpec(projectDir, "", {
		name,
		args: [OWNER_FIXTURE, controlDir, endpointDir, sessionDir],
		ready: { log: "OWNER_READY", timeoutMs: OWNER_READY_TIMEOUT_MS },
	});

	let owner: OwnerEvent | undefined;
	let startedId = "unknown";
	try {
		const started = await client.request({
			op: "terminal_start",
			subscriptionId: bootstrapSubscription,
			spec,
			columns: 120,
			rows: 40,
		});
		if (started.op !== "terminal_start") throw new Error("terminal_start did not start the owner");
		owner = (await waitForEvent(eventsFile, "ready", OWNER_READY_TIMEOUT_MS)) as OwnerEvent;
		startedId = owner.id;
		expect(started.daemon.pid).toBe(owner.pid);
		expect(started.daemon.id).toBe(owner.id);
	} finally {
		bootstrapOff();
		await client
			.request({ op: "terminal_detach", subscriptionId: bootstrapSubscription, name, id: startedId })
			.catch(() => undefined);
	}
	if (!owner) throw new Error("owner fixture never became ready");

	const web = await SocketPeer.connect(owner.endpoint);
	await web.next(frame => frame.type === "ready", 5_000);

	const mirrors: MirrorProcess[] = [];
	let closed = false;

	const spawnMirror = (options: { refresh?: boolean } = {}): MirrorProcess => {
		const subscriptionId = `view-${Snowflake.next()}`;
		const statusFile = path.join(controlDir, `mirror-${Snowflake.next()}.json`);
		const outputFile = path.join(controlDir, `mirror-${Snowflake.next()}.out`);
		const configFile = path.join(controlDir, `mirror-${Snowflake.next()}.json.tmp`);
		const config: Record<string, unknown> = {
			projectDir,
			runtimeDir,
			name,
			id: owner.id,
			subscriptionId,
			statusFile,
			outputFile,
			columns: 120,
			rows: 40,
		};
		if (options.refresh) {
			Object.assign(config, {
				endpoint: owner.endpoint,
				sessionId: owner.sessionId,
				generation: owner.generation,
				refresh: true,
			});
		}
		fs.writeFileSync(configFile, JSON.stringify(config));
		const proc = Bun.spawn([process.execPath, MIRROR_FIXTURE, configFile], {
			cwd: projectDir,
			env: { ...process.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		let stderr = "";
		const decoder = new TextDecoder();
		const drain = async (stream: ReadableStream<Uint8Array>, consume: (text: string) => void): Promise<void> => {
			for await (const chunk of stream) consume(decoder.decode(chunk, { stream: true }));
		};
		void drain(proc.stdout, () => {});
		void drain(proc.stderr, text => {
			stderr += text;
		});
		const mirror: MirrorProcess = {
			proc,
			subscriptionId,
			statusFile,
			outputFile,
			stderr: () => stderr,
			async waitForStatus(expected, timeoutMs = CONDITION_TIMEOUT_MS) {
				let status: Frame | undefined;
				await waitFor(
					() => {
						status = readJson<Frame>(statusFile);
						return status?.name === expected || status?.name === "failed" || status?.name === "exited";
					},
					timeoutMs,
					() =>
						`mirror never reached ${expected}; status ${JSON.stringify(status)} stderr ${JSON.stringify(stderr)}`,
				);
				return status!;
			},
			async waitForText(marker, timeoutMs = CONDITION_TIMEOUT_MS) {
				const deadline = Date.now() + timeoutMs;
				for (;;) {
					const text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
					if (text.includes(marker)) return;
					const status = readJson<Frame>(statusFile);
					if (status?.name === "failed" || status?.name === "exited") {
						throw new Error(
							`mirror stopped before showing ${JSON.stringify(marker)}; status ${JSON.stringify(status)} stderr ${JSON.stringify(stderr)}`,
						);
					}
					if (Date.now() > deadline) {
						throw new Error(
							`mirror never showed ${JSON.stringify(marker)}; tail ${JSON.stringify(text.slice(-1500))} stderr ${JSON.stringify(stderr)}`,
						);
					}
					await delay();
				}
			},
			kill() {
				proc.kill("SIGKILL");
			},
		};
		mirrors.push(mirror);
		return mirror;
	};

	const fixture: LifetimeFixture = {
		client,
		name,
		id: owner.id,
		generation: owner.generation,
		ownerPid: owner.pid,
		backgroundPid: owner.backgroundPid,
		sessionId: owner.sessionId,
		sessionFile: owner.sessionFile,
		sessionDir,
		eventsFile,
		web,
		mirror: spawnMirror,
		resumeMirror: options => spawnMirror({ refresh: true, ...options }),
		async sendInput(data) {
			const result = await client.request({ op: "send", name, id: owner.id, data });
			if (result.op !== "send") throw new Error("unexpected send result");
		},
		async waitForTurnStart() {
			await waitFor(
				() => readEvents(eventsFile).some(event => event.name === "turn-started"),
				10_000,
				() =>
					`owner never started the turn; events ${JSON.stringify(readEvents(eventsFile))} frames ${JSON.stringify(web.snapshot())}`,
			);
		},
		async waitForCompletion(id) {
			try {
				return await web.next(frame => frame.type === "prompt_result" && frame.id === id);
			} catch (error) {
				const logPath = path.join(runtimeDir, "daemons", name, "output.log");
				const previousPath = path.join(runtimeDir, "daemons", name, "output.previous.log");
				const readLog = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
				const log = `${readLog(previousPath)}${readLog(logPath)}`.slice(-20_000);
				const debugPath = `/tmp/omp-owner-debug-${owner.pid}.log`;
				fs.writeFileSync(debugPath, log);
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}; ownerAlive=${alive(owner.pid)}; events=${JSON.stringify(readEvents(eventsFile))}; ownerLog=${JSON.stringify(log)}`,
				);
			}
		},
		readExitEntries() {
			if (!fs.existsSync(owner.sessionFile)) return [];
			return fs
				.readFileSync(owner.sessionFile, "utf8")
				.split("\n")
				.filter(line => line.length > 0)
				.flatMap(line => {
					try {
						const entry = JSON.parse(line) as Frame;
						return entry.customType === "session_exit" ? [entry] : [];
					} catch {
						return [];
					}
				});
		},
		listJsonl() {
			return fs
				.readdirSync(sessionDir)
				.filter(file => file.endsWith(".jsonl"))
				.sort();
		},
		readTranscript() {
			return fs.existsSync(owner.sessionFile) ? fs.readFileSync(owner.sessionFile, "utf8") : "";
		},
		async close() {
			if (closed) return;
			closed = true;
			for (const mirror of mirrors) {
				if (mirror.proc.exitCode === null) mirror.proc.kill("SIGKILL");
			}
			web.close();
			await client.request({ op: "stop", name, timeoutMs: 5_000 }).catch(() => undefined);
			const deadline = Date.now() + 5_000;
			while (alive(owner.pid) && Date.now() < deadline) await delay(25);
			tempDir.removeSync();
		},
	};
	return fixture;
}

function expectMirrorKilled(mirror: MirrorProcess): void {
	expect(mirror.proc.signalCode).toBe("SIGKILL");
}

describe("terminal mirror lifetime", () => {
	it("completes the turn and a fresh mirror sees it after the mirror is SIGKILLed", async () => {
		await withTerminalBroker(async ({ client, projectDir, runtimeDir }) => {
			const f = await startLifetimeFixture(client, projectDir, runtimeDir);
			try {
				const first = f.mirror();
				const attached = await first.waitForStatus("attached");
				expect(attached.name).toBe("attached");

				f.web.send({ id: "slow-turn", type: "prompt", message: "delayed fixture turn" });
				await f.waitForTurnStart();
				await f.web.next(frame => frame.type === "agent_start");
				expect(f.web.has(frame => frame.type === "prompt_result")).toBe(false);

				first.kill();
				await first.proc.exited;
				expectMirrorKilled(first);

				const completion = await f.waitForCompletion("slow-turn");
				expect(completion).toMatchObject({ type: "prompt_result", id: "slow-turn", status: "completed" });

				expect(alive(f.ownerPid)).toBe(true);
				expect(f.readExitEntries()).toHaveLength(0);
				const transcripts = f.listJsonl();
				expect(transcripts).toHaveLength(1);
				expect(transcripts[0]).toBe(path.basename(f.sessionFile));
				expect(f.readTranscript()).toContain("completed while detached");

				const fresh = f.resumeMirror();
				expect((await fresh.waitForStatus("attached")).name).toBe("attached");
				await fresh.waitForText("completed while detached");
				expect(alive(fresh.proc.pid)).toBe(true);
				expect(alive(f.ownerPid)).toBe(true);
				expect(f.readExitEntries()).toHaveLength(0);
			} finally {
				await f.close();
			}
		});
	}, 90_000);

	it("keeps background work across a mirror death and reaps it on the real quit", async () => {
		await withTerminalBroker(async ({ client, projectDir, runtimeDir }) => {
			const f = await startLifetimeFixture(client, projectDir, runtimeDir);
			try {
				f.web.send({ id: "background-turn", type: "prompt", message: "turn with background work" });
				await f.waitForTurnStart();
				await f.web.next(frame => frame.type === "agent_start");

				const mirror = f.mirror();
				await mirror.waitForStatus("attached");
				expect(alive(f.backgroundPid)).toBe(true);

				mirror.kill();
				await mirror.proc.exited;
				expectMirrorKilled(mirror);

				await delay(50);
				expect(alive(f.ownerPid)).toBe(true);
				expect(alive(f.backgroundPid)).toBe(true);
				expect(f.readExitEntries()).toHaveLength(0);
				expect((await f.waitForCompletion("background-turn")).status).toBe("completed");

				const fresh = f.resumeMirror();
				expect((await fresh.waitForStatus("attached")).name).toBe("attached");
				await f.sendInput("/exit\r");
				const exit = await fresh.waitForStatus("exited");
				expect(exit).toMatchObject({ name: "exited", detached: false });

				await waitFor(
					() => !alive(f.ownerPid),
					10_000,
					() => `owner ${f.ownerPid} is still running after /exit`,
				);
				const exits = f.readExitEntries();
				expect(exits).toHaveLength(1);
				expect(exits[0]?.data).toMatchObject({ kind: "normal" });

				await waitFor(
					() => !alive(f.backgroundPid),
					10_000,
					() => `background process ${f.backgroundPid} survived the owner's dispose`,
				);
			} finally {
				await f.close();
			}
		});
	}, 90_000);

	it("keeps the turn when the mirror detaches cleanly instead of dying", async () => {
		await withTerminalBroker(async ({ client, projectDir, runtimeDir }) => {
			const f = await startLifetimeFixture(client, projectDir, runtimeDir);
			const subscriptionId = `clean-${Snowflake.next()}`;
			const ack = (frame: DaemonTerminalNotification): void => {
				if (frame.event !== "terminal_output") return;
				void client
					.request({
						op: "terminal_ack",
						subscriptionId,
						name: f.name,
						id: f.id,
						sequence: frame.sequence,
					})
					.catch(() => undefined);
			};
			const off = client.subscribeTerminal(subscriptionId, ack);
			try {
				f.web.send({ id: "clean-turn", type: "prompt", message: "turn across a clean detach" });
				await f.waitForTurnStart();
				await f.web.next(frame => frame.type === "agent_start");

				const attached = await client.request({
					op: "terminal_attach",
					subscriptionId,
					name: f.name,
					id: f.id,
					columns: 120,
					rows: 40,
				});
				expect(attached.op).toBe("terminal_attach");
				const detached = await client.request({
					op: "terminal_detach",
					subscriptionId,
					name: f.name,
					id: f.id,
				});
				expect(detached.op).toBe("terminal_detach");

				expect((await f.waitForCompletion("clean-turn")).status).toBe("completed");
				expect(alive(f.ownerPid)).toBe(true);
				expect(f.readExitEntries()).toHaveLength(0);
				expect(f.readTranscript()).toContain("completed while detached");
				expect(f.listJsonl()).toEqual([path.basename(f.sessionFile)]);

				const fresh = f.resumeMirror();
				expect((await fresh.waitForStatus("attached")).name).toBe("attached");
				await fresh.waitForText("completed while detached");
				expect(alive(f.ownerPid)).toBe(true);
				expect(f.readExitEntries()).toHaveLength(0);
			} finally {
				off();
				await f.close();
			}
		});
	}, 90_000);

	it("keeps concurrent mirrors and the web attachment alive when one mirror is killed", async () => {
		await withTerminalBroker(async ({ client, projectDir, runtimeDir }) => {
			const f = await startLifetimeFixture(client, projectDir, runtimeDir);
			try {
				const first = f.mirror();
				await first.waitForStatus("attached");
				expect(alive(first.proc.pid)).toBe(true);

				const second = f.mirror();
				expect((await second.waitForStatus("attached")).name).toBe("attached");
				expect(alive(second.proc.pid)).toBe(true);
				expect(alive(f.ownerPid)).toBe(true);

				first.kill();
				await first.proc.exited;
				expectMirrorKilled(first);

				const fresh = f.resumeMirror();
				expect((await fresh.waitForStatus("attached")).name).toBe("attached");
				expect(alive(second.proc.pid)).toBe(true);
				expect(alive(fresh.proc.pid)).toBe(true);
				expect(alive(f.ownerPid)).toBe(true);

				f.web.send({ id: "after-kill", type: "get_state" });
				expect((await f.web.next(frame => frame.id === "after-kill")).success).toBe(true);
			} finally {
				await f.close();
			}
		});
	}, 90_000);
});
