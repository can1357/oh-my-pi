/**
 * Brokered launch: the outer process never opens the transcript. It resolves
 * the target read-only, then either attaches to the live owner's terminal,
 * boots one detached `PtySession` owner that publishes both `terminal` and
 * `<sessionId>.sock`, or forwards stdio to that socket.
 *
 * Every escape hatch (ephemeral, headless, print, ACP, already an owner) is
 * decided here so the unbrokered in-process runners keep their exact lifetime
 * contract: bound to stdio EOF and to this process.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { isEnoent, isPidAlive, isRecord, readLines, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { flagConsumesValue } from "../cli/flag-tables";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { DaemonBrokerClient } from "./client";
import { createDaemonBrokerClient, requireTerminalProtocol } from "./client";
import { type DaemonTerminalNotification, sanitizeTerminalGeometry } from "./protocol";
import { resolveSessionEndpointDir, SESSION_RUN_DIR_ENV, type SessionAttachTerminal } from "./session-attach";
import { runLiveSessionAttach } from "./session-attach-run";
import { isSessionOwnerProcess, sessionOwnerSpec } from "./session-owner";
import { runTerminalMirror, type TerminalMirrorOptions } from "./terminal-mirror";

/** The launch shape a brokered decision depends on. */
export interface BrokeredLaunchSelection {
	mode: string;
	print: boolean;
	noSession: boolean;
	noUi: boolean;
	/** Explicit `--resume <id|path>`; `true` for the bare picker. */
	resume: string | true | undefined;
	continue: boolean;
	fork: boolean;
	fromClaude: boolean;
	fromCodex: boolean;
}

/**
 * Only a persistent, UI-hosting launch delegates to an owner. Ephemeral
 * (`--no-session`), headless (`--no-ui`), print, ACP and owner-child launches
 * stay in-process and keep their stdio/proces lifetime.
 */
export function shouldBootBrokeredSession(selection: BrokeredLaunchSelection, isInteractive: boolean): boolean {
	if (selection.noSession || selection.noUi || selection.print) return false;
	if (selection.mode === "acp") return false;
	if (isSessionOwnerProcess()) return false;
	if (selection.fork || selection.fromClaude || selection.fromCodex || selection.resume === true) return false;
	if (isInteractive) return true;
	return selection.mode === "rpc" || selection.mode === "rpc-ui";
}

/** Remove this launch's `--mode rpc|rpc-ui` so the owner child boots the interactive host. */
export function stripRpcModeArgs(argv: readonly string[]): string[] {
	const stripped: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--mode") {
			index++;
			continue;
		}
		if (arg === "--mode=rpc" || arg === "--mode=rpc-ui") continue;
		stripped.push(arg);
	}
	return stripped;
}

/**
 * Drop a bare `--resume`/`-r` selector: the interactive picker has no stdio
 * surface, and the unbrokered RPC host never opened it either. An explicit
 * id/path keeps its value token.
 */
export function stripBareResumeArgs(argv: readonly string[]): string[] {
	const stripped: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--") {
			stripped.push(...argv.slice(index));
			break;
		}
		const flag = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
		if (flag !== "--resume" && flag !== "-r") {
			stripped.push(arg);
			continue;
		}
		if (arg.includes("=")) {
			stripped.push(arg);
			continue;
		}
		const next = argv[index + 1];
		if (!flagConsumesValue(arg, next) || next === undefined) continue;
		stripped.push(arg, next);
		index++;
	}
	return stripped;
}

const OWNER_SESSION_SELECTORS: Readonly<Record<string, true>> = {
	"--resume": true,
	"-r": true,
	"--restore": true,
	"--session": true,
	"--continue": true,
	"-c": true,
	"--fork": true,
	"--from-claude": true,
	"--from-codex": true,
};

/** How long a stdio bridge follows an owner that re-publishes its socket in place. */
const BRIDGE_RECONNECT_BUDGET_MS = 15_000;
const BRIDGE_RECONNECT_INITIAL_DELAY_MS = 50;
const BRIDGE_RECONNECT_MAX_DELAY_MS = 500;
const BRIDGE_RECONNECT_CONNECT_TIMEOUT_MS = 1_000;

/**
 * Point an owner relaunch at the exact session the parent gate resolved,
 * keeping every configuration flag and positional message. The parent rewrites
 * `--continue`/auto-resume selectors so the owner cannot pick a different
 * recent session after the ownership decision was made.
 */
export function ownerArgvForSession(argv: readonly string[], sessionSource: string): string[] {
	const kept: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--") {
			kept.push(...argv.slice(index));
			break;
		}
		const flag = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
		if (OWNER_SESSION_SELECTORS[flag]) {
			if (flagConsumesValue(arg, argv[index + 1])) index++;
			continue;
		}
		kept.push(arg);
	}
	return [...kept, "--resume", sessionSource];
}

export interface BrokeredOwner {
	readonly client: DaemonBrokerClient;
	readonly daemon: DaemonSnapshot;
	readonly name: string;
	readonly subscriptionId: string;
	readonly sessionId: string;
	readonly socketPath: string;
	readonly endpointDir: string;
	/** Frames the owner emitted between `terminal_start` and the mirror taking over the sink. */
	readonly initialFrames: readonly DaemonTerminalNotification[];
}

export interface BootBrokeredOwnerOptions {
	projectDir: string;
	/** Owner argv, already stripped of the transport that asked for the boot. */
	argv: readonly string[];
	endpointDir?: string;
	/** Known for `--resume <id>`; discovered from the publication otherwise. */
	expectedSessionId?: string;
	columns?: number;
	rows?: number;
	timeoutMs?: number;
}

interface OwnerPublication {
	sessionId: string;
	pid: number;
	terminal?: unknown;
}

async function readOwnerPublication(
	endpointDir: string,
	pid: number,
	expectedSessionId: string | undefined,
): Promise<OwnerPublication | undefined> {
	let entries: string[];
	try {
		entries = await fsp.readdir(endpointDir);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json") || entry.startsWith("bridge-")) continue;
		let record: unknown;
		try {
			record = JSON.parse(await fsp.readFile(path.join(endpointDir, entry), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;
		if (record.pid !== pid || typeof record.sessionId !== "string") continue;
		if (expectedSessionId !== undefined && record.sessionId !== expectedSessionId) continue;
		return { sessionId: record.sessionId, pid, terminal: record.terminal };
	}
	return undefined;
}

async function socketPublished(endpointDir: string, sessionId: string): Promise<boolean> {
	try {
		await fsp.stat(ipcEndpoint(endpointDir, sessionId));
		return true;
	} catch {
		return false;
	}
}

/**
 * Wait until the owner child publishes both `<sessionId>.json` and its socket.
 * A child that exits first fails the launch instead of waiting out the bound.
 */
async function waitForOwnerPublication(options: {
	client: DaemonBrokerClient;
	name: string;
	endpointDir: string;
	pid: number;
	expectedSessionId?: string;
	timeoutMs: number;
}): Promise<OwnerPublication> {
	const deadline = Date.now() + options.timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		let daemon: DaemonSnapshot | undefined;
		try {
			const described = await options.client.request({ op: "describe", name: options.name });
			if (described.op === "describe") daemon = described.daemon;
		} catch (error) {
			lastError = error;
		}
		if (daemon !== undefined && (daemon.state === "exited" || daemon.state === "failed")) {
			throw new Error(
				`Session owner ${options.name} exited before publishing (${daemon.exitReason ?? daemon.state})${await ownerFailureOutput(options.client, options.name)}`,
			);
		}
		const publication = await readOwnerPublication(options.endpointDir, options.pid, options.expectedSessionId);
		if (publication && (await socketPublished(options.endpointDir, publication.sessionId))) return publication;
		await Bun.sleep(50);
	}
	throw new Error(
		`Session owner ${options.name} did not publish its endpoint within ${options.timeoutMs}ms${
			lastError === undefined ? "" : `: ${toError(lastError).message}`
		}`,
	);
}

async function ownerFailureOutput(client: DaemonBrokerClient, name: string): Promise<string> {
	try {
		const logs = await client.request({
			op: "logs",
			name,
			lines: 20,
			head: false,
			follow: false,
			renderTerminalRows: true,
			timeoutMs: 1_000,
		});
		if (logs.op !== "logs") return "";
		const text = (logs.terminalRows?.join("\n") ?? logs.text ?? logs.terminalText ?? "").trim();
		return text.length === 0 ? "" : `:\n${text}`;
	} catch {
		return "";
	}
}

/**
 * Start one detached brokered `PtySession` owner and wait for its publication.
 * The terminal subscription is installed before the child's first byte, so a
 * failure to publish can stop the exact generation it started.
 */
export async function bootBrokeredOwner(options: BootBrokeredOwnerOptions): Promise<BrokeredOwner> {
	const endpointDir = resolveSessionEndpointDir(options.endpointDir);
	const client = await createDaemonBrokerClient(options.projectDir);
	let started: DaemonSnapshot | undefined;
	const name = `omp-session-${Snowflake.next()}`;
	const subscriptionId = `owner-${Snowflake.next()}`;
	const initialFrames: DaemonTerminalNotification[] = [];
	const geometry = sanitizeTerminalGeometry(options.columns, options.rows);
	try {
		await requireTerminalProtocol(client);
		client.subscribeTerminal(subscriptionId, frame => {
			initialFrames.push(frame);
		});
		const result = await client.request({
			op: "terminal_start",
			subscriptionId,
			spec: sessionOwnerSpec({
				name,
				projectDir: options.projectDir,
				argv: options.argv,
				env: { [SESSION_RUN_DIR_ENV]: endpointDir },
			}),
			columns: geometry.columns,
			rows: geometry.rows,
		});
		if (result.op !== "terminal_start") throw new Error("terminal_start produced a non-terminal result");
		started = result.daemon;
		const pid = started.pid;
		if (pid === undefined) throw new Error(`Session owner ${name} did not report a pid`);
		const publication = await waitForOwnerPublication({
			client,
			name,
			endpointDir,
			pid,
			timeoutMs: options.timeoutMs ?? 20_000,
			...(options.expectedSessionId === undefined ? {} : { expectedSessionId: options.expectedSessionId }),
		});
		return {
			client,
			daemon: started,
			name,
			subscriptionId,
			sessionId: publication.sessionId,
			socketPath: ipcEndpoint(endpointDir, publication.sessionId),
			endpointDir,
			initialFrames,
		};
	} catch (error) {
		if (started !== undefined) {
			await client.request({ op: "stop", name, id: started.id, timeoutMs: 2_000 }).catch(stopError => {
				process.stderr.write(
					`warning: failed to stop unpublished session owner ${name}: ${toError(stopError).message}\n`,
				);
			});
		}
		client.close();
		throw error;
	}
}

/** The resolved target of a persistent launch, already ownership-gated by the caller. */
export type PersistentLaunchTarget =
	| { kind: "attach"; sessionId: string; terminal?: SessionAttachTerminal }
	| { kind: "cold"; sessionId: string }
	| { kind: "none" };

export interface InteractiveOwnerLaunchOptions {
	projectDir: string;
	argv: readonly string[];
	target: PersistentLaunchTarget;
	endpointDir?: string;
	columns?: number;
	rows?: number;
	/** Local terminal seams forwarded to the mirror in tests. */
	mirror?: Partial<Omit<TerminalMirrorOptions, "client" | "name" | "id" | "subscriptionId" | "refresh">>;
}

/**
 * Interactive launch that cannot run in-process: attach to the live owner's
 * terminal, or boot one and mirror it. Returns the process exit code.
 */
export async function runInteractiveOwnerLaunch(options: InteractiveOwnerLaunchOptions): Promise<number> {
	if (options.target.kind === "attach") {
		if (options.target.terminal === undefined) {
			throw new Error(
				`Session "${options.target.sessionId}" has a live socket but no attachable terminal; use --mode rpc to bridge to it.`,
			);
		}
		return runLiveSessionAttach(options.target.sessionId, options.target.terminal, {
			...(options.endpointDir === undefined ? {} : { endpointDir: options.endpointDir }),
			...(options.mirror === undefined ? {} : { mirror: options.mirror }),
		});
	}
	const expectedSessionId = options.target.kind === "cold" ? options.target.sessionId : undefined;
	const owner = await bootBrokeredOwner({
		projectDir: options.projectDir,
		argv: options.argv,
		...(options.endpointDir === undefined ? {} : { endpointDir: options.endpointDir }),
		...(expectedSessionId === undefined ? {} : { expectedSessionId }),
		...(options.columns === undefined ? {} : { columns: options.columns }),
		...(options.rows === undefined ? {} : { rows: options.rows }),
	});
	try {
		if (owner.daemon.pid === undefined) throw new Error("Session owner did not report a pid");
		const result = await runTerminalMirror({
			...options.mirror,
			client: owner.client,
			name: owner.name,
			id: owner.daemon.id,
			subscriptionId: owner.subscriptionId,
			alreadyAttached: true,
			initialFrames: owner.initialFrames,
		});
		return result.detached ? 0 : (result.exitCode ?? 1);
	} finally {
		owner.client.close();
	}
}

export interface RpcOwnerBridgeOptions {
	projectDir: string;
	argv: readonly string[];
	target: PersistentLaunchTarget;
	endpointDir?: string;
	timeoutMs?: number;
	columns?: number;
	rows?: number;
	/** Already-claimed stdio, so this process owns the singleton stream. */
	input?: ReadableStream<Uint8Array>;
	output?: { write(chunk: string): unknown };
}

/**
 * Persistent `--mode rpc` wrapper: attach straight to an existing session
 * socket, or boot one owner (mode flags stripped) and attach to the socket it
 * publishes. The owner outlives this process; stdin EOF only closes the bridge.
 */
export async function runPersistentRpcLaunch(options: RpcOwnerBridgeOptions): Promise<number> {
	const endpointDir = resolveSessionEndpointDir(options.endpointDir);
	const stdio = {
		...(options.input === undefined ? {} : { input: options.input }),
		...(options.output === undefined ? {} : { output: options.output }),
	};
	if (options.target.kind === "attach") {
		const socketPath = ipcEndpoint(endpointDir, options.target.sessionId);
		const ownerPid = await ownerPidOf(socketPath);
		return runStdioRpcBridge({
			sessionId: options.target.sessionId,
			socketPath,
			endpointDir,
			...(ownerPid === undefined ? {} : { ownerPid }),
			...stdio,
		});
	}
	const owner = await bootBrokeredOwner({
		projectDir: options.projectDir,
		argv: stripBareResumeArgs(stripRpcModeArgs(options.argv)),
		endpointDir,
		...(options.target.kind === "cold" ? { expectedSessionId: options.target.sessionId } : {}),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.columns === undefined ? {} : { columns: options.columns }),
		...(options.rows === undefined ? {} : { rows: options.rows }),
	});
	try {
		await owner.client
			.request({
				op: "terminal_detach",
				subscriptionId: owner.subscriptionId,
				name: owner.name,
				id: owner.daemon.id,
			})
			.catch(() => undefined);
		const ownerPid = owner.daemon.pid;
		return await runStdioRpcBridge({
			sessionId: owner.sessionId,
			socketPath: owner.socketPath,
			endpointDir,
			...(ownerPid === undefined ? {} : { ownerPid }),
			...stdio,
		});
	} finally {
		owner.client.close();
	}
}

/** The publication pid behind a reachable socket; absent when it cannot be read. */
async function ownerPidOf(socketPath: string): Promise<number | undefined> {
	const endpointDir = path.dirname(socketPath);
	const sessionId = path.basename(socketPath).replace(/\.sock$/, "");
	try {
		const record = JSON.parse(await fsp.readFile(path.join(endpointDir, `${sessionId}.json`), "utf8"));
		if (isRecord(record) && typeof record.pid === "number") return record.pid;
	} catch {
		return undefined;
	}
	return undefined;
}

export interface StdioRpcBridgeOptions {
	sessionId: string;
	socketPath: string;
	endpointDir: string;
	ownerPid?: number;
	input?: ReadableStream<Uint8Array>;
	output?: { write(chunk: string): unknown };
}

export function bridgeSidecarPath(endpointDir: string, pid: number = process.pid): string {
	return path.join(endpointDir, `bridge-${pid}.json`);
}

/**
 * Owner-only sidecar so a detached keeper (`@deepseek-ai/omp-rpc`) can find the
 * session for the pid it spawned. `<sessionId>.json` keeps naming the owner.
 */
async function writeBridgeSidecar(options: {
	endpointDir: string;
	sessionId: string;
	pid: number;
	ownerPid?: number;
}): Promise<string> {
	const file = bridgeSidecarPath(options.endpointDir, options.pid);
	const temporary = `${file}.tmp-${options.pid}`;
	const handle = await fsp.open(temporary, "w", 0o600);
	try {
		await handle.writeFile(
			JSON.stringify({
				pid: options.pid,
				sessionId: options.sessionId,
				ownerPid: options.ownerPid,
				startedAt: Date.now(),
			}),
			"utf8",
		);
	} finally {
		await handle.close();
	}
	await fsp.rename(temporary, file);
	return file;
}

function unlinkBridgeSync(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {}
}

/**
 * Forward stdio RPC frames to the session socket and the socket's frames back.
 * Stdin EOF closes only this connection: the owner, its socket and its terminal
 * stay alive for the next client.
 *
 * An owner `/restart` keeps the same pid and re-publishes
 * the same socket path in place, so a socket close is retried while stdin
 * stays open and the owner pid is alive; frames written in between are held and
 * flushed on the next connection.
 */
export async function runStdioRpcBridge(options: StdioRpcBridgeOptions): Promise<number> {
	const input = options.input ?? Bun.stdin.stream();
	const output = options.output ?? process.stdout;
	const sidecar = await writeBridgeSidecar({
		endpointDir: options.endpointDir,
		sessionId: options.sessionId,
		pid: process.pid,
		...(options.ownerPid === undefined ? {} : { ownerPid: options.ownerPid }),
	});
	const onProcessExit = () => unlinkBridgeSync(sidecar);
	const onSignal = () => {
		unlinkBridgeSync(sidecar);
		process.exit(0);
	};
	process.on("exit", onProcessExit);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	let connection: IpcConnection | undefined = await IpcConnection.connect(options.socketPath, {
		framing: "lines",
		timeoutMs: 10_000,
	});
	const finished = Promise.withResolvers<void>();
	const decoder = new TextDecoder();
	const buffered: string[] = [];
	let flushChain: Promise<void> = Promise.resolve();
	const flushBuffered = (target: IpcConnection): Promise<void> => {
		const run = async (): Promise<void> => {
			while (buffered.length > 0 && !target.closed) {
				const pending = buffered[0] as string;
				const belowHighWater = target.send(pending);
				if (!belowHighWater && target.closed) return;
				buffered.shift();
				if (belowHighWater) continue;
				await target.drained();
				if (connection !== target) return;
			}
		};
		const next = flushChain.then(run);
		flushChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
	let pumping = true;
	let inputClosed = false;
	const ownerAlive = (): boolean => options.ownerPid !== undefined && isPidAlive(options.ownerPid);
	const pump = (async () => {
		try {
			for await (const line of readLines(input)) {
				if (!pumping) return;
				const text = decoder.decode(line).trim();
				if (text.length === 0) continue;
				if (connection && !connection.closed && buffered.length === 0) {
					const current: IpcConnection = connection;
					const belowHighWater = current.send(text);
					if (!belowHighWater && current.closed) {
						buffered.push(text);
						continue;
					}
					if (!belowHighWater) {
						await current.drained();
						if (connection === current) await flushBuffered(current);
					}
					continue;
				}
				buffered.push(text);
			}
		} catch {
			// A closed or failing stdin ends the wrapper, never the owner.
		} finally {
			inputClosed = true;
			finished.resolve();
		}
	})();
	try {
		let reconnectDelayMs = BRIDGE_RECONNECT_INITIAL_DELAY_MS;
		for (;;) {
			const current = connection;
			if (!current) return 0;
			const closed = Promise.withResolvers<void>();
			current.start(
				line => output.write(`${line}\n`),
				() => closed.resolve(),
			);
			await flushBuffered(current);
			await Promise.race([finished.promise, closed.promise]);
			current.destroy();
			connection = undefined;
			if (inputClosed || !ownerAlive()) break;
			const reconnectDeadline = Date.now() + BRIDGE_RECONNECT_BUDGET_MS;
			while (!inputClosed && ownerAlive() && Date.now() < reconnectDeadline) {
				await Bun.sleep(reconnectDelayMs);
				reconnectDelayMs = Math.min(reconnectDelayMs * 2, BRIDGE_RECONNECT_MAX_DELAY_MS);
				if (inputClosed || !ownerAlive()) break;
				try {
					connection = await IpcConnection.connect(options.socketPath, {
						framing: "lines",
						timeoutMs: BRIDGE_RECONNECT_CONNECT_TIMEOUT_MS,
					});
				} catch {
					connection = undefined;
				}
				if (connection) break;
			}
			if (!connection) break;
		}
		return 0;
	} finally {
		pumping = false;
		process.off("exit", onProcessExit);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		unlinkBridgeSync(sidecar);
		try {
			await input.cancel();
		} catch {}
		void pump.catch(() => undefined);
		connection?.destroy();
	}
}
