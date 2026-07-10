/**
 * Transport-neutral facade over one AgentSession.
 *
 * Adapters (terminal, API, mobile, Slack/Telegram, …) share this execution core.
 * Remote adapters MUST enforce authentication and rate limiting before calling
 * into the gateway; this module never widens session permissions or mutates
 * model/config/policy settings, and it never writes to stdout.
 */
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
	PromptOptions,
} from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type {
	GatewayCommand,
	GatewayEvent,
	GatewayEventListener,
	GatewayIdentity,
	GatewayModelRef,
	GatewayResponseData,
	GatewaySessionEvent,
	GatewaySessionState,
} from "./types";
import { parseGatewayCommand } from "./types";

/**
 * Narrow host surface for tests and adapters. Intentionally excludes permission,
 * model, thinking, and settings mutators so the gateway cannot widen privileges.
 */
export type AgentSessionGatewayHost = Pick<
	AgentSession,
	| "prompt"
	| "steer"
	| "followUp"
	| "abort"
	| "newSession"
	| "subscribe"
	| "isStreaming"
	| "sessionFile"
	| "sessionId"
	| "thinkingLevel"
> & {
	/** Minimal model projection; full Model remains assignable structurally. */
	model: GatewayModelRef | undefined;
	sessionManager: {
		getCwd(): string;
	};
};

function projectModel(model: GatewayModelRef | undefined): GatewayModelRef | undefined {
	if (!model) return undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
	};
}

function readState(session: AgentSessionGatewayHost): GatewaySessionState {
	return {
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		isStreaming: session.isStreaming,
		thinkingLevel: session.thinkingLevel,
		cwd: session.sessionManager.getCwd(),
		model: projectModel(session.model),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameIdentity(a: GatewayIdentity, b: GatewayIdentity): boolean {
	return a.channelId === b.channelId && a.sessionKey === b.sessionKey;
}

function projectSessionEvent(event: AgentSessionEvent): GatewaySessionEvent | null {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end" };
		case "message_update":
			if (event.message.role === "assistant" && event.assistantMessageEvent.type === "text_delta") {
				return { type: "assistant_text_delta", text: event.assistantMessageEvent.delta };
			}
			return null;
		case "message_end":
			if (event.message.role !== "assistant") return null;
			return {
				type: "assistant_end",
				stopReason: event.message.stopReason,
				hasError: Boolean(event.message.errorMessage),
			};
		case "tool_execution_start":
			return { type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName };
		case "tool_execution_end":
			return {
				type: "tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError === true,
			};
		case "notice":
			return {
				type: "notice",
				level: event.level,
				message: event.message.slice(0, 4_000),
				source: event.source,
			};
		case "thinking_level_changed":
			return { type: "thinking_level_changed", thinkingLevel: event.thinkingLevel };
		default:
			return null;
	}
}

export interface AgentSessionGatewayOptions {
	readonly identity?: GatewayIdentity;
	readonly onListenerError?: (error: unknown) => void;
}

export class AgentSessionGateway {
	readonly #session: AgentSessionGatewayHost;
	readonly #listeners: GatewayEventListener[] = [];
	readonly #onListenerError: ((error: unknown) => void) | undefined;
	#boundIdentity: GatewayIdentity | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#disposed = false;

	constructor(session: AgentSessionGatewayHost, options: AgentSessionGatewayOptions = {}) {
		this.#session = session;
		this.#boundIdentity = options.identity;
		this.#onListenerError = options.onListenerError;
		const onSessionEvent: AgentSessionEventListener = event => {
			const projected = projectSessionEvent(event);
			if (projected) this.#emit({ type: "session_event", event: projected });
		};
		this.#unsubscribeSession = session.subscribe(onSessionEvent);
	}

	subscribe(listener: GatewayEventListener): () => void {
		this.#listeners.push(listener);
		if (!this.#disposed) this.#notifyListener(listener, { type: "ready" });
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index >= 0) this.#listeners.splice(index, 1);
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		// Keep gateway listeners so correlated post-dispose errors can still be observed.
	}

	/**
	 * Validate untrusted runtime input, then dispatch. Invalid commands emit a
	 * correlated error event and do not touch the session.
	 */
	async handle(input: unknown): Promise<void> {
		const parsed = parseGatewayCommand(input);
		if (!parsed.ok) {
			const id =
				typeof input === "object" && input && "id" in input && typeof input.id === "string" ? input.id : undefined;
			this.#emit({ type: "protocol_error", id, error: parsed.error });
			return;
		}
		await this.dispatch(parsed.command);
	}

	async dispatch(command: GatewayCommand): Promise<void> {
		if (this.#disposed) {
			this.#emit({
				type: "response",
				id: command.id,
				command: command.type,
				success: false,
				error: "gateway disposed",
			});
			return;
		}
		if (this.#boundIdentity && !sameIdentity(this.#boundIdentity, command.identity)) {
			this.#emit({
				type: "response",
				id: command.id,
				command: command.type,
				success: false,
				error: "gateway identity mismatch",
			});
			return;
		}
		this.#boundIdentity ??= command.identity;

		try {
			const data = await this.#run(command);
			if (data === undefined) {
				this.#emit({
					type: "response",
					id: command.id,
					command: command.type,
					success: true,
				});
			} else {
				this.#emit({
					type: "response",
					id: command.id,
					command: command.type,
					success: true,
					data,
				});
			}
		} catch (error) {
			this.#emit({
				type: "response",
				id: command.id,
				command: command.type,
				success: false,
				error: errorMessage(error),
			});
		}
	}

	async #run(command: GatewayCommand): Promise<GatewayResponseData> {
		switch (command.type) {
			case "prompt": {
				const options: PromptOptions = {};
				if (command.images) options.images = command.images;
				if (command.streamingBehavior) options.streamingBehavior = command.streamingBehavior;
				const agentInvoked = await this.#session.prompt(command.message, options);
				return { agentInvoked };
			}
			case "steer": {
				await this.#session.steer(command.message, command.images);
				return undefined;
			}
			case "follow_up": {
				await this.#session.followUp(command.message, command.images);
				return undefined;
			}
			case "abort": {
				await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
				return undefined;
			}
			case "abort_and_prompt": {
				await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
				const agentInvoked = await this.#session.prompt(command.message, {
					images: command.images,
				});
				return { agentInvoked };
			}
			case "get_state":
				return readState(this.#session);
			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const completed = await this.#session.newSession(options);
				return { cancelled: !completed };
			}
		}
	}

	#emit(event: GatewayEvent): void {
		if (this.#disposed && event.type !== "response" && event.type !== "protocol_error") return;
		for (const listener of [...this.#listeners]) this.#notifyListener(listener, event);
	}

	#notifyListener(listener: GatewayEventListener, event: GatewayEvent): void {
		try {
			listener(event);
		} catch (error) {
			try {
				this.#onListenerError?.(error);
			} catch {
				// Listener error reporting must never recurse into gateway delivery.
			}
		}
	}
}

export function createAgentSessionGateway(
	session: AgentSessionGatewayHost,
	options: AgentSessionGatewayOptions = {},
): AgentSessionGateway {
	return new AgentSessionGateway(session, options);
}
