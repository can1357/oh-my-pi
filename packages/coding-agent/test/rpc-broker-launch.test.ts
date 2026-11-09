import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { isRecord, readJsonl, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown> & { type?: string; id?: string; success?: boolean };
type BridgeProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface Publication {
	pid: number;
	sessionId: string;
	sessionFile: string;
	terminal?: { name: string; id: string; protocolVersion: number };
}

interface Waiter {
	predicate: (frame: Frame) => boolean;
	resolve: (frame: Frame) => void;
}

class FrameFeed {
	readonly frames: Frame[] = [];
	readonly #waiters: Waiter[] = [];

	push(frame: Frame): void {
		this.frames.push(frame);
		for (const waiter of Array.from(this.#waiters)) {
			if (!waiter.predicate(frame)) continue;
			this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
			waiter.resolve(frame);
		}
	}

	wait(predicate: (frame: Frame) => boolean, timeoutMs: number, label: string): Promise<Frame> {
		const existing = this.frames.find(predicate);
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ predicate, resolve });
		return withTimeout(promise, timeoutMs, `${label}; saw ${JSON.stringify(this.frames.slice(-6))}`);
	}
}

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const FRAME_TIMEOUT_MS = 90_000;
const STARTUP_WATCHDOG_SOAK_MS = 11_000;

class LaunchedBridge {
	readonly feed = new FrameFeed();
	readonly #child: BridgeProcess;
	readonly #stderr: Promise<string>;

	constructor(args: readonly string[], cwd: string, env: Record<string, string>) {
		this.#child = Bun.spawn([process.execPath, CLI, ...args], {
			cwd,
			env: { ...env, PATH: process.env.PATH },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#stderr = new Response(this.#child.stderr).text();
		void this.#pump();
	}

	get pid(): number {
		return this.#child.pid;
	}

	async #pump(): Promise<void> {
		for await (const frame of readJsonl<unknown>(this.#child.stdout)) {
			if (isRecord(frame)) this.feed.push(frame as Frame);
		}
		this.feed.push({ type: "__bridge_exit", code: this.#child.exitCode });
	}

	saw(predicate: (frame: Frame) => boolean, timeoutMs = FRAME_TIMEOUT_MS): Promise<Frame> {
		const wait = this.feed.wait(predicate, timeoutMs, "timed out waiting for a frame");
		return wait.catch(async error => {
			const stderr = await Promise.race([this.#stderr, Promise.resolve("")]);
			throw new Error(`${error instanceof Error ? error.message : String(error)}; stderr: ${stderr.slice(-3000)}`);
		});
	}

	stderr(): Promise<string> {
		return this.#stderr;
	}

	write(frame: object): void {
		this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		this.#child.stdin.flush();
	}

	async closeStdin(): Promise<number> {
		await this.#child.stdin.end();
		return withTimeout(this.#child.exited, 15_000, "bridge did not exit after stdin EOF");
	}

	async close(): Promise<number> {
		if (this.#child.exitCode !== null) return this.#child.exitCode;
		this.#child.kill();
		return this.#child.exited;
	}
}

const SCRIPT = "/usr/bin/script";
const STTY = "/usr/bin/stty";
const hasPtyHarness =
	process.platform === "linux" && (await Bun.file(SCRIPT).exists()) && (await Bun.file(STTY).exists());

type PtyProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface PtySize {
	readonly columns: number;
	readonly rows: number;
}

async function directChildren(pid: number): Promise<number[]> {
	try {
		const raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
		return raw.trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
	} catch {
		return [];
	}
}

async function descendants(pid: number): Promise<number[]> {
	const found: number[] = [];
	const pending = await directChildren(pid);
	while (pending.length > 0) {
		const child = pending.shift()!;
		found.push(child);
		pending.push(...(await directChildren(child)));
	}
	return found;
}

async function findCliDescendant(rootPid: number, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const pid of await descendants(rootPid)) {
			const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
			if (cmdline.split("\0").includes(CLI)) return pid;
		}
		await Bun.sleep(50);
	}
	throw new Error(`no bun cli.ts descendant under ${rootPid}`);
}

async function groupAlive(pid: number): Promise<boolean> {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function terminateProcessGroup(proc: PtyProcess): Promise<void> {
	const signal = (name: NodeJS.Signals): void => {
		try {
			process.kill(-proc.pid, name);
		} catch {
			try {
				proc.kill(name);
			} catch {}
		}
	};
	signal("SIGTERM");
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (!(await groupAlive(proc.pid)) && proc.exitCode !== null) return;
		await Bun.sleep(50);
	}
	signal("SIGKILL");
	await Promise.race([proc.exited, Bun.sleep(2_000)]);
}

async function readPtySize(pid: number): Promise<PtySize | undefined> {
	let link: string;
	try {
		link = await fs.readlink(`/proc/${pid}/fd/0`);
	} catch {
		return undefined;
	}
	if (!link.startsWith("/dev/pts/")) return undefined;
	const result = Bun.spawnSync([STTY, "-F", link, "size"], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) return undefined;
	const [rowsText, columnsText] = result.stdout.toString().trim().split(/\s+/);
	const rows = Number(rowsText);
	const columns = Number(columnsText);
	if (!Number.isInteger(rows) || !Number.isInteger(columns)) return undefined;
	return { columns, rows };
}

class LaunchedInteractive {
	readonly #child: PtyProcess;
	readonly #chunks: Buffer[] = [];
	readonly #stderr: Promise<string>;

	constructor(args: readonly string[], cwd: string, env: Record<string, string>) {
		const command = `stty cols 100 rows 30 2>/dev/null; ${[process.execPath, CLI, ...args]
			.map(part => JSON.stringify(part))
			.join(" ")}`;
		this.#child = Bun.spawn([SCRIPT, "-q", "-e", "-c", command, "/dev/null"], {
			cwd,
			env: { ...env, PATH: process.env.PATH, TERM: "xterm-256color" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
		this.#stderr = new Response(this.#child.stderr).text();
		void this.#pump();
	}

	get pid(): number {
		return this.#child.pid;
	}

	get outputBytes(): number {
		return this.#chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	}

	output(): string {
		return Buffer.concat(this.#chunks).toString("utf8");
	}

	async #pump(): Promise<void> {
		for await (const chunk of this.#child.stdout) this.#chunks.push(Buffer.from(chunk));
	}

	async waitForOutput(timeoutMs = FRAME_TIMEOUT_MS): Promise<void> {
		await withTimeout(
			(async () => {
				while (this.outputBytes === 0) {
					if (this.#child.exitCode !== null) {
						throw new Error(
							`interactive mirror exited ${this.#child.exitCode} before painting; stderr: ${await this.#stderr}`,
						);
					}
					await Bun.sleep(25);
				}
			})(),
			timeoutMs,
			"interactive mirror never painted the owner's first frames",
		);
	}

	async waitForText(text: string): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (this.output().includes(text)) return;
			if (this.#child.exitCode !== null) {
				throw new Error(`attach exited ${this.#child.exitCode}: ${this.output()}`);
			}
			await Bun.sleep(25);
		}
		throw new Error(`native attach never rendered ${text}: ${this.output()}`);
	}

	write(data: string): void {
		this.#child.stdin.write(data);
		this.#child.stdin.flush();
	}

	async resize(columns: number, rows: number): Promise<void> {
		const mirrorPid = await findCliDescendant(this.pid, 10_000);
		const tty = await fs.readlink(`/proc/${mirrorPid}/fd/1`);
		const result = Bun.spawnSync([STTY, "-F", tty, "cols", String(columns), "rows", String(rows)], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(`native viewer resize failed: ${result.stderr.toString()}`);
		process.kill(mirrorPid, "SIGWINCH");
	}

	async signalMirrorHangup(): Promise<void> {
		const mirrorPid = await findCliDescendant(this.pid, 30_000);
		process.kill(mirrorPid, "SIGHUP");
	}

	waitForExit(timeoutMs = 20_000): Promise<number> {
		return withTimeout(this.#child.exited, timeoutMs, "interactive mirror did not exit after SIGHUP");
	}

	async close(): Promise<void> {
		await terminateProcessGroup(this.#child);
		await this.#stderr.catch(() => "");
	}
}

interface Harness {
	root: string;
	home: string;
	project: string;
	runDir: string;
	env: Record<string, string>;
}

async function createHarness(): Promise<Harness> {
	const root = path.join(os.tmpdir(), `omp-broker-launch-${Snowflake.next()}`);
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	const agentDir = path.join(home, ".omp", "agent");
	const runDir = path.join(home, ".omp", "run");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 99\n");
	return {
		root,
		home,
		project,
		runDir,
		env: {
			HOME: home,
			USERPROFILE: home,
			TMPDIR: os.tmpdir(),
			NO_COLOR: "1",
			PI_NO_TITLE: "1",
			PI_CODING_AGENT_DIR: agentDir,
			OMP_RUN_DIR: runDir,
			OMP_DAEMON_RUNTIME_DIR: path.join(runDir, "daemons"),
		},
	};
}

async function readRunDir(harness: Harness): Promise<string[]> {
	try {
		return await fs.readdir(harness.runDir);
	} catch {
		return [];
	}
}

async function readPublication(harness: Harness): Promise<Publication | undefined> {
	const file = (await readRunDir(harness)).find(entry => entry.endsWith(".json") && !entry.startsWith("bridge-"));
	if (!file) return undefined;
	return JSON.parse(await fs.readFile(path.join(harness.runDir, file), "utf8")) as Publication;
}

async function waitForPublication(harness: Harness, timeoutMs = 90_000): Promise<Publication> {
	return withTimeout(
		(async () => {
			while (true) {
				const publication = await readPublication(harness);
				if (publication !== undefined) return publication;
				await Bun.sleep(25);
			}
		})(),
		timeoutMs,
		"session owner never published its endpoint",
	);
}

async function daemonPids(runtimeDir: string): Promise<number[]> {
	const root = path.join(runtimeDir, "daemons");
	const names = await fs.readdir(root).catch(() => []);
	const pids: number[] = [];
	for (const name of names) {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(path.join(root, name, "meta.json"), "utf8"));
			if (!isRecord(raw) || !isRecord(raw.daemon)) continue;
			const pid = raw.daemon.pid;
			if (typeof pid === "number" && Number.isInteger(pid)) pids.push(pid);
		} catch {}
	}
	return pids;
}

async function processAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await processAlive(pid))) return;
		await Bun.sleep(25);
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}

async function stopOwner(harness: Harness, publication: Publication | undefined): Promise<void> {
	const runtimeDirNames = await fs.readdir(path.join(harness.runDir, "daemons")).catch(() => []);
	const pids = new Set<number>();
	if (publication?.pid !== undefined) pids.add(publication.pid);
	for (const runtimeDirName of runtimeDirNames) {
		const runtimeDir = path.join(harness.runDir, "daemons", runtimeDirName);
		if (publication?.terminal !== undefined) {
			let client: DaemonBrokerClient | undefined;
			try {
				client = await createDaemonBrokerClient(harness.project, { runtimeDir });
				await client.request({
					op: "stop",
					name: publication.terminal.name,
					id: publication.terminal.id,
					timeoutMs: 2_000,
				});
			} catch {
			} finally {
				client?.close();
			}
		}
		for (const pid of await daemonPids(runtimeDir)) pids.add(pid);
		try {
			const brokerPid = Number((await fs.readFile(path.join(runtimeDir, "broker.pid"), "utf8")).trim());
			if (Number.isInteger(brokerPid)) {
				pids.add(brokerPid);
				process.kill(brokerPid, "SIGTERM");
			}
		} catch {}
	}
	for (const pid of pids) {
		if (await processAlive(pid)) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
	}
	await Promise.all([...pids].map(pid => waitForProcessExit(pid)));
}

function baseArgs(): string[] {
	return ["--model", "claude-sonnet-4-5", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-prewalk"];
}

async function connectSocket(
	socketPath: string,
): Promise<{ feed: FrameFeed; send: (frame: object) => void; close: () => void }> {
	const connection = await IpcConnection.connect(socketPath, { framing: "lines", timeoutMs: 5_000 });
	const feed = new FrameFeed();
	connection.start(
		line => {
			try {
				const frame: unknown = JSON.parse(line);
				if (isRecord(frame)) feed.push(frame as Frame);
			} catch {}
		},
		() => {},
	);
	return {
		feed,
		send: frame => connection.send(JSON.stringify(frame)),
		close: () => connection.destroy(),
	};
}

describe("brokered rpc launch", () => {
	let harness: Harness;
	let bridge: LaunchedBridge | undefined;
	let interactive: LaunchedInteractive | undefined;
	let owner: Publication | undefined;

	afterEach(async () => {
		await interactive?.close();
		interactive = undefined;
		await bridge?.close();
		bridge = undefined;
		owner ??= await readPublication(harness);
		await stopOwner(harness, owner);
		owner = undefined;
		await fs.rm(harness.root, { recursive: true, force: true });
	});

	test("a cold rpc launch boots one interactive owner that survives bridge EOF", async () => {
		harness = await createHarness();
		bridge = new LaunchedBridge(["--mode", "rpc", ...baseArgs()], harness.project, harness.env);
		await bridge.saw(frame => frame.type === "ready");
		bridge.write({ type: "get_state", id: "state" });
		const state = await bridge.saw(frame => frame.type === "response" && frame.id === "state");
		expect(state.success).toBe(true);

		const publication = await readPublication(harness);
		expect(publication).toBeDefined();
		owner = publication;
		expect(publication!.pid).not.toBe(bridge.pid);
		expect(publication!.terminal?.protocolVersion).toBe(1);
		expect((await readRunDir(harness)).filter(entry => entry.endsWith(".sock"))).toHaveLength(1);

		const sidecarPath = path.join(harness.runDir, `bridge-${bridge.pid}.json`);
		const sidecarStat = await fs.stat(sidecarPath);
		expect(sidecarStat.mode & 0o777).toBe(0o600);
		const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8")) as Record<string, unknown>;
		expect(sidecar).toMatchObject({
			pid: bridge.pid,
			sessionId: publication!.sessionId,
			ownerPid: publication!.pid,
		});

		expect(await bridge.closeStdin()).toBe(0);
		await expect(fs.stat(sidecarPath)).rejects.toThrow();
		const publicationPath = path.join(harness.runDir, `${publication!.sessionId}.json`);
		await expect(fs.stat(publicationPath)).resolves.toBeDefined();
		await expect(fs.stat(path.join(harness.runDir, `${publication!.sessionId}.sock`))).resolves.toBeDefined();
		expect(JSON.parse(await fs.readFile(publicationPath, "utf8"))).toEqual(publication);
		process.kill(publication!.pid, 0);

		const socket = await connectSocket(path.join(harness.runDir, `${publication!.sessionId}.sock`));
		await socket.feed.wait(frame => frame.type === "ready", 10_000, "shared socket never became ready");
		for (const [id, command, extra] of [
			["shared-get-state", "get_state", {}],
			["shared-filter", "set_event_filter", { events: ["message"], messageUpdates: "full" }],
			["shared-ask", "set_ask_dialog", { enabled: true }],
			["shared-swap", "new_session", {}],
			["shared-switch", "switch_session", {}],
			["shared-open", "open_session", {}],
			["shared-fork", "fork", {}],
			["shared-handoff", "handoff", {}],
			["shared-btw", "get_btw_history", {}],
		] as const) {
			socket.send({ type: command, id, ...extra });
			const response = await socket.feed.wait(
				frame => frame.type === "response" && frame.id === id,
				10_000,
				`no response for ${command}`,
			);
			if (
				command === "new_session" ||
				command === "switch_session" ||
				command === "open_session" ||
				command === "fork" ||
				command === "handoff"
			) {
				expect(response.success).toBe(false);
				expect(String(response.error)).toContain("shared session socket");
			} else {
				expect(response.success).toBe(true);
			}
		}
		socket.close();
	}, 120_000);

	test("a resumed rpc launch bridges into the same owner without booting a second", async () => {
		harness = await createHarness();
		bridge = new LaunchedBridge(["--mode", "rpc", ...baseArgs()], harness.project, harness.env);
		await bridge.saw(frame => frame.type === "ready");
		const first = await readPublication(harness);
		expect(first).toBeDefined();
		owner = first;
		expect(await bridge.closeStdin()).toBe(0);
		bridge = undefined;

		bridge = new LaunchedBridge(
			["--mode", "rpc", "--resume", first!.sessionId, ...baseArgs()],
			harness.project,
			harness.env,
		);
		await bridge.saw(frame => frame.type === "ready");
		bridge.write({ type: "get_state", id: "attached" });
		const state = await bridge.saw(frame => frame.type === "response" && frame.id === "attached");
		expect(state.success).toBe(true);
		const attached = await readPublication(harness);
		expect(attached?.pid).toBe(first!.pid);
		const runtimeDirNames = await fs.readdir(path.join(harness.runDir, "daemons"));
		const daemonRecords = await fs.readdir(path.join(harness.runDir, "daemons", runtimeDirNames[0]!, "daemons"));
		expect(daemonRecords).toHaveLength(1);
		expect(await bridge.closeStdin()).toBe(0);
	}, 120_000);

	test.skipIf(!hasPtyHarness)(
		"an interactive launch mirrors the terminal-sized owner and survives mirror SIGHUP",
		async () => {
			harness = await createHarness();
			interactive = new LaunchedInteractive(baseArgs(), harness.project, harness.env);
			const publication = await waitForPublication(harness);
			owner = publication;
			expect(publication.pid).not.toBe(interactive.pid);
			expect(publication.terminal?.protocolVersion).toBe(1);
			const socketPath = path.join(harness.runDir, `${publication.sessionId}.sock`);
			const publicationPath = path.join(harness.runDir, `${publication.sessionId}.json`);
			await expect(fs.stat(socketPath)).resolves.toBeDefined();

			await interactive.waitForOutput();
			expect(interactive.outputBytes).toBeGreaterThan(0);
			const size = await withTimeout(
				(async () => {
					while (true) {
						const observed = await readPtySize(publication.pid);
						if (observed !== undefined) return observed;
						await Bun.sleep(25);
					}
				})(),
				10_000,
				"owner PTY size was never readable",
			);
			expect(size).toEqual({ columns: 100, rows: 30 });

			await Bun.sleep(STARTUP_WATCHDOG_SOAK_MS);
			expect(interactive.output()).not.toContain("Still starting after");

			await interactive.signalMirrorHangup();
			expect(await interactive.waitForExit()).toBe(129);
			await expect(fs.stat(publicationPath)).resolves.toBeDefined();
			await expect(fs.stat(socketPath)).resolves.toBeDefined();
			expect(process.kill(publication.pid, 0)).toBe(true);

			const socket = await connectSocket(socketPath);
			try {
				await socket.feed.wait(frame => frame.type === "ready", 10_000, "owner socket never became ready");
				socket.send({ type: "get_state", id: "after-hangup" });
				const state = await socket.feed.wait(
					frame => frame.type === "response" && frame.id === "after-hangup",
					10_000,
					"owner stopped answering after the mirror detached",
				);
				expect(state.success).toBe(true);
			} finally {
				socket.close();
			}
		},
		180_000,
	);

	for (const noUi of [false, true]) {
		test.skipIf(!hasPtyHarness)(
			noUi
				? "native --attach refuses terminal-less --mode rpc --no-ui without side effects"
				: "native --attach controls the same persistent --mode rpc conversation",
			async () => {
				harness = await createHarness();
				const requests: string[] = [];
				const provider = Bun.serve({
					hostname: "127.0.0.1",
					port: 0,
					async fetch(request) {
						const body = await request.text();
						const payload: unknown = JSON.parse(body);
						const lastMessage =
							isRecord(payload) && Array.isArray(payload.messages) ? payload.messages.at(-1) : undefined;
						const content =
							isRecord(lastMessage) && lastMessage.role === "user" ? lastMessage.content : undefined;
						const text =
							typeof content === "string"
								? content
								: Array.isArray(content)
									? content
											.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
											.join("\n")
									: "";
						// Episode recaps share this provider but are not owner conversation turns.
						const conversationTurn = ["NATIVE_WEB_WARMUP", "NATIVE_TERMINAL_ONE", "NATIVE_TERMINAL_TWO"].some(
							marker => text.trimEnd().endsWith(marker),
						);
						if (conversationTurn) requests.push(body);
						const reply = conversationTurn
							? `NATIVE_CONTROL_REPLY_${requests.length}`
							: "NATIVE_SIDE_CHANNEL_REPLY";
						const chunks = [
							{
								id: `native-control-${requests.length}`,
								choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }],
							},
							{
								id: `native-control-${requests.length}`,
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							},
						];
						return new Response(
							`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					},
				});
				const viewers: LaunchedInteractive[] = [];
				let observer: { feed: FrameFeed; send: (frame: object) => void; close: () => void } | undefined;
				try {
					const agentDir = harness.env.PI_CODING_AGENT_DIR!;
					await Bun.write(
						path.join(agentDir, "config.yml"),
						JSON.stringify({
							setupVersion: 99,
							defaultThinkingLevel: "off",
							startup: { showSplash: false, setupWizard: false, changelogMode: "hidden", checkUpdate: false },
							marketplace: { autoUpdate: "off" },
							telemetry: { otlpExportEnabled: false },
							compaction: { enabled: false },
						}),
					);
					await Bun.write(
						path.join(agentDir, "models.yml"),
						JSON.stringify({
							providers: {
								"native-control": {
									baseUrl: `${provider.url.origin}/v1`,
									api: "openai-completions",
									auth: "none",
									models: [
										{
											id: "local",
											name: "Local native control fixture",
											reasoning: false,
											input: ["text"],
											cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
											contextWindow: 131072,
											maxTokens: 1024,
										},
									],
								},
							},
						}),
					);
					const args = [
						"--mode",
						"rpc",
						...(noUi ? ["--no-ui"] : []),
						"--model",
						"native-control/local",
						"--no-extensions",
						"--no-skills",
						"--no-rules",
						"--no-lsp",
						"--no-prewalk",
						"--no-tools",
					];
					bridge = new LaunchedBridge(args, harness.project, harness.env);
					await bridge.saw(frame => frame.type === "ready");
					owner = await waitForPublication(harness);
					const originalOwner = owner;
					const socketPath = path.join(harness.runDir, `${owner.sessionId}.sock`);
					observer = await connectSocket(socketPath);
					await observer.feed.wait(frame => frame.type === "ready", 10_000, "independent RPC observer not ready");
					bridge.write({ type: "prompt", id: "web-warmup", message: "NATIVE_WEB_WARMUP" });
					await observer.feed.wait(
						frame => frame.type === "agent_end" && JSON.stringify(frame).includes("NATIVE_CONTROL_REPLY_1"),
						30_000,
						"real provider conversation did not complete through RPC",
					);
					const sessionPath = await fs.realpath(owner.sessionFile);
					const sessionDir = path.dirname(sessionPath);
					const filesBefore = (await fs.readdir(sessionDir)).filter(file => file.endsWith(".jsonl")).sort();
					const transcriptBefore = await fs.readFile(sessionPath, "utf8");
					const first = new LaunchedInteractive(["--attach", sessionPath], harness.project, harness.env);
					viewers.push(first);
					interactive = first;
					try {
						if (noUi) {
							const nativeAttachExitCode = await first.waitForExit();
							expect(nativeAttachExitCode).toBe(2);
							expect(first.output()).toContain("terminal-unavailable");
							expect(await fs.readFile(sessionPath, "utf8")).toBe(transcriptBefore);
							expect(requests).toHaveLength(1);
							observer.send({ type: "get_state", id: "after-native-refusal" });
							const state = await observer.feed.wait(
								frame => frame.type === "response" && frame.id === "after-native-refusal",
								10_000,
								"independent RPC observer lost its owner after native refusal",
							);
							expect(state).toMatchObject({
								success: true,
								data: { sessionId: originalOwner.sessionId, sessionFile: sessionPath },
							});
							process.stdout.write(
								`${JSON.stringify({
									contract: "brokered_session_control_v1",
									nativeAttachExitCode,
								})}\n`,
							);
							return;
						}
						await first.waitForText("NATIVE_CONTROL_REPLY_1");
						first.write("NATIVE_TERMINAL_ONE\r");
						await observer.feed.wait(
							frame => frame.type === "agent_end" && JSON.stringify(frame).includes("NATIVE_CONTROL_REPLY_2"),
							30_000,
							"native terminal input did not execute a turn on the RPC owner's conversation",
						);
						expect(requests[1]).toContain("NATIVE_WEB_WARMUP");
						expect(requests[1]).toContain("NATIVE_TERMINAL_ONE");
						await first.resize(101, 33);
						await withTimeout(
							(async () => {
								const deadline = Date.now() + 10_000;
								while (Date.now() < deadline) {
									const size = await readPtySize(originalOwner.pid);
									if (size?.columns === 101 && size.rows === 33) return;
									await Bun.sleep(25);
								}
								throw new Error("native viewer resize did not reach the same owner's PTY");
							})(),
							10_000,
							"native viewer resize did not reach the same owner's PTY",
						);
						const second = new LaunchedInteractive(["--attach", sessionPath], harness.project, harness.env);
						viewers.push(second);
						await second.waitForText("NATIVE_CONTROL_REPLY_2");
						await first.signalMirrorHangup();
						expect(await first.waitForExit()).toBe(129);
						expect(await processAlive(originalOwner.pid)).toBe(true);
						second.write("NATIVE_TERMINAL_TWO\r");
						await observer.feed.wait(
							frame => frame.type === "agent_end" && JSON.stringify(frame).includes("NATIVE_CONTROL_REPLY_3"),
							30_000,
							"second native viewer lost control after the first detached",
						);
						expect(requests[2]).toContain("NATIVE_TERMINAL_ONE");
						expect(requests[2]).toContain("NATIVE_TERMINAL_TWO");
						await second.signalMirrorHangup();
						expect(await second.waitForExit()).toBe(129);
						observer.send({ type: "get_state", id: "after-native-detach" });
						const state = await observer.feed.wait(
							frame => frame.type === "response" && frame.id === "after-native-detach",
							10_000,
							"independent RPC observer lost its owner after both native viewers detached",
						);
						expect(state).toMatchObject({
							success: true,
							data: { sessionId: originalOwner.sessionId, sessionFile: sessionPath },
						});
						const transcript = await fs.readFile(sessionPath, "utf8");
						expect(transcript).toContain("NATIVE_TERMINAL_ONE");
						expect(transcript).toContain("NATIVE_TERMINAL_TWO");
						expect(transcript).toContain("NATIVE_CONTROL_REPLY_3");
					} finally {
						expect(await processAlive(originalOwner.pid)).toBe(true);
						expect(await readPublication(harness)).toEqual(originalOwner);
						expect((await fs.readdir(sessionDir)).filter(file => file.endsWith(".jsonl")).sort()).toEqual(
							filesBefore,
						);
						process.stdout.write(
							`${JSON.stringify({
								contract: "brokered_session_control_v1",
								mode: args.slice(0, noUi ? 3 : 2),
								ownerPid: originalOwner.pid,
								bridgePid: bridge.pid,
								sessionId: originalOwner.sessionId,
								terminal: originalOwner.terminal ?? null,
								providerTurns: requests.length,
							})}\n`,
						);
					}
				} finally {
					await Promise.all(viewers.map(viewer => viewer.close()));
					interactive = undefined;
					observer?.close();
					provider.stop(true);
				}
			},
			120_000,
		);
	}

	test("--no-ui keeps the rpc lifecycle in process and leaves no detached owner", async () => {
		harness = await createHarness();
		bridge = new LaunchedBridge(["--mode", "rpc", "--no-ui", ...baseArgs()], harness.project, harness.env);
		await bridge.saw(frame => frame.type === "ready");
		bridge.write({ type: "get_state", id: "headless" });
		const state = await bridge.saw(frame => frame.type === "response" && frame.id === "headless");
		expect(state.success).toBe(true);

		const publication = await readPublication(harness);
		expect(publication?.pid).toBe(bridge.pid);
		expect(publication?.terminal).toBeUndefined();
		const sessionId = publication!.sessionId;
		expect(await bridge.closeStdin()).toBe(0);

		await expect(fs.stat(path.join(harness.runDir, `${sessionId}.json`))).rejects.toThrow();
		await expect(fs.stat(path.join(harness.runDir, `${sessionId}.sock`))).rejects.toThrow();
		expect((await readRunDir(harness)).filter(entry => entry.endsWith(".sock"))).toEqual([]);
	}, 120_000);
});
