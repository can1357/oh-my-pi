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
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { IrcAwaitTargetStopped, IrcBus, type IrcDeliveryReceipt, type IrcMessage } from "../../irc/bus";
import type { Theme } from "../../modes/theme/theme";
import { type AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { ensurePersistedRoster, isCurrentSessionRosterRef } from "../../registry/persisted-agents";
import { canSpawnAtDepth } from "../../task/types";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../../tui";
import {
	createCachedComponent,
	formatBadge,
	formatErrorDetail,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
} from "../render-utils";
import {
	type CoordinationDetails,
	DEFAULT_HUB_LIST_LIMIT,
	type HubListStatus,
	type HubRenderArgs,
	type HubRosterCounts,
	hubErrorResult,
	MAX_HUB_LIST_LIMIT,
} from "./types";

export { DEFAULT_HUB_LIST_LIMIT, MAX_HUB_LIST_LIMIT } from "./types";

export const DEFAULT_IRC_TIMEOUT_MS = 120_000;

/** Hub roster ordering (running before idle before parked) shared with the child prompt's live-row cap. */
export const LIST_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

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

/** Effective message-wait timeout: explicit param wins, then `irc.timeoutMs`. */
export function resolveMessageTimeoutMs(settings: Settings, explicit?: number): number {
	if (explicit !== undefined) return normalizeIrcTimeoutMs(explicit);
	return normalizeIrcTimeoutMs(settings.get("irc.timeoutMs"));
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

	const bus = IrcBus.forRegistry(registry);
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
	timeoutMs?: number;
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
	// A direct send may address a parked id that another root's scan (or a
	// prior list) restored into this process-global registry. Refresh this
	// caller's persisted roster once before the bus resolves the target, so a
	// same-named parked ref (and the revival that follows it) targets this
	// root's transcript — never requiring a prior `list`. Broadcasts address
	// no id and fan out to live peers only, so they skip the refresh. A
	// missing caller session hint keeps the existing in-memory behavior: no
	// root is guessed from the registry or cwd.
	if (!isBroadcast && sessionFileHint) {
		await ensurePersistedRoster(registry, sessionFileHint);
	}

	const bus = IrcBus.forRegistry(registry);
	let waited: IrcMessage | null | undefined;
	const timeoutMs = params.await ? resolveMessageTimeoutMs(settings, params.timeoutMs) : undefined;
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

/** Pure message wait: no jobs in play, block on the bus with peer liveness. */
export async function executeMessageWait(
	deps: { registry: AgentRegistry; senderId: string; settings: Settings },
	params: { from?: string; timeoutMs?: number },
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, settings } = deps;
	const from = params.from?.trim() || undefined;
	const timeoutMs = resolveMessageTimeoutMs(settings, params.timeoutMs);
	try {
		const waited = await IrcBus.forRegistry(registry).wait(senderId, { from }, timeoutMs, signal, {
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
	const busMessages = IrcBus.forRegistry(registry).inbox(senderId, { peek });
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

// =============================================================================
// TUI Renderer (messaging half)
// =============================================================================

const BODY_LINES_COLLAPSED = 2;
const BODY_LINES_EXPANDED = 12;
const BODY_LINE_WIDTH = 100;

function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}

function outcomeColor(outcome: IrcDeliveryReceipt["outcome"]): ToolUIColor {
	switch (outcome) {
		case "woken":
			return "success";
		case "revived":
			return "warning";
		case "injected":
			return "accent";
		case "failed":
			return "error";
	}
}

/** Glyph + status word, matching the agent-hub status conventions. */
function peerStatusBadge(status: string, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("accent", `${theme.status.running} running`);
		case "idle":
			return theme.fg("success", `${theme.status.enabled} idle`);
		case "parked":
			return theme.fg("muted", `${theme.status.shadowed} parked`);
		default:
			return theme.fg("error", `${theme.status.aborted} ${status}`);
	}
}

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text?.trim() ?? "";
}

/**
 * Quote-bordered message body preview. `tone` separates outbound text (dim)
 * from received text (toolOutput); a trailing dim counter marks elided lines.
 */
function bodyLines(
	body: string,
	expanded: boolean,
	theme: Theme,
	options: { indent?: string; tone?: "dim" | "toolOutput"; collapsedLines?: number } = {},
): string[] {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "toolOutput";
	const max = expanded ? BODY_LINES_EXPANDED : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
	const total = body.split("\n").filter(line => line.trim()).length;
	const quote = theme.fg("dim", theme.md.quoteBorder);
	const lines = getPreviewLines(body, max, BODY_LINE_WIDTH, Ellipsis.Unicode).map(
		line => `${indent}${quote} ${theme.fg(tone, replaceTabs(line))}`,
	);
	const hidden = total - Math.min(total, max);
	if (hidden > 0) {
		lines.push(`${indent}${quote} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
	}
	return lines;
}

/** Header title carrying the op direction: `IRC ➤ peer` out, `IRC ⟵ peer` in. */
function callTitle(args: HubRenderArgs | undefined, theme: Theme): string {
	switch (args?.op) {
		case "send":
			return `IRC ${theme.nav.selected} ${args.to?.trim() || "…"}`;
		case "wait":
			return `IRC ${theme.nav.back} ${args.from?.trim() || "anyone"}`;
		case "inbox":
			return "IRC inbox";
		case "list":
			return "IRC peers";
		default:
			return "Hub";
	}
}

function callMeta(args: HubRenderArgs | undefined): string[] {
	const meta: string[] = [];
	if (args?.op === "send") {
		if (args.to === "all") meta.push("broadcast");
		if (args.await) meta.push("await reply");
		if (args.replyTo) meta.push("reply");
	}
	if (args?.op === "wait" && args.timeoutMs) meta.push(`timeout ${formatDuration(args.timeoutMs)}`);
	if (args?.op === "inbox" && args.peek) meta.push("peek");
	return meta;
}

function renderErrorResult(
	result: { content: Array<{ type: string; text?: string }> },
	args: HubRenderArgs | undefined,
	theme: Theme,
): string[] {
	const text = textContent(result) || "IRC call failed.";
	return [
		renderStatusLine({ icon: "error", title: callTitle(args, theme), meta: callMeta(args) }, theme),
		formatErrorDetail(text, theme),
	];
}

/**
 * Display-only transcript card for live IRC traffic: `irc:incoming` DMs
 * delivered to this session, `irc:autoreply` side-channel replies sent on
 * this session's behalf, and `irc:relay` observations of agent↔agent
 * traffic. Shares the tool renderer's glyph + quote-border conventions so
 * cards and hub messaging output look identical in the transcript.
 */
export function createIrcMessageCard(
	card: {
		kind: "incoming" | "autoreply" | "relay";
		from?: string;
		to?: string;
		body?: string;
		replyTo?: string;
		timestamp?: number;
	},
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const from = card.from?.trim() || "?";
	const title =
		card.kind === "incoming"
			? `IRC ${uiTheme.nav.back} ${from}`
			: card.kind === "autoreply"
				? `IRC ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`
				: `IRC ${from} ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`;
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
			if (body.trim()) {
				lines.push(...bodyLines(body, expanded, uiTheme, { indent: "  ", collapsedLines: 3 }));
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}

function renderSendResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const receipts = details.receipts ?? [];
	const to = details.to ?? args?.to?.trim() ?? "?";
	const title = `IRC ${theme.nav.selected} ${to}`;

	// Pre-delivery failures (validation) and empty broadcasts carry no receipts.
	if (receipts.length === 0) {
		const text = textContent(result) || (result.isError ? "Send failed." : "Nothing to deliver.");
		return [
			renderStatusLine({ icon: result.isError ? "error" : "warning", title }, theme),
			result.isError ? formatErrorDetail(text, theme) : `  ${theme.fg("muted", replaceTabs(text))}`,
		];
	}

	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	const failedCount = receipts.length - delivered.length;
	const waited = details.waited;
	const timedOut = waited === null;

	const meta: string[] = [];
	if (to === "all") meta.push("broadcast");
	if (receipts.length === 1) {
		const receipt = receipts[0]!;
		meta.push(theme.fg(outcomeColor(receipt.outcome), receipt.outcome));
	} else {
		if (delivered.length > 0) meta.push(theme.fg("success", `${delivered.length} delivered`));
		if (failedCount > 0) meta.push(theme.fg("error", `${failedCount} failed`));
	}
	if (timedOut) meta.push(theme.fg("warning", "no reply"));

	const icon = result.isError
		? { icon: "error" as const }
		: timedOut
			? { icon: "warning" as const }
			: { iconOverride: ircGlyph(theme) };
	const lines = [renderStatusLine({ ...icon, title, meta }, theme)];

	const sent = args?.message?.trim();
	if (sent) lines.push(...bodyLines(sent, expanded, theme, { indent: "  ", tone: "dim" }));

	if (receipts.length > 1 || failedCount > 0) {
		lines.push(
			...renderTreeList<IrcDeliveryReceipt>(
				{
					items: receipts,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "recipient",
					renderItem: receipt => {
						const badge = formatBadge(receipt.outcome, outcomeColor(receipt.outcome), theme);
						const error =
							receipt.outcome === "failed" && receipt.error
								? ` ${theme.fg("error", `${theme.format.dash} ${receipt.error}`)}`
								: "";
						return `${theme.fg("toolOutput", receipt.to)} ${badge}${error}`;
					},
				},
				theme,
			),
		);
	}

	if (waited) {
		const age = messageAge(waited.ts);
		lines.push(
			`  ${theme.fg("dim", theme.nav.back)} ${theme.fg("accent", waited.from)}${age ? ` ${theme.fg("dim", age)}` : ""}`,
		);
		lines.push(...bodyLines(waited.body, expanded, theme, { indent: "  " }));
	} else if (timedOut) {
		lines.push(`  ${theme.fg("warning", "No reply yet — they may answer later; check inbox or wait again.")}`);
	}
	return lines;
}

function renderWaitResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const waited = details.waited;
	if (!waited) {
		const text = textContent(result) || "No message arrived.";
		return [
			renderStatusLine(
				{ icon: "warning", title: `IRC ${theme.nav.back} ${args?.from?.trim() || "anyone"}`, meta: ["timed out"] },
				theme,
			),
			`  ${theme.fg("muted", replaceTabs(text))}`,
		];
	}
	const meta = [messageAge(waited.ts)];
	if (waited.replyTo) meta.push("reply");
	return [
		renderStatusLine({ iconOverride: ircGlyph(theme), title: `IRC ${theme.nav.back} ${waited.from}`, meta }, theme),
		...bodyLines(waited.body, expanded, theme, { indent: "  " }),
	];
}

function renderInboxResult(
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const messages = details.inbox ?? [];
	if (messages.length === 0) {
		return [renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta: ["empty"] }, theme)];
	}
	const meta = [`${messages.length} ${messages.length === 1 ? "message" : "messages"}`];
	if (args?.peek) meta.push("peek");
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta }, theme);
	const items = renderTreeList<IrcMessage>(
		{
			items: messages,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "message",
			renderItem: msg => {
				const age = messageAge(msg.ts);
				const replyBadge = msg.replyTo ? ` ${formatBadge("reply", "muted", theme)}` : "";
				const head = `${theme.fg("accent", msg.from)}${age ? ` ${theme.fg("dim", age)}` : ""}${replyBadge}`;
				return [head, ...bodyLines(msg.body, expanded, theme, { collapsedLines: 1 })];
			},
		},
		theme,
	);
	return [header, ...items];
}

function renderListResult(details: Partial<CoordinationDetails>, expanded: boolean, theme: Theme): string[] {
	const peers = [...(details.peers ?? [])].sort(
		(a, b) =>
			(LIST_STATUS_ORDER[a.status] ?? 9) - (LIST_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
	);
	const rosterCounts = details.counts;
	if (peers.length === 0) {
		const meta =
			rosterCounts && rosterCounts.running + rosterCounts.idle + rosterCounts.parked > 0
				? [
						`${rosterCounts.running} running`,
						`${rosterCounts.idle} idle`,
						`${rosterCounts.parked} parked`,
						...(rosterCounts.truncated > 0 ? [`${rosterCounts.truncated} truncated`] : []),
					]
				: ["no other agents"];
		return [renderStatusLine({ icon: "info", title: "IRC peers", meta }, theme)];
	}
	const counts = new Map<string, number>();
	for (const peer of peers) counts.set(peer.status, (counts.get(peer.status) ?? 0) + 1);
	const meta = rosterCounts
		? [
				`${rosterCounts.running} running`,
				`${rosterCounts.idle} idle`,
				`${rosterCounts.parked} parked`,
				...(rosterCounts.truncated > 0 ? [`${rosterCounts.truncated} truncated`] : []),
			]
		: [...counts].map(([status, count]) => `${count} ${status}`);
	const unreadTotal = peers.reduce((sum, peer) => sum + peer.unread, 0);
	if (unreadTotal > 0) meta.push(theme.fg("warning", `${unreadTotal} unread`));
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC peers", meta }, theme);
	const items = renderTreeList(
		{
			items: peers,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "peer",
			renderItem: peer => {
				const kindText = peer.parentId ? `${peer.kind}${theme.sep.dot}of ${peer.parentId}` : peer.kind;
				const unread = peer.unread > 0 ? ` ${formatBadge(`${peer.unread} unread`, "warning", theme)}` : "";
				const age = messageAge(peer.lastActivity);
				const activity = peer.activity ? ` ${theme.fg("dim", replaceTabs(peer.activity))}` : "";
				const name = theme.fg("dim", replaceTabs(peer.displayName));
				return `${peerStatusBadge(peer.status, theme)} ${theme.bold(replaceTabs(peer.id))} ${name} ${theme.fg("dim", kindText)}${activity}${unread}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			},
		},
		theme,
	);
	return [header, ...items];
}
function buildResultLines(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	switch (details.op ?? args?.op) {
		case "send":
			return renderSendResult(result, details, args, expanded, theme);
		case "wait":
			return renderWaitResult(result, details, args, expanded, theme);
		case "inbox":
			return result.isError
				? renderErrorResult(result, args, theme)
				: renderInboxResult(details, args, expanded, theme);
		case "list":
			return result.isError ? renderErrorResult(result, args, theme) : renderListResult(details, expanded, theme);
		default: {
			const text = textContent(result) || (result.isError ? "Hub call failed." : "Done.");
			return [
				renderStatusLine({ icon: result.isError ? "error" : "success", title: callTitle(args, theme) }, theme),
				result.isError ? formatErrorDetail(text, theme) : `  ${theme.fg("muted", replaceTabs(text))}`,
			];
		}
	}
}

/** Pending-call frame for messaging ops (send/wait-from/inbox/list). */
export function messagingRenderCall(args: HubRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
	const lines = [
		renderStatusLine({ icon: "pending", title: callTitle(args, uiTheme), meta: callMeta(args) }, uiTheme),
	];
	if (args?.op === "send" && args.message?.trim()) {
		lines.push(...bodyLines(args.message, false, uiTheme, { indent: "  ", tone: "dim", collapsedLines: 1 }));
	}
	return new Text(lines.join("\n"), 0, 0);
}

/** Result frame for messaging ops and message-carrying `wait` results. */
export function messagingRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
	args?: HubRenderArgs,
): Component {
	const details: Partial<CoordinationDetails> = result.details ?? {};
	return createCachedComponent(
		() => options.expanded,
		(width, expanded) =>
			buildResultLines(result, details, args, expanded, uiTheme).map(line =>
				truncateToWidth(line, width, Ellipsis.Unicode),
			),
	);
}
