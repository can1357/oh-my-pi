import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { deobfuscateAssistantContent } from "../../src/secrets/message-transform";
import { SecretObfuscator } from "../../src/secrets/obfuscator";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import type { SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { sessionMessagePersistenceKey } from "../../src/session/turn-persistence";
import { collectIrcPeerRoster } from "../../src/task/executor";
import { cfgTaskAgentModelOverrides } from "../../src/task/settings";
import type { AgentDefinition } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import { WriteTool } from "../../src/tools/write";
import type { AgentsProbe, AgentsProbeGlobals } from "../fixtures/agents-bridge-worker";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { runEach } from "../helpers/cleanup";

/** The timeout of each case's teardown: far past what its cleanups take. */
const TEARDOWN_TIMEOUT_MS = 30_000;

/** What each case acquired, released newest first by `afterEach`, each on its own. */
const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(
	() =>
		runEach([
			...cleanups.splice(0).reverse(),
			() => AgentLifecycleManager.resetGlobalForTests(),
			() => AgentRegistry.resetGlobalForTests(),
			() => IrcBus.resetGlobalForTests(),
		]),
	TEARDOWN_TIMEOUT_MS,
);

/** A bridge worker, terminated by the case's cleanups; its 20 s start cap is below each worker case's 60 s timeout. */
async function startWorker(): Promise<{ worker: SubagentWorker; probe: AgentsProbe }> {
	const probe = Promise.withResolvers<AgentsProbe>();
	const probeService: ThreadService = {
		name: "agents-probe",
		globals: (): AgentsProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/agents-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 20_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return { worker, probe: await probe.promise };
}

/**
 * Poll a condition fed by another thread (mirror patches, worker-side state).
 * There is no in-process clock to fake across a real worker; this waits on the
 * condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function liveRef(id: string): AgentRef {
	const ref = AgentRegistry.global().get(id);
	if (!ref) throw new Error(`no ref ${id}`);
	return ref;
}

function mirrorOf(session: AgentSessionHandle | null | undefined): RemoteAgentSession {
	if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker session mirror");
	return session;
}

/**
 * Watch `remote` as a focused view does, until the returned stop or the case's end: the stop is registered with the
 * case's cleanups as the watch starts. Stopping twice stops once.
 */
function watch(remote: RemoteAgentSession): () => void {
	let unsubscribe: (() => void) | undefined = remote.subscribe(() => {});
	const stop = (): void => {
		const current = unsubscribe;
		unsubscribe = undefined;
		current?.();
	};
	cleanups.push(stop);
	return stop;
}

async function mainSession(id: string, sessionAgents?: AgentDefinition[]): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	// Cleanups run newest first: the session is disposed, then its auth store is closed, each on its own.
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		inheritedSessionAgents: sessionAgents,
		agentId: id,
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** What main receives of `value` in one note: every note is its own structured clone. */
function note<T>(value: T): T {
	return structuredClone(value);
}

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		details: { exitCode: 0 },
		isError: false,
		timestamp,
	};
}

function textOf(message: AgentMessage | null | undefined): string {
	if (!message || !("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/**
 * For each message of the mirror's list, in order: whether an entry holds an equal message (same
 * persistence key, deep-equal; each entry taken once, in entry order) and, if so, whether the two
 * are one object.
 */
function sharing(remote: RemoteAgentSession): Array<"shared" | "copy" | "no equal entry"> {
	const held = remote.sessionManager.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
	let from = 0;
	return remote.messages.map(message => {
		const key = sessionMessagePersistenceKey(message);
		const at = held.findIndex(
			(candidate, index) =>
				index >= from &&
				key !== undefined &&
				sessionMessagePersistenceKey(candidate) === key &&
				Bun.deepEquals(candidate, message, true),
		);
		if (at < 0) return "no equal entry";
		from = at + 1;
		return held[at] === message ? "shared" : "copy";
	});
}

function messageEntryCount(remote: RemoteAgentSession): number {
	return remote.sessionManager.getEntries().filter(entry => entry.type === "message").length;
}

/** The text the `agent://` and `history://` readers serve for `id`, as a tool reads them. */
async function readerTexts(id: string): Promise<{ agent: string; history: string }> {
	const router = InternalUrlRouter.instance();
	const text = async (url: string): Promise<string> => {
		const { content } = await router.resolve(url);
		return typeof content === "string" ? content : content.toString("utf8");
	};
	return { agent: await text(`agent://${id}`), history: await text(`history://${id}`) };
}

describe("agent bridging across subagent workers", () => {
	it("mirrors a real worker-homed AgentSession on main: streaming, run state, events, messages", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { gated: true });
		const ref = liveRef("W1");
		const remote = mirrorOf(ref.session);
		expect(remote.instanceKey).toBe(key);
		expect(remote.home).toBe(worker.threadId);
		expect(key.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(worker.load).toBe(1);

		const runStates: string[] = [];
		cleanups.push(remote.subscribeRunState(state => runStates.push(state)));
		const events: string[] = [];
		cleanups.push(remote.subscribe(event => events.push(event.type)));

		const prompting = remote.prompt("hello from main");
		await waitFor(() => remote.isStreaming && ref.status === "running");
		expect(remote.runStartedAt).toBeNumber();

		await probe.openGate();
		expect(await prompting).toBe(true);
		await waitFor(() => !remote.isStreaming && ref.status === "idle");
		const roles = remote.messages.map(message => message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
		expect(remote.agent.state.messages).toBe(remote.messages);
		expect(remote.getSessionStats().assistantMessages).toBeGreaterThan(0);
		expect(runStates).toEqual(["running", "idle"]);
		expect(events).toContain("agent_end");
	}, 60_000);

	it("republishes the message mirror after a history rewrite that keeps both endpoints", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		// Watched, so the entries reach main too.
		watch(remote);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await waitFor(() => remote.messages.length >= 4);

		// Pruning rebuilds the runtime history with new interior content but the same first/last objects.
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");

		await waitFor(() => remote.messages.length >= 6);
		const interior = remote.messages[1];
		expect(interior?.role === "assistant" ? interior.content : undefined).toEqual([{ type: "text", text: "pruned" }]);
		// The replace builds the sharing again: a message equal to its entry is that entry's object. The pruned
		// one, which its entry no longer equals, has none.
		await waitFor(() => messageEntryCount(remote) >= 6);
		const shared = sharing(remote);
		expect({
			first: shared[0],
			pruned: shared[1],
			second: shared[2],
			third: shared[4],
			copies: shared.filter(state => state === "copy").length,
		}).toEqual({ first: "shared", pruned: "no equal entry", second: "shared", third: "shared", copies: 0 });
	}, 60_000);

	it("shares one object between a mirrored toolResult entry's message and the mirror's message, and keeps a restored-secret message separate", async () => {
		// If this regresses, main holds each message of a watched worker subagent twice, once in its message list
		// and once in its entry list, though the two are equal; or it shows the restored secret in the message list.
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		// Idle and unwatched: after a round trip to the worker, nothing but the notes below reaches the mirror.
		await probe.threadId();
		expect(remote.messages).toEqual([]);
		const base = Date.now();

		// The `messages` note first, then the `entries` note, as one publisher flush sends them.
		const first = toolResult("call-1", "first output", base);
		remote.applyMessages({ kind: "append", messages: [note(first)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e1", null, note(first))] });
		// The `entries` note first: the entry was recorded before its message reached the published list.
		const second = toolResult("call-2", "second output", base + 1);
		remote.applyEntries({ kind: "append", entries: [messageEntry("e2", "e1", note(second))] });
		remote.applyMessages({ kind: "append", messages: [note(second)] });
		// The entry of an assistant message shows its secret restored for display; the message keeps the placeholder.
		const secret = "sk-agents-bridge-secret-0042";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const masked: AssistantMessage = {
			...createAssistantMessage(`the key is ${obfuscator.obfuscate(secret)}`),
			timestamp: base + 2,
		};
		const shown: AssistantMessage = { ...masked, content: deobfuscateAssistantContent(obfuscator, masked.content) };
		remote.applyMessages({ kind: "append", messages: [note(masked)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e3", "e2", note(shown))] });

		const branch = remote.sessionManager
			.getBranch("e3")
			.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
		const [firstMessage, secondMessage, maskedMessage] = remote.messages;
		expect({
			messagesNoteFirst: branch[0] === firstMessage,
			entriesNoteFirst: branch[1] === secondMessage,
			restoredSecretShared: branch[2] === maskedMessage,
			entryShowsSecret: textOf(branch[2]).includes(secret),
			messageShowsSecret: textOf(maskedMessage).includes(secret),
		}).toEqual({
			messagesNoteFirst: true,
			entriesNoteFirst: true,
			restoredSecretShared: false,
			entryShowsSecret: true,
			messageShowsSecret: false,
		});
		expect(remote.messages.map(textOf)).toEqual(["first output", "second output", textOf(masked)]);
	}, 60_000);

	it("gives the same agent:// and history:// text for a worker subagent's messages before and after its mirror shares entry and message objects", async () => {
		// If this regresses, a watched worker subagent's mirror serves agent:// and history:// a message list its
		// sharing changed, as an entry's text in place of the unequal message a pruned turn left.
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");
		await waitFor(() => remote.messages.length >= 6);

		// Unwatched: main has no entries, so nothing can be shared yet.
		expect(messageEntryCount(remote)).toBe(0);
		const unshared = await readerTexts("W1");
		expect(unshared.history).toContain("pruned");
		expect(unshared.agent).toContain("Done");

		// A watch brings the entries, which the mirror may share with the equal messages it holds.
		const unwatch = watch(remote);
		await waitFor(() => messageEntryCount(remote) >= 6);
		expect(await readerTexts("W1")).toEqual(unshared);

		// A history replace while watched: the mirror builds its list again against the entries.
		unwatch();
		const before = remote.messages[1];
		await probe.rewriteInterior("W1", "pruned");
		watch(remote);
		await waitFor(() => remote.messages[1] !== before);
		expect(await readerTexts("W1")).toEqual(unshared);
	}, 60_000);

	it("shares a streamed message's object only once its final message arrives", async () => {
		// If this regresses, a watched worker subagent's finished reply stays in main twice (its entry and its
		// message), or its entry keeps the half-streamed text.
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		// After a round trip to the worker, nothing but the notes and events below reaches the mirror.
		await probe.threadId();
		const final: AssistantMessage = {
			...createAssistantMessage("Hello"),
			responseId: "resp-1",
			timestamp: Date.now(),
		};
		const partial: AssistantMessage = { ...final, content: [{ type: "text", text: "Hel" }] };

		// While it streams, the reply is only the mirror's stream message (the forwarded events).
		remote.applyEvent({ type: "message_start", message: note(partial) });
		remote.applyEvent({
			type: "message_update",
			message: note(partial),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial: note(partial) },
		});
		const streamed = remote.agent.state.streamMessage;
		expect(textOf(streamed)).toBe("Hel");
		// Then its final message, as the publisher sends it: the `messages` note and the `entries` note, ahead of
		// the forwarded `message_end`.
		remote.applyMessages({ kind: "append", messages: [note(final)] });
		remote.applyEntries({ kind: "append", entries: [messageEntry("e1", null, note(final))] });
		const [entry] = remote.sessionManager.getBranch("e1");
		const entryMessage = entry?.type === "message" ? entry.message : undefined;
		const message = remote.messages.at(-1);
		expect({
			streamedInEntries: entryMessage === streamed,
			streamedInMessages: message === streamed,
			entryText: textOf(entryMessage),
			messageText: textOf(message),
			finalShared: entryMessage === message,
		}).toEqual({
			streamedInEntries: false,
			streamedInMessages: false,
			entryText: "Hello",
			messageText: "Hello",
			finalShared: true,
		});
		remote.applyEvent({ type: "message_end", message: note(final) });
		expect(remote.agent.state.streamMessage).toBeNull();
	}, 60_000);

	it("fails a worker's registry CAS against a stale main ref generation", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const before = await probe.grab("W1");
		const registry = AgentRegistry.global();
		const replaced = registry.register({
			id: "W1",
			displayName: "W1",
			kind: "sub",
			session: liveRef("W1").session,
			status: "idle",
		});
		expect(replaced.generation).not.toBe(before);

		expect(await probe.cas("W1", "running")).toEqual({ grabbed: false, fresh: true, canonical: true });
		expect(registry.get("W1")?.status).toBe("running");
		expect(await probe.manages()).toBe(true);
	}, 60_000);

	it("keeps late worker activity out of a same-id replacement's peer roster entry", async () => {
		const { probe } = await startWorker();
		const registry = AgentRegistry.global();
		const runs: Promise<boolean>[] = [];
		const openRun = async () => {
			const key = await probe.open("W1", { gated: true, monitored: true });
			const ref = liveRef("W1");
			const remote = mirrorOf(ref.session);
			runs.push(remote.prompt("Inspect the task"));
			await waitFor(() => ref.status === "running" && remote.isStreaming);
			return key;
		};
		const activity = () => collectIrcPeerRoster(registry, "Main").peers.find(peer => peer.id === "W1")?.activity;
		try {
			const old = await openRun();
			await probe.toolCall(old, "grep");
			expect(activity()).toBe("running grep");
			const current = await openRun();
			await probe.toolCall(current, "read");
			expect(activity()).toBe("running read");
			const lastActivity = liveRef("W1").lastActivity;

			// Tool start flushes progress at once (no 150ms coalescing), so the worker sends
			// the tool's heartbeat and then the probe reply on the same port.
			await probe.toolCall(old, "bash");
			expect(activity()).toBe("running read");
			expect(liveRef("W1").lastActivity).toBe(lastActivity);
		} finally {
			await probe.openGate();
			await Promise.all(runs);
		}
	}, 60_000);

	it("lets a worker read a main-homed session through one canonical peer handle", async () => {
		const { probe } = await startWorker();
		const main = await mainSession("Main");
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: main,
			status: "running",
		});

		const report = await probe.peer("Main");
		expect(report).toEqual({
			isPeer: true,
			key: main.instanceKey,
			isStreaming: false,
			messageCount: 0,
			sessionFile: undefined,
			canonical: true,
			casBySession: true,
		});
		expect(liveRef("Main").status).toBe("idle");

		await probe.peerSubscribe("Main");
		expect(await probe.peerPrompt("Main", "hello from a worker")).toEqual({ accepted: true });
		expect(main.messages.map(message => message.role)).toContain("assistant");
		await waitFor(async () => {
			const seen = await probe.peerSeen();
			return seen.events.includes("agent_end") && seen.runStates.includes("idle");
		});
		expect((await probe.peerSeen()).runStates).toEqual(["running", "idle"]);
	}, 60_000);

	it("switches a worker-homed child to a granted model and applies viable effort on its next request", async () => {
		const [{ probe }, parent] = await Promise.all([
			startWorker(),
			mainSession("Parent", [
				{
					name: "m1",
					model: ["anthropic/claude-sonnet-4-6"],
					thinkingLevel: ThinkingLevel.Medium,
					description: "User-tagged model",
					systemPrompt: "",
					source: "bundled",
				},
			]),
		]);
		const registry = AgentRegistry.global();
		registry.register({ id: "Parent", displayName: "Parent", kind: "main", session: parent });
		await probe.open("Parent.Child", { parentId: "Parent", parentSessionKey: parent.instanceKey });
		const remote = mirrorOf(liveRef("Parent.Child").session);
		registry.register({
			id: "Foreign",
			displayName: "Foreign",
			kind: "sub",
			parentId: "Parent",
			parentSessionKey: "old-parent",
			session: remote,
		});

		let spawns = "task";
		cfgTaskAgentModelOverrides.override(parent.settings, { task: "anthropic/claude-sonnet-4-5" });
		const write = new WriteTool({
			cwd: parent.sessionManager.getCwd(),
			hasUI: false,
			settings: parent.settings,
			getSessionFile: () => parent.sessionFile ?? null,
			getSessionSpawns: () => spawns,
			getSessionAgents: () => parent.getSessionAgents(),
			getAgentId: () => "Parent",
			getAgentSession: () => parent,
			agentRegistry: registry,
		});
		const set = (path: string, content: string) => write.execute("control", { path: `agent://${path}`, content });

		await expect(set("Parent.Child/model", "m1:max")).rejects.toThrow("Allowed: task");
		await expect(set("Foreign/effort", "high")).rejects.toThrow("only yourself or a direct child");
		expect(remote.model?.id).toBe("claude-sonnet-4-5");

		spawns = "task,m1";
		const model = await set("Parent.Child/model", "m1:max");
		expect(model.content[0]).toMatchObject({
			text: expect.stringContaining("anthropic/claude-sonnet-4-6 (effort: high)"),
		});
		const effort = await set("Parent.Child/effort", "minimal");
		expect(effort.content[0]).toMatchObject({
			text: expect.stringContaining("anthropic/claude-sonnet-4-6 (effort: low)"),
		});
		expect(await probe.prompt("Parent.Child", "Check the settings for this turn")).toEqual({
			model: "claude-sonnet-4-6",
			effort: ThinkingLevel.Low,
		});
		await set("Parent.Child/model", "task:off");
		expect(remote.model?.id).toBe("claude-sonnet-4-5");
		expect(remote.thinkingLevel).toBe(ThinkingLevel.Off);
	}, 60_000);

	it("delivers an IRC message from main into a worker-homed session", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);

		const receipt = await IrcBus.global().send({ from: "Main", to: "W1", body: "ping from main" });
		expect(["injected", "woken"]).toContain(receipt.outcome);
		await waitFor(async () => (await probe.localCustomTypes("W1")).includes("irc:incoming"));
		await waitFor(() =>
			remote.messages.some(message => message.role === "custom" && message.customType === "irc:incoming"),
		);
	}, 60_000);

	it("detaches refs and rejects in-flight commands when the worker dies", async () => {
		const { worker, probe } = await startWorker();
		await probe.open("Parked", { sessionFile: "/tmp/agents-bridge-parked.jsonl", gated: true });
		await probe.open("Lost", {});
		await probe.adopt("Parked");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("Parked"));
		const parked = liveRef("Parked");
		const lost = liveRef("Lost");
		const remote = mirrorOf(parked.session);

		const pending = remote.prompt("never answered");
		await waitFor(() => remote.isStreaming);
		worker.terminate("killed by test");

		await expect(pending).rejects.toThrow(worker.threadId);
		expect(remote.closed).toBe(true);
		expect(parked.session).toBeNull();
		expect(parked.status).toBe("parked");
		expect(lost.session).toBeNull();
		expect(lost.status).toBe("aborted");
		// The adoption (and its release hook) survives; only the dead worker's warm reviver is gone.
		expect(lifecycle.has("Parked")).toBe(true);
		await expect(lifecycle.ensureLive("Parked")).rejects.toThrow("no reviver registered");
		await expect(remote.prompt("again")).rejects.toThrow(worker.threadId);
		await remote.dispose();
	}, 60_000);

	it("parks a worker-homed session and warm-revives it through the worker's reviver", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { sessionFile: "/tmp/agents-bridge-revive.jsonl" });
		await probe.adopt("W1");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("W1"));
		const ref = liveRef("W1");
		const first = mirrorOf(ref.session);

		await lifecycle.park("W1");
		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
		expect(first.closed).toBe(true);
		expect(await probe.disposed(key)).toBe(true);

		const revived = mirrorOf(await lifecycle.ensureLive("W1"));
		expect(revived).not.toBe(first);
		expect(revived.instanceKey.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(liveRef("W1").session).toBe(revived);
		expect(liveRef("W1").status).toBe("idle");
		expect(worker.load).toBe(1);
	}, 60_000);
});
