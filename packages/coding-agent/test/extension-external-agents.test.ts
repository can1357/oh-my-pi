import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext, ExternalAgentSpec } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { RpcSubagentRegistry, readRpcExternalTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { getRunningSubagentBadgeAgentIds } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/running-subagent-badge";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type ExternalTranscriptPage } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncResultEntry } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { AgentTranscriptViewerModel } from "@oh-my-pi/pi-coding-agent/ui/overlays/panels/agent-transcript-viewer-model";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { untrack } from "@oh-my-pi/pi-tui";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { until } from "./helpers/fake-clock";

// Extensions that drive agents elsewhere (a remote host, a job queue) register them so the
// session shows, waits on, messages and cancels them like its own subagents.
describe("ExtensionContext.agents.registerExternal", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let subagentEventBus: EventBus;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		tempDir = path.join(os.tmpdir(), `pi-ext-external-agents-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		subagentEventBus = new EventBus();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	async function extensionContext(): Promise<ExtensionContext> {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		let seen: ExtensionContext | undefined;
		({ session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			subagentEventBus,
			disableExtensionDiscovery: true,
			extensions: [
				pi => {
					pi.on("before_agent_start", (_event, ctx) => {
						seen = ctx;
					});
				},
			],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		}));
		await session!.extensionRunner!.emitBeforeAgentStart("hi", undefined, []);
		return seen!;
	}

	function remoteAgent(overrides: Partial<ExternalAgentSpec> = {}): ExternalAgentSpec {
		return {
			label: "port the parser",
			execution: {
				backend: "queue",
				jobId: "job-7",
				machine: "gpu-1",
				model: "anthropic/claude-x",
				thinking: "high",
			},
			readTranscript: async fromByte => ({ text: "", newSize: fromByte }),
			...overrides,
		};
	}

	function toolSession(): ToolSession {
		return {
			cwd: tempDir,
			hasUI: false,
			settings: Settings.isolated({ "launch.enabled": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: session!.asyncJobManager,
		} as unknown as ToolSession;
	}

	it("lists the agent in the registry, the running-agent roster and RPC subagent channels", async () => {
		const ctx = await extensionContext();
		const rpc = new RpcSubagentRegistry(subagentEventBus, () => {});
		const agent = ctx.agents!.registerExternal(remoteAgent());
		const registry = AgentRegistry.global();

		expect(registry.get(agent.id)).toMatchObject({
			kind: "external",
			displayName: "port the parser",
			status: "running",
			session: null,
			execution: { backend: "queue", jobId: "job-7", machine: "gpu-1" },
			history: { resolvedModel: "anthropic/claude-x:high" },
		});
		expect(getRunningSubagentBadgeAgentIds(registry)).toEqual([agent.id]);
		expect(rpc.getSubagents()).toMatchObject([
			{ id: agent.id, agent: "queue@gpu-1", description: "port the parser", status: "running" },
		]);

		agent.update({ status: "idle", model: "openai/gpt-y", progress: "waiting for review" });
		expect(registry.get(agent.id)).toMatchObject({ status: "idle", history: { resolvedModel: "openai/gpt-y:high" } });
		expect(rpc.getSubagents()[0]?.progress).toMatchObject({
			status: "completed",
			resolvedModel: "openai/gpt-y:high",
			lastIntent: "waiting for review",
		});
		rpc.dispose();
	});

	it("serves its transcript to RPC subagent clients, also after it finished", async () => {
		const ctx = await extensionContext();
		const rpc = new RpcSubagentRegistry(subagentEventBus, () => {});
		const line = `${JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: "hello", timestamp: 0 } })}\n`;
		const size = Buffer.byteLength(line);
		const agent = ctx.agents!.registerExternal(
			remoteAgent({
				readTranscript: async fromByte => ({
					text: line,
					newSize: size,
					...(fromByte === 0 ? {} : { reset: true }),
				}),
			}),
		);
		agent.complete({ status: "done", text: "ok" });
		const external = rpc.resolveExternalTranscript(agent.id)!;

		expect(await readRpcExternalTranscript(external, 0)).toMatchObject({
			fromByte: 0,
			nextByte: size,
			reset: false,
			messages: [{ role: "user", content: "hello" }],
		});
		expect(await readRpcExternalTranscript(external, size)).toMatchObject({
			fromByte: 0,
			nextByte: size,
			reset: true,
			messages: [{ role: "user", content: "hello" }],
		});
		rpc.dispose();
	});

	it("pages the transcript viewer through readTranscript and replaces what it read on a reset", async () => {
		const ctx = await extensionContext();
		const entry = (id: string, text: string): string =>
			`${JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message: { role: "user", content: text, timestamp: 0 } })}\n`;
		const modelChange = (id: string, model: string): string =>
			`${JSON.stringify({ type: "model_change", id, parentId: null, timestamp: new Date(0).toISOString(), model })}\n`;
		const first = modelChange("m1", "openai/model-a") + entry("a", "first") + entry("b", "second");
		const rebuilt = modelChange("m2", "openai/model-b") + entry("c", "rebuilt");
		const pages: ExternalTranscriptPage[] = [
			{ text: first, newSize: Buffer.byteLength(first) },
			{ text: rebuilt, newSize: Buffer.byteLength(rebuilt), reset: true },
		];
		const reads: number[] = [];
		const agent = ctx.agents!.registerExternal(
			remoteAgent({
				readTranscript: async fromByte => {
					reads.push(fromByte);
					return pages.shift() ?? { text: "", newSize: fromByte };
				},
			}),
		);
		const viewer = new AgentTranscriptViewerModel({
			agentId: agent.id,
			transcript: agentTranscriptSource,
			registry: AgentRegistry.global(),
			terminalRows: () => 40,
			expandKeys: [],
			hubKeys: [],
			onClose: () => {},
			onHubClose: () => {},
			pollMs: 60_000,
		});
		const shown = (): string[] =>
			untrack(viewer.blocks).map(block => (block.kind === "user" ? block.text : block.kind));

		await until(() => shown().length === 2, "first page");
		expect(shown()).toEqual(["first", "second"]);
		expect(viewer.model).toBe("openai/model-a");
		viewer.poll();
		await until(() => shown()[0] === "rebuilt", "reset page");
		expect(shown()).toEqual(["rebuilt"]);
		// The rebuilt transcript's model_change names the model shown.
		expect(viewer.model).toBe("openai/model-b");
		viewer.poll();
		await until(() => reads.length === 3, "read after the reset");
		expect(reads).toEqual([0, Buffer.byteLength(first), Buffer.byteLength(rebuilt)]);
		viewer.dispose();
	});

	it("reads its whole transcript for agent://<id>, page by page", async () => {
		const ctx = await extensionContext();
		const reply = (id: string, text: string): string =>
			`${JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date(0).toISOString(), message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } })}\n`;
		const transcript = reply("a", "first draft") + reply("b", "final answer");
		// One line per page, like an extension that caps its page size.
		const agent = ctx.agents!.registerExternal(
			remoteAgent({
				readTranscript: async fromByte => {
					const end = transcript.indexOf("\n", fromByte) + 1 || fromByte;
					return { text: transcript.slice(fromByte, end), newSize: end };
				},
			}),
		);

		const progress = await new AgentProtocolHandler().resolve(new URL(`agent://${agent.id}`) as never);
		expect(progress.content).toContain("final answer");
	});

	it("fails a read of agent://<id> on a transcript error its extension returns", async () => {
		const ctx = await extensionContext();
		const agent = ctx.agents!.registerExternal(
			remoteAgent({ readTranscript: async () => ({ text: "", newSize: 0, error: "job purged" }) }),
		);

		await expect(new AgentProtocolHandler().resolve(new URL(`agent://${agent.id}`) as never)).rejects.toThrow(
			"job purged",
		);
	});

	it("blocks wait until complete() and delivers the result once", async () => {
		const ctx = await extensionContext();
		const injected: AsyncResultEntry[] = [];
		const enqueue = session!.yieldQueue.enqueueWithReceipt.bind(session!.yieldQueue);
		vi.spyOn(session!.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			if (kind === "async-result") injected.push(entry as AsyncResultEntry);
			return enqueue(kind, entry);
		});
		const agent = ctx.agents!.registerExternal(remoteAgent());
		let returned = false;
		const waiting = new WaitTool(toolSession()).execute("wait", {}).finally(() => {
			returned = true;
		});

		await until(() => AgentRegistry.global().awaits.blocksOn("Main", agent.id, 0), "wait blocking on the agent");
		expect(returned).toBe(false);
		agent.complete({ status: "done", text: "PARSER PORTED" });
		agent.complete({ status: "failed", text: "late duplicate" });
		const text = (await waiting).content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain("PARSER PORTED");
		expect(text).not.toContain("late duplicate");
		await session!.asyncJobManager!.drainDeliveries({ timeoutMs: 1_000 });
		expect(injected).toEqual([]);
		expect(AgentRegistry.global().get(agent.id)?.status).toBe("idle");
	});

	it("calls cancel when its job is cancelled or the Agent Hub kills it", async () => {
		const ctx = await extensionContext();
		const cancelled: string[] = [];
		const byJob = ctx.agents!.registerExternal(remoteAgent({ cancel: async () => void cancelled.push("job") }));
		const byHub = ctx.agents!.registerExternal(remoteAgent({ cancel: async () => void cancelled.push("hub") }));
		const registry = AgentRegistry.global();

		expect(session!.cancelAsyncJob(byJob.id)).toBe(true);
		await AgentLifecycleManager.global().release(byHub.id, registry.get(byHub.id), { tombstone: true });
		await session!.asyncJobManager!.waitForAll();
		expect(cancelled.sort()).toEqual(["hub", "job"]);
		for (const { id } of [byJob, byHub]) {
			expect(registry.get(id)?.status).toBe("aborted");
			expect(session!.asyncJobManager!.getJob(id)?.status).toBe("cancelled");
		}
		expect(session!.asyncJobManager!.hasPendingDeliveries({ ownerId: "Main" })).toBe(false);
	});

	it("routes agent:// writes to steer: a steer while it runs, a follow-up once idle", async () => {
		const ctx = await extensionContext();
		const steered: Array<[string, string]> = [];
		const agent = ctx.agents!.registerExternal(
			remoteAgent({ steer: async (text, mode) => void steered.push([text, mode]) }),
		);
		const write = new WriteTool(toolSession());

		const sent = await write.execute("send", { path: `agent://${agent.id}`, content: "use the v2 grammar" });
		expect(sent.content).toEqual([{ type: "text", text: `Delivered to ${agent.id}.` }]);
		agent.update({ status: "idle" });
		await write.execute("send", { path: `agent://${agent.id}`, content: "add tests too" });
		expect(steered).toEqual([
			["use the v2 grammar", "steer"],
			["add tests too", "follow_up"],
		]);
	});

	it("refuses messages once complete() settled it", async () => {
		const ctx = await extensionContext();
		const steered: string[] = [];
		const agent = ctx.agents!.registerExternal(remoteAgent({ steer: async text => void steered.push(text) }));
		agent.complete({ status: "done", text: "ok" });

		const sent = await new WriteTool(toolSession()).execute("send", {
			path: `agent://${agent.id}`,
			content: "one more thing",
		});
		expect(sent.isError).toBe(true);
		expect(steered).toEqual([]);
	});

	it("gives an agent registered from an advisor-scoped context to the session's agent", async () => {
		await extensionContext();
		const advisorCtx = session!.extensionRunner!.createContext(undefined, undefined, {
			kind: "sub",
			id: "advisor",
			name: "advisor",
			depth: 0,
			parentId: "Main",
		});
		const agent = advisorCtx.agents!.registerExternal(remoteAgent());

		expect(AgentRegistry.global().get(agent.id)?.parentId).toBe("Main");
		expect(session!.asyncJobManager!.getJob(agent.id)).toMatchObject({
			type: "extension",
			ownerId: "Main",
			agentId: agent.id,
		});
	});

	it("parks the agent on session shutdown without cancelling the remote work", async () => {
		const ctx = await extensionContext();
		let cancelled = false;
		const agent = ctx.agents!.registerExternal(
			remoteAgent({
				cancel: async () => {
					cancelled = true;
				},
			}),
		);

		await session!.dispose();
		session = undefined;
		expect(cancelled).toBe(false);
		expect(AgentRegistry.global().get(agent.id)?.status).toBe("parked");
	});
});
