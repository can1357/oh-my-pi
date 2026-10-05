import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import type { Settings } from "../config/settings";
import type { MessagingService, SessionCandidate } from "../messaging/service";
import { peerDisplayText } from "../messaging/names";
import { IrcBus } from "./bus";
import type { AgentRegistryApi } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { canSpawnAtDepth } from "../task/types";

import { cfgTaskMaxRecursionDepth } from "../task/settings";

function coordinationErrorResult(text: string, details: CoordinationDetails): AgentToolResult<CoordinationDetails> {
	return { content: [{ type: "text", text }], details, isError: true };
}

/** Messaging is available to subagents and to top-level sessions able to spawn peers. */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	const maxDepth = cfgTaskMaxRecursionDepth.get(settings);
	return canSpawnAtDepth(maxDepth, taskDepth);
}

export function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	const progressTag = msg.progress ? " (progress; reply follows)" : "";
	return `[${msg.id}] ${msg.from}${replyTag}${progressTag}: ${msg.body}`;
}

/** Takes every message buffered in `senderId`'s session inbox before automatic injection; with `ifAny`, none unless one satisfies it. */
export function drainPendingInbox(
	registry: AgentRegistryApi,
	senderId: string,
	ifAny?: (msg: IrcMessage) => boolean,
): IrcMessage[] {
	const session = registry.get(senderId)?.session;
	return typeof session?.drainPendingIrcInboxMessages === "function"
		? session.drainPendingIrcInboxMessages(senderId, ifAny ? { ifAny } : undefined)
		: [];
}

/** `wait` result carrying the consumed messages, oldest first. */
export function messageResult(senderId: string, waited: IrcMessage[]): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: waited.map(formatIncoming).join("\n\n") }],
		details: { op: "wait", from: senderId, waited },
	};
}

/** Send a direct message or, from a top-level agent only, a broadcast; delivery never waits for a reply. */
export async function executeSend(
	deps: {
		registry: AgentRegistryApi;
		senderId: string;
		sessionFileHint?: string | null;
		messaging?: MessagingService;
	},
	params: { to: string; message: string; progress?: boolean; notifyWhenIdle?: boolean },
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, sessionFileHint, messaging } = deps;
	const to = params.to.trim();
	const message = params.message;
	const notifyWhenIdle = messaging !== undefined && params.notifyWhenIdle === true;
	if (!to) return coordinationErrorResult("A recipient is required.", { op: "send", from: senderId });
	if (!message.trim() && !notifyWhenIdle)
		return coordinationErrorResult("A non-empty message is required.", { op: "send", from: senderId });
	if (to === senderId && !messaging)
		return coordinationErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	const isBroadcast = to === "all";
	// A subagent's broadcast wakes every live peer for news that is almost never
	// theirs; it messages the one agent that can answer instead.
	if (isBroadcast && registry.get(senderId)?.kind !== "main")
		return coordinationErrorResult(
			"Only the main agent can broadcast. Message the one agent that can answer via `agent://<id>`.",
			{ op: "send", from: senderId, to },
		);
	// Restore parked recipients only when needed; never delay delivery to a live peer.
	if (!isBroadcast && sessionFileHint) {
		const recipient = registry.get(to);
		if (!recipient || recipient.status === "parked") await ensurePersistedRoster(registry, sessionFileHint);
	}
	if (!isBroadcast && messaging) {
		const local = registry.get(to);
		const localCandidate = local && local.id !== senderId && local.kind !== "advisor" && local.status !== "aborted";
		// A local agent match skips the saved-session disk scan; live sessions are still checked for a name clash.
		const resolution = await messaging.resolve(to, { includeOffline: !localCandidate });
		if (resolution.kind === "self") {
			return coordinationErrorResult("That is this session's own name.", { op: "send", from: senderId, to });
		}
		if (resolution.kind === "incompatible") {
			return coordinationErrorResult(
				`Not sent: ${peerDisplayText(resolution.name)} runs an incompatible omp version.`,
				{
					op: "send",
					from: senderId,
					to,
				},
			);
		}
		const sessions: SessionCandidate[] =
			resolution.kind === "found" || resolution.kind === "offline"
				? [resolution.target]
				: resolution.kind === "ambiguous"
					? resolution.candidates
					: [];
		if (sessions.length + (localCandidate ? 1 : 0) > 1) {
			const rows = sessions.map(
				session =>
					`- ${peerDisplayText(session.name ?? "(unnamed)")} (session ${session.shortId}, ${peerDisplayText(session.cwd)})`,
			);
			if (localCandidate) rows.push(`- ${peerDisplayText(to)} (local agent)`);
			return coordinationErrorResult(
				`Not sent: "${peerDisplayText(to)}" matches more than one agent:\n${rows.join("\n")}\nAddress one by its session short id.`,
				{ op: "send", from: senderId, to },
			);
		}
		if (resolution.kind === "found" || resolution.kind === "offline") {
			const outcome = await messaging.send(resolution.target, message, {
				notifyWhenIdle,
			});
			return {
				content: [{ type: "text", text: outcome.text }],
				details: { op: "send", from: senderId, to },
				isError: !outcome.ok,
			};
		}
	}
	if (to === senderId) {
		return coordinationErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	}
	if (notifyWhenIdle) {
		return coordinationErrorResult("Not sent: notify=idle only works for your other sessions.", {
			op: "send",
			from: senderId,
			to,
		});
	}

	const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
	const bus = IrcBus.global();
	const receipts = await Promise.all(
		targets.map(target =>
			bus.send({
				from: senderId,
				to: target,
				body: message,
				...(isBroadcast ? { broadcast: true } : {}),
				...(params.progress ? { progress: true } : {}),
			}),
		),
	);
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	let text: string;
	if (isBroadcast) {
		text =
			targets.length === 0
				? "No live peers to broadcast to."
				: `Broadcast delivered to ${delivered.length} of ${targets.length} peer(s).`;
		if (receipts.length) {
			text += `\n${receipts
				.map(receipt =>
					receipt.outcome === "failed"
						? `- ${receipt.to}: failed — ${receipt.error ?? "not running"}`
						: `- ${receipt.to}: ${receipt.outcome}`,
				)
				.join("\n")}`;
		}
	} else {
		const receipt = receipts[0]!;
		const recipient = registry.get(to);
		const unavailable = !recipient || recipient.status === "aborted" || !recipient.session;
		text =
			receipt.outcome === "failed"
				? `Failed: ${to} ${unavailable ? "is not running" : "could not receive the message"}. ${receipt.error ?? ""}`.trimEnd()
				: receipt.outcome === "revived"
					? `Queued for ${to} (was parked; revived).`
					: `Delivered to ${to}.`;
	}
	return {
		content: [{ type: "text", text }],
		details: { op: "send", from: senderId, to, receipts },
		isError: delivered.length === 0 && targets.length > 0,
	};
}
