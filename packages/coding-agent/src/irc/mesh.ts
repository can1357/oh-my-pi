/**
 * Instance side of the agent mesh (see `mesh-protocol.ts`): joins the
 * project's daemon room, mirrors its roster, sends messages to agents of other
 * omp instances and hands theirs to the local {@link IrcBus}.
 *
 * Bound to the interactive main session's settings by {@link bindAgentMesh};
 * without a daemon (or one lacking the `agents` module) the mesh stays empty
 * and every remote send fails with a clear receipt.
 */
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import { isRecord, logger, toError } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { canonicalProjectDir, daemonClient } from "../daemon/client";
import { type DaemonClient, type DaemonTunnel, projectScope } from "../daemon/protocol";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { sessionFileBelongsToRoot } from "../registry/persisted-agents";
import { cfgTaskCrossInstance } from "../task/settings";
import { IrcBus } from "./bus";
import {
	AGENT_MESH_KIND,
	AGENT_MESH_ROOM_KEY,
	AGENT_MESH_VERSION,
	formatPeerAddress,
	lineReader,
	type MeshDown,
	type MeshPeer,
	type MeshSubagent,
	type MeshUp,
	type PeerAddress,
} from "./mesh-protocol";

/** Wakes one remote instance may cause here per {@link WAKE_WINDOW_MS}; beyond it, sends are refused. */
const WAKE_BUDGET = 20;
const WAKE_WINDOW_MS = 10 * 60_000;
const RECEIPT_TIMEOUT_MS = 40_000;
const REJOIN_DELAY_MS = 1_000;

/** The mesh link of this process. */
class AgentMesh {
	readonly #projectDir: string;
	readonly #lifetime = new AbortController();
	#unsubscribeReconnect?: () => void;
	#unsubscribeRegistry?: () => void;
	#client: DaemonClient | undefined;
	#tunnel: DaemonTunnel | undefined;
	#lease: string | undefined;
	#joining: Promise<void> | undefined;
	#peers = new Map<number, MeshPeer>();
	readonly #pending = new Map<string, { resolve: (receipt: IrcDeliveryReceipt) => void; timer: NodeJS.Timeout }>();
	readonly #wakes = new Map<number, number[]>();
	#publishQueued = false;

	constructor(projectDir: string) {
		this.#projectDir = projectDir;
		this.#rejoin();
	}

	/** Live instances in this project, this one excluded. */
	peers(): MeshPeer[] {
		return [...this.#peers.values()].filter(peer => peer.pid !== process.pid);
	}

	peer(pid: number): MeshPeer | undefined {
		return pid === process.pid ? undefined : this.#peers.get(pid);
	}

	/** Deliver `body` from local agent `from` to a remote agent; resolves with the recipient's receipt. */
	send(to: PeerAddress, from: string, body: string, progress?: boolean): Promise<IrcDeliveryReceipt> {
		const address = formatPeerAddress(to);
		const tunnel = this.#tunnel;
		if (!tunnel)
			return Promise.resolve({ to: address, outcome: "failed", error: "Not connected to the agent mesh." });
		if (!this.#peers.has(to.pid)) {
			return Promise.resolve({
				to: address,
				outcome: "failed",
				error: `No omp instance with pid ${to.pid} in this project.`,
			});
		}
		const id = crypto.randomUUID();
		const { promise, resolve } = Promise.withResolvers<IrcDeliveryReceipt>();
		const timer = setTimeout(() => {
			if (this.#pending.delete(id))
				resolve({ to: address, outcome: "failed", error: "Delivery unconfirmed (timed out)." });
		}, RECEIPT_TIMEOUT_MS);
		timer.unref();
		this.#pending.set(id, {
			resolve: receipt => resolve({ ...receipt, to: address }),
			timer,
		});
		this.#emit({
			t: "send",
			id,
			toPid: to.pid,
			to: to.id ?? MAIN_AGENT_ID,
			from,
			body,
			...(progress ? { progress } : {}),
		});
		return promise;
	}

	/** Leave the room and dispose subscriptions and pending deliveries. */
	stop(): void {
		this.#lifetime.abort();
		this.#unsubscribeReconnect?.();
		this.#unsubscribeRegistry?.();
		this.#tunnel?.close();
		this.#clearConnection();
	}

	#clearConnection(): void {
		this.#tunnel = undefined;
		this.#peers.clear();
		const lease = this.#lease;
		this.#lease = undefined;
		if (lease) void this.#client?.release(lease).catch(() => {});
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ to: "", outcome: "failed", error: "Agent mesh connection closed." });
		}
		this.#pending.clear();
	}

	#rejoin(): void {
		if (this.#lifetime.signal.aborted || this.#joining || this.#tunnel) return;
		this.#joining = this.#connect()
			.catch(error => {
				logger.debug("agent mesh unavailable", { error: toError(error).message });
			})
			.finally(() => {
				this.#joining = undefined;
			});
	}

	async #connect(): Promise<void> {
		const signal = this.#lifetime.signal;
		const scope = projectScope(await canonicalProjectDir(this.#projectDir));
		if (signal.aborted) return;
		const client = await daemonClient();
		if (signal.aborted || client.welcome.caps[AGENT_MESH_KIND] !== AGENT_MESH_VERSION) return;
		if (!this.#client) {
			this.#client = client;
			// Leases and tunnels die with the daemon connection.
			this.#unsubscribeReconnect = client.onReconnect(() => {
				this.#tunnel?.close();
				this.#clearConnection();
				this.#rejoin();
			});
			this.#unsubscribeRegistry = AgentRegistry.global().onChange(event => {
				if (event.type === "metadata_changed" || event.ref.kind === "advisor" || this.#publishQueued) return;
				this.#publishQueued = true;
				queueMicrotask(() => {
					this.#publishQueued = false;
					this.#publishState();
				});
			});
		}
		const opened = await client.open({
			kind: AGENT_MESH_KIND,
			scope,
			key: AGENT_MESH_ROOM_KEY,
			label: "agent mesh",
		});
		this.#lease = opened.lease;
		if (signal.aborted) {
			this.#clearConnection();
			return;
		}
		let tunnel: DaemonTunnel;
		try {
			tunnel = await client.attach(opened.unit.id, undefined, signal);
		} catch (error) {
			this.#clearConnection();
			throw error;
		}
		if (signal.aborted) {
			tunnel.close();
			return;
		}
		this.#tunnel = tunnel;
		tunnel.start(
			lineReader(message => {
				if (this.#tunnel === tunnel && isRecord(message)) this.#onMessage(message as unknown as MeshDown);
			}),
			() => {
				if (this.#tunnel !== tunnel) return;
				this.#clearConnection();
				if (!signal.aborted) setTimeout(() => this.#rejoin(), REJOIN_DELAY_MS).unref();
			},
		);
		this.#publishState();
	}

	#publishState(): void {
		if (!this.#tunnel) return;
		const registry = AgentRegistry.global();
		const main = registry.get(MAIN_AGENT_ID);
		const sessionFile = main?.sessionFile ?? null;
		const agents: MeshSubagent[] = [];
		if (sessionFile) {
			for (const ref of registry.list()) {
				if (ref.kind === "sub" && ref.sessionFile && sessionFileBelongsToRoot(ref.sessionFile, sessionFile)) {
					agents.push({ id: ref.id, status: ref.status, sessionFile: ref.sessionFile });
				}
			}
		}
		this.#emit({ t: "state", state: { sessionFile, status: main?.status ?? "unknown", agents } });
	}

	#emit(message: MeshUp): void {
		this.#tunnel?.send(`${JSON.stringify(message)}\n`);
	}

	#onMessage(message: MeshDown): void {
		switch (message.t) {
			case "roster":
				this.#peers = new Map(message.peers.map(peer => [peer.pid, peer]));
				return;
			case "peer":
				this.#peers.set(message.peer.pid, message.peer);
				return;
			case "receipt": {
				const pending = this.#pending.get(message.id);
				if (!pending) return;
				this.#pending.delete(message.id);
				clearTimeout(pending.timer);
				pending.resolve(message.receipt);
				return;
			}
			case "deliver":
				void this.#deliver(message);
				return;
		}
	}

	async #deliver(message: Extract<MeshDown, { t: "deliver" }>): Promise<void> {
		let receipt: IrcDeliveryReceipt;
		if (!message.progress && !this.#spendWake(message.fromPid)) {
			receipt = {
				to: message.to,
				outcome: "failed",
				error: `Refused: instance ${process.pid} accepts at most ${WAKE_BUDGET} messages per ${WAKE_WINDOW_MS / 60_000} minutes from one peer.`,
			};
		} else {
			const from = formatPeerAddress({
				pid: message.fromPid,
				...(message.from === MAIN_AGENT_ID ? {} : { id: message.from }),
			});
			try {
				receipt = await IrcBus.global().send({
					from,
					to: message.to,
					body: message.body,
					localOnly: true,
					...(message.progress ? { progress: true } : {}),
				});
			} catch (error) {
				receipt = { to: message.to, outcome: "failed", error: toError(error).message };
			}
		}
		this.#emit({ t: "receipt", id: message.id, receipt });
	}

	/**
	 * Count one message from `pid` against its budget. Bounds how long two
	 * instances can keep waking each other unattended: ping-pong between
	 * models stops at the budget instead of running forever.
	 */
	#spendWake(pid: number): boolean {
		const now = Date.now();
		const recent = (this.#wakes.get(pid) ?? []).filter(at => now - at < WAKE_WINDOW_MS);
		if (recent.length >= WAKE_BUDGET) {
			this.#wakes.set(pid, recent);
			return false;
		}
		recent.push(now);
		this.#wakes.set(pid, recent);
		return true;
	}
}

let mesh: AgentMesh | undefined;

/** The active mesh link, if the interactive session enabled cross-instance messaging. */
export function agentMesh(): AgentMesh | undefined {
	return mesh;
}

/** Join or leave the room as the interactive session's cross-instance setting changes. */
export function bindAgentMesh(projectDir: string, settings: Settings): () => void {
	const apply = (enabled: boolean) => {
		if (enabled) {
			mesh ??= new AgentMesh(projectDir);
		} else {
			const previous = mesh;
			mesh = undefined;
			previous?.stop();
		}
	};
	const unlisten = cfgTaskCrossInstance.listen(settings, apply);
	apply(cfgTaskCrossInstance.get(settings));
	return () => {
		unlisten();
		apply(false);
	};
}
