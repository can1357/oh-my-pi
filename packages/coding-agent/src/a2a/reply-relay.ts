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
import { IncomingRequests, type IncomingRequestLease } from "./incoming-requests";
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

/** Control handle for an installed relay. */
export interface A2aReplyRelayHandle {
	/** Detach the relay from the session's event stream. */
	stop(): void;
	/**
	 * Wait for the relay's queued run decisions and the detached sends they
	 * started, including work enqueued while draining. Test/control seam only:
	 * production turn finalization never awaits it, so a slow or stuck
	 * transport never blocks a run's settle.
	 */
	settled(): Promise<void>;
}

export interface SendA2aReplyOptions extends Pick<
	A2aReplyRelayOptions,
	"bridge" | "identity" | "rescan" | "timeoutMs" | "send"
> {
	/** The claim on the request being answered; settled by this send. */
	lease: IncomingRequestLease;
	answer: string;
}

/** Detached `sendA2aReply` operations in this thread, drained by {@link settleA2aReplies}. */
const detachedSends = new Set<Promise<unknown>>();

/**
 * Wait until every detached A2A reply send started in this thread has
 * finished, including work enqueued while draining. A test and control seam:
 * production code never awaits it, so reply transport stays fully detached
 * from turn finalization.
 */
export async function settleA2aReplies(): Promise<void> {
	while (detachedSends.size > 0) {
		await Promise.allSettled(detachedSends);
	}
}

/** Install the relay on a main session; returns the control handle. */
export function installA2aReplyRelay(options: A2aReplyRelayOptions): A2aReplyRelayHandle {
	// Requests whose relay chance was used up, kept open for a manual reply.
	const settledRequests = new Set<string>();
	let queue = Promise.resolve();
	let queued = 0;
	let stopped = false;
	const unsubscribe = options.subscribe(event => {
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		queued++;
		queue = queue
			.then(async () => {
				for (const request of await IncomingRequests.global().list(MAIN_AGENT_ID)) {
					if (settledRequests.has(request.messageId)) continue;
					const answer = answerAfter(event.messages, request.at);
					if (answer === undefined) {
						settledRequests.add(request.messageId);
						continue;
					}
					const lease = await IncomingRequests.global().consume({
						to: MAIN_AGENT_ID,
						from: request.from,
						messageId: request.messageId,
					});
					if (lease !== undefined) {
						// This attempt used the request's one automatic-turn
						// opportunity, even when the send fails and releases it:
						// a later human turn is not a retry.
						settledRequests.add(request.messageId);
						void sendA2aReply({ ...options, lease, answer });
					}
				}
			})
			.catch(error => {
				logger.warn("A2A reply relay failed", { error: String(error) });
			})
			.finally(() => {
				queued--;
			});
	});
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			unsubscribe();
		},
		async settled() {
			// Drain the decision queue first (a queued decision may still start
			// a send), then the detached sends — rechecking until both stay
			// quiet, so work enqueued while draining is also awaited.
			while (queued > 0 || detachedSends.size > 0) {
				await queue;
				await settleA2aReplies();
			}
		},
	};
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

/**
 * Normalize a URL for endpoint comparison. An invalid URL is returned as-is:
 * it can never equal a valid registered endpoint, and the refusal path (not a
 * fallback) is the correct outcome for it.
 */
function normalizedUrl(url: string): string {
	try {
		return new URL(url).toString();
	} catch {
		return url;
	}
}

/**
 * The one peer registration the request's sender resolves to.
 *
 * Candidates are registered agents whose `skillId` equals `request.from`. A
 * supplied `fromUrl` must match a candidate's registered endpoint URL by
 * normal URL serialization (including a trailing `/`); a mismatch never falls
 * back to another candidate. With no URL, exactly one candidate must exist —
 * two or more make the selection ambiguous and it is refused instead of
 * arbitrary. Duplicate registrations of the same `(url, skillId)` endpoint
 * collapse to one candidate (the bridge keeps one entry per endpoint).
 */
function findPeer(bridge: A2aBridgeApi, request: A2aIncomingRequest): A2aRuntimeAgent | undefined {
	let candidates = bridge.list().filter(agent => agent.skillId === request.from);
	if (request.fromUrl !== undefined) {
		const wanted = normalizedUrl(request.fromUrl);
		candidates = candidates.filter(agent => normalizedUrl(agent.url) === wanted);
	}
	const distinct = new Map<string, A2aRuntimeAgent>();
	for (const candidate of candidates) {
		const key = `${normalizedUrl(candidate.url)}\u0000${candidate.skillId}`;
		// Duplicate registrations of the same endpoint+skill advertise one
		// destination; the first registration is kept deterministically so
		// duplicates can never make the selection arbitrary.
		if (!distinct.has(key)) distinct.set(key, candidate);
	}
	if (distinct.size !== 1) return undefined;
	return distinct.values().next().value;
}

/**
 * One structured warning for a sender the roster cannot resolve to exactly
 * one endpoint: never the reply text, never credentials. Ambiguity (several
 * candidates, no `fromUrl` to separate them) and an unmatched `fromUrl` are
 * both named, with every candidate's registered name and URL.
 */
function logUnresolvedSender(bridge: A2aBridgeApi, request: A2aIncomingRequest): void {
	const candidates = bridge
		.list()
		.filter(agent => agent.skillId === request.from)
		.map(agent => ({ name: agent.name, url: agent.url }));
	if (request.fromUrl !== undefined) {
		if (candidates.length > 0) {
			logger.warn("A2A reply relay: sender endpoint does not match any registered peer", {
				from: request.from,
				fromUrl: request.fromUrl,
				candidates,
			});
		} else {
			logger.warn("A2A reply relay: sender is not a reachable peer", { from: request.from });
		}
		return;
	}
	if (candidates.length > 1) {
		logger.warn("A2A reply relay: ambiguous automatic reply destination, kept open for a manual reply", {
			from: request.from,
			candidates,
		});
		return;
	}
	logger.warn("A2A reply relay: sender is not a reachable peer", { from: request.from });
}

/**
 * Send a correlated reply to the peer that originated the leased request. The
 * send is registered in the thread's detached-send set the moment it starts,
 * so {@link settleA2aReplies} can wait for it without the callers awaiting.
 *
 * The lease settles with the send: `exitCode === 0` confirms it (the request
 * is permanently answered); any failure — no reachable peer, a nonzero exit,
 * or a throw — releases it, so the request stays open for a manual reply.
 * Returns whether the reply was successfully sent; `false` is never a silent
 * successful acknowledgement.
 */
export async function sendA2aReply(options: SendA2aReplyOptions): Promise<boolean> {
	const { lease, answer } = options;
	const request = lease.request;
	const tracked = (async (): Promise<boolean> => {
		try {
			let peer = findPeer(options.bridge, request);
			if (peer === undefined) {
				await options.rescan();
				peer = findPeer(options.bridge, request);
			}
			if (peer === undefined) {
				logUnresolvedSender(options.bridge, request);
				await IncomingRequests.global().release(lease.leaseId);
				return false;
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
				await IncomingRequests.global().release(lease.leaseId);
				return false;
			}
			await IncomingRequests.global().confirm(lease.leaseId);
			return true;
		} catch (error) {
			logger.warn("A2A reply relay failed", { from: request.from, error: String(error) });
			await IncomingRequests.global().release(lease.leaseId);
			return false;
		}
	})();
	detachedSends.add(tracked);
	void tracked.finally(() => {
		detachedSends.delete(tracked);
	});
	return tracked;
}
