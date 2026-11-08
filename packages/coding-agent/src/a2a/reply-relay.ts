/**
 * Automatic A2A reply for the terminal's main agent (A2).
 *
 * A peer request lands in the main conversation, and the envelope asks the
 * model to answer by spawning `a2a:<sender>`. The model also talks to the
 * human in this terminal, so it often answers in plain text instead, and the
 * sender would wait forever. Subagents have the same gap closed by the task
 * executor's wake-turn relay; this is the main-session counterpart.
 *
 * When a run settles (terminal `agent_end`), every request delivered to the
 * main agent that is still unanswered gets exactly one chance: if the model
 * produced text after the request arrived, the last such text is sent back as
 * the correlated reply (`inReplyTo`). A reply carries no reply-back envelope,
 * so a relay can never start a request -> reply loop. A run that ended
 * without text, or was aborted or failed, relays nothing, and the request
 * stays open for a manual reply only: later runs belong to the human, so
 * their output is never relayed to the peer.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session-events";
import {
	type A2aBridgeApi,
	type A2aRuntimeAgent,
	type SpawnA2aAgentOptions,
	type SpawnA2aAgentResult,
	spawnA2aAgent,
} from "./agent-bridge";
import type { A2aIncomingRequest } from "./rpc";

export interface A2aReplyRelayOptions {
	bridge: A2aBridgeApi;
	/** Main-session event stream. */
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	/** This terminal's public identity, stamped on the reply. */
	identity(): Promise<{ name?: string; url?: string }>;
	/** Refresh the peer roster when the sender is not registered yet. */
	rescan(): Promise<void>;
	/** Whole-send budget in milliseconds; `0`/undefined waits indefinitely. */
	timeoutMs?: number;
	/** Send seam; defaults to {@link spawnA2aAgent}. */
	send?: (options: SpawnA2aAgentOptions) => Promise<SpawnA2aAgentResult>;
}

/** Install the relay on a main session; returns the unsubscribe. */
export function installA2aReplyRelay(options: A2aReplyRelayOptions): () => void {
	// Requests whose relay chance was used up, kept open for a manual reply.
	const settled = new Set<string>();
	return options.subscribe(event => {
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		for (const request of options.bridge.outstandingRequests()) {
			if (request.to !== MAIN_AGENT_ID || settled.has(request.messageId)) continue;
			const answer = answerAfter(event.messages, request.at);
			if (answer === undefined) {
				settled.add(request.messageId);
				continue;
			}
			if (options.bridge.consumeOutstandingRequest(request.from, request.messageId) === undefined) continue;
			void relayAnswer(options, request, answer);
		}
	});
}

/**
 * The run's answer to a request delivered at `at`: the last assistant text
 * produced after it, or `undefined` when there is none or the run ended
 * aborted or failed.
 */
function answerAfter(messages: readonly AgentMessage[], at: number): string | undefined {
	let answer: string | undefined;
	let ended: string | undefined;
	for (const message of messages) {
		if (message.role !== "assistant" || message.timestamp < at) continue;
		ended = message.stopReason;
		const text = message.content
			.flatMap(part => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
		if (text.length > 0) answer = text;
	}
	return ended === "aborted" || ended === "error" ? undefined : answer;
}

function findPeer(bridge: A2aBridgeApi, from: string): A2aRuntimeAgent | undefined {
	return bridge.list().find(agent => agent.skillId === from);
}

async function relayAnswer(options: A2aReplyRelayOptions, request: A2aIncomingRequest, answer: string): Promise<void> {
	try {
		let peer = findPeer(options.bridge, request.from);
		if (peer === undefined) {
			await options.rescan();
			peer = findPeer(options.bridge, request.from);
		}
		if (peer === undefined) {
			logger.warn("A2A reply relay: sender is not a reachable peer", { from: request.from });
			return;
		}
		const send = options.send ?? spawnA2aAgent;
		const result = await send({
			agent: peer,
			prompt: answer,
			inReplyTo: request.messageId,
			fromIdentity: await options.identity(),
			...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		});
		if (result.exitCode !== 0) {
			logger.warn("A2A reply relay failed", { from: request.from, error: result.error ?? result.output });
		}
	} catch (error) {
		logger.warn("A2A reply relay failed", { from: request.from, error: String(error) });
	}
}
