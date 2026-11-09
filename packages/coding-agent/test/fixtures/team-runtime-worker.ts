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
import type { TeamIdentity } from "../../src/task/team-runtime";
import type { TeamClaimResult } from "../../src/task/team-ledger";
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

export interface TeamProbe {
	open(id: string): Promise<string>;
	start(key: string, team: TeamDefinition): Promise<{ generation: number; leadId: string }>;
	claim(key: string, identity: TeamIdentity, id: string): Promise<TeamClaimResult>;
}
export interface TeamProbeGlobals {
	ready(probe: TeamProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");
const sessions = new Map<string, AgentSession>();
const probe: TeamProbe = {
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
	start: (key, team) => getTeamClient().start(key, team),
	claim: (key, identity, id) => getTeamClient().claim(key, identity, id),
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
