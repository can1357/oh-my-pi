import { LIST_STATUS_ORDER } from "@oh-my-pi/pi-tui/tools/hub";
/**
 * Hub messaging half — agent-to-agent messaging over the process-global IrcBus.
 *
 * `send` is fire-and-forget: the bus routes the message to the recipient
 * (waking idle agents with a real turn, reviving parked ones via the
 * lifecycle manager, injecting a non-interrupting aside into busy ones) and
 * returns delivery receipts immediately. Replies are real turns by the
 * recipient, observed with `wait` (or the `await: true` send sugar). `inbox`
 * drains pending messages; `list` shows actionable running+idle peers by default.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";

import { IrcAwaitTargetStopped, IrcBus } from "../../irc/bus";
import { type IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";

import { type AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { ensurePersistedRoster, isCurrentSessionRosterRef } from "../../registry/persisted-agents";
import { canSpawnAtDepth } from "../../task/types";

import {
	type CoordinationDetails,
	DEFAULT_HUB_LIST_LIMIT,
	type HubListStatus,
	type HubRosterCounts,
	MAX_HUB_LIST_LIMIT,
} from "@oh-my-pi/pi-tui/tools/hub";
import { hubErrorResult } from "./types";

export const DEFAULT_IRC_TIMEOUT_MS = 120_000;

export interface HubListParams {
	status?: HubListStatus;
	limit?: number;
}

function isAddressablePeer(ref: { id: string; kind: string; status: string }, senderId: string): boolean {
	return ref.id !== senderId && ref.kind !== "advisor" && ref.status !== "aborted";
}

function resolveHubListLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_HUB_LIST_LIMIT;
	return Math.min(Math.max(1, Math.floor(limit)), MAX_HUB_LIST_LIMIT);
}

function selectListRefs(
	registry: AgentRegistry,
	senderId: string,
	status: HubListStatus | undefined,
	rootSessionFile: string | undefined,
) {
	if (status === "parked") {
		return registry
			.list()
			.filter(
				ref =>
					isAddressablePeer(ref, senderId) &&
					ref.status === "parked" &&
					isCurrentSessionRosterRef(ref, rootSessionFile),
			);
	}
	const live = registry.listVisibleTo(senderId);
	return status ? live.filter(ref => ref.status === status) : live;
}

function countAddressable(refs: { status: string }[]): Pick<HubRosterCounts, "running" | "idle" | "parked"> {
	const counts = { running: 0, idle: 0, parked: 0 };
	for (const ref of refs) {
		if (ref.status === "running") counts.running++;
		else if (ref.status === "idle") counts.idle++;
		else if (ref.status === "parked") counts.parked++;
	}
	return counts;
}

function formatRosterSummary(counts: HubRosterCounts, emptyNoun: string): string {
	const tally = `running ${counts.running}, idle ${counts.idle}, parked ${counts.parked}; shown ${counts.shown}, truncated ${counts.truncated}`;
	if (counts.shown === 0) {
		return counts.running + counts.idle + counts.parked === 0
			? `No other agents (${tally}).`
			: `No ${emptyNoun} (${tally}).`;
	}
	return `${counts.shown} peer(s) (${tally}):`;
}

/**
 * Messaging availability: there must be someone to chat with. True for every
 * subagent (it always has a parent, and possibly siblings) and for any
 * session that can still spawn subagents through the task tool. Only a
 * top-level session with task spawning unavailable has no peers.
 */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	// Top-level session: peers exist only if it can still spawn subagents — the
	// same capacity gate the task tool uses, reused here to avoid drift.
	const maxDepth = settings.get("task.maxRecursionDepth") ?? 2;
	return canSpawnAtDepth(maxDepth, taskDepth);
}

export function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	return `[${msg.id}] ${msg.from}${replyTag}: ${msg.body}`;
}

export function normalizeIrcTimeoutMs(value: number): number {
	if (value === 0) return 0; // 0 = timeout disabled
	// Negative or non-finite settings are misconfigurations — fall back to the
	// default instead of producing an instant 1 ms timeout.
	if (!Number.isFinite(value) || value < 0) return DEFAULT_IRC_TIMEOUT_MS;
	return Math.max(1, Math.trunc(value));
}

/** Session-buffered inbox drain used before parking a bus waiter. */
export function drainPendingInbox(registry: AgentRegistry, senderId: string, from?: string): IrcMessage | undefined {
	const session = registry.get(senderId)?.session;
	return typeof session?.drainPendingIrcInboxMessages === "function"
		? session.drainPendingIrcInboxMessages(senderId, { from, limit: 1 })[0]
		: undefined;
}

/** `wait` result carrying a consumed message. */
export function messageResult(senderId: string, waited: IrcMessage): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: formatIncoming(waited) }],
		details: { op: "wait", from: senderId, waited },
	};
}

/**
 * List addressable peers. Default is running+idle with a conservative bound.
 * One latched restore from the root session file runs before counts, even
 * when live siblings are already in memory.
 */
export async function executeList(
	registry: AgentRegistry,
	senderId: string,
	params: HubListParams = {},
	sessionFileHint?: string | null,
): Promise<AgentToolResult<CoordinationDetails>> {
	const rootSessionFile = await ensurePersistedRoster(
		registry,
		sessionFileHint ?? registry.get(senderId)?.sessionFile,
	);
	const refs = registry
		.list()
		.filter(ref => isAddressablePeer(ref, senderId) && isCurrentSessionRosterRef(ref, rootSessionFile));

	const selected = selectListRefs(registry, senderId, params.status, rootSessionFile);
	selected.sort(
		(a, b) =>
			(LIST_STATUS_ORDER[a.status] ?? 9) - (LIST_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
	);
	const limit = resolveHubListLimit(params.limit);
	const truncated = Math.max(0, selected.length - limit);
	const shownRefs = truncated > 0 ? selected.slice(0, limit) : selected;
	const counts: HubRosterCounts = {
		...countAddressable(refs.filter(ref => isAddressablePeer(ref, senderId))),
		shown: shownRefs.length,
		truncated,
	};

	const bus = IrcBus.global();
	const peers = shownRefs.map(ref => ({
		id: ref.id,
		displayName: ref.displayName,
		kind: ref.kind,
		status: ref.status,
		parentId: ref.parentId,
		unread: bus.unreadCount(ref.id),
		lastActivity: ref.lastActivity,
		activity: ref.activity,
	}));
	const lines = [formatRosterSummary(counts, params.status ? `${params.status} peers` : "actionable peers")];
	for (const peer of peers) {
		const extras = [
			peer.activity || undefined,
			peer.unread > 0 ? `unread ${peer.unread}` : undefined,
			peer.parentId ? `parent ${peer.parentId}` : undefined,
			`active ${formatDuration(Date.now() - peer.lastActivity)} ago`,
		].filter(Boolean);
		lines.push(`- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}] — ${extras.join(", ")}`);
	}
	if (counts.parked > 0) {
		lines.push("");
		lines.push(
			params.status === "parked"
				? "Parked agents are revived automatically when you message them."
				: 'Parked agents remain queryable with status="parked" and are revived automatically when you message them.',
		);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "list", from: senderId, peers, counts },
	};
}

export interface HubSendParams {
	to?: string;
	message?: string;
	replyTo?: string;
	await?: boolean;
}

export async function executeSend(
	deps: { registry: AgentRegistry; senderId: string; settings: Settings; sessionFileHint?: string | null },
	params: HubSendParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, settings, sessionFileHint } = deps;
	const to = params.to?.trim();
	const message = params.message?.trim();
	if (!to) {
		return hubErrorResult('`to` is required for op="send".', { op: "send", from: senderId });
	}
	if (!message) {
		return hubErrorResult('`message` is required for op="send".', { op: "send", from: senderId });
	}
	if (to === senderId) {
		return hubErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	}
	const isBroadcast = to === "all";
	if (isBroadcast && params.await) {
		return hubErrorResult('`await` is invalid with to:"all" — broadcasts have no single replier.', {
			op: "send",
			from: senderId,
			to,
		});
	}
	// Discovery can retarget parked refs to the caller's root, but cannot
	// replace a live peer. Never gate live control messages on filesystem
	// discovery: the recipient may be waiting for this message to finish work.
	if (!isBroadcast && sessionFileHint) {
		const recipient = registry.get(to);
		if (!recipient || recipient.status === "parked") {
			await ensurePersistedRoster(registry, sessionFileHint);
		}
	}

	const bus = IrcBus.global();
	let waited: IrcMessage | null | undefined;
	const timeoutMs = params.await ? normalizeIrcTimeoutMs(settings.get("irc.timeoutMs")) : undefined;
	const awaitAbort = params.await ? new AbortController() : undefined;
	const awaitCancelled = new Error("IRC await cancelled");
	let removeAwaitAbortListener: (() => void) | undefined;
	const waiting = params.await
		? bus
				.wait(senderId, { from: to }, timeoutMs ?? DEFAULT_IRC_TIMEOUT_MS, awaitAbort?.signal, {
					drainPending: false,
					awaitTarget: { registry, target: to },
				})
				.then(
					message => ({ message, error: null as Error | null }),
					error => ({
						message: null,
						error: error === awaitCancelled ? null : error instanceof Error ? error : new Error(String(error)),
					}),
				)
		: undefined;
	if (params.await && signal && awaitAbort) {
		if (signal.aborted) {
			awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
		} else {
			const onAbort = (): void => {
				awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAwaitAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	try {
		// Broadcasts fan out to live peers only (running | idle); reviving every
		// parked agent on a broadcast would be a stampede. Direct sends go
		// through the bus unfiltered so parked recipients are revived.
		const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
		// A broadcast that also reaches the main agent delivers the body to it
		// directly (its own incoming card); relaying the sibling legs to the
		// main UI would then show the same body once per other recipient.
		const suppressRelay = isBroadcast && targets.includes(MAIN_AGENT_ID);
		const receipts = await Promise.all(
			targets.map(target =>
				bus.send(
					{ from: senderId, to: target, body: message, replyTo: params.replyTo },
					// Awaited sends mark the sender as blocked on an answer so a
					// busy recipient that cannot reach a step boundary (async
					// disabled) auto-replies instead of stranding the sender.
					{ expectsReply: params.await || undefined, suppressRelay: suppressRelay || undefined },
				),
			),
		);

		const lines: string[] = [];
		const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
		if (targets.length === 0) {
			lines.push("No live peers to broadcast to.");
		} else if (delivered.length === 0) {
			lines.push("No recipients received the message.");
		} else {
			lines.push(`Delivered to ${delivered.length} peer(s):`);
		}
		for (const receipt of receipts) {
			lines.push(
				receipt.outcome === "failed"
					? `- ${receipt.to}: failed — ${receipt.error ?? "unknown error"}`
					: `- ${receipt.to}: ${receipt.outcome}`,
			);
		}

		if (params.await && waiting && timeoutMs !== undefined) {
			lines.push("");
			if (delivered.length > 0) {
				const reply = await waiting;
				if (reply.error) {
					if (reply.error instanceof IrcAwaitTargetStopped) {
						// The awaited peer ran and stopped without replying: the send
						// still succeeded, so surface a clean note instead of erroring
						// out — and settle now rather than blocking the full timeout.
						lines.push(
							`${to} stopped without replying. ` +
								`Check \`inbox\` or their transcript (history://${to}) for a later answer.`,
						);
					} else if (signal?.aborted) {
						// The send already succeeded; if the wait was interrupted by our
						// caller signal (steering / messaging), preserve the delivery receipt
						// so the agent loop keeps this tool as "sent" instead of marking it
						// skipped, which would prompt a duplicate resend on the next turn.
						lines.push(
							`Send delivered but the reply wait was interrupted before ${to} answered. ` +
								"Check `inbox` or `wait` again after handling the interrupt.",
						);
					} else {
						throw reply.error;
					}
				} else {
					waited = reply.message;
					if (waited) {
						lines.push(`Reply from ${waited.from}:`);
						lines.push(waited.body);
					} else {
						lines.push(
							`No reply from ${to} within ${formatDuration(timeoutMs)}. ` +
								"They may answer later — check `inbox` or `wait` again.",
						);
					}
				}
			} else {
				awaitAbort?.abort(awaitCancelled);
				const reply = await waiting;
				if (reply.error && !(reply.error instanceof IrcAwaitTargetStopped)) throw reply.error;
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "send",
				from: senderId,
				to,
				receipts,
				...(waited !== undefined ? { waited } : {}),
			},
			isError: delivered.length === 0 && targets.length > 0,
		};
	} finally {
		awaitAbort?.abort(awaitCancelled);
		removeAwaitAbortListener?.();
	}
}

/** Pure message wait: no jobs in play, block on the bus with peer liveness for `timeoutMs`. */
export async function executeMessageWait(
	deps: { registry: AgentRegistry; senderId: string },
	params: { from?: string; timeoutMs: number },
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId } = deps;
	const { timeoutMs } = params;
	const from = params.from?.trim() || undefined;
	try {
		const waited = await IrcBus.global().wait(senderId, { from }, timeoutMs, signal, {
			liveness: { registry, senderId },
		});
		if (!waited) {
			const filterNote = from ? ` from ${from}` : "";
			return {
				content: [{ type: "text", text: `No message${filterNote} within ${formatDuration(timeoutMs)}.` }],
				details: { op: "wait", from: senderId, waited: null },
				// A clean wait timeout carries no information once consumed.
				useless: true,
			};
		}
		return messageResult(senderId, waited);
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		return hubErrorResult(error instanceof Error ? error.message : String(error), { op: "wait", from: senderId });
	}
}

export function executeInbox(
	registry: AgentRegistry,
	senderId: string,
	peek?: boolean,
): AgentToolResult<CoordinationDetails> {
	const busMessages = IrcBus.global().inbox(senderId, { peek });
	const session = registry.get(senderId)?.session;
	const pendingMessages =
		typeof session?.drainPendingIrcInboxMessages === "function" ? session.drainPendingIrcInboxMessages(senderId) : [];
	const messages = [...busMessages, ...pendingMessages].sort((a, b) => a.ts - b.ts);
	if (messages.length === 0) {
		return {
			content: [{ type: "text", text: "Inbox empty." }],
			details: { op: "inbox", from: senderId, inbox: [] },
			// An empty inbox drain carries no information once consumed.
			useless: true,
		};
	}
	const header = peek ? `${messages.length} unread message(s):` : `${messages.length} message(s):`;
	const lines = [header, ...messages.map(msg => `- ${formatIncoming(msg)}`)];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "inbox", from: senderId, inbox: messages },
	};
}
