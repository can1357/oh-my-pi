import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { registerExternalAgent } from "../../src/registry/external-agents";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { collectIrcPeerRoster } from "../../src/task/executor";
import { cfgTaskAgentModelOverrides } from "../../src/task/settings";
import type { AgentDefinition } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import { resolveArtifactSpillThreshold } from "../../src/tools/output-meta";
import { WriteTool } from "../../src/tools/write";
import type { AgentsProbe, AgentsProbeGlobals } from "../fixtures/agents-bridge-worker";

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function startWorker(): Promise<{ worker: SubagentWorker; probe: AgentsProbe }> {
	const probe = Promise.withResolvers<AgentsProbe>();
	const probeService: ThreadService = {
		name: "agents-probe",
		globals: (): AgentsProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/agents-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 60_000,
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
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		inheritedSessionAgents: sessionAgents,
		agentId: id,
	});
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
	});
	return session;
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
		remote.subscribeRunState(state => runStates.push(state));
		const events: string[] = [];
		remote.subscribe(event => events.push(event.type));

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
	});

	it("republishes the message mirror after a history rewrite that keeps both endpoints", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await waitFor(() => remote.messages.length >= 4);

		// Pruning rebuilds the runtime history with new interior content but the same first/last objects.
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");

		await waitFor(() => remote.messages.length >= 6);
		const interior = remote.messages[1];
		expect(interior?.role === "assistant" ? interior.content : undefined).toEqual([{ type: "text", text: "pruned" }]);
	});

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
	});

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
	});

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
	});

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
	}, 20_000);

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
	});

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
	});

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
	});

	it("settles an external agent registered through a worker's registry proxy", async () => {
		const { probe } = await startWorker();
		const ref = liveRef(await probe.settleExternal());
		expect(ref.status).toBe("idle");
		expect(ref.external?.steer).toBeUndefined();
	});

	it("reads a main-registered external agent's transcript from a worker, also after it settled", async () => {
		const { probe } = await startWorker();
		const transcript = `${JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "final answer" }], timestamp: 0 } })}\n`;
		const agent = registerExternalAgent(
			{
				registry: AgentRegistry.global(),
				jobs: new AsyncJobManager({}),
				ownerId: "Main",
				emitFrame: () => {},
				resultCap: { maxBytes: resolveArtifactSpillThreshold(undefined) },
			},
			{
				label: "remote run",
				execution: { backend: "queue", jobId: "q-1" },
				readTranscript: async fromByte => ({ text: transcript.slice(fromByte), newSize: transcript.length }),
			},
		);

		expect(await probe.readUrl(`agent://${agent.id}`)).toContain("final answer");
		agent.complete({ status: "done", text: "remote result" });
		expect(await probe.readUrl(`history://${agent.id}`)).toContain("final answer");
	});
});
