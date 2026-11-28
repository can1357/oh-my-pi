/**
 * Wire protocol of the agent mesh: omp instances on one machine messaging
 * each other's agents through the daemon's `agents` room unit.
 *
 * Each instance attaches one tunnel (LF-delimited JSON) to the daemon's single
 * global room and advertises its project directory; listings default to the
 * instance's own project, while addressing by pid works across projects.
 * An instance is addressed by its pid: `agent://<pid>` is its main agent,
 * `agent://<pid>/<id>` one of its subagents. The room only forwards; delivery
 * semantics (inject, wake, revive) stay with the recipient's local IrcBus.
 *
 * Implementations: `daemon/modules/agents.ts` (room), `irc/mesh.ts` (instance).
 */
import type { AgentStatus } from "../registry/agent-hub-types";
import type { IrcDeliveryReceipt } from "./irc-types";

/** Daemon module kind and `caps` key. */
export const AGENT_MESH_KIND = "agents";
/** Bumped on incompatible changes to the messages below. */
export const AGENT_MESH_VERSION = 3;
/** Key of the one room unit, in the global scope. */
export const AGENT_MESH_ROOM_KEY = "room";

/** Status and transcript location published by a subagent's owning process. */
export interface MeshSubagent {
	id: string;
	status: AgentStatus;
	sessionFile: string;
}

/** Current registry state advertised by an instance. */
export interface MeshState {
	/** Canonical project directory (`canonicalProjectDir`) the instance runs in. */
	project: string;
	/** Root transcript; its artifact directory holds the published outputs. */
	sessionFile: string | null;
	status: AgentStatus | "unknown";
	agents: MeshSubagent[];
	/** Title of the root session; peers show it in place of the pid. */
	title?: string;
}

/** One instance in the room, as the roster shows it. */
export interface MeshPeer extends MeshState {
	pid: number;
}

/** Instance → room. */
export type MeshUp =
	| { t: "state"; state: MeshState }
	| { t: "send"; id: string; toPid: number; to: string; from: string; body: string; progress?: boolean }
	| { t: "receipt"; id: string; receipt: IrcDeliveryReceipt };

/** Room → instance. */
export type MeshDown =
	| { t: "roster"; peers: MeshPeer[] }
	| { t: "peer"; peer: MeshPeer }
	| { t: "deliver"; id: string; fromPid: number; from: string; to: string; body: string; progress?: boolean }
	| { t: "receipt"; id: string; receipt: IrcDeliveryReceipt };

/** Split LF-delimited JSON from a tunnel's byte stream. */
export function lineReader(onMessage: (message: unknown) => void): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buffered = "";
	return chunk => {
		buffered += decoder.decode(chunk, { stream: true });
		for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (!line) continue;
			try {
				onMessage(JSON.parse(line));
			} catch {
				// Malformed line from a mismatched build: skip it.
			}
		}
	};
}

/** A remote mesh address: `<pid>` (its main agent) or `<pid>/<id>`. */
export interface PeerAddress {
	pid: number;
	/** Agent id inside that instance; undefined means its main agent. */
	id?: string;
}

/** Parse `<pid>` / `<pid>/<id>`; undefined for a local id. */
export function parsePeerAddress(address: string): PeerAddress | undefined {
	const match = /^(\d+)(?:\/([A-Za-z0-9_.-]+))?$/.exec(address);
	if (!match) return undefined;
	return { pid: Number(match[1]), ...(match[2] ? { id: match[2] } : {}) };
}

/** Text form of a {@link PeerAddress}, as used for `IrcMessage.from`/`to`. */
export function formatPeerAddress(address: PeerAddress): string {
	return address.id ? `${address.pid}/${address.id}` : String(address.pid);
}
