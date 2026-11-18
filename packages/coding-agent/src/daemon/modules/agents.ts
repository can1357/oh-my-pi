/**
 * `agents` module: the switchboard of the agent mesh (`irc/mesh-protocol.ts`).
 *
 * One unit per project scope is the room. Every omp instance in that project
 * attaches one tunnel. The room fans out peer status to its members and
 * forwards `send`s to the recipient instance and its receipt back.
 * It holds no mailbox: an absent recipient fails the send at once.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import {
	AGENT_MESH_KIND,
	AGENT_MESH_VERSION,
	lineReader,
	type MeshDown,
	type MeshPeer,
	type MeshUp,
} from "../../irc/mesh-protocol";
import type { DaemonModule, ModuleTunnel, ModuleUnit } from "../module";
import type { UnitPolicy } from "../protocol";

/** How long a forwarded send waits for the recipient's receipt. */
const RECEIPT_TIMEOUT_MS = 30_000;

const POLICY: UnitPolicy = { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "none" };

interface Member {
	tunnel: ModuleTunnel;
	peer: MeshPeer;
}

/** A send forwarded to `toPid`, awaiting its receipt for `originPid`'s request `originId`. */
interface Forward {
	originPid: number;
	originId: string;
	toPid: number;
	to: string;
	timer: NodeJS.Timeout;
}

function emit(tunnel: ModuleTunnel, message: MeshDown): void {
	tunnel.send(`${JSON.stringify(message)}\n`);
}

class RoomUnit implements ModuleUnit {
	label = "agent mesh";
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	readonly #exit = Promise.withResolvers<{ exitCode?: number; reason?: string }>();
	readonly #members = new Map<number, Member>();
	readonly #forwards = new Map<string, Forward>();

	constructor() {
		this.exited = this.#exit.promise;
	}

	pids(): number[] {
		return [];
	}

	busy(): boolean {
		return this.#forwards.size > 0;
	}

	attach(tunnel: ModuleTunnel): void {
		const pid = tunnel.client.pid;
		const member: Member = { tunnel, peer: { pid, sessionFile: null, status: "unknown", agents: [] } };
		// A reconnecting instance replaces its stale tunnel.
		this.#members.get(pid)?.tunnel.close();
		this.#members.set(pid, member);
		tunnel.start(
			lineReader(message => {
				if (isRecord(message)) this.#onMessage(member, message as unknown as MeshUp);
			}),
			() => {
				if (this.#members.get(pid) !== member) return;
				this.#members.delete(pid);
				for (const [id, forward] of this.#forwards) {
					if (forward.toPid === pid)
						this.#settle(id, { to: forward.to, outcome: "failed", error: `Instance ${pid} left.` });
					else if (forward.originPid === pid) this.#drop(id);
				}
				this.#broadcastRoster();
			},
		);
		this.#broadcastRoster();
	}

	#onMessage(member: Member, message: MeshUp): void {
		if (this.#members.get(member.peer.pid) !== member) return;
		switch (message.t) {
			case "state":
				member.peer = { ...message.state, pid: member.peer.pid };
				for (const other of this.#members.values()) {
					if (other !== member) emit(other.tunnel, { t: "peer", peer: member.peer });
				}
				return;
			case "send": {
				const target = this.#members.get(message.toPid);
				const to = message.to;
				if (!target) {
					emit(member.tunnel, {
						t: "receipt",
						id: message.id,
						receipt: {
							to,
							outcome: "failed",
							error: `No omp instance with pid ${message.toPid} in this project.`,
						},
					});
					return;
				}
				const id = crypto.randomUUID();
				const timer = setTimeout(
					() => this.#settle(id, { to, outcome: "failed", error: "Delivery unconfirmed (timed out)." }),
					RECEIPT_TIMEOUT_MS,
				);
				timer.unref();
				this.#forwards.set(id, {
					originPid: member.peer.pid,
					originId: message.id,
					toPid: message.toPid,
					to,
					timer,
				});
				emit(target.tunnel, {
					t: "deliver",
					id,
					fromPid: member.peer.pid,
					from: message.from,
					to,
					body: message.body,
					...(message.progress ? { progress: true } : {}),
				});
				return;
			}
			case "receipt": {
				const forward = this.#forwards.get(message.id);
				// Only the recipient may answer its delivery.
				if (forward?.toPid === member.peer.pid) this.#settle(message.id, message.receipt);
				return;
			}
			default:
				logger.debug("agent mesh: unknown message", { pid: member.peer.pid });
		}
	}

	#settle(id: string, receipt: IrcDeliveryReceipt): void {
		const forward = this.#drop(id);
		if (!forward) return;
		const origin = this.#members.get(forward.originPid);
		if (origin) emit(origin.tunnel, { t: "receipt", id: forward.originId, receipt });
	}

	#drop(id: string): Forward | undefined {
		const forward = this.#forwards.get(id);
		if (!forward) return undefined;
		clearTimeout(forward.timer);
		this.#forwards.delete(id);
		return forward;
	}

	#broadcastRoster(): void {
		const peers = [...this.#members.values()].map(member => member.peer);
		for (const member of this.#members.values()) emit(member.tunnel, { t: "roster", peers });
	}

	async stop(reason: string): Promise<void> {
		for (const id of [...this.#forwards.keys()]) this.#drop(id);
		for (const member of this.#members.values()) member.tunnel.close();
		this.#members.clear();
		this.#exit.resolve({ reason });
	}
}

/** Agent mesh switchboard, one project-scoped room unit (key: `AGENT_MESH_ROOM_KEY`). */
export const agentsModule: DaemonModule = {
	kind: AGENT_MESH_KIND,
	version: AGENT_MESH_VERSION,
	policy: () => POLICY,
	open: () => new RoomUnit(),
};
