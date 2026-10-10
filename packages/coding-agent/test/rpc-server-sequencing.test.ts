import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RpcServer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-server";
import type {
	RpcAttachedFrame,
	RpcResumedFrame,
	RpcSessionOrigin,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir, TestClient } from "./helpers/rpc-server-harness";
import { makeAssistantMessage } from "./session-manager/helpers";

let dir: string;
let session: AgentSession;
let server: RpcServer;
let ui: ExtensionUIContext;
let restoreAgentDir: () => void;

async function startServer(
	mock: MockModelOptions,
	sessionOptions?: Parameters<typeof createTestSession>[3],
): Promise<void> {
	session = await createTestSession(dir, mock, undefined, sessionOptions);
	server = await RpcServer.start(session, { setToolUIContext: ctx => void (ui = ctx) });
}

/** A saved, answered session in `threadDir` with the test session's cwd, so a switch to it is not a cwd change. */
async function savedSessionIn(threadDir: string): Promise<{ file: string; id: string }> {
	const saved = SessionManager.create(dir, threadDir);
	saved.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
	saved.appendMessage(makeAssistantMessage());
	await saved.flush();
	const target = { file: saved.getSessionFile()!, id: saved.getSessionId() };
	await saved.close();
	return target;
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-seq-"));
	restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
});
afterEach(async () => {
	await server?.dispose();
	restoreAgentDir();
	await removeWithRetries(dir);
});

describe("RpcServer sequencing", () => {
	it("sends attached with a snapshot, then seq-ordered frames with no gaps for an unfiltered client", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const attached = server.attach(a.conn) as RpcAttachedFrame;
		expect(attached.type).toBe("attached");
		expect(attached.snapshot.entries).toEqual(session.sessionManager.getEntries());
		await a.command({ type: "prompt", message: "hi" });
		await a.next(f => f.type === "agent_end");
		const seqs = a.frames.filter(f => typeof f.seq === "number").map(f => f.seq as number);
		expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
		expect(a.frames.some(f => f.type === "entry")).toBe(true);
	});

	it("replays the ring tail on resume and falls back to a snapshot for a stale epoch", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		await a.command({ type: "prompt", message: "one" });
		await a.next(f => f.type === "agent_end");
		const lastSeq = a.frames.filter(f => typeof f.seq === "number").at(5)!.seq as number;
		const b = new TestClient(server);
		const resumed = server.attach(b.conn, { epoch: server.epoch, lastSeq }) as RpcResumedFrame;
		expect(resumed.type).toBe("resumed");
		expect(resumed.replayed).toBe(server.seq - lastSeq);
		// On the wire: ready, resumed, then exactly the missed frames in seq order.
		const end = server.seq;
		await b.next(f => f.seq === end);
		const missed = Array.from({ length: resumed.replayed }, (_, i) => lastSeq + 1 + i);
		expect(b.frames.slice(0, 2 + resumed.replayed).map(f => f.seq ?? f.type)).toEqual([
			"ready",
			"resumed",
			...missed,
		]);
		const c = new TestClient(server);
		expect(server.attach(c.conn, { epoch: server.epoch - 1, lastSeq }).type).toBe("attached");
	});

	it("answers a resume minted against another server instance with a snapshot, not that host's frames", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		await a.command({ type: "prompt", message: "one" });
		await a.next(f => f.type === "agent_end");
		const stale = {
			epoch: server.epoch,
			lastSeq: a.frames.filter(f => typeof f.seq === "number").at(5)!.seq as number,
		};
		await server.dispose();
		// The respawned host: same history shape, so its ring holds `lastSeq + 1` too.
		await startServer({ handler: { content: ["ok"] } });
		const b = new TestClient(server);
		server.attach(b.conn);
		await b.command({ type: "prompt", message: "one" });
		await b.next(f => f.type === "agent_end");
		expect(server.seq).toBeGreaterThan(stale.lastSeq);
		const c = new TestClient(server);
		expect(server.attach(c.conn, stale).type).toBe("attached");
	});

	it("falls back to a snapshot once a resume's next frame has left the ring, exactly at the ring's oldest frame", async () => {
		const ringLimit = 4096; // RING_LIMIT in rpc-server.ts
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		const preBurst = server.seq;
		for (let i = 0; i < ringLimit + 10; i++) ui.notify(`n${i}`);
		const resume = (lastSeq: number) =>
			server.attach(new TestClient(server).conn, { epoch: server.epoch, lastSeq }).type;
		expect(resume(preBurst)).toBe("attached");
		// The ring holds frames seq - ringLimit + 1 through seq.
		expect(resume(server.seq - ringLimit)).toBe("resumed");
		expect(resume(server.seq - ringLimit - 1)).toBe("attached");
	});

	it("replays an extension dialog opened while the client was away, so the resumer can answer it", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		const lastSeq = server.seq;
		await server.disconnect(a.conn, "network blip");
		const answer = ui.confirm("Still there?", "msg");
		const b = new TestClient(server);
		expect(server.attach(b.conn, { epoch: server.epoch, lastSeq }).type).toBe("resumed");
		const request = await b.next(f => f.type === "extension_ui_request" && f.method === "confirm");
		expect(request.seq).toBe(lastSeq + 1);
		b.write({ type: "extension_ui_response", id: request.id, confirmed: true });
		expect(await answer).toBe(true);
	});

	it("hands a late joiner the open dialog in its snapshot and withdraws it from the other UI client once answered", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const answer = ui.confirm("Late?", "msg");
		const late = new TestClient(server);
		const { snapshot } = server.attach(late.conn) as RpcAttachedFrame;
		expect(snapshot.pendingUi).toEqual([expect.objectContaining({ method: "confirm", title: "Late?" })]);
		const other = new TestClient(server);
		server.attach(other.conn);
		const [request] = snapshot.pendingUi;
		late.write({ type: "extension_ui_response", id: request.id, confirmed: true });
		expect(await answer).toBe(true);
		expect(await other.next(f => f.method === "cancel")).toMatchObject({ targetId: request.id });
	});

	it("refuses switch_session to a file another host owns, without switching", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		const asked: string[] = [];
		server.onBeforeSwitch = async sessionFile => {
			asked.push(sessionFile);
			return { hostId: "other-host" };
		};
		const sessionId = session.sessionId;
		const epoch = server.epoch;
		const res = await a.command({ type: "switch_session", sessionPath: "elsewhere.jsonl" });
		expect(res).toMatchObject({ success: false, code: "session_hosted", hostId: "other-host" });
		expect(asked).toEqual([path.resolve("elsewhere.jsonl")]);
		expect(session.sessionId).toBe(sessionId);
		expect(server.epoch).toBe(epoch);
	});

	it("lets one peer's abort cancel another peer's input that an extension input hook still holds", async () => {
		const atHook = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await startServer(
			{ handler: { content: ["ok"] } },
			{
				inputHook: async text => {
					if (!text.startsWith("hold:")) return;
					atHook.resolve();
					await release.promise;
				},
			},
		);
		const a = new TestClient(server);
		const b = new TestClient(server);
		a.write({ id: "held", type: "prompt", message: "hold: first" });
		await atHook.promise;
		// Accepted after a's input: the server-wide gate cancels it, whichever peer sent the abort.
		expect(await b.command({ type: "abort" })).toMatchObject({ success: true });
		release.resolve();
		expect(await a.next(f => f.type === "prompt_result" && f.id === "held")).toMatchObject({ status: "aborted" });
		expect(session.messages.some(message => message.role === "assistant")).toBe(false);

		// The abort is not sticky: input accepted after it runs.
		await a.command({ type: "prompt", message: "after" });
		expect(await a.next(f => f.type === "prompt_result" && f.id === "c1")).toMatchObject({ status: "completed" });
		expect(session.messages.filter(message => message.role === "assistant")).toHaveLength(1);
	});

	it("refuses open_session onto a session another host owns, keeping the open session and asking about the resolved file", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		const target = await savedSessionIn(path.join(dir, "thread"));
		const asked: string[] = [];
		server.onBeforeSwitch = async sessionFile => {
			asked.push(sessionFile);
			return { hostId: "other-host" };
		};
		const [sessionId, sessionFile, epoch] = [session.sessionId, session.sessionFile, server.epoch];

		const res = await a.command({ type: "open_session", sessionDir: path.join(dir, "thread") });

		expect(res).toMatchObject({ success: false, code: "session_hosted", hostId: "other-host" });
		expect(asked).toEqual([path.resolve(target.file)]);
		expect([session.sessionId, session.sessionFile, server.epoch]).toEqual([sessionId, sessionFile, epoch]);
	});

	it("claims the file open_session resolved before switching and settles after the replacement", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		const target = await savedSessionIn(path.join(dir, "thread"));
		const events: string[] = [];
		server.onBeforeSwitch = async sessionFile => {
			events.push(`before ${path.basename(sessionFile)}`);
			return undefined;
		};
		server.onEpochChanged = () => events.push("epoch");
		server.onSwitchSettled = () => events.push("settled");

		const res = await a.command({ type: "open_session", sessionDir: path.join(dir, "thread") });

		expect(res).toMatchObject({ success: true, data: { cancelled: false, resumed: true, sessionId: target.id } });
		expect(events).toEqual([`before ${path.basename(target.file)}`, "epoch", "settled"]);
	});

	it("holds a switch started inside the process (an extension action) to the same ownership check", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		const target = await savedSessionIn(path.join(dir, "thread"));
		const events: string[] = [];
		let owner: { hostId: string } | undefined = { hostId: "other-host" };
		server.onBeforeSwitch = async sessionFile => {
			events.push(`before ${path.basename(sessionFile)}`);
			return owner;
		};
		server.onEpochChanged = () => events.push("epoch");
		const settled = Promise.withResolvers<void>();
		server.onSwitchSettled = () => {
			events.push("settled");
			settled.resolve();
		};
		const [sessionId, epoch] = [session.sessionId, server.epoch];

		// What `ctx.switchSession` and custom commands call: refused with nothing changed, as for an extension veto.
		expect(await session.switchSession(target.file)).toBe(false);
		expect([session.sessionId, server.epoch]).toEqual([sessionId, epoch]);
		expect(events).toEqual([`before ${path.basename(target.file)}`]);

		owner = undefined;
		events.length = 0;
		expect(await session.switchSession(target.file)).toBe(true);
		// The claim is settled only after the replacement let the host adopt it.
		await settled.promise;
		expect(events).toEqual([`before ${path.basename(target.file)}`, "epoch", "settled"]);
		expect(session.sessionId).toBe(target.id);
	});

	it("tells sequenced clients and the host hook where a relocated session lives, and leaves stdio alone", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const stdio = new TestClient(server, { sequenced: false });
		const attached = server.attach(a.conn) as RpcAttachedFrame;
		await a.command({ type: "prompt", message: "persist me" });
		await a.next(f => f.type === "agent_end");
		const origin = (): RpcSessionOrigin => {
			const artifactsDir = session.sessionManager.getArtifactsDir();
			return {
				cwd: session.sessionManager.getCwd(),
				artifactsDir,
				// A persisted session's `local://` maps under its artifacts directory.
				localRoot: path.join(artifactsDir!, "local"),
				sessionId: session.sessionManager.getSessionId(),
			};
		};
		expect(attached.snapshot.origin).toEqual(origin());
		const before = origin();
		const relocated: Array<[string | undefined, string]> = [];
		server.onSessionRelocated = (sessionFile, cwd) => relocated.push([sessionFile, cwd]);

		const moved = path.join(dir, "moved-project");
		const movedSessions = path.join(dir, "moved-sessions");
		await fs.mkdir(moved, { recursive: true });
		await session.moveSession(moved, movedSessions);

		const update = await a.next(f => f.type === "session_info_update" && f.origin !== undefined);
		expect(update.origin).toEqual(origin());
		expect(origin()).toMatchObject({ cwd: moved, sessionId: before.sessionId });
		expect(origin().artifactsDir).not.toBe(before.artifactsDir);
		expect(path.dirname(origin().artifactsDir!)).toBe(movedSessions);
		expect(relocated).toEqual([[session.sessionFile, moved]]);
		// A new client sees where the session lives now, from its first snapshot.
		const late = new TestClient(server);
		expect((server.attach(late.conn) as RpcAttachedFrame).snapshot.origin).toEqual(origin());

		// A move that changes nothing announces nothing.
		await session.moveSession(moved, movedSessions);
		expect(relocated).toHaveLength(1);
		expect(a.frames.filter(f => f.type === "session_info_update" && f.origin !== undefined)).toHaveLength(1);
		await stdio.command({ type: "get_state" });
		expect(stdio.frames.some(f => f.type === "session_info_update")).toBe(false);
	});

	it("reports the host's own temp-dir local:// root for a session that has no artifacts directory", async () => {
		await startServer({ handler: { content: ["ok"] } }, { inMemory: true });
		const a = new TestClient(server);
		const { snapshot } = server.attach(a.conn) as RpcAttachedFrame;
		const sessionId = session.sessionManager.getSessionId();
		expect(snapshot.origin).toEqual({
			cwd: dir,
			artifactsDir: null,
			localRoot: path.join(os.tmpdir(), "omp-local", sessionId),
			sessionId,
		});
	});

	it("broadcasts session_replaced with a new epoch to every client after new_session", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		server.attach(a.conn);
		server.attach(b.conn);
		const before = server.epoch;
		const oldSessionId = session.sessionId;
		const epochChanges: Array<[number, string | undefined]> = [];
		server.onEpochChanged = (epoch, sessionFile) => epochChanges.push([epoch, sessionFile]);
		await a.command({ type: "new_session" });
		const replaced = await b.next(f => f.type === "session_replaced");
		expect(replaced.epoch).toBe(before + 1);
		expect(replaced.reason).toBe("new");
		expect(session.sessionId).not.toBe(oldSessionId);
		// The new session's own bookkeeping entries (thinking level, service tier), never the old transcript.
		expect(replaced.snapshot).toMatchObject({
			header: { id: session.sessionId },
			entries: session.sessionManager.getEntries(),
		});
		expect(replaced.sessionFile).toBe(session.sessionFile);
		expect(epochChanges).toEqual([[before + 1, session.sessionFile]]);
	});

	it("rejects a stale-epoch prompt without appending anything, but still aborts", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		const old = server.epoch;
		await a.command({ type: "new_session" });
		const entriesBefore = session.sessionManager.getEntries().length;
		const res = await a.command({ type: "prompt", message: "late", ifEpoch: old });
		expect(res).toMatchObject({ success: false, code: "stale", epoch: server.epoch });
		expect(session.sessionManager.getEntries().length).toBe(entriesBefore);
		expect(await a.command({ type: "abort", ifEpoch: old })).toMatchObject({ success: true });
	});

	it("rejects a stale-leaf branch", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		server.attach(a.conn);
		await a.command({ type: "prompt", message: "one" });
		await a.next(f => f.type === "agent_end");
		const leaf = session.sessionManager.getLeafId();
		await a.command({ type: "prompt", message: "two" });
		await a.next(f => f.type === "agent_end" && a.frames.filter(x => x.type === "agent_end").length === 2);
		const userEntry = session.sessionManager
			.getEntries()
			.find(e => e.type === "message" && e.message.role === "user")!;
		const res = await a.command({ type: "branch", entryId: userEntry.id, ifLeaf: leaf });
		expect(res).toMatchObject({ success: false, code: "stale", leafId: session.sessionManager.getLeafId() });
	});

	it("keeps stdio bytes free of seq, entry, and session_replaced", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const s = new TestClient(server, { sequenced: false });
		await s.command({ type: "new_session" });
		// Replacement frames precede the response; a later round-trip is a second sync point.
		await s.command({ type: "get_state" });
		expect(s.frames.some(f => "seq" in f || f.type === "entry" || f.type === "session_replaced")).toBe(false);
	});

	it("forks at an entry, reports reason fork to every client, and refuses a fork while a run is streaming", async () => {
		const release = Promise.withResolvers<void>();
		session = await createTestSession(dir, { handler: { content: ["ok"] } }, release.promise);
		server = await RpcServer.start(session, {});
		const a = new TestClient(server);
		const b = new TestClient(server);
		server.attach(a.conn);
		server.attach(b.conn);
		await a.command({ type: "prompt", message: "hi" });
		await a.next(f => f.type === "message_update");
		expect(await a.command({ type: "fork" })).toMatchObject({ success: false, code: "session_busy" });
		release.resolve();
		await a.next(f => f.type === "agent_end");

		const [userEntry, replyEntry] = session.sessionManager.getEntries().filter(entry => entry.type === "message");
		const sourceFile = session.sessionFile;
		const before = server.epoch;
		expect(await a.command({ type: "fork", entryId: replyEntry!.id })).toMatchObject({
			success: true,
			data: { cancelled: false },
		});
		const replaced = await b.next(f => f.type === "session_replaced");
		expect(replaced).toMatchObject({ epoch: before + 1, reason: "fork" });
		expect(session.sessionFile).not.toBe(sourceFile);
		expect(
			session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "message")
				.map(entry => entry.id),
		).toEqual([userEntry!.id, replyEntry!.id]);
	});

	it("reports goal state through get_state, goal and the attach snapshot on every connection", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const stdio = new TestClient(server, { sequenced: false });
		const attached = server.attach(a.conn) as RpcAttachedFrame;
		expect(attached.snapshot.state.goal).toBeNull();
		expect(await a.command({ type: "get_state" })).toMatchObject({ success: true, data: { goal: null } });
		expect(await stdio.command({ type: "goal", op: "get" })).toMatchObject({
			success: true,
			data: { goal: null, state: null },
		});
		// A refusal is a normal error response, not a dropped command.
		expect(await a.command({ type: "goal", op: "resume" })).toMatchObject({ success: false, command: "goal" });
	});

	it("replaces the session with the target session's goal, in both directions", async () => {
		await startServer({ handler: { content: ["ok"] } });
		// The mock reply's model id is not registered; record one the switch back can restore.
		session.sessionManager.appendModelChange("anthropic/claude-sonnet-4-5");
		const a = new TestClient(server);
		const b = new TestClient(server);
		server.attach(a.conn);
		server.attach(b.conn);
		// A finished turn writes the transcript, so it can be switched back to.
		await a.command({ type: "prompt", message: "hi" });
		await a.next(f => f.type === "agent_end");
		const goalFile = session.sessionFile;
		expect(await a.command({ type: "goal", op: "create", objective: "ship it" })).toMatchObject({ success: true });
		expect(await a.command({ type: "get_state" })).toMatchObject({
			data: { goal: { goal: { objective: "ship it" } } },
		});

		// Into a session without a goal: the replacement must not carry the goal left behind.
		await a.command({ type: "new_session" });
		const fresh = await b.next(f => f.type === "session_replaced" && f.reason === "new");
		expect(fresh.snapshot).toMatchObject({ state: { goal: null } });
		expect(await a.command({ type: "get_state" })).toMatchObject({ data: { goal: null } });

		// Back into the goal session: the replacement carries the goal reattached from its transcript.
		expect(await a.command({ type: "switch_session", sessionPath: goalFile })).toMatchObject({ success: true });
		const back = await b.next(f => f.type === "session_replaced" && f.reason === "resume");
		expect(back.snapshot).toMatchObject({ state: { goal: { goal: { objective: "ship it" } } } });
	});

	it("sends config_update after a direct model or thinking change to sequenced clients only, not stdio", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		const stdio = new TestClient(server, { sequenced: false });
		server.attach(a.conn);
		server.attach(b.conn);
		const updates = (c: TestClient): Record<string, unknown>[] => c.frames.filter(f => f.type === "config_update");

		await a.command({ type: "set_model", provider: "anthropic", modelId: "claude-opus-4-5" });
		const afterModel = await b.next(f => f.type === "config_update");
		expect(afterModel).toMatchObject({ model: { provider: "anthropic", id: "claude-opus-4-5" } });
		expect(afterModel.thinkingLevel).toBe(session.thinkingLevel);
		expect(typeof afterModel.seq).toBe("number");

		await a.command({ type: "set_thinking_level", level: "high" });
		expect(await a.command({ type: "cycle_thinking_level" })).toMatchObject({
			success: true,
			data: { level: expect.any(String) },
		});
		expect(await a.command({ type: "cycle_model" })).toMatchObject({ success: true, data: { isScoped: false } });
		// b's own round-trip is its sync point: its frames arrive in order.
		await b.command({ type: "get_state" });
		expect(updates(b)).toHaveLength(4);
		const last = updates(b).at(-1)!;
		expect(last).toMatchObject({ model: { id: session.model?.id } });
		expect(last.thinkingLevel).toBe(session.thinkingLevel);

		// A failed command reports no change.
		const before = updates(a).length;
		await a.command({ type: "set_model", provider: "anthropic", modelId: "no-such-model" });
		expect(updates(a)).toHaveLength(before);

		// Frames arrive in write order: a config_update sent to stdio would precede this response.
		await stdio.command({ type: "get_state" });
		expect(stdio.frames.some(f => f.type === "config_update")).toBe(false);
	});

	it("answers a non-string command type with Unknown command, as stdio does", async () => {
		await startServer({ handler: { content: ["ok"] } });
		for (const sequenced of [true, false]) {
			const c = new TestClient(server, { sequenced });
			expect(await c.command({ type: 5 })).toMatchObject({ success: false, error: "Unknown command: 5" });
			expect(await c.command({})).toMatchObject({ success: false, error: "Unknown command: undefined" });
		}
	});

	it("gives a mid-turn joiner the streaming message under the id later updates use", async () => {
		const release = Promise.withResolvers<void>();
		session = await createTestSession(dir, { handler: { content: ["streamed reply"] } }, release.promise);
		server = await RpcServer.start(session, {});
		const a = new TestClient(server);
		server.attach(a.conn);
		await a.command({ type: "prompt", message: "go" });
		await a.next(f => f.type === "message_update");
		const late = new TestClient(server);
		const attached = server.attach(late.conn) as RpcAttachedFrame;
		expect(attached.snapshot.streaming).toBeDefined();
		release.resolve();
		const end = await late.next(
			f => f.type === "message_end" && f.messageId === attached.snapshot.streaming!.messageId,
		);
		expect(isRecord(end.message) && end.message.role).toBe("assistant");
	});

	describe("queued prompts", () => {
		const PIXEL: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
		};
		const sizeOf = (frame: Record<string, unknown>, queue: "steering" | "followUp"): number | undefined => {
			const chips = frame[queue];
			return Array.isArray(chips) ? chips.length : undefined;
		};

		/** A server whose run is held open, with `A`, a captioned image, `B` and `A` queued behind it as follow-ups. */
		async function startWithQueue(): Promise<{ release: () => void; a: TestClient; stdio: TestClient }> {
			const release = Promise.withResolvers<void>();
			session = await createTestSession(dir, { handler: { content: ["ok"] } }, release.promise);
			server = await RpcServer.start(session, {});
			const a = new TestClient(server);
			const stdio = new TestClient(server, { sequenced: false });
			server.attach(a.conn);
			await a.command({ type: "prompt", message: "go" });
			await a.next(f => f.type === "message_update");
			const prompts: [message: string, images?: ImageContent[]][] = [["A"], ["caption", [PIXEL]], ["B"], ["A"]];
			for (const [message, images] of prompts) {
				await a.command({ type: "prompt", message, images, streamingBehavior: "followUp" });
			}
			return { release: release.resolve, a, stdio };
		}

		it("tells sequenced clients which queued chips carry an attachment, and stdio nothing it did not already get", async () => {
			const { release, a, stdio } = await startWithQueue();
			try {
				const live = await a.next(f => f.type === "queue_update" && sizeOf(f, "followUp") === 4);
				expect(live).toMatchObject({
					followUp: ["A", "caption", "B", "A"],
					attachments: { steering: [], followUp: [false, true, false, false] },
				});
				const plain = await stdio.next(f => f.type === "queue_update" && sizeOf(f, "followUp") === 4);
				expect("attachments" in plain).toBe(false);

				const late = new TestClient(server);
				const attached = server.attach(late.conn) as RpcAttachedFrame;
				expect(attached.snapshot.state.queuedMessages.followUp).toEqual(["A", "caption", "B", "A"]);
				expect(attached.snapshot.queueAttachments).toEqual({ steering: [], followUp: [false, true, false, false] });
			} finally {
				release();
			}
		});

		it("removes the first match by default, the newest on request, and refuses one with an attachment on request", async () => {
			const { release, a, stdio } = await startWithQueue();
			try {
				const remove = (options: Record<string, unknown>) =>
					a.command({ type: "remove_queued_message", queue: "followUp", ...options });

				// Queued A, caption, B, A: `last` removes the newest A and keeps the older one in front…
				expect(await remove({ message: "A", match: "last" })).toMatchObject({
					success: true,
					data: { removed: true },
				});
				expect(session.getQueuedMessages().followUp).toEqual(["A", "caption", "B"]);
				// …while the default, with a second A queued, removes the oldest and keeps the newer one behind.
				await a.command({ type: "prompt", message: "A", streamingBehavior: "followUp" });
				expect(await remove({ message: "A" })).toMatchObject({ data: { removed: true } });
				expect(session.getQueuedMessages().followUp).toEqual(["caption", "B", "A"]);
				expect(await remove({ message: "A", match: "last" })).toMatchObject({ data: { removed: true } });
				expect(session.getQueuedMessages().followUp).toEqual(["caption", "B"]);

				// The captioned image is not text-only: asked to refuse attachments, the host removes nothing.
				expect(await remove({ message: "caption", refuseAttachments: true })).toMatchObject({
					data: { removed: false, refused: "attachments" },
				});
				expect(session.getQueuedMessages().followUp).toEqual(["caption", "B"]);
				expect(session.queuedMessageHasAttachments("caption", "followUp")).toBe(true);
				expect(await remove({ message: "B", refuseAttachments: true })).toMatchObject({ data: { removed: true } });

				expect(await remove({ message: "B", match: "middle" })).toMatchObject({
					success: false,
					error: 'match must be "first" or "last"',
				});
				expect(await remove({ message: "B", refuseAttachments: "yes" })).toMatchObject({
					success: false,
					error: "refuseAttachments must be a boolean",
				});

				// stdio keeps its exact response: removal reports `removed`, and the images it took, and nothing else.
				const response = await stdio.command({
					type: "remove_queued_message",
					message: "caption",
					queue: "followUp",
				});
				expect(response.data).toEqual({ removed: true, images: [expect.objectContaining({ type: "image" })] });
			} finally {
				release();
			}
		});
	});
});
