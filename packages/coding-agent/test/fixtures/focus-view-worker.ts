/**
 * Subagent worker entry for the focus-view tests: the real link wiring of
 * `subagent-worker-entry` with the identity, agents and auth services, plus a
 * probe service that hands the test functions driving real `AgentSession`s
 * homed on this worker. Sessions are built over the main thread's model
 * registry (its worker mirror); a turn prompted with `[hold]` streams its
 * reply in two deltas, holding between them until the test opens the gate.
 */
import { MessagePort, parentPort } from "node:worker_threads";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, TextContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { authService } from "../../src/thread/services/auth";
import { identityThreadService } from "../../src/thread/services/identity";
import { getApprovalGrants } from "../../src/tools/approval-cache";

/** What the worker-side session reports about itself. */
export interface FocusSessionReport {
	configuredThinkingLevel: string | undefined;
	steering: string[];
	followUp: string[];
	customEntries: Array<{ customType: string; data: unknown }>;
	userTexts: string[];
	todoPhases: TodoPhase[];
}

/** Operations the test drives on the worker. */
export interface FocusProbe {
	/** Build, register, and return the key of a session homed here, over main's `registry`. */
	open(id: string, registry: ModelRegistry, settings: Record<string, unknown>): Promise<string>;
	/** Prompt the session on its home thread; resolves when the run settles. */
	prompt(id: string, text: string): Promise<void>;
	/** Release the reply held between its two deltas. */
	release(): Promise<void>;
	report(id: string): Promise<FocusSessionReport>;
	/** Approve approval scope `key` for the rest of the session, as its extension wrapper does. */
	grantSessionApproval(id: string, key: string): Promise<void>;
	/** Remember `always-ask-cached` grant `key` in the session's conversation tier. */
	recordSessionGrant(id: string, key: string): Promise<void>;
	/** Drop every queued follow-up for good, as queue editing does. */
	dropFollowUps(id: string): Promise<void>;
}

/** Test-only boot globals of the probe service. */
export interface FocusProbeGlobals {
	ready(probe: FocusProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const sessions = new Map<string, AgentSession>();
let gate = Promise.withResolvers<void>();

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A turn whose newest user message says `[hold]` streams "Hel", holds for the gate, then "lo"; others answer "ok". */
function heldStream(model: Model<Api>, context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const lastUser = context.messages.findLast(message => message.role === "user");
	const hold = textOf(lastUser?.content).includes("[hold]");
	void (async () => {
		const text: TextContent = { type: "text", text: "" };
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		partial.content.push(text);
		stream.push({ type: "text_start", contentIndex: 0, partial });
		if (hold) {
			text.text = "Hel";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Hel", partial });
			await gate.promise;
			text.text = "Hello";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial });
		} else {
			text.text = "ok";
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial });
		}
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
		partial.duration = 10;
		stream.push({ type: "done", reason: "stop", message: partial });
	})();
	return stream;
}

function local(id: string): AgentSession {
	const session = sessions.get(id);
	if (!session) throw new Error(`no local session ${id}`);
	return session;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

const probe: FocusProbe = {
	open: async (id, registry, overrides) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Focus fixture"], tools: [] },
			convertToLlm,
			streamFn: heldStream,
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(overrides),
			modelRegistry: registry,
			extensionRunner: new ExtensionRunner([], new ExtensionRuntime(), process.cwd(), sessionManager, registry),
			agentId: id,
		});
		sessions.set(id, session);
		AgentRegistry.global().register({ id, displayName: id, kind: "sub", session, sessionFile: null, status: "idle" });
		AgentRegistry.global().syncSessionStatus(id, session);
		return session.instanceKey;
	},
	prompt: async (id, text) => {
		await local(id).prompt(text);
	},
	release: async () => {
		gate.resolve();
		gate = Promise.withResolvers<void>();
	},
	report: async id => {
		const session = local(id);
		return {
			configuredThinkingLevel: session.configuredThinkingLevel(),
			steering: [...session.getQueuedMessages().steering],
			followUp: [...session.getQueuedMessages().followUp],
			customEntries: session.sessionManager
				.getEntries()
				.flatMap(entry => (entry.type === "custom" ? [{ customType: entry.customType, data: entry.data }] : [])),
			userTexts: session.messages.flatMap(message => (message.role === "user" ? [textOf(message.content)] : [])),
			todoPhases: session.getTodoPhases(),
		};
	},
	dropFollowUps: async id => {
		const session = local(id);
		session.dropQueuedMessages(session.agent.peekFollowUpQueue());
	},
	grantSessionApproval: async (id, key) => {
		local(id).extensionRunner?.grantSessionApproval(key);
	},
	recordSessionGrant: async (id, key) => {
		const session = local(id);
		getApprovalGrants(session.settings.getAgentDir(), session.sessionManager.getSessionId()).record(
			key,
			"read",
			"session",
		);
	},
};

function isProbeGlobals(value: unknown): value is FocusProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probeService: ThreadService = {
	name: "focus-probe",
	boot(globals) {
		if (!isProbeGlobals(globals)) throw new Error("probe globals missing");
		globals.ready(probe);
	},
};

const services: readonly ThreadService[] = [identityThreadService, agentsThreadService, authService, probeService];

function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer
	);
}

function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}

let frameHandler: ((frame: RpcFrame) => void) | undefined;

port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		setCurrentThreadId(message.threadId);
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
			{
				name: `${message.threadId}↔main`,
				sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
			},
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = {
			type: "subagent-worker-ready",
		};
		port.postMessage(ready);
		return;
	}
	if (isFrame(message)) frameHandler(message);
});
