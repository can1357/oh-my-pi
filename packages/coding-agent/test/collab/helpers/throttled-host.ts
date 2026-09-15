/**
 * Host-side harness for the collab send-queue suites.
 *
 * Wraps the in-memory relay so a test can (a) read every host→relay envelope's
 * target peer id in wire order and (b) throttle the host socket by hand: with
 * `throttle` on, nothing drains `bufferedAmount`, so the host's queue stops at
 * the first frame past the 64 KB high-water mark and the test decides when it
 * moves again by zeroing the field.
 */
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { unpackEnvelope } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { FakeWebSocket, InMemoryRelay } from "./in-memory-relay";

export const HIGH_WATER_MARK = 64 * 1024;

export interface Snapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: SessionEntry[];
}

/** 96 × 16 KB ≈ 1.5 MB, so the host's 512 KB chunk cap yields several chunks. */
export function makeSnapshot(): Snapshot {
	const body = "x".repeat(16 * 1024);
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 96; i++) {
		entries.push({
			type: "message",
			id: `e${i}`,
			parentId: null,
			timestamp: "2026-09-08T00:00:00Z",
			message: { role: "user", content: body, timestamp: 0 },
		});
	}
	return {
		header: { type: "session", id: "sess-queue", timestamp: "2026-09-08T00:00:00Z", cwd: "/tmp" },
		entries,
	};
}

export interface HostObservations {
	notices: string[];
	participantCounts: number[];
}

export function makeHostContext(snapshot: Snapshot, seen: HostObservations): InteractiveModeContext {
	// AgentSession#emit dispatches listeners synchronously, and CollabHost's own
	// subscription mirrors `notice` events to guests as broadcast frames. Model
	// that here, or a host-level test never exercises the mirror.
	const listeners: ((event: unknown) => void)[] = [];
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			snapshotForReplication: () => snapshot,
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "queue",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (listener: (event: unknown) => void) => {
				listeners.push(listener);
				return () => {
					const at = listeners.indexOf(listener);
					if (at >= 0) listeners.splice(at, 1);
				};
			},
			emitNotice: (level: string, message: string, source?: string) => {
				seen.notices.push(message);
				for (const listener of [...listeners]) listener({ type: "notice", level, message, source });
			},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: (status: { participantCount: number } | null) => {
				if (status) seen.participantCounts.push(status.participantCount);
			},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

export interface RelayProbe {
	/** Target peer id of every host→relay envelope, in wire order. */
	targets: number[];
	hostSocket(): FakeWebSocket;
}

export function instrumentRelay(relay: InMemoryRelay, opts: { throttle: boolean }): RelayProbe {
	let hostWs: FakeWebSocket | undefined;
	const connect = relay.connect.bind(relay);
	relay.connect = ws => {
		connect(ws);
		if (ws.role !== "host") return;
		hostWs = ws;
		if (!opts.throttle) return;
		const send = ws.send.bind(ws);
		ws.send = data => {
			ws.bufferedAmount += data.byteLength;
			send(data);
		};
	};
	const targets: number[] = [];
	const forward = relay.forward.bind(relay);
	relay.forward = (from, bytes) => {
		if (from.role === "host") targets.push(unpackEnvelope(bytes)?.peerId ?? -1);
		forward(from, bytes);
	};
	return {
		targets,
		hostSocket: () => {
			if (!hostWs) throw new Error("in-memory relay never saw the host socket");
			return hostWs;
		},
	};
}

export async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
}
