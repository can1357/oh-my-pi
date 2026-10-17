import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import type { MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { RpcServer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-server";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isRecord, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir, TestClient } from "./helpers/rpc-server-harness";

let dir: string;
let session: AgentSession;
let server: RpcServer;
let ui: ExtensionUIContext;
let restoreAgentDir: () => void;

async function startServer(mock: MockModelOptions): Promise<void> {
	session = await createTestSession(dir, mock);
	// `setToolUIContext` is the production seam main.ts uses for rpc-ui; it hands out the shared UI context.
	server = await RpcServer.start(session, { setToolUIContext: ctx => void (ui = ctx) });
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-multi-"));
	restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
});
afterEach(async () => {
	await server?.dispose();
	restoreAgentDir();
	await removeWithRetries(dir);
});

describe("RpcServer with two connections", () => {
	it("fans one prompt's events to both clients with identical message ids, prompt_result only to the sender", async () => {
		await startServer({ handler: { content: ["hello back"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		await a.command({ type: "prompt", message: "hi" });
		await a.next(f => f.type === "prompt_result");
		await b.next(f => f.type === "agent_end");
		const ids = (c: TestClient) => c.frames.filter(f => f.type === "message_end").map(f => f.messageId);
		expect(ids(b)).toEqual(ids(a));
		expect(ids(a).length).toBeGreaterThan(0);
		expect(b.frames.some(f => f.type === "prompt_result")).toBe(false);
	});

	it("gives a client that joins after earlier turns the host's message ids", async () => {
		await startServer({ handler: { content: ["hello back"] } });
		const a = new TestClient(server);
		await a.command({ type: "prompt", message: "first" });
		await a.next(f => f.type === "prompt_result");
		const b = new TestClient(server);
		await a.command({ type: "prompt", message: "second" });
		await a.next(f => f.type === "prompt_result" && f.id === "c2");
		await b.next(f => f.type === "agent_end");
		const [idsA, idsB] = [a, b].map(c => c.frames.filter(f => f.type === "message_end").map(f => f.messageId));
		expect(idsB.length).toBeGreaterThan(0);
		expect(idsB).toEqual(idsA.slice(idsA.length - idsB.length));
	});

	it("first dialog answer wins and the other client receives cancel for that id", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		const answer = ui.confirm("Proceed?", "msg");
		const reqA = await a.next(f => f.type === "extension_ui_request" && f.method === "confirm");
		await b.next(f => f.id === reqA.id);
		b.write({ type: "extension_ui_response", id: reqA.id, confirmed: true });
		expect(await answer).toBe(true);
		const cancel = await a.next(f => f.method === "cancel");
		expect(cancel.targetId).toBe(reqA.id);
		a.write({ type: "extension_ui_response", id: reqA.id, confirmed: false }); // late answer: ignored
		// Frames are read in order, so this response proves the late answer was already handled.
		await a.command({ type: "get_messages" });
		expect(server.uiPending.size).toBe(0);
		expect(b.frames.some(f => f.method === "cancel" && f.targetId === reqA.id)).toBe(false);
	});

	it("keeps a dialog pending with no UI client and lets a late joiner answer it", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const answer = ui.confirm("Late?", "msg");
		expect([...server.uiPending.values()].map(r => r.method)).toEqual(["confirm"]);
		const late = new TestClient(server);
		const [id] = server.uiPending.keys();
		late.write({ type: "extension_ui_response", id, confirmed: true });
		expect(await answer).toBe(true);
	});

	it("routes a host tool call to its latest registrant and fails it when that client drops", async () => {
		await startServer({
			responses: [{ content: [{ type: "toolCall", name: "probe", arguments: {} }] }],
			handler: { content: ["done"] },
		});
		const a = new TestClient(server);
		const b = new TestClient(server);
		const tool = { name: "probe", description: "p", parameters: { type: "object", properties: {} } };
		await a.command({ type: "set_host_tools", tools: [tool] });
		await b.command({ type: "set_host_tools", tools: [tool] });
		await a.command({ type: "prompt", message: "use probe" });
		await b.next(f => f.type === "host_tool_call" && f.toolName === "probe");
		expect(a.frames.some(f => f.type === "host_tool_call")).toBe(false);
		await server.disconnect(b.conn, "test");
		const result = await a.next(
			f => f.type === "message_end" && isRecord(f.message) && f.message.role === "toolResult",
		);
		const message = result.message;
		if (!isRecord(message) || !Array.isArray(message.content)) throw new Error("expected a toolResult message");
		expect(message.isError).toBe(true);
		const text = message.content.map(c => (isRecord(c) && typeof c.text === "string" ? c.text : "")).join("");
		expect(text).toContain("host tool client disconnected");
	});

	it("re-merges host tools after the latest registrant drops so the next call reaches the earlier one", async () => {
		await startServer({
			responses: [
				{ content: [{ type: "toolCall", name: "probe", arguments: {} }] },
				{ content: ["first done"] },
				{ content: [{ type: "toolCall", name: "probe", arguments: {} }] },
			],
			handler: { content: ["second done"] },
		});
		const a = new TestClient(server);
		const b = new TestClient(server);
		const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
		await a.command({ type: "set_host_tools", tools: [tool("probe"), tool("alpha")] });
		await b.command({ type: "set_host_tools", tools: [tool("probe"), tool("beta")] });
		const first = await a.command({ type: "prompt", message: "first" });
		await b.next(f => f.type === "host_tool_call" && f.toolName === "probe");
		await server.disconnect(b.conn, "test");
		await a.next(f => f.type === "prompt_result" && f.id === first.id);

		const second = await a.command({ type: "prompt", message: "second" });
		const call = await a.next(f => f.type === "host_tool_call" && f.toolName === "probe");
		a.write({ type: "host_tool_result", id: call.id, result: { content: [{ type: "text", text: "from a" }] } });
		expect((await a.next(f => f.type === "prompt_result" && f.id === second.id)).status).toBe("completed");
		const state = await a.command({ type: "get_state" });
		const tools = isRecord(state.data) && Array.isArray(state.data.dumpTools) ? state.data.dumpTools : [];
		const names = tools.map(t => (isRecord(t) ? t.name : undefined));
		expect(names).toContain("alpha");
		expect(names).not.toContain("beta");
	});

	it("keeps a host URI scheme routed while its latest registrant stays connected", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		const schemes = [{ scheme: "zz-multi" }];
		await a.command({ type: "set_host_uri_schemes", schemes });
		await b.command({ type: "set_host_uri_schemes", schemes });
		await server.disconnect(a.conn, "test");
		expect(InternalUrlRouter.instance().canHandle("zz-multi://doc")).toBe(true);
		await server.disconnect(b.conn, "test");
		expect(InternalUrlRouter.instance().canHandle("zz-multi://doc")).toBe(false);
	});

	it("hands a host URI scheme back to the earlier registrant when the latest one drops", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		const schemes = [{ scheme: "zz-reclaim" }];
		await a.command({ type: "set_host_uri_schemes", schemes });
		await b.command({ type: "set_host_uri_schemes", schemes });
		await server.disconnect(b.conn, "test");
		const read = InternalUrlRouter.instance().resolve("zz-reclaim://doc");
		const request = await a.next(f => f.type === "host_uri_request");
		a.write({ type: "host_uri_result", id: request.id, content: "from a" });
		expect((await read).content).toBe("from a");
		await server.disconnect(a.conn, "test");
		expect(InternalUrlRouter.instance().canHandle("zz-reclaim://doc")).toBe(false);
	});

	it("hands a host URI scheme back to the earlier registrant when the latest one stops registering it", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		await a.command({ type: "set_host_uri_schemes", schemes: [{ scheme: "zz-withdraw" }] });
		await b.command({ type: "set_host_uri_schemes", schemes: [{ scheme: "zz-withdraw" }] });
		await b.command({ type: "set_host_uri_schemes", schemes: [] });
		const read = InternalUrlRouter.instance().resolve("zz-withdraw://doc");
		const request = await a.next(f => f.type === "host_uri_request");
		a.write({ type: "host_uri_result", id: request.id, content: "from a" });
		expect((await read).content).toBe("from a");
		await server.disconnect(a.conn, "test");
	});

	it("refuses a host URI registration that was still queued when its client dropped, keeping the live registrant routed", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		const schemes = [{ scheme: "zz-queued" }];
		await a.command({ type: "set_host_uri_schemes", schemes });
		// Hold the shared command queue on a switch whose host check is unanswered, so b's registration waits behind it.
		const hostCheck = Promise.withResolvers<{ hostId: string } | undefined>();
		server.onBeforeSwitch = () => hostCheck.promise;
		const held = a.command({ type: "switch_session", sessionPath: path.join(dir, "elsewhere.jsonl") });
		b.write({ id: "late", type: "set_host_uri_schemes", schemes });
		b.end();
		// The input ended: b's frame was read and is queued.
		await b.conn.inputClosed;

		const dropped = server.disconnect(b.conn, "test");
		hostCheck.resolve({ hostId: "other-host" });
		await dropped;
		expect(await held).toMatchObject({ success: false, code: "session_hosted" });

		// b's late registration never ran: the scheme is still a's, and nothing was sent to b.
		const read = InternalUrlRouter.instance().resolve("zz-queued://doc");
		const request = await a.next(f => f.type === "host_uri_request");
		a.write({ type: "host_uri_result", id: request.id, content: "from a" });
		expect((await read).content).toBe("from a");
		expect(b.frames.some(f => f.type === "host_uri_request")).toBe(false);
		await server.disconnect(a.conn, "test");
		expect(InternalUrlRouter.instance().canHandle("zz-queued://doc")).toBe(false);
	});

	it("releases a dropped client's pending login prompt so the shared command queue keeps moving", async () => {
		registerOAuthProvider({
			id: "zz-multi-login",
			name: "Test login",
			login: async ({ onAuth, onPrompt }) => {
				onAuth({ url: "https://example.invalid/auth" });
				return onPrompt({ message: "Paste the code" });
			},
		});
		try {
			await startServer({ handler: { content: ["ok"] } });
			const a = new TestClient(server);
			const b = new TestClient(server);
			a.write({ id: "login", type: "login", providerId: "zz-multi-login" });
			await a.next(f => f.type === "extension_ui_request" && f.method === "input");
			await server.disconnect(a.conn, "test");
			expect((await b.command({ type: "get_state" })).success).toBe(true);
		} finally {
			unregisterOAuthProvider("zz-multi-login");
		}
	});

	it("sends a builtin command's output only to the client that ran it", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		await a.command({ type: "prompt", message: "/shake bogus" });
		expect(a.frames.find(f => f.type === "command_output")?.text).toContain('Unknown /shake mode "bogus"');
		// Frames arrive in write order: a broadcast sent with a's output would precede this response.
		await b.command({ type: "get_messages" });
		expect(b.frames.some(f => f.type === "command_output")).toBe(false);
	});

	it("settles every client's open prompt when another client replaces the session", async () => {
		const gate = Promise.withResolvers<void>();
		session = await createTestSession(dir, { handler: { content: ["streaming reply"] } }, gate.promise);
		server = await RpcServer.start(session, {});
		const a = new TestClient(server);
		const b = new TestClient(server);
		await a.command({ type: "prompt", message: "hi" });
		await a.next(f => f.type === "message_update");
		const replaced = b.command({ type: "new_session" });
		gate.resolve();
		expect((await replaced).success).toBe(true);
		expect((await a.next(f => f.type === "prompt_result")).status).toBe("aborted");
	});

	it("drops a client whose output backlog passes its spool cap and keeps serving the others", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const healthy = new TestClient(server);
		// A reader that never drains: after `ready`, every frame spools.
		const sink = new Writable({ highWaterMark: 1, write() {} });
		const stalled = server.connect(
			{ input: new ReadableStream(), sink },
			{ sequenced: true, ui: true, clientId: "stalled", maxSpoolBytes: 1024 },
		);
		ui.notify("x".repeat(2048));
		expect(server.connections.has(stalled)).toBe(false);
		// The transport is ended, so the client learns it was dropped.
		expect(sink.destroyed).toBe(true);
		expect((await healthy.next(f => f.method === "notify")).message).toBe("x".repeat(2048));
		expect((await healthy.command({ type: "get_state" })).success).toBe(true);
	});
});
