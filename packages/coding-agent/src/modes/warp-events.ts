import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isInsideTmux, wrapTmuxPassthrough } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions/types";
import { isSilentAbort, isUserInterruptAbort, SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";

const WARP_CLI_AGENT_PROTOCOL_VERSION = 1;
const WARP_CLI_AGENT_SENTINEL = "warp://cli-agent";
const WARP_ATTENTION_EVENTS: Record<string, true> = {
	stop: true,
	stop_failure: true,
	permission_request: true,
	question_asked: true,
};

/** True when Warp has negotiated the structured CLI-agent OSC protocol. */
export function isWarpCliAgentProtocolActive(): boolean {
	return Number(process.env.WARP_CLI_AGENT_PROTOCOL_VERSION) >= WARP_CLI_AGENT_PROTOCOL_VERSION;
}

export type WarpEventValue =
	| string
	| number
	| boolean
	| null
	| readonly WarpEventValue[]
	| { readonly [key: string]: WarpEventValue | undefined };

/** Fields added to the Warp CLI-agent event envelope by the event bridge. */
export type WarpEvent = Readonly<Record<string, WarpEventValue | undefined>>;

export interface WarpEventEmitterOptions {
	sessionId: string;
	getCwd?: () => string;
}

export interface WarpEventEmitter {
	emit(event: WarpEvent): void;
}

/**
 * Creates the Warp event transport for a top-level interactive TUI session.
 * The caller MUST enforce that install-site invariant; the sole production
 * caller is gated by `isInteractive`, so ACP, RPC, print, headless, and
 * subagent sessions never construct an emitter.
 */
export function createWarpEventEmitter(options: WarpEventEmitterOptions): WarpEventEmitter | undefined {
	if (!isWarpCliAgentProtocolActive()) {
		return undefined;
	}

	return {
		emit(event): void {
			const cwd = options.getCwd?.() ?? process.cwd();
			const body = {
				...event,
				v: WARP_CLI_AGENT_PROTOCOL_VERSION,
				// Warp resolves this via CLIAgent.command_prefix(); OhMyPi is "omp".
				agent: "omp",
				session_id: options.sessionId,
				cwd,
				project: path.basename(cwd),
				plugin_version: VERSION,
			};
			const osc = `\x1b]777;notify;${WARP_CLI_AGENT_SENTINEL};${JSON.stringify(body)}\x07`;
			if (!isInsideTmux()) {
				process.stdout.write(osc);
				return;
			}
			// DCS-wrap every OSC so Warp can parse it under allow-passthrough.
			// Outer BEL after DCS is only for attention-worthy events so tmux
			// monitor-bell flags the pane; the OSC's own trailing \x07 is its
			// terminator and does not drive the outer bell after wrapping.
			const wrapped = wrapTmuxPassthrough(osc);
			const eventName = event.event;
			const ring = typeof eventName === "string" && Object.hasOwn(WARP_ATTENTION_EVENTS, eventName);
			process.stdout.write(ring ? `${wrapped}\x07` : wrapped);
		},
	};
}

type LastAssistantStop = {
	response: string;
	event: "stop" | "stop_failure";
	error_type?: "error" | "aborted";
};

function lastAssistantStop(messages: readonly AgentMessage[]): LastAssistantStop {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;

		const text = message.content
			.filter(content => content.type === "text")
			.map(content => content.text)
			.join("");

		let response = "";
		if (text.length > 0) {
			response = text;
		} else {
			const errorMessage = message.errorMessage;
			if (typeof errorMessage === "string" && errorMessage.length > 0 && !isSilentAbort(message)) {
				if (message.stopReason === "error") {
					response = errorMessage;
				} else if (message.stopReason === "aborted" && !isUserInterruptAbort(message)) {
					response = errorMessage;
				}
			}
		}

		if (message.stopReason === "error") {
			return { response, event: "stop_failure", error_type: "error" };
		}
		if (
			message.stopReason === "aborted" &&
			!isSilentAbort(message) &&
			!isUserInterruptAbort(message) &&
			typeof message.errorMessage === "string" &&
			message.errorMessage.length > 0
		) {
			return { response, event: "stop_failure", error_type: "aborted" };
		}
		return { response, event: "stop" };
	}
	return { response: "", event: "stop" };
}

function truncateEventText(text: string): string {
	let end = 0;
	let count = 0;
	for (const codePoint of text) {
		if (count === 200) break;
		end += codePoint.length;
		count++;
	}
	return text.slice(0, end);
}

function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string",
		)
		.map(block => block.text)
		.join("");
}

/** Internal event bridge installed only by the top-level interactive TUI runner. */
export function createWarpEventBridgeExtension(): ExtensionFactory {
	return api => {
		let emitter: WarpEventEmitter | undefined;
		let activePrompt: string | undefined;
		let getCwd: (() => string) | undefined;

		const rebuildEmitter = (_event: unknown, ctx: ExtensionContext): void => {
			activePrompt = undefined;
			getCwd = () => ctx.sessionManager.getCwd();
			emitter = createWarpEventEmitter({ sessionId: ctx.sessionManager.getSessionId(), getCwd });
			emitter?.emit({ event: "session_start" });
		};

		api.on("session_start", rebuildEmitter);
		api.on("session_switch", rebuildEmitter);
		api.on("session_branch", rebuildEmitter);

		api.on("message_start", event => {
			const message = event.message as AgentMessage;
			if (message.role === "user") {
				if (message.synthetic || message.attribution === "agent") {
					return;
				}
			} else if (
				message.role !== "custom" ||
				message.customType !== SKILL_PROMPT_MESSAGE_TYPE ||
				message.attribution !== "user"
			) {
				return;
			}
			activePrompt = truncateEventText(messageText(message.content));
			emitter?.emit({ event: "prompt_submit", query: activePrompt });
		});

		api.on("tool_approval_requested", event => {
			emitter?.emit({
				event: "permission_request",
				tool_name: event.toolName,
				summary: `omp wants to run ${event.toolName}`,
			});
		});

		api.on("tool_approval_resolved", () => {
			emitter?.emit({ event: "permission_replied" });
		});

		api.on("tool_execution_start", event => {
			if (event.toolName === "ask") {
				emitter?.emit({ event: "question_asked", summary: "Waiting for your answer" });
			}
		});

		api.on("tool_result", event => {
			emitter?.emit({ event: "tool_complete", tool_name: event.toolName });
		});

		api.on("agent_end", event => {
			if (event.willContinue) {
				return;
			}
			const stop = lastAssistantStop(event.messages);
			emitter?.emit({
				event: stop.event,
				query: activePrompt,
				response: truncateEventText(stop.response),
				...(stop.error_type !== undefined ? { error_type: stop.error_type } : {}),
			});
		});
	};
}
