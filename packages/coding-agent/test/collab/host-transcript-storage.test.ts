/**
 * A collab guest pages a subagent's transcript from the host with
 * `fetch-transcript`. The host reads it through its session's storage: under
 * `session.storage: sql` the transcript is a row with no file behind it, and a
 * host that stats and reads the filesystem (or another storage) answers with
 * an error instead of the transcript's bytes.
 */
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost, TRANSCRIPT_READ_CAP } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

/** Storage the host session's manager reports; each test points it at its backend. */
let hostStorage: SessionStorage = new FileSessionStorage();

/** Only the members CollabHost touches while a guest joins and fetches. */
function makeHostContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getStorage: () => hostStorage,
			getSessionId: () => "sess-transcript-storage",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: "sess-transcript-storage",
					timestamp: new Date().toISOString(),
					cwd: "/tmp",
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
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

/** A raw guest that yields only the `welcome` and `transcript` frames these tests assert on. */
async function joinAsGuest(link: string): Promise<{ socket: CollabSocket; nextFrame(): Promise<CollabFrame> }> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (frame.t !== "welcome" && frame.t !== "transcript") return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "transcript-reader" });
	socket.connect();
	return {
		socket,
		nextFrame: () => {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<CollabFrame>();
			waiters.push(resolve);
			return promise;
		},
	};
}

let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext());
	// Port is irrelevant: the fake transport routes by the `role` query param.
	await host.start("ws://localhost:8787");
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

describe("collab host transcript fetch storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function serve(kind: "file" | "sql", text: string) {
		const previous = defaultSessionStorage();
		let storage: SessionStorage = new FileSessionStorage();
		if (kind === "sql") {
			const client = new SQL("sqlite::memory:");
			storage = await SqlSessionStorage.create({ client });
			cleanups.push(() => client.end());
		}
		// The process default stays file storage: the host must read its session's.
		setDefaultSessionStorage(new FileSessionStorage());
		hostStorage = storage;
		cleanups.push(() => {
			setDefaultSessionStorage(previous);
			hostStorage = new FileSessionStorage();
		});
		const dir = TempDir.createSync("@omp-collab-transcript-storage-");
		cleanups.push(() => dir.removeSync());
		const id = `Sub-${kind}-${crypto.randomUUID()}`;
		const sessionFile = dir.join("main", `${id}.jsonl`);
		await storage.writeText(sessionFile, text);
		const registry = AgentRegistry.global();
		const ref = registry.register({ id, displayName: id, kind: "sub", session: null, sessionFile });
		cleanups.push(() => {
			registry.unregister(id, ref);
		});
		const guest = await joinAsGuest(host.link);
		cleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
		let reqId = 0;
		return async (fromByte: number) => {
			guest.socket.send({ t: "fetch-transcript", reqId: ++reqId, agentId: id, fromByte });
			const reply = await guest.nextFrame();
			if (reply.t !== "transcript") throw new Error(`expected transcript, got ${reply.t}`);
			return reply;
		};
	}

	for (const kind of ["file", "sql"] as const) {
		it(`serves the bytes of a transcript held by ${kind} storage`, async () => {
			const text = `${JSON.stringify({ type: "session", id: "sub", cwd: "/tmp" })}\n${JSON.stringify({ type: "message", content: "héllo 😀" })}\n`;
			const fetchPage = await serve(kind, text);

			expect(await fetchPage(0)).toEqual({ t: "transcript", reqId: 1, text, newSize: Buffer.byteLength(text) });
			// A guest caught up to the end gets nothing new and the size it already has.
			expect(await fetchPage(Buffer.byteLength(text))).toEqual({
				t: "transcript",
				reqId: 2,
				text: "",
				newSize: Buffer.byteLength(text),
			});
		});

		it(`pages a ${kind} transcript larger than the reply cap on whole lines`, async () => {
			// 16032-byte lines of 4-byte characters: the 4 MiB cap falls inside line 262,
			// three bytes into a character.
			const line = `${JSON.stringify({ type: "message", content: "😀".repeat(4_000) })}\n`;
			const text = line.repeat(Math.ceil((TRANSCRIPT_READ_CAP * 1.5) / Buffer.byteLength(line)));
			const fetchPage = await serve(kind, text);

			const first = await fetchPage(0);
			expect(first.error).toBeUndefined();
			expect(first.newSize).toBeLessThanOrEqual(TRANSCRIPT_READ_CAP);
			expect(first.text.endsWith("\n")).toBe(true);
			expect(Buffer.byteLength(first.text)).toBe(first.newSize);
			const rest = await fetchPage(first.newSize);
			expect(rest.newSize).toBe(Buffer.byteLength(text));
			expect(first.text + rest.text).toBe(text);
		});
	}
});
