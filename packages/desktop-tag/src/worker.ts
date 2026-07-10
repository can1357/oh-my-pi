import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@pk-nerdsaver-ai/pi-coding-agent";
import { AgentSessionGateway } from "@pk-nerdsaver-ai/pi-coding-agent/gateway/agent-session-gateway";
import type {
	GatewayCommand,
	GatewayEvent,
	GatewayEventListener,
} from "@pk-nerdsaver-ai/pi-coding-agent/gateway/types";
import type {
	ClientBridge,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";
import { getProjectDir, logger } from "@pk-nerdsaver-ai/pi-utils";

import { AgentEventChannel } from "./events";
import type {
	ActionLevel,
	AgentEvent,
	AgentWorker,
	ApprovalDecision,
	ApprovalRequest,
	ContextPacket,
	RoutingDecision,
	SessionHandle,
	TaskInput,
} from "./types";

interface WorkerSession {
	setClientBridge(bridge: ClientBridge): void;
	dispose(): Promise<void>;
}

interface WorkerGateway {
	dispatch(command: GatewayCommand): Promise<void>;
	subscribe(listener: GatewayEventListener): () => void;
	dispose(): void;
}

interface WorkerRuntime {
	session: WorkerSession;
	gateway: WorkerGateway;
}

interface ActiveSession extends WorkerRuntime {
	channel: AgentEventChannel;
	bridge: DesktopTagClientBridge;
	controller: AbortController;
	taskId: string;
	settled: boolean;
	cancelling: boolean;
	cancellation?: Promise<void>;
	assistantError?: string;
}

type AgentSessionFactory = (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
type AgentRuntimeFactory = (options: CreateAgentSessionOptions) => Promise<WorkerRuntime>;
type WorkerFactory = AgentSessionFactory | AgentRuntimeFactory;

/** Bridges permission requests from the agent into the overlay approval flow. */
class DesktopTagClientBridge implements ClientBridge {
	readonly capabilities = { requestPermission: true };
	readonly #channel: AgentEventChannel;
	readonly #lifecycleSignal: AbortSignal;
	readonly #pending = new Map<string, (outcome: ClientBridgePermissionOutcome) => void>();

	constructor(channel: AgentEventChannel, lifecycleSignal: AbortSignal) {
		this.#channel = channel;
		this.#lifecycleSignal = lifecycleSignal;
	}

	async requestPermission(
		toolCall: ClientBridgePermissionToolCall,
		options: ClientBridgePermissionOption[],
		signal?: AbortSignal,
	): Promise<ClientBridgePermissionOutcome> {
		if (this.#lifecycleSignal.aborted) return { outcome: "cancelled" };
		const { promise, resolve } = Promise.withResolvers<ClientBridgePermissionOutcome>();
		this.#pending.set(toolCall.toolCallId, resolve);

		const allowedOptions = options.map(o => o.optionId).filter(id => id.startsWith("allow"));
		const scope: ApprovalRequest["scope"] = allowedOptions.includes("allow_once") ? "once" : "session";
		const level: ActionLevel = scope === "session" ? 2 : 1;
		const rawInput = toolCall.rawInput;
		const requestArguments: Record<string, unknown> =
			typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
				? Object.fromEntries(Object.entries(rawInput))
				: {};

		const request: ApprovalRequest = {
			actionId: toolCall.toolCallId,
			stepId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			arguments: requestArguments,
			effects: toolCall.title,
			level,
			scope,
		};

		this.#channel.push({
			type: "approval.requested",
			request,
		});

		const cancel = () => this.resolve(toolCall.toolCallId, { outcome: "cancelled" });
		signal?.addEventListener("abort", cancel, { once: true });
		this.#lifecycleSignal.addEventListener("abort", cancel, { once: true });

		try {
			return await promise;
		} finally {
			signal?.removeEventListener("abort", cancel);
			this.#lifecycleSignal.removeEventListener("abort", cancel);
			this.#pending.delete(toolCall.toolCallId);
		}
	}

	resolve(toolCallId: string, outcome: ClientBridgePermissionOutcome): void {
		const resolver = this.#pending.get(toolCallId);
		if (resolver) resolver(outcome);
	}

	get actionIds(): string[] {
		return [...this.#pending.keys()];
	}
}

/** A worker that delegates tasks to a local agent session through the gateway. */
export class PiWorker implements AgentWorker {
	readonly #sessions = new Map<string, ActiveSession>();
	readonly #factory: WorkerFactory;

	constructor(factory: WorkerFactory = createAgentSession) {
		this.#factory = factory;
	}

	async createSession(taskId: string, input: TaskInput): Promise<SessionHandle> {
		const { contextPacket, preferredExecutor } = input;
		const routing = input.routing;

		const promptLines = [
			"You are operating in desktop-tag mode.",
			"A screenshot or selected context has been captured from the user's desktop.",
			"Use the provided context to answer or act. Prefer non-destructive, reversible actions.",
		];
		if (preferredExecutor) {
			promptLines.push(`Preferred executor for this task: ${preferredExecutor}.`);
		}

		const options: CreateAgentSessionOptions = {
			cwd: getProjectDir(),
			hasUI: true,
			toolNames: routing.tools,
			appendSystemPrompt: promptLines.join("\n"),
		};

		const message = buildInitialMessage(contextPacket, routing);
		const images = contextPacket.visual.screenshotPath ? [await loadImage(contextPacket.visual.screenshotPath)] : [];

		const { session, gateway } = await this.#createRuntime(options);

		const channel = new AgentEventChannel();
		const controller = new AbortController();
		const bridge = new DesktopTagClientBridge(channel, controller.signal);
		session.setClientBridge(bridge);
		const active: ActiveSession = {
			session,
			gateway,
			channel,
			bridge,
			controller,
			taskId,
			settled: false,
			cancelling: false,
		};
		this.#sessions.set(taskId, active);
		this.#attachListener(active);

		// Let the caller attach its replaying subscription before a fast session can settle and leave the active registry.
		void Bun.sleep(0)
			.then(async () => {
				if (active.settled || active.cancelling || controller.signal.aborted) return;
				await gateway.dispatch({
					id: crypto.randomUUID(),
					type: "prompt",
					identity: { channelId: "desktop-tag", sessionKey: taskId },
					message,
					images,
				});
			})
			.catch(error =>
				this.#settle(active, {
					type: "task.failed",
					taskId,
					error: `Failed to start task: ${error instanceof Error ? error.message : String(error)}`,
				}),
			);

		return { sessionId: taskId };
	}

	async #createRuntime(options: CreateAgentSessionOptions): Promise<WorkerRuntime> {
		const created = await this.#factory(options);
		if ("gateway" in created) return created;
		return { session: created.session, gateway: new AgentSessionGateway(created.session) };
	}

	async sendMessage(sessionId: string, message: string, images?: ImageContent[]): Promise<void> {
		const active = this.#sessions.get(sessionId);
		if (!active) throw new Error(`Session ${sessionId} not found`);
		await active.gateway.dispatch({
			id: crypto.randomUUID(),
			type: "prompt",
			identity: { channelId: "desktop-tag", sessionKey: sessionId },
			message,
			images,
		});
	}

	async approve(sessionId: string, actionId: string, decision: ApprovalDecision): Promise<void> {
		const active = this.#sessions.get(sessionId);
		if (!active) throw new Error(`Session ${sessionId} not found`);
		if (decision.editedArguments !== undefined) {
			throw new Error("Edited approval arguments are not supported by the desktop-tag worker.");
		}
		if (decision.scope === "group" || decision.scope === "application") {
			throw new Error(`Approval scope "${decision.scope}" is not supported by the desktop-tag worker.`);
		}
		if (decision.allowed) {
			const optionId = decision.scope === "session" ? "allow_always" : "allow_once";
			active.bridge.resolve(actionId, { outcome: "selected", optionId });
		} else {
			active.bridge.resolve(actionId, { outcome: "cancelled" });
		}
	}

	/** Abort and dispose an active task. Idempotent; concurrent callers await the same settlement. */
	cancel(sessionId: string): Promise<void> {
		const active = this.#sessions.get(sessionId);
		if (!active || active.settled) return Promise.resolve();
		if (active.cancellation) return active.cancellation;
		active.cancelling = true;
		active.controller.abort();
		active.cancellation = this.#abortAndSettle(active, sessionId);
		return active.cancellation;
	}

	async #abortAndSettle(active: ActiveSession, sessionId: string): Promise<void> {
		try {
			await active.gateway.dispatch({
				id: crypto.randomUUID(),
				type: "abort",
				identity: { channelId: "desktop-tag", sessionKey: sessionId },
			});
		} finally {
			await this.#settle(active, { type: "task.failed", taskId: active.taskId, error: "Task cancelled." });
		}
	}

	subscribe(sessionId: string): AsyncIterable<AgentEvent> {
		const active = this.#sessions.get(sessionId);
		if (!active) throw new Error(`Session ${sessionId} not found`);
		return active.channel.subscribe();
	}

	#attachListener(active: ActiveSession): void {
		active.gateway.subscribe(event => {
			if (active.settled) return;
			if (active.cancelling) return;
			if (event.type === "session_event" && event.event.type === "assistant_end") {
				active.assistantError = event.event.hasError ? "Assistant turn ended with an error." : undefined;
			}
			if (event.type === "session_event" && event.event.type === "agent_end") {
				const terminal: AgentEvent = active.assistantError
					? { type: "task.failed", taskId: active.taskId, error: active.assistantError }
					: { type: "task.completed", taskId: active.taskId, summary: "" };
				void this.#settle(active, terminal);
				return;
			}

			const translated = translateGatewayEvent(active.taskId, event);
			for (const translatedEvent of translated) {
				if (translatedEvent.type === "task.failed") {
					void this.#settle(active, translatedEvent);
					return;
				}
				active.channel.push(translatedEvent);
			}
		});
	}

	async #settle(active: ActiveSession, terminal: AgentEvent): Promise<void> {
		if (active.settled) return;
		active.settled = true;
		this.#sessions.delete(active.taskId);
		active.channel.push(terminal);
		active.channel.close();
		active.gateway.dispose();
		try {
			await active.session.dispose();
		} catch (error) {
			logger.error("Failed to dispose desktop-tag agent session", {
				error: error instanceof Error ? error.message : String(error),
				taskId: active.taskId,
			});
		}
	}
}

async function loadImage(path: string): Promise<ImageContent> {
	const bytes = await Bun.file(path).bytes();
	return {
		type: "image",
		data: bytes.toBase64(),
		mimeType: "image/png",
		detail: "high",
	};
}

function buildInitialMessage(packet: ContextPacket, routing: RoutingDecision): string {
	const lines = [
		`The user asked: ${packet.userRequest}`,
		`Capture mode: ${packet.captureMode}`,
		`Routing: ${routing.message}`,
	];
	if (packet.foregroundApp.processName) {
		lines.push(
			`Foreground app: ${packet.foregroundApp.processName} - ${packet.foregroundApp.windowTitle ?? "unknown window"}`,
		);
	}
	if (packet.browser.url) {
		lines.push(`Active browser tab: ${packet.browser.title ?? ""} (${packet.browser.url})`);
	}
	if (packet.selection.clipboardText) {
		lines.push(`Clipboard/selection text: ${packet.selection.clipboardText}`);
	}
	lines.push("Use the attached screenshot and context to answer or act.");
	return lines.join("\n");
}

function translateGatewayEvent(taskId: string, event: GatewayEvent): AgentEvent[] {
	switch (event.type) {
		case "ready":
			return [];
		case "session_event": {
			const ev = event.event;
			switch (ev.type) {
				case "agent_start":
					return [{ type: "task.started", taskId }];
				case "agent_end":
					return [];
				case "assistant_text_delta":
					return [{ type: "agent.message.delta", text: ev.text }];
				case "assistant_end":
					return [];
				case "tool_start":
					return [{ type: "tool.started", callId: ev.toolCallId, toolName: ev.toolName }];
				case "tool_end":
					return [{ type: "tool.completed", callId: ev.toolCallId, result: null, isError: ev.isError }];
				case "notice":
					return [{ type: "agent.message.delta", text: `[${ev.level}] ${ev.message}` }];
				case "thinking_level_changed":
					return [];
				default:
					return [];
			}
		}
		case "response": {
			if (event.success) return [];
			return [{ type: "task.failed", taskId, error: event.error }];
		}
		case "protocol_error":
			return [{ type: "task.failed", taskId, error: event.error }];
		default:
			logger.debug("Unhandled gateway event", { type: (event as { type: string }).type });
			return [];
	}
}
