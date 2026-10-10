import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcServer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-server";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { connectSessionHost } from "@oh-my-pi/pi-coding-agent/session-host/client";
import { runSessionHost, type SessionHostOptions } from "@oh-my-pi/pi-coding-agent/session-host/host";
import { resolveAttachTarget } from "@oh-my-pi/pi-coding-agent/session-host/hosted-startup";
import {
	findHostForSession,
	listSessionHosts,
	newHostId,
	type SessionHostEntry,
} from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, logger, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir } from "../helpers/rpc-server-harness";
import {
	holdLeaseInAnotherProcess,
	killLeaseProcesses,
	leaseFreeInAnotherProcess,
} from "../helpers/session-lease-process";

let dir: string;
let registryDir: string;
let restoreAgentDir: () => void;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-"));
	registryDir = path.join(dir, "registry");
	restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
});
afterEach(async () => {
	killLeaseProcesses();
	restoreAgentDir();
	await removeWithRetries(dir);
});

interface TestHost {
	hostId: string;
	session: AgentSession;
	exited: boolean;
	exitedPromise: Promise<void>;
	stop(): Promise<void>;
}

let hostCount = 0;
async function startHost(options: Partial<SessionHostOptions> = {}): Promise<TestHost> {
	const sessionDir = path.join(dir, `host-${++hostCount}`);
	await fs.mkdir(sessionDir, { recursive: true });
	return serveSession(await createTestSession(sessionDir, { handler: { content: ["ok"] } }), options);
}

/** A session whose extension vetoes every switch to another session (`session_before_switch`), calling `duringVeto` first. */
function createVetoingSession(sessionDir: string, duringVeto: () => void): Promise<AgentSession> {
	return createExtensionSession(sessionDir, "veto-switch", pi => {
		pi.on("session_before_switch", () => {
			duringVeto();
			return { cancel: true };
		});
	});
}

async function createExtensionSession(
	sessionDir: string,
	name: string,
	factory: ExtensionFactory,
): Promise<AgentSession> {
	const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(sessionDir, "models.yml"));
	const sessionManager = SessionManager.create(sessionDir, path.join(sessionDir, "sessions"));
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, sessionDir, new EventBus(), runtime, name);
	return new AgentSession({
		agent: new Agent({
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner: new ExtensionRunner([extension], runtime, sessionDir, sessionManager, modelRegistry),
	});
}

/** A session whose provider routing id is pinned (`--provider-session-id`): `session.sessionId` is not its transcript id. */
async function createPinnedSession(sessionDir: string, providerSessionId: string): Promise<AgentSession> {
	const authStorage = await AuthStorage.create(path.join(sessionDir, "auth.db"));
	return new AgentSession({
		agent: new Agent({
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		}),
		sessionManager: SessionManager.create(sessionDir, path.join(sessionDir, "sessions")),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(sessionDir, "models.yml")),
		providerSessionId,
	});
}

/** Serve `session` in a session host of this process; resolves once the host has published its registry entry. */
async function serveSession(session: AgentSession, options: Partial<SessionHostOptions> = {}): Promise<TestHost> {
	const hostId = newHostId();
	const done = Promise.withResolvers<void>();
	const host: TestHost = {
		hostId,
		session,
		exited: false,
		exitedPromise: done.promise,
		async stop() {
			if (host.exited) return;
			await (await attachClient(host)).exit();
			await done.promise;
		},
	};
	void runSessionHost(session, {
		...options,
		hostId,
		registryDir,
		onExit: async () => {
			await session.dispose();
			host.exited = true;
			done.resolve();
			return new Promise<never>(() => {});
		},
	});
	await waitFor(async () => (await listSessionHosts(registryDir)).some(e => e.hostId === hostId));
	return host;
}

async function attachClient(host: TestHost): Promise<RpcClient> {
	const entry = (await listSessionHosts(registryDir)).find(e => e.hostId === host.hostId)!;
	const client = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
	await client.start();
	return client;
}

async function onlyEntry(): Promise<SessionHostEntry> {
	const [entry] = await listSessionHosts(registryDir);
	return entry;
}

interface RawClient {
	frames: Record<string, unknown>[];
	closed: Promise<unknown>;
	next(match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
	write(frame: object): void;
	close(): void;
}

/** A socket client that keeps every frame, for wire contracts RpcClient does not expose. `hello` overrides a ui:false v1 hello. */
async function rawClient(hello: Record<string, unknown>): Promise<RawClient> {
	const { endpoint, token } = await onlyEntry();
	const sock = net.connect(endpoint);
	sock.setEncoding("utf8");
	const frames: Record<string, unknown>[] = [];
	let waiters: Array<{
		match: (frame: Record<string, unknown>) => boolean;
		resolve: (frame: Record<string, unknown>) => void;
	}> = [];
	let buffered = "";
	sock.on("data", (chunk: string) => {
		buffered += chunk;
		for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
			const frame = JSON.parse(buffered.slice(0, nl)) as Record<string, unknown>;
			buffered = buffered.slice(nl + 1);
			frames.push(frame);
			waiters = waiters.filter(w => (w.match(frame) ? (w.resolve(frame), false) : true));
		}
	});
	const write = (frame: object): void => void sock.write(`${JSON.stringify(frame)}\n`);
	write({ type: "hello", token, protocolVersion: 1, client: { kind: "test" }, capabilities: { ui: false }, ...hello });
	return {
		frames,
		closed: once(sock, "close"),
		next: match => {
			const seen = frames.find(match);
			if (seen) return Promise.resolve(seen);
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiters.push({ match, resolve });
			return promise;
		},
		write,
		close: () => sock.destroy(),
	};
}

/** Close `clients`, wait until the host has seen them leave, then stop it. */
async function stopWith(host: TestHost, clients: RawClient[]): Promise<void> {
	for (const client of clients) client.close();
	await waitFor(async () => (await onlyEntry()).clients === 0);
	await host.stop();
}

const isHandshake = (frame: Record<string, unknown>): boolean => frame.type === "attached" || frame.type === "resumed";

/** Polls a condition, not a guessed delay: the registry file is the host's only observable readiness and presence signal. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(25);
	}
}

/** A saved session no host serves (header only), recorded under `cwd`. */
async function savedSession(cwd: string): Promise<{ file: string; id: string }> {
	await fs.mkdir(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, path.join(dir, "saved-sessions"));
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("session was not given a file");
	const id = manager.getSessionId();
	await manager.close();
	return { file, id };
}

describe("session host", () => {
	it("rejects a bad token", async () => {
		const host = await startHost();
		const sock = net.connect((await onlyEntry()).endpoint);
		sock.write(
			`${JSON.stringify({ type: "hello", token: "nope", protocolVersion: 1, client: { kind: "test" }, capabilities: { ui: false } })}\n`,
		);
		const reply = JSON.parse((await once(sock, "data"))[0].toString().split("\n")[0]);
		expect(reply).toMatchObject({ success: false, code: "unauthorized" });
		await host.stop();
	});

	it("publishes before extension startup, so an attached client can answer a dialog session_start awaits", async () => {
		const sessionDir = path.join(dir, "startup-dialog");
		await fs.mkdir(sessionDir, { recursive: true });
		const session = await createExtensionSession(sessionDir, "startup-dialog", pi => {
			pi.on("session_start", async (_event, ctx) => {
				ctx.ui.notify(`answered ${await ctx.ui.confirm("Trust?", "startup")}`);
			});
		});
		// Resolves only once the entry is published: before the fix, never, as startup waited on the dialog.
		const host = await serveSession(session);
		const a = await rawClient({ capabilities: { ui: true } });
		const { snapshot } = await a.next(isHandshake);
		// In the snapshot, or live if this client attached before session_start reached the dialog.
		const request =
			(isRecord(snapshot) && Array.isArray(snapshot.pendingUi) ? snapshot.pendingUi[0] : undefined) ??
			(await a.next(frame => frame.method === "confirm"));
		expect(request).toMatchObject({ method: "confirm", title: "Trust?" });
		// Held until startup finishes. `set_ask_dialog` is served during startup, through the same command queue: had
		// get_state not been held, its response would come first.
		a.write({ id: "state", type: "get_state" });
		a.write({ id: "ask", type: "set_ask_dialog", enabled: true });
		await a.next(frame => frame.id === "ask");
		expect(a.frames.some(frame => frame.id === "state")).toBe(false);
		a.write({ type: "extension_ui_response", id: request.id, confirmed: true });
		const state = await a.next(frame => frame.id === "state");
		expect(state).toMatchObject({ type: "response", success: true });
		const notice = a.frames.findIndex(frame => frame.method === "notify");
		expect(a.frames[notice]).toMatchObject({ message: "answered true" });
		expect(notice).toBeLessThan(a.frames.indexOf(state));
		await stopWith(host, [a]);
	});

	it("withdraws its registry entry and endpoint when extension startup fails after publishing", async () => {
		const sessionDir = path.join(dir, "startup-failure");
		await fs.mkdir(sessionDir, { recursive: true });
		const session = await createTestSession(sessionDir, { handler: { content: ["ok"] } });
		await expect(
			runSessionHost(session, {
				hostId: newHostId(),
				registryDir,
				setToolUIContext: () => {
					throw new Error("startup failed");
				},
				onExit: () => Promise.withResolvers<never>().promise,
			}),
		).rejects.toThrow("startup failed");
		expect(await fs.readdir(registryDir)).toEqual([]);
		await session.dispose();
	});

	it("rejects a valid hello whose line overruns the hello size limit", async () => {
		const host = await startHost();
		const { endpoint, token } = await onlyEntry();
		const sock = net.connect(endpoint);
		// One write: the newline can land in the same chunk as the 64 KiB limit.
		const label = "x".repeat(64 * 1024);
		sock.write(
			`${JSON.stringify({ type: "hello", token, protocolVersion: 1, client: { kind: "test", label }, capabilities: { ui: false } })}\n`,
		);
		const reply = JSON.parse((await once(sock, "data"))[0].toString().split("\n")[0]);
		expect(reply).toMatchObject({ success: false, code: "unauthorized" });
		sock.destroy();
		await host.stop();
	});

	it("sends a snapshot larger than one RPC frame intact to a client that said hello with protocol v2", async () => {
		const host = await startHost();
		const text = "x".repeat(MAX_RPC_FRAME_BYTES + 512 * 1024);
		const entryId = host.session.sessionManager.appendCustomEntry("big", { text });
		const { endpoint, token } = await onlyEntry();
		const sock = net.connect(endpoint);
		const decoder = new RpcFrameDecoder();
		const attached = Promise.withResolvers<Record<string, unknown>>();
		let buffered = "";
		sock.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
				const frame = decoder.push(JSON.parse(buffered.slice(0, nl)));
				buffered = buffered.slice(nl + 1);
				if (isRecord(frame) && frame.type === "attached") attached.resolve(frame);
			}
		});
		sock.write(
			`${JSON.stringify({ type: "hello", token, protocolVersion: 2, client: { kind: "test" }, capabilities: { ui: false } })}\n`,
		);
		const { snapshot } = await attached.promise;
		expect(isRecord(snapshot) && Array.isArray(snapshot.entries)).toBe(true);
		const entries = isRecord(snapshot) && Array.isArray(snapshot.entries) ? snapshot.entries : [];
		expect(entries.find(entry => isRecord(entry) && entry.id === entryId)).toMatchObject({ data: { text } });
		sock.destroy();
		// RpcClient over connectSessionHost decodes the chunked `attached` it receives before any negotiation.
		const c = await attachClient(host);
		expect((await c.getState()).sessionId).toBe(host.session.sessionId);
		await c.detach();
		await host.stop();
	});

	it("keeps the host after the last client detaches and after an abruptly closed client", async () => {
		const host = await startHost();
		const a = await attachClient(host);
		await a.detach();
		const b = await attachClient(host);
		await b.stop(); // socket destroyed without `detach`
		await waitFor(async () => (await onlyEntry()).clients === 0);
		expect(host.exited).toBe(false);
		const c = await attachClient(host);
		expect((await c.getState()).sessionId).toBe(host.session.sessionId);
		// stop()'s `exit` stops the host only as the last client.
		await c.detach();
		await host.stop();
	});

	it("delivers a backlogged client's queued output, the detach response last, before closing it", async () => {
		const host = await startHost();
		const { endpoint, token } = await onlyEntry();
		const a = net.connect(endpoint);
		await once(a, "connect");
		a.pause();
		const hello = { type: "hello", token, protocolVersion: 1, client: { kind: "test" }, capabilities: { ui: false } };
		const states = Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`, type: "get_state" }));
		a.write(`${[hello, ...states, { id: "bye", type: "detach" }].map(frame => JSON.stringify(frame)).join("\n")}\n`);
		// One command FIFO serves every client: b's answer means a's detach ran while a was not reading.
		const b = await attachClient(host);
		await b.getState();
		const chunks: Buffer[] = [];
		a.on("data", (chunk: Buffer) => chunks.push(chunk));
		a.resume();
		await once(a, "close");
		const responses = Buffer.concat(chunks)
			.toString()
			.trim()
			.split("\n")
			.map(line => JSON.parse(line))
			.filter(frame => frame.type === "response");
		expect(responses).toHaveLength(2001);
		expect(responses.at(-1)).toMatchObject({ id: "bye", success: true });
		await b.detach();
		await host.stop();
	});

	it("drops a leaving client that stopped reading instead of waiting for its output to drain", async () => {
		const host = await startHost({ flushTimeoutMs: 200 });
		const { endpoint, token } = await onlyEntry();
		const a = net.connect(endpoint);
		await once(a, "connect");
		a.pause();
		const hello = { type: "hello", token, protocolVersion: 1, client: { kind: "test" }, capabilities: { ui: false } };
		const states = Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`, type: "get_state" }));
		a.write(`${[hello, ...states].map(frame => JSON.stringify(frame)).join("\n")}\n`);
		await waitFor(async () => (await onlyEntry()).clients === 1);
		a.write(`${JSON.stringify({ id: "bye", type: "detach" })}\n`);
		// The departure is published only once its output drained or was given up on.
		await waitFor(async () => (await onlyEntry()).clients === 0);
		a.destroy();
		await host.stop();
	});

	it("closes a socket that sends no hello in time, but never an authenticated client", async () => {
		const host = await startHost({ helloTimeoutMs: 100 });
		const c = await attachClient(host);
		const silent = net.connect((await onlyEntry()).endpoint);
		silent.resume();
		await once(silent, "close");
		// c authenticated before `silent` connected, so it outlived its own hello window.
		expect((await c.getState()).sessionId).toBe(host.session.sessionId);
		await c.detach();
		await host.stop();
	});

	it("treats exit as detach while another client remains and stops the host for the last one", async () => {
		const host = await startHost();
		const a = await attachClient(host);
		const b = await attachClient(host);
		await a.exit();
		expect(host.exited).toBe(false);
		await b.exit();
		await host.exitedPromise;
		expect(await listSessionHosts(registryDir)).toEqual([]);
	});

	it("refuses to switch to a session another host owns", async () => {
		const other = await startHost();
		const host = await startHost();
		const a = await attachClient(host);
		await expect(a.switchSession(other.session.sessionFile!)).rejects.toMatchObject({
			code: "session_hosted",
			hostId: other.hostId,
		});
		await other.stop();
		await a.detach();
		await host.stop();
	});

	it("moves its lease to the session it switches to, keyed by that session's id", async () => {
		const host = await startHost();
		const own = { file: host.session.sessionFile!, id: host.session.sessionManager.getSessionId() };
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(false);
		const target = await savedSession(host.session.sessionManager.getCwd());
		expect(await leaseFreeInAnotherProcess(target.file, target.id)).toBe(true);
		const a = await attachClient(host);
		expect(await a.switchSession(target.file)).toEqual({ cancelled: false });
		expect(host.session.sessionId).toBe(target.id);
		expect(await leaseFreeInAnotherProcess(target.file, target.id)).toBe(false);
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(true);
		await a.detach();
		await host.stop();
	});

	it("releases a switch target's lease when an extension vetoes the switch", async () => {
		const sessionDir = path.join(dir, "veto-host");
		await fs.mkdir(sessionDir, { recursive: true });
		const target = await savedSession(sessionDir);
		// The hook runs mid-switch, after the host leased the target. The host is in this process, so a raw lease
		// probe from here (which, unlike a claim, conflicts with the host's) sees whether the target is leased then.
		let leasedDuringSwitch: boolean | undefined;
		const session = await createVetoingSession(sessionDir, () => {
			const probe = tryAcquireSessionLease(target.id);
			leasedDuringSwitch = probe === null;
			probe?.release();
		});
		const host = await serveSession(session);
		const own = { file: session.sessionFile!, id: session.sessionManager.getSessionId() };
		const a = await attachClient(host);
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(false);
		expect(await a.switchSession(target.file)).toEqual({ cancelled: true });
		expect(leasedDuringSwitch).toBe(true);
		expect(await leaseFreeInAnotherProcess(target.file, target.id)).toBe(true);
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(false);
		expect((await a.getState()).sessionFile).toBe(own.file);
		await a.detach();
		await host.stop();
	});

	it("keeps its own lease and session when a switch fails on a target that holds no session", async () => {
		const host = await startHost();
		const own = { file: host.session.sessionFile!, id: host.session.sessionManager.getSessionId() };
		const a = await attachClient(host);
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(false);
		// A directory cannot be loaded as a session, and has no header whose id could be leased.
		const target = path.join(dir, "not-a-session.jsonl");
		await fs.mkdir(target);
		await expect(a.switchSession(target)).rejects.toThrow();
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(false);
		expect((await a.getState()).sessionFile).toBe(own.file);
		await a.detach();
		await host.stop();
	});

	it("releases a switch target's lease when the switch throws after the host claimed it", async () => {
		const host = await startHost();
		const own = { file: host.session.sessionFile!, id: host.session.sessionManager.getSessionId() };
		const target = await savedSession(host.session.sessionManager.getCwd());
		// Only the failure is injected: the RPC command, the host's lease claim and its cleanup are real.
		let leasedWhenFailing: boolean | undefined;
		spyOn(host.session, "switchSession").mockImplementationOnce(async () => {
			const probe = tryAcquireSessionLease(target.id);
			leasedWhenFailing = probe === null;
			probe?.release();
			throw new Error("switch exploded");
		});
		const a = await attachClient(host);
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(false);
		await expect(a.switchSession(target.file)).rejects.toThrow("switch exploded");
		expect(leasedWhenFailing).toBe(true);
		expect(await leaseFreeInAnotherProcess(target.file, target.id)).toBe(true);
		expect(await leaseFreeInAnotherProcess(own.file, own.id)).toBe(false);
		expect(host.session.sessionManager.getSessionId()).toBe(own.id);
		expect((await a.getState()).sessionFile).toBe(own.file);
		await a.detach();
		await host.stop();
	});

	it("refuses to switch to a session another process leases", async () => {
		const host = await startHost();
		const target = await savedSession(host.session.sessionManager.getCwd());
		await holdLeaseInAnotherProcess(target.file, target.id);
		const a = await attachClient(host);
		await expect(a.switchSession(target.file)).rejects.toMatchObject({ code: "session_hosted", hostId: "unknown" });
		expect((await a.getState()).sessionFile).toBe(host.session.sessionFile);
		await a.detach();
		await host.stop();
	});

	it("refuses to start on a session another process leases", async () => {
		const sessionDir = path.join(dir, "leased");
		await fs.mkdir(sessionDir, { recursive: true });
		const session = await createTestSession(sessionDir, { handler: { content: ["ok"] } });
		// Verifies the holder shares this process's lease namespace, so a host that wrongly started would not hang here.
		await holdLeaseInAnotherProcess(session.sessionFile!, session.sessionManager.getSessionId());
		await expect(
			runSessionHost(session, {
				hostId: newHostId(),
				registryDir,
				onExit: () => Promise.withResolvers<never>().promise,
			}),
		).rejects.toThrow("session already open in another process");
		expect(await listSessionHosts(registryDir)).toEqual([]);
		await session.dispose();
	});

	it("leases the transcript id, not a pinned provider session id, and keeps leasing it through new_session", async () => {
		const sessionDir = path.join(dir, "pinned-host");
		await fs.mkdir(sessionDir, { recursive: true });
		const session = await createPinnedSession(sessionDir, "provider-pin");
		const first = { file: session.sessionFile!, id: session.sessionManager.getSessionId() };
		expect(session.sessionId).toBe("provider-pin");
		expect(first.id).not.toBe("provider-pin");
		const host = await serveSession(session);
		const a = await attachClient(host);
		expect(await leaseFreeInAnotherProcess(first.file, first.id)).toBe(false);
		expect(await a.newSession()).toEqual({ cancelled: false });
		const next = { file: session.sessionFile!, id: session.sessionManager.getSessionId() };
		expect(next.id).not.toBe(first.id);
		expect(session.sessionId).toBe("provider-pin");
		expect(await leaseFreeInAnotherProcess(next.file, next.id)).toBe(false);
		expect(await leaseFreeInAnotherProcess(first.file, first.id)).toBe(true);
		await a.detach();
		await host.stop();
	});

	it("sends extension UI only to clients whose hello declared the ui capability", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const withUi = await rawClient({ capabilities: { ui: true } });
		const withoutUi = await rawClient({});
		await Promise.all([withUi.next(isHandshake), withoutUi.next(isHandshake)]);
		ui!.notify("hello");
		expect(await withUi.next(f => f.type === "extension_ui_request")).toMatchObject({
			method: "notify",
			message: "hello",
		});
		// One connection's frames arrive in order: this response follows any UI frame sent to it before.
		withoutUi.write({ id: "s", type: "get_state" });
		await withoutUi.next(f => f.type === "response" && f.id === "s");
		expect(withoutUi.frames.some(f => f.type === "extension_ui_request")).toBe(false);
		await stopWith(host, [withUi, withoutUi]);
	});

	it("resumes a hello that names this host and answers another host's resume with a snapshot", async () => {
		const host = await startHost();
		const a = await rawClient({});
		const attached = await a.next(isHandshake);
		expect(attached).toMatchObject({ type: "attached", hostId: host.hostId });
		// a's own arrival was broadcast after `attached`, so the ring holds the frame after its seq.
		const position = { epoch: attached.epoch, lastSeq: attached.seq };
		const same = await rawClient({ resume: { hostId: host.hostId, ...position } });
		expect((await same.next(isHandshake)).type).toBe("resumed");
		const foreign = await rawClient({ resume: { hostId: newHostId(), ...position } });
		expect((await foreign.next(isHandshake)).type).toBe("attached");
		await stopWith(host, [a, same, foreign]);
	});

	it("tells attached clients when another client attaches and detaches", async () => {
		const host = await startHost();
		const a = await rawClient({ client: { kind: "test", label: "a" } });
		const { clientId: aId } = await a.next(isHandshake);
		const b = await rawClient({ client: { kind: "test", label: "b" } });
		const { clientId: bId } = await b.next(isHandshake);
		const count = (f: Record<string, unknown>): number => (Array.isArray(f.clients) ? f.clients.length : -1);
		const joined = await a.next(f => f.type === "clients_changed" && count(f) === 2);
		expect(joined.clients).toEqual([
			{ clientId: aId, kind: "test", label: "a" },
			{ clientId: bId, kind: "test", label: "b" },
		]);
		b.write({ id: "bye", type: "detach" });
		const left = await a.next(
			f => f.type === "clients_changed" && (f.seq as number) > (joined.seq as number) && count(f) === 1,
		);
		expect(left.clients).toEqual([{ clientId: aId, kind: "test", label: "a" }]);
		await stopWith(host, [a, b]);
	});

	it("drops a connection that fails after authenticating and keeps serving", async () => {
		const host = await startHost();
		// attach()'s snapshot throws, as it can while the session is disposing.
		const snapshot = spyOn(RpcServer.prototype, "snapshot").mockImplementation(() => {
			throw new Error("snapshot failed");
		});
		try {
			const broken = await rawClient({});
			await broken.closed;
		} finally {
			snapshot.mockRestore();
		}
		const c = await attachClient(host);
		expect((await c.getState()).sessionId).toBe(host.session.sessionId);
		await c.detach();
		await host.stop();
	});

	it("retries a failed registry rewrite on the next change instead of treating its state as published", async () => {
		const host = await startHost();
		const entry = await onlyEntry();
		const entryPath = path.join(registryDir, `${host.hostId}.json`);
		// A non-empty directory in the entry's place fails every rewrite, as a rename onto an open file can on Windows.
		await fs.rm(entryPath);
		await fs.mkdir(path.join(entryPath, "blocker"), { recursive: true });
		const failed = Promise.withResolvers<void>();
		const unregister = logger.registerLogSink(event => {
			if (event.message === "Session host registry update failed") failed.resolve();
		});
		const c = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
		try {
			await c.start();
			await failed.promise;
		} finally {
			unregister();
		}
		await fs.rm(entryPath, { recursive: true });
		// An entry append re-publishes the unchanged state (`clients: 1`).
		host.session.sessionManager.appendCustomEntry("poke", {});
		await waitFor(async () => (await listSessionHosts(registryDir)).some(e => e.clients === 1));
		await c.detach();
		await host.stop();
	});

	it("leaves a live host attachable and its registry entry untouched when another host fails to bind its id", async () => {
		const host = await startHost();
		const entryPath = path.join(registryDir, `${host.hostId}.json`);
		const before = await fs.readFile(entryPath, "utf8");
		const intruderDir = path.join(dir, "intruder");
		await fs.mkdir(intruderDir, { recursive: true });
		const intruder = await createTestSession(intruderDir, { handler: { content: ["ok"] } });
		// A different session under the same `--host-id`: its endpoint is the live host's, so the bind fails.
		await expect(
			runSessionHost(intruder, {
				hostId: host.hostId,
				registryDir,
				onExit: () => Promise.withResolvers<never>().promise,
			}),
		).rejects.toMatchObject({ code: "EADDRINUSE" });
		// Byte-identical, so the bearer token is the one the live host accepts; listing probes the socket and
		// would prune the entry if the failed attempt had unlinked it.
		expect(await fs.readFile(entryPath, "utf8")).toBe(before);
		expect((await listSessionHosts(registryDir)).map(listed => listed.hostId)).toEqual([host.hostId]);
		const a = await attachClient(host);
		expect((await a.getState()).sessionFile).toBe(host.session.sessionFile);
		// The failed attempt released the lease it had claimed for its own session.
		expect(await leaseFreeInAnotherProcess(intruder.sessionFile!, intruder.sessionManager.getSessionId())).toBe(true);
		await intruder.dispose();
		await a.detach();
		await host.stop();
	});

	it("republishes its entry as soon as /move relocates the served session, keeping the session's lease", async () => {
		const host = await startHost();
		const manager = host.session.sessionManager;
		await manager.ensureOnDisk();
		const id = manager.getSessionId();
		const oldFile = host.session.sessionFile!;
		const moved = path.join(dir, "moved-project");
		await fs.mkdir(moved, { recursive: true });
		expect(await leaseFreeInAnotherProcess(oldFile, id)).toBe(false);
		// What `/move` and `/wt` call. Nothing is appended afterwards, so no later entry can republish for the host.
		await host.session.moveSession(moved, path.join(dir, "moved-sessions"));
		const newFile = host.session.sessionFile!;
		expect(newFile).not.toBe(oldFile);
		await waitFor(async () => (await findHostForSession(newFile, registryDir))?.hostId === host.hostId, 3_000);
		expect(await findHostForSession(oldFile, registryDir)).toBeUndefined();
		expect(await onlyEntry()).toMatchObject({ hostId: host.hostId, cwd: moved, sessionFile: newFile });
		// `omp attach <new path>`. The lookup above already found the host, so this cannot start a second one.
		expect(await resolveAttachTarget(newFile, { cwd: moved, args: [], registryDir })).toMatchObject({
			hostId: host.hostId,
			sessionFile: newFile,
		});
		// The same logical session: its lease is still held, whichever path it is looked up by.
		expect(manager.getSessionId()).toBe(id);
		expect(await leaseFreeInAnotherProcess(newFile, id)).toBe(false);
		const a = await attachClient(host);
		expect((await a.getState()).sessionFile).toBe(newFile);
		await a.detach();
		await host.stop();
	});
});
