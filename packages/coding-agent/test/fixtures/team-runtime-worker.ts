import { MessagePort, parentPort } from "node:worker_threads";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import type { TeamClaimResult } from "../../src/task/team-ledger";
import type { TeamIdentity, TeamStopResponse } from "../../src/task/team-runtime";
import type { TeamDefinition } from "../../src/task/teams";
import { loadedModulesChangedSince } from "../../src/thread/code-skew";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { RpcLink, type RpcFrame } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { teamThreadService } from "../../src/thread/services/team";
import { getTeamClient } from "../../src/thread/services/team-client";
import { BUILTIN_TEAMS_SLASH_COMMANDS } from "../../src/slash-commands/builtin-teams";
import type { ToolSession } from "../../src/tools";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";

export interface TeamProbe {
	open(id: string): Promise<string>;
	start(key: string, team: TeamDefinition): Promise<{ generation: number; leadId: string }>;
	claim(key: string, identity: TeamIdentity, id: string): Promise<TeamClaimResult>;
	putMember(key: string, generation: number, memberId: string): Promise<boolean>;
	respondStop(key: string, identity: TeamIdentity, requestId: string, body: string): Promise<TeamStopResponse>;
	planPending(key: string, identity: TeamIdentity): Promise<boolean>;
	submitPlan(key: string, identity: TeamIdentity, text: string): Promise<void>;
	/** Approve a member plan through the worker→main team client, optionally pinned to a revision. */
	approve(key: string, handle: string, revision?: number): Promise<void>;
	memberIdentity(key: string, team: string, generation: number, handle: string): Promise<TeamIdentity>;
	command(key: string, cwd: string, args: string): Promise<string>;
	beforeInstall(): Promise<string>;
	/** Settle a worker-hosted member's finished turn through the worker→main registry RPC. */
	runTurn(id: string): Promise<boolean>;
	/**
	 * Open a gated member session in this worker: `identity` is installed on
	 * its tool session, and `gate(name)` drives the real AgentSession gate
	 * (worker-local `beforeToolCall` → `getTeamClient().planPending` over the
	 * worker→main RPC link). Returns `{ blocked, error }`: `error` is the
	 * serialized rejection `planPending` threw across RPC, if any.
	 */
	openGated(id: string, identity: TeamIdentity): Promise<string>;
	gate(
		key: string,
		name: string,
	): Promise<{
		blocked: boolean;
		error?: { message: string; code?: unknown };
	}>;
}
export interface TeamProbeGlobals {
	ready(probe: TeamProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");
const sessions = new Map<string, AgentSession>();
let beforeInstall = "";
const gated = new Map<string, { session: AgentSession; toolSession: { teamIdentity?: TeamIdentity } }>();
let lastGateError: Error | undefined;
const probe: TeamProbe = {
	async beforeInstall() {
		return beforeInstall;
	},
	async open(id) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const auth = await AuthStorage.create(":memory:");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
			agentId: id,
		});
		sessions.set(id, session);
		AgentRegistry.global().register({ id, displayName: id, kind: "sub", session });
		return session.instanceKey;
	},
	async openGated(id, identity) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const auth = await AuthStorage.create(":memory:");
		const toolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			teamIdentity: identity,
		} as unknown as ToolSession;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
			agentId: id,
			evalToolSession: toolSession,
			toolRegistry: new Map(),
		});
		gated.set(session.instanceKey, { session, toolSession });
		sessions.set(id, session);
		AgentRegistry.global().register({ id, displayName: id, kind: "sub", session });
		return session.instanceKey;
	},
	async gate(key, name) {
		const entry = gated.get(key);
		if (!entry) throw new Error("gated session missing");
		const { session } = entry;
		// Record the rejection that crosses the worker→main RPC while the real
		// gate runs: the pass-through wrapper sees exactly what #teamPlanGate sees.
		const client = getTeamClient();
		const inner = client.planPending.bind(client);
		lastGateError = undefined;
		client.planPending = async (sessionKey, identity) => {
			try {
				return await inner(sessionKey, identity);
			} catch (error) {
				lastGateError = error instanceof Error ? error : new Error(String(error));
				throw error;
			}
		};
		try {
			const model = session.agent.state.model!;
			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const tool: AgentTool = {
				name,
				label: name,
				description: name,
				parameters: type({}),
				async execute() {
					return { content: [{ type: "text", text: name }] };
				},
			};
			const args: Record<string, unknown> = {};
			const result = await session.agent.beforeToolCall!({
				tool,
				args,
				assistantMessage,
				context: session.agent.state,
				toolCall: { type: "toolCall", id: crypto.randomUUID(), name, arguments: args },
			});
			const captured = lastGateError as Error | undefined;
			return {
				blocked: result?.block === true,
				error: captured && {
					message: captured.message,
					code: Reflect.get(captured, "code"),
				},
			};
		} finally {
			client.planPending = inner;
		}
	},
	start: (key, team) => getTeamClient().start(key, team),
	claim: (key, identity, id) => getTeamClient().claim(key, identity, id),
	respondStop: (key, identity, requestId, body) => getTeamClient().respondStop(key, identity, requestId, body),
	planPending: (key, identity) => getTeamClient().planPending(key, identity),
	submitPlan: (key, identity, text) => getTeamClient().submitPlan(key, identity, text),
	approve: (key, handle, revision) => getTeamClient().approve(key, handle, revision),
	memberIdentity: (key, team, generation, handle) => getTeamClient().memberIdentity(key, team, generation, handle),
	async putMember(key, generation, memberId) {
		const ref = AgentRegistry.global().get(memberId);
		if (!ref) throw new Error("member missing");
		return getTeamClient().putMember(key, "audit", generation, memberId, null, {
			id: memberId,
			reservation: "worker-test",
			ref: { ...ref },
		});
	},
	async command(key, cwd, args) {
		const session = [...sessions.values()].find(value => value.instanceKey === key);
		if (!session) throw new Error("session missing");
		const outputs: string[] = [];
		const handle = BUILTIN_TEAMS_SLASH_COMMANDS[0]!.handle as unknown as (
			command: { args: string },
			runtime: unknown,
		) => Promise<void>;
		await handle(
			{ args },
			{
				session,
				settings: Settings.isolated({ "team.enabled": true }),
				sessionManager: { getCwd: () => cwd },
				output: (text: string) => outputs.push(text),
			},
		);
		return outputs.join("\n");
	},
	async runTurn(id) {
		// Drive the settle from the worker through the real registry proxy:
		// markTurnSettled's callSync crosses worker→main RPC, main's registry
		// emits `final: true`, and main's team runtime sends the notice. The
		// ref is flipped idle first, as a finished member turn leaves it.
		const registry = AgentRegistry.global();
		const ref = registry.get(id);
		if (!ref) throw new Error("member missing");
		registry.setStatus(id, "idle", ref);
		return registry.markTurnSettled(id, ref);
	},
};
const probeService: ThreadService = {
	name: "team-probe",
	boot(globals) {
		if (typeof globals !== "object" || globals === null || typeof Reflect.get(globals, "ready") !== "function")
			throw new Error("probe globals missing");
		(globals as TeamProbeGlobals).ready(probe);
	},
};
const services = [identityThreadService, agentsThreadService, teamThreadService, probeService];
let frameHandler: ((frame: RpcFrame) => void) | undefined;
port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (
			typeof message !== "object" ||
			message === null ||
			Reflect.get(message, "type") !== "subagent-worker-init" ||
			!isThreadId(Reflect.get(message, "threadId")) ||
			!(Reflect.get(message, "replyPort") instanceof MessagePort) ||
			!(Reflect.get(message, "counter") instanceof SharedArrayBuffer)
		)
			return;
		const init = message as SubagentWorkerInit;
		setCurrentThreadId(init.threadId);
		try {
			getTeamClient();
			beforeInstall = "unexpected client";
		} catch (error) {
			beforeInstall = error instanceof Error ? error.message : String(error);
		}
		const link: WorkerThreadLink = new RpcLink(
			{
				send: frame => port.postMessage(frame),
				listen: handler => {
					frameHandler = handler;
					return () => {
						frameHandler = undefined;
					};
				},
			},
			{ name: `${init.threadId}↔main`, sync: { port: init.replyPort, counter: new Int32Array(init.counter) } },
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = {
			type: "subagent-worker-ready",
			changedModules: loadedModulesChangedSince(init.mainStartedAt),
		};
		port.postMessage(ready);
		return;
	}
	if (typeof message === "object" && message !== null && typeof Reflect.get(message, "t") === "string")
		frameHandler(message as RpcFrame);
});
