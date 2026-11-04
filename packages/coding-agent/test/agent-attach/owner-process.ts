import { EventBus } from "../../src/utils/event-bus";
import type { AgentSession } from "../../src/session/agent-session";
import type { AgentViewSession } from "../../src/session/agent-session-handle";
import type { AgentRef, AgentRegistryApi } from "../../src/registry/agent-registry";
import { startAgentAttachService } from "../../src/agent-attach/service";
import { TASK_SUBAGENT_ATTACH_CHANNEL } from "../../src/agent-attach/protocol";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { createInterface } from "node:readline";

const ownerSessionId = process.env.OMP_ATTACH_OWNER_ID ?? "owner-smoke";
const agentId = process.env.OMP_ATTACH_AGENT_ID ?? "AgentSmoke";
const sessionInstanceKey = "fixture-child-instance";
const sessionFile = `${process.cwd()}/child-session.jsonl`;
const messages = [
	{ role: "user", content: [{ type: "text", text: "attach transcript fixture" }], timestamp: Date.now() },
];
const steered: string[] = [];
const sessionListeners = new Set<(event: { type: string }) => void>();
let aborted = false;
let snapshotCalls = 0;

const childSession = {
	instanceKey: sessionInstanceKey,
	sessionManager: {
		getSessionId: () => "child-session",
		getSessionFile: () => sessionFile,
		getCwd: () => process.cwd(),
	},
	agent: {
		state: { streamMessage: null },
		getPendingToolResults: () => [],
	},
	model: null,
	isStreaming: false,
	runStartedAt: undefined,
	subscribe(listener: (event: { type: string }) => void) {
		sessionListeners.add(listener);
		return () => sessionListeners.delete(listener);
	},
	subscribeRunState() {
		return () => {};
	},
	async settleInFlightMessagePersistence() {},
	buildTranscriptSessionContext() {
		snapshotCalls++;
		return { messages };
	},
	activeToolExecutionUpdates: () => [],
	getSessionStats: () => ({}),
	getQueuedMessages: () => ({ steering: [], followUp: [], liveSteered: 0 }),
	async steer(text: string) {
		steered.push(text);
	},
	async abort() {
		aborted = true;
	},
	async prompt(text: string) {
		steered.push(text);
		for (const listener of sessionListeners) listener({ type: "agent_start" });
		return true;
	},
} as unknown as AgentViewSession;

const ref = {
	id: agentId,
	kind: "sub",
	status: "running",
	generation: 7,
	displayName: "Attach fixture",
	sessionFile,
	session: childSession,
} as unknown as AgentRef;
const refs = new Map<string, AgentRef>();
const registryListeners = new Set<(event: { type: string; ref: AgentRef }) => void>();
const registry = {
	get: (id: string) => refs.get(id),
	onChange(listener: (event: { type: string; ref: AgentRef }) => void) {
		registryListeners.add(listener);
		return () => registryListeners.delete(listener);
	},
} as unknown as AgentRegistryApi;
const ownerSession = {
	sessionManager: {
		getSessionId: () => ownerSessionId,
	},
	registerSessionChangeCallback() {
		return () => {};
	},
	emitNotice: () => {},
} as unknown as AgentSession;
const eventBus = new EventBus();
const subagentEventBus = new EventBus();
let available: unknown;
eventBus.on(TASK_SUBAGENT_ATTACH_CHANNEL, payload => {
	available = payload;
});

const service = await startAgentAttachService({ session: ownerSession, registry, eventBus, subagentEventBus });
refs.set(agentId, ref);
subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
	id: agentId,
	status: "started",
	sessionInstanceKey,
	sessionFile,
});
process.stdout.write(`${JSON.stringify({ type: "ready", ownerSessionId, agentId, available })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
	if (line === "state") {
		process.stdout.write(
			`${JSON.stringify({ type: "state", status: ref.status, steered, aborted, snapshotCalls })}\n`,
		);
	} else if (line === "clear-aborted") {
		aborted = false;
		process.stdout.write(
			`${JSON.stringify({ type: "state", status: ref.status, steered, aborted, snapshotCalls })}\n`,
		);
	} else if (line === "idle" || line === "running") {
		ref.status = line;
		for (const listener of registryListeners) listener({ type: "status_changed", ref });
		process.stdout.write(
			`${JSON.stringify({ type: "state", status: ref.status, steered, aborted, snapshotCalls })}\n`,
		);
	} else if (line === "end") {
		subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: agentId,
			status: "aborted",
			sessionInstanceKey,
			sessionFile,
		});
		ref.status = "aborted";
		for (const listener of registryListeners) listener({ type: "status_changed", ref });
		process.stdout.write(`${JSON.stringify({ type: "ended", status: ref.status })}\n`);
	} else if (line === "close") {
		await service.close();
		process.stdin.destroy();
		break;
	}
}
