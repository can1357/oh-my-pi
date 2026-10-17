import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { connectSessionHost } from "@oh-my-pi/pi-coding-agent/session-host/client";
import { runSessionHost, type SessionHostOptions } from "@oh-my-pi/pi-coding-agent/session-host/host";
import { listSessionHosts, newHostId, type SessionHostEntry } from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { isEnoent, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir } from "./rpc-server-harness";

/** Polls a condition, not a guessed delay: the registry file is the host's only observable readiness and presence signal. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(25);
	}
}

export interface TestSessionHost {
	hostId: string;
	session: AgentSession;
	/** True once the host's `onExit` ran: the last client sent `exit`. */
	exited: boolean;
	/** `exit` through a throwaway client; stops the host only when no other client is attached. */
	stop(): Promise<void>;
}

export interface TestClientOptions {
	/** Declare the `ui` capability in the hello. Default false. */
	ui?: boolean;
	/** Receives the socket transport on every `start()`, to drop it from the outside like a network failure. */
	onTransport?: (transport: RpcAgentProcess) => void;
}

/**
 * Real in-process session hosts (`runSessionHost` over a registry-published socket) in a temp dir,
 * with `RpcClient`s attached over `connectSessionHost`. {@link dispose} stops every client and host it made.
 */
export class SessionHostFixture {
	readonly dir: string;
	readonly registryDir: string;
	readonly #restoreAgentDir: () => void;
	readonly #hosts: TestSessionHost[] = [];
	readonly #clients: RpcClient[] = [];
	#hostCount = 0;

	private constructor(dir: string) {
		this.dir = dir;
		this.registryDir = path.join(dir, "registry");
		this.#restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	}

	static async create(): Promise<SessionHostFixture> {
		return new SessionHostFixture(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-host-")));
	}

	/**
	 * A host serving a fresh session whose mock model answers `ok`; `gate` holds each reply after its first delta until
	 * it resolves; `inMemory` keeps the transcript in memory, with no session file or artifacts directory.
	 */
	async startHost(
		options: Partial<SessionHostOptions> = {},
		gate?: Promise<void>,
		sessionOptions: { inMemory?: boolean } = {},
	): Promise<TestSessionHost> {
		const sessionDir = path.join(this.dir, `host-${++this.#hostCount}`);
		await fs.mkdir(sessionDir, { recursive: true });
		const session = await createTestSession(sessionDir, { handler: { content: ["ok"] } }, gate, sessionOptions);
		const hostId = newHostId();
		const done = Promise.withResolvers<void>();
		const host: TestSessionHost = {
			hostId,
			session,
			exited: false,
			stop: async () => {
				if (host.exited) return;
				const closer = await this.client(host);
				await closer.start();
				await closer.exit();
				await done.promise;
			},
		};
		void runSessionHost(session, {
			...options,
			hostId,
			registryDir: this.registryDir,
			onExit: async () => {
				await session.dispose();
				host.exited = true;
				done.resolve();
				return new Promise<never>(() => {});
			},
		});
		await waitFor(async () => (await this.#findEntry(hostId)) !== undefined);
		this.#hosts.push(host);
		return host;
	}

	/** The host's published registry entry; throws once the host has withdrawn. */
	async entry(host: TestSessionHost): Promise<SessionHostEntry> {
		const entry = await this.#findEntry(host.hostId);
		if (!entry) throw new Error(`Session host ${host.hostId} is not registered`);
		return entry;
	}

	/** A client for `host` that has not started: register listeners first, then `start()` to attach. */
	async client(host: TestSessionHost, options: TestClientOptions = {}): Promise<RpcClient> {
		const entry = await this.entry(host);
		const client = new RpcClient({
			spawn: async () => {
				const transport = await connectSessionHost({ entry, client: { kind: "test" }, ui: options.ui ?? false });
				options.onTransport?.(transport);
				return transport;
			},
		});
		this.#clients.push(client);
		return client;
	}

	/** Wait until the host's registry entry reports `count` attached clients. */
	async waitForClients(host: TestSessionHost, count: number): Promise<void> {
		await waitFor(async () => (await this.#findEntry(host.hostId))?.clients === count);
	}

	async dispose(): Promise<void> {
		await Promise.all(this.#clients.map(client => client.stop()));
		for (const host of this.#hosts) {
			if (host.exited) continue;
			await this.waitForClients(host, 0);
			await host.stop();
		}
		this.#restoreAgentDir();
		await removeWithRetries(this.dir);
	}

	async #findEntry(hostId: string): Promise<SessionHostEntry | undefined> {
		return (await listSessionHosts(this.registryDir)).find(entry => entry.hostId === hostId);
	}
}

export interface IsolatedConfigRoot {
	/** The directory `getBaseConfigRoot()` names while isolated. */
	root: string;
	/** Put the environment back and delete the directory. */
	restore(): Promise<void>;
}

/**
 * Give the process a base config root of its own for one test. omp's run state (the default host registry, the
 * hosted replica directory) lives under it, so the test never reads, prunes, or fills the developer's `~/.omp`.
 * `PI_CONFIG_DIR` is the one in-process seam: `os.homedir()` ignores a `HOME` changed after startup. Call `restore`
 * before disposing the {@link SessionHostFixture}: that teardown re-reads the directory environment.
 */
export function isolateConfigRoot(): IsolatedConfigRoot {
	const saved = process.env.PI_CONFIG_DIR;
	const name = `.omp-test-${crypto.randomUUID()}`;
	const root = path.join(os.homedir(), name);
	process.env.PI_CONFIG_DIR = name;
	return {
		root,
		restore: async () => {
			if (saved === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = saved;
			await removeWithRetries(root);
		},
	};
}

/** Everything under `dir` (relative, sorted), without dotfile lock sidecars; empty when `dir` does not exist. */
export async function listTree(dir: string): Promise<string[]> {
	try {
		const names = await fs.readdir(dir, { recursive: true });
		return names.filter(name => !path.basename(name).startsWith(".")).sort();
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

export interface HostProxy {
	/** The host's entry with its endpoint redirected through the proxy. */
	entry: SessionHostEntry;
	/** Send `frame` to every connected client as if the host had. */
	inject(frame: object): void;
	/** Cut every client's connection, like a network failure. */
	drop(): void;
	close(): void;
}

/**
 * A unix socket in front of a host's endpoint: the test can cut the link, add a frame the host would not send, or
 * (`refuseExit`) have the proxy answer a client's `exit` request with that error instead of passing it on.
 */
export async function startProxy(
	entry: SessionHostEntry,
	dir: string,
	options: { refuseExit?: string } = {},
): Promise<HostProxy> {
	const socketPath = path.join(dir, "proxy.sock");
	const clients = new Set<net.Socket>();
	const server = net.createServer(client => {
		const upstream = net.connect(entry.endpoint);
		clients.add(client);
		if (options.refuseExit === undefined) client.pipe(upstream);
		else forwardRefusingExit(client, upstream, options.refuseExit);
		upstream.pipe(client);
		// A reset ends the pair; `close` always follows.
		for (const socket of [client, upstream]) {
			socket.on("error", () => {});
			socket.on("close", () => {
				clients.delete(client);
				client.destroy();
				upstream.destroy();
			});
		}
	});
	const listening = Promise.withResolvers<void>();
	server.listen(socketPath, listening.resolve);
	await listening.promise;
	return {
		entry: { ...entry, endpoint: socketPath },
		inject: (frame: object): void => {
			for (const client of clients) client.write(`${JSON.stringify(frame)}\n`);
		},
		drop: (): void => {
			for (const client of clients) client.destroy();
		},
		close: (): void => void server.close(),
	};
}

/** Pass `client`'s request lines to `upstream`, except `exit`: that one is answered here with `error`. */
function forwardRefusingExit(client: net.Socket, upstream: net.Socket, error: string): void {
	let pending = "";
	client.setEncoding("utf8");
	client.on("data", chunk => {
		pending += String(chunk);
		for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
			const line = pending.slice(0, end + 1);
			pending = pending.slice(end + 1);
			const request = JSON.parse(line) as { id?: string; type?: string };
			if (request.type === "exit") {
				const refusal = { id: request.id, type: "response", command: "exit", success: false, error };
				client.write(`${JSON.stringify(refusal)}\n`);
			} else {
				upstream.write(line);
			}
		}
	});
	client.once("end", () => upstream.end());
}
