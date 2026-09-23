/**
 * Contract: tail-first snapshots (issue #9469). A guest that sends
 * `hello.snapshot = { mode: "tail", maxBytes }` receives only the recent end
 * of the host's active branch, cut at a turn boundary, plus `welcome.history`;
 * older pages come from `fetch-history`, one whole-turn window per request.
 * Guests that don't ask get today's full snapshot, unchanged.
 *
 * Drives the production `CollabHost` over the in-memory relay with real
 * sealing and a real `SessionManager` holding the large fixture session.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { isTurnStartEntry } from "@oh-my-pi/pi-agent-core/compaction";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { replicationByteLength } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { buildTailFixture, type TailFixture } from "./helpers/tail-fixture";
import { instrumentRelay, type RelayProbe } from "./helpers/throttled-host";

const MIB = 1024 * 1024;
const WIRE_TYPES: Record<string, true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

type HistoryFrame = Extract<CollabFrame, { t: "history" }>;
type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;

function hostContext(sessionManager: SessionManager): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager,
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "tail",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

interface RunningHost {
	host: CollabHost;
	probe: RelayProbe;
	stop(): Promise<void>;
}

async function startHost(sessionManager: SessionManager, throttle = false): Promise<RunningHost> {
	const relay = installInMemoryRelay();
	const probe = instrumentRelay(relay, { throttle });
	const host = new CollabHost(hostContext(sessionManager));
	await host.start("ws://localhost:8790");
	return {
		host,
		probe,
		stop: async () => {
			uninstallInMemoryRelay();
			await host.stop("test done");
		},
	};
}

/** Raw guest recording every frame; `until` resolves on the first unclaimed match. */
class RawGuest {
	readonly frames: CollabFrame[] = [];
	#claimed = new Set<number>();
	#waiters: { match: (frame: CollabFrame) => boolean; resolve: (frame: CollabFrame) => void }[] = [];
	#reqId = 0;
	private constructor(readonly socket: CollabSocket) {}

	static async connect(link: string, snapshot?: unknown): Promise<RawGuest> {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		const guest = new RawGuest(socket);
		socket.onFrame = frame => guest.#receive(frame);
		socket.onOpen = () => guest.hello(writeToken, snapshot);
		socket.connect();
		return guest;
	}

	hello(writeToken: string | undefined, snapshot: unknown): void {
		this.socket.send({
			t: "hello",
			proto: COLLAB_PROTO,
			name: "tail-guest",
			writeToken,
			snapshot,
		} as CollabFrame);
	}

	#receive(frame: CollabFrame): void {
		const index = this.frames.push(frame) - 1;
		const waiter = this.#waiters.findIndex(w => w.match(frame));
		if (waiter < 0) return;
		this.#claimed.add(index);
		this.#waiters.splice(waiter, 1)[0]?.resolve(frame);
	}

	until(match: (frame: CollabFrame) => boolean): Promise<CollabFrame> {
		const index = this.frames.findIndex((frame, i) => !this.#claimed.has(i) && match(frame));
		if (index >= 0) {
			this.#claimed.add(index);
			return Promise.resolve(this.frames[index] as CollabFrame);
		}
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		this.#waiters.push({ match, resolve });
		return promise;
	}

	/** Welcome plus the concatenated snapshot train. */
	async joined(): Promise<{ welcome: WelcomeFrame; entries: SessionEntry[] }> {
		const welcome = (await this.until(f => f.t === "welcome")) as WelcomeFrame;
		await this.until(f => f.t === "snapshot-chunk" && f.final);
		const start = this.frames.indexOf(welcome);
		const entries: SessionEntry[] = [];
		for (const frame of this.frames.slice(start + 1)) {
			if (frame.t !== "snapshot-chunk") continue;
			entries.push(...frame.entries);
			if (frame.final) break;
		}
		return { welcome, entries };
	}

	sendFetchHistory(before: unknown, maxBytes?: unknown): number {
		const reqId = ++this.#reqId;
		this.socket.send({ t: "fetch-history", reqId, before, maxBytes } as CollabFrame);
		return reqId;
	}

	/** Every frame of one reply, in order, through the final one. */
	async page(reqId: number): Promise<{ entries: SessionEntry[]; last: HistoryFrame; frames: number }> {
		const last = (await this.until(f => f.t === "history" && f.reqId === reqId && f.final)) as HistoryFrame;
		const parts = this.frames.filter((f): f is HistoryFrame => f.t === "history" && f.reqId === reqId);
		return { entries: parts.flatMap(f => f.entries), last, frames: parts.length };
	}

	async fetchHistory(before: string, maxBytes?: number) {
		return this.page(this.sendFetchHistory(before, maxBytes));
	}
}

function wirePath(sessionManager: SessionManager): SessionEntry[] {
	return sessionManager.getBranch().filter(entry => entry.type in WIRE_TYPES);
}

function ids(entries: readonly SessionEntry[]): string[] {
	return entries.map(entry => entry.id);
}

function bytes(entries: readonly SessionEntry[]): number {
	return entries.reduce((sum, entry) => sum + (replicationByteLength(entry) ?? 0), 0);
}

/** Number of turns in a slice that begins at a turn start. */
function turns(entries: readonly SessionEntry[]): number {
	return entries.filter(isTurnStartEntry).length;
}

let fixture: TailFixture;
let path: SessionEntry[];
let running: RunningHost;

beforeAll(async () => {
	fixture = buildTailFixture();
	path = wirePath(fixture.sessionManager);
	running = await startHost(fixture.sessionManager);
});

afterAll(async () => {
	await running.stop();
});

describe("collab tail-first snapshot (#9469)", () => {
	it("sends today's full snapshot without history to a guest that doesn't ask for a tail", async () => {
		const guest = await RawGuest.connect(running.host.link);
		try {
			const { welcome, entries } = await guest.joined();
			expect(welcome.history).toBeUndefined();
			const all = fixture.sessionManager.getEntries().filter(entry => entry.type in WIRE_TYPES);
			expect(welcome.entryCount).toBe(all.length);
			expect(ids(entries)).toEqual(ids(all));
		} finally {
			guest.socket.close();
		}
	});

	it("sends the most recent whole turns of the active branch within the guest's budget", async () => {
		const guest = await RawGuest.connect(running.host.link, { mode: "tail", maxBytes: MIB });
		try {
			const { welcome, entries } = await guest.joined();
			const start = path.length - entries.length;
			expect(ids(entries)).toEqual(ids(path.slice(start)));
			expect(isTurnStartEntry(entries[0] as SessionEntry)).toBe(true);
			expect(bytes(entries)).toBeLessThanOrEqual(MIB);
			// The budget is filled: one more turn would not have fit.
			const previousTurn = path.slice(0, start).findLastIndex(isTurnStartEntry);
			expect(bytes(path.slice(previousTurn))).toBeGreaterThan(MIB);
			expect(welcome.entryCount).toBe(entries.length);
			expect(welcome.history).toEqual({ v: 1, startId: entries[0]?.id ?? null, hasEarlier: true });
		} finally {
			guest.socket.close();
		}
	});

	it("always sends at least one whole turn, however far it exceeds the budget", async () => {
		const guest = await RawGuest.connect(running.host.link, { mode: "tail", maxBytes: 1 });
		try {
			const { entries } = await guest.joined();
			expect(turns(entries)).toBe(1);
			expect(ids(entries)).toEqual(ids(path.slice(path.findLastIndex(isTurnStartEntry))));

			// The ~1.2 MB turn, requested with a budget far below its size.
			const bigStart = path.findIndex(entry => entry.id === fixture.ids.bigTurnStart);
			const next = path.findIndex((entry, i) => i > bigStart && isTurnStartEntry(entry));
			const page = await guest.fetchHistory(path[next]?.id ?? "", 1024);
			expect(ids(page.entries)).toEqual(ids(path.slice(bigStart, next)));
			expect(bytes(page.entries)).toBeGreaterThan(MIB);
			expect(page.last.startId).toBe(fixture.ids.bigTurnStart);
		} finally {
			guest.socket.close();
		}
	});

	it("pages back to the root with no gaps or overlaps", async () => {
		const guest = await RawGuest.connect(running.host.viewLink, { mode: "tail", maxBytes: MIB });
		try {
			const { welcome, entries } = await guest.joined();
			expect(welcome.readOnly).toBe(true);
			let received = entries;
			let window = welcome.history;
			let pages = 0;
			while (window?.hasEarlier) {
				const page = await guest.fetchHistory(window.startId ?? "", MIB);
				expect(page.last.error).toBeUndefined();
				expect(page.last.startId).toBe(page.entries[0]?.id ?? null);
				if (turns(page.entries) > 1) expect(bytes(page.entries)).toBeLessThanOrEqual(MIB);
				received = [...page.entries, ...received];
				window = { v: 1, startId: page.last.startId ?? null, hasEarlier: page.last.hasEarlier ?? false };
				pages++;
			}
			expect(ids(received)).toEqual(ids(path));
			expect(pages).toBeGreaterThan(20);
		} finally {
			guest.socket.close();
		}
	});

	it("answers stale for a cursor that is not on the active branch", async () => {
		const guest = await RawGuest.connect(running.host.link, { mode: "tail", maxBytes: MIB });
		try {
			await guest.joined();
			for (const before of [fixture.ids.abandonedLeaf, "no-such-entry"]) {
				const page = await guest.fetchHistory(before, MIB);
				expect(page.last.error).toBe("stale");
				expect(page.entries).toEqual([]);
			}
		} finally {
			guest.socket.close();
		}
	});

	it("serves history only to a guest whose welcome advertised it", async () => {
		const guest = await RawGuest.connect(running.host.link);
		try {
			const { welcome } = await guest.joined();
			expect(welcome.history).toBeUndefined();
			const page = await guest.fetchHistory(path.at(-1)?.id ?? "", MIB);
			expect(page.last.error).toBe("history is only available after a tail join");
			expect(page.entries).toEqual([]);
		} finally {
			guest.socket.close();
		}
	});

	it("rejects malformed history requests without hanging the guest", async () => {
		const guest = await RawGuest.connect(running.host.link, { mode: "tail", maxBytes: MIB });
		try {
			const { welcome } = await guest.joined();
			const cursor = welcome.history?.startId ?? "";
			for (const [before, maxBytes] of [
				[42, MIB],
				[cursor, -1],
				[cursor, Number.NaN],
				[cursor, "1MiB"],
			] as const) {
				const page = await guest.page(guest.sendFetchHistory(before, maxBytes));
				expect(page.last.error).toBe("malformed fetch-history");
			}
		} finally {
			guest.socket.close();
		}
	});

	for (const snapshot of [
		"x",
		{ mode: "tail", maxBytes: -1 },
		{ mode: "nope" },
		{ mode: "tail", maxBytes: Number.NaN },
	]) {
		it(`falls back to the full snapshot for hello.snapshot = ${JSON.stringify(snapshot)}`, async () => {
			const guest = await RawGuest.connect(running.host.link, snapshot);
			try {
				const { welcome, entries } = await guest.joined();
				expect(welcome.history).toBeUndefined();
				expect(entries).toHaveLength(welcome.entryCount);
				expect(welcome.entryCount).toBe(fixture.sessionManager.getEntries().length);
			} finally {
				guest.socket.close();
			}
		});
	}
});

describe("collab tail-first snapshot under backpressure", () => {
	it("bounds queued history pages per guest and keeps the room alive", async () => {
		await running.stop();
		running = await startHost(fixture.sessionManager, true);
		const hostWs = running.probe.hostSocket();
		const guest = await RawGuest.connect(running.host.link, { mode: "tail", maxBytes: MIB });
		// The in-memory socket never drains on its own while throttled; a real
		// interval stands in for the network, as in host-peer-left-queue.test.ts.
		let drain: Timer | undefined;
		try {
			const welcome = (await guest.until(f => f.t === "welcome")) as WelcomeFrame;
			const cursor = welcome.history?.startId ?? "";
			const reqIds = Array.from({ length: 40 }, () => guest.sendFetchHistory(cursor, 64 * 1024));
			drain = setInterval(() => {
				hostWs.bufferedAmount = 0;
			}, 5);
			const finals = await Promise.all(reqIds.map(reqId => guest.page(reqId)));
			const served = finals.filter(page => page.last.error === undefined);
			const busy = finals.filter(page => page.last.error === "busy");
			expect(served.length).toBe(16);
			expect(busy.length).toBe(24);
			for (const page of served) expect(ids(page.entries)).toEqual(ids(served[0]?.entries ?? []));
			// Replies leave in request order: the FIFO queue never reorders a peer's work.
			const order = guest.frames
				.filter((f): f is HistoryFrame => f.t === "history" && f.final)
				.map(frame => frame.reqId);
			expect(order).toEqual(reqIds);
			// Slots are released as pages drain: a later request is served again.
			const again = await guest.fetchHistory(cursor, 64 * 1024);
			expect(again.last.error).toBeUndefined();
		} finally {
			if (drain) clearInterval(drain);
			guest.socket.close();
		}
	});

	it("drops the rest of a join train when the same guest says hello again", async () => {
		await running.stop();
		running = await startHost(fixture.sessionManager, true);
		const hostWs = running.probe.hostSocket();
		const guest = await RawGuest.connect(running.host.link);
		let drain: Timer | undefined;
		try {
			await guest.until(f => f.t === "welcome");
			// The full ~23 MB train is stuck behind the throttle; re-join as a tail guest.
			guest.hello(undefined, { mode: "tail", maxBytes: MIB });
			drain = setInterval(() => {
				hostWs.bufferedAmount = 0;
			}, 5);
			const second = (await guest.until(f => f.t === "welcome")) as WelcomeFrame;
			await guest.until(f => f.t === "snapshot-chunk" && f.final);
			// A barrier: anything left of the first train would drain before this reply.
			const barrier = await guest.fetchHistory(second.history?.startId ?? "", 1);
			expect(barrier.last.error).toBeUndefined();
			const finals = guest.frames.filter(f => f.t === "snapshot-chunk" && f.final);
			expect(finals).toHaveLength(1);
			const afterSecond = guest.frames.slice(guest.frames.indexOf(second) + 1);
			const tail = afterSecond.flatMap(f => (f.t === "snapshot-chunk" ? f.entries : []));
			expect(tail).toHaveLength(second.entryCount);
		} finally {
			if (drain) clearInterval(drain);
			guest.socket.close();
		}
	});
});

describe("collab tail-first snapshot after the branch moves", () => {
	it("answers stale once the cursor entry is discarded from the active branch", async () => {
		const sessionManager = SessionManager.inMemory("/work/tail-small");
		for (let turn = 0; turn < 4; turn++) {
			sessionManager.appendMessage({ role: "user", content: `turn ${turn}`, timestamp: turn });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `reply ${turn}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-fixture",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: turn,
			});
		}
		await running.stop();
		running = await startHost(sessionManager);
		const guest = await RawGuest.connect(running.host.link, { mode: "tail", maxBytes: 1 });
		try {
			const { welcome } = await guest.joined();
			const cursor = welcome.history?.startId ?? "";
			expect((await guest.fetchHistory(cursor, 1)).last.error).toBeUndefined();
			// The cursor has a content child, so the subtree is kept off-branch.
			await sessionManager.discardEntryDurably(cursor);
			expect(ids(wirePath(sessionManager))).not.toContain(cursor);
			expect((await guest.fetchHistory(cursor, 1)).last.error).toBe("stale");
		} finally {
			guest.socket.close();
		}
	});
});
