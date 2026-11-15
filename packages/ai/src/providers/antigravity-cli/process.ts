/**
 * Subprocess, workspace-isolation, and deadline primitives shared by dedicated
 * and pooled Antigravity CLI (`agy acp`) transports.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { ClientSideConnection, ndJsonStream, type SessionNotification } from "@oh-my-pi/pi-utils/acp";
import agentDefinition from "./agent.md" with { type: "text" };
import { resolveAgyBinary } from "./binary";
import { agyCredentialEnv } from "./credentials";
import type { McpBridge } from "./mcp-bridge";

const AGENT_NAME = "bridge";

/** ACP operations required by the host; injectable without module or environment mutation. */
export type AgyConnection = Pick<
	ClientSideConnection,
	| "initialize"
	| "newSession"
	| "loadSession"
	| "closeSession"
	| "setSessionConfigOption"
	| "prompt"
	| "cancel"
	| "signal"
>;

/** Owned process/connection resources. close must terminate the transport and is idempotent. */
export interface AgyTransport {
	connection: AgyConnection;
	exited: Promise<number>;
	/** Effective credential revision of the leased backend when backed by a shared pool. */
	credentialVersion?: string;
	/** Effective credential expiry (epoch ms) of the leased backend when backed by a shared pool. */
	credentialExpires?: number;
	close(): void;
}

/** A scheduled host deadline; cancellation must be idempotent. */
export interface AgyTimer {
	cancel(): void;
}

/** Clock seam keeps lifecycle tests isolated from global timers. */
export type AgyScheduler = (delayMs: number, callback: () => void) => AgyTimer;

/** Arguments for spawning a managed `agy acp --agent bridge` child process. */
export interface AgyProcessSpawnOptions {
	geminiDir: string;
	cwd: string;
	bridge: McpBridge;
	signal?: AbortSignal;
	onUpdate(notification: SessionNotification): void;
}

/** Spawned `agy acp` subprocess paired with its loopback MCP bridge and event-loop ref controls. */
export interface AgySpawnedProcess extends AgyTransport {
	ref(): void;
	unref(): void;
}

interface RefCountedStream {
	ref(): void;
	unref(): void;
}

function isRefCountedStream(value: object): value is RefCountedStream {
	return "ref" in value && typeof value.ref === "function" && "unref" in value && typeof value.unref === "function";
}

async function writeAgentDefinition(geminiDir: string): Promise<void> {
	const file = Bun.file(path.join(geminiDir, "config", "agents", `${AGENT_NAME}.md`));
	if ((await file.exists()) && (await file.text()) === agentDefinition) return;
	await Bun.write(file, agentDefinition);
}

/** Spawn `agy acp --agent bridge` connected to `options.bridge`. Shared by pooled and dedicated hosts. */
export async function spawnAgyCliProcess(options: AgyProcessSpawnOptions): Promise<AgySpawnedProcess> {
	const binary = await resolveAgyBinary();
	if (!$which("nc")) throw new Error("Antigravity CLI needs nc (netcat) on PATH for its tool bridge");
	await writeAgentDefinition(options.geminiDir);
	options.signal?.throwIfAborted();
	// Bun.spawn's Web ReadableStream stdout lacks ref()/unref() and holds the event
	// loop open once ClientSideConnection starts awaiting reader.read(); node:child_process
	// exposes stdout as a Readable with ref()/unref() so warm idle shared backends allow natural exit.
	const child = spawn(
		binary,
		[
			"acp",
			"--agent",
			AGENT_NAME,
			"--gemini-dir",
			options.geminiDir,
			"--ide-mcp-port",
			String(options.bridge.port),
			"--dangerously-skip-permissions",
		],
		{
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "ignore"],
			env: { ...Bun.env, ...agyCredentialEnv(), AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
		},
	);
	const exited = Promise.withResolvers<number>();
	child.once("close", (code, signal) => {
		exited.resolve(code ?? (signal ? 1 : 0));
	});
	child.once("error", error => {
		exited.reject(error);
	});
	exited.promise.catch(() => undefined);
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		options.bridge.close();
		child.kill("SIGKILL");
	};
	try {
		if (!isRefCountedStream(child.stdout)) {
			throw new Error("Antigravity CLI child stdout lacks ref()/unref() required for idle shutdown");
		}
		const stdoutRef = child.stdout;
		const spawned = Promise.withResolvers<void>();
		child.once("spawn", () => spawned.resolve());
		child.once("error", spawned.reject);
		await spawned.promise;
		options.signal?.throwIfAborted();
		const input = new WritableStream<Uint8Array>({
			write: chunk => {
				const written = Promise.withResolvers<void>();
				child.stdin.write(chunk, error => (error ? written.reject(error) : written.resolve()));
				return written.promise;
			},
			close: () => {
				const ended = Promise.withResolvers<void>();
				child.stdin.end(() => ended.resolve());
				return ended.promise;
			},
		});
		const output = new ReadableStream<Uint8Array>({
			start: controller => {
				let streamDone = false;
				child.stdout.on("data", (chunk: Buffer) => {
					if (!streamDone) controller.enqueue(new Uint8Array(chunk));
				});
				child.stdout.once("end", () => {
					if (streamDone) return;
					streamDone = true;
					controller.close();
				});
				child.stdout.once("error", error => {
					if (streamDone) return;
					streamDone = true;
					controller.error(error);
				});
			},
		});
		const connection = new ClientSideConnection(
			() => ({
				requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
				sessionUpdate: options.onUpdate,
			}),
			ndJsonStream(input, output),
		);
		let referenced = true;
		return {
			connection,
			exited: exited.promise,
			ref: () => {
				if (referenced) return;
				referenced = true;
				child.ref();
				stdoutRef.ref();
				options.bridge.ref();
			},
			unref: () => {
				if (!referenced) return;
				referenced = false;
				child.unref();
				stdoutRef.unref();
				options.bridge.unref();
			},
			close,
		};
	} catch (error) {
		close();
		throw error;
	}
}

/** Ensure the private empty workspace directory passed to `agy` when workspace isolation is active. */
export async function ensureEmptyWorkspace(geminiDir: string): Promise<string> {
	const workspace = path.join(geminiDir, "empty-workspace");
	await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
	await fs.chmod(workspace, 0o700);
	return workspace;
}

/** Schedule a timer; `unref` lets idle pool timers avoid holding the event loop open. */
export function scheduleTimer(delayMs: number, callback: () => void, options?: { unref?: boolean }): AgyTimer {
	const timer = setTimeout(callback, delayMs);
	if (options?.unref) timer.unref();
	return { cancel: () => clearTimeout(timer) };
}

/** Race `operation` against a `schedule`-backed deadline, always cancelling the timer on settle. */
export async function withTimeout<T>(
	operation: Promise<T>,
	ms: number,
	message: string,
	schedule: AgyScheduler,
): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = schedule(ms, () => timeout.reject(new Error(message)));
	try {
		return await Promise.race([operation, timeout.promise]);
	} finally {
		timer.cancel();
	}
}
