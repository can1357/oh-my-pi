/** `irc` — inter-agent messaging: send/wait/inbox/list ops with delivery receipts. */
import type { ReactNode } from "react";
import type { Tone } from "../parts";
import { Badge, Badges, Note, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util";

interface IrcReceipt {
	to: string;
	outcome: string;
	error?: string;
}

interface IrcMsg {
	from: string;
	body: string;
	replyTo?: string;
}

interface IrcPeer {
	id: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
}

function parseReceipts(value: unknown): IrcReceipt[] {
	if (!Array.isArray(value)) return [];
	const out: IrcReceipt[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const to = str(item.to);
		const outcome = str(item.outcome);
		if (to === null || outcome === null) continue;
		out.push({ to, outcome, error: str(item.error) ?? undefined });
	}
	return out;
}

function parseMsg(value: unknown): IrcMsg | null {
	if (!isRecord(value)) return null;
	const from = str(value.from);
	const body = str(value.body);
	if (from === null || body === null) return null;
	return { from, body, replyTo: str(value.replyTo) ?? undefined };
}

function parseInbox(value: unknown): IrcMsg[] {
	if (!Array.isArray(value)) return [];
	const out: IrcMsg[] = [];
	for (const item of value) {
		const msg = parseMsg(item);
		if (msg) out.push(msg);
	}
	return out;
}

const PEER_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

function parsePeers(value: unknown): IrcPeer[] {
	if (!Array.isArray(value)) return [];
	const out: IrcPeer[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const id = str(item.id);
		if (id === null) continue;
		out.push({
			id,
			kind: str(item.kind) ?? "?",
			status: str(item.status) ?? "?",
			parentId: str(item.parentId) ?? undefined,
			unread: typeof item.unread === "number" && Number.isFinite(item.unread) ? item.unread : 0,
		});
	}
	return out.sort((a, b) => (PEER_STATUS_ORDER[a.status] ?? 9) - (PEER_STATUS_ORDER[b.status] ?? 9));
}

/** Mirrors the TUI's outcomeColor: woken=success, revived=warning, injected=accent, failed=error. */
function outcomeTone(outcome: string): Tone | undefined {
	switch (outcome) {
		case "woken":
			return "ok";
		case "revived":
			return "warn";
		case "injected":
			return "accent";
		case "failed":
			return "err";
		default:
			return undefined;
	}
}

function statusTone(status: string): Tone | undefined {
	switch (status) {
		case "running":
			return "accent";
		case "idle":
			return "ok";
		case "parked":
			return undefined;
		default:
			return "err";
	}
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op) ?? "?";
	const d = detailsRecord(result);
	const opBadge = <Badge tone={result?.isError ? "err" : op === "send" ? "accent" : undefined}>{op}</Badge>;
	if (op === "send") {
		const to = str(args.to);
		const message = str(args.message);
		return (
			<>
				{opBadge} {to && <span className="tv-pattern">→ {to}</span>}{" "}
				{message && <span className="tv-muted">{truncate(normalizeWs(message), 80)}</span>}
			</>
		);
	}
	if (op === "wait") {
		const waited = d ? parseMsg(d.waited) : null;
		if (waited) {
			return (
				<>
					{opBadge} <span className="tv-pattern">← {waited.from}</span>{" "}
					<span className="tv-muted">{truncate(normalizeWs(waited.body), 80)}</span>
				</>
			);
		}
		const from = str(args.from);
		return (
			<>
				{opBadge} <span className="tv-pattern">← {from ?? "anyone"}</span>
				{d?.waited === null && (
					<>
						{" "}
						<Badge tone="warn">timed out</Badge>
					</>
				)}
			</>
		);
	}
	if (op === "inbox") {
		const inbox = d ? parseInbox(d.inbox) : [];
		return (
			<>
				{opBadge} {args.peek === true && <Badge>peek</Badge>}{" "}
				{d && (
					<span className="tv-muted">
						{inbox.length === 0 ? "empty" : `${inbox.length} ${inbox.length === 1 ? "message" : "messages"}`}
					</span>
				)}
			</>
		);
	}
	if (op === "list") {
		const peers = d ? parsePeers(d.peers) : [];
		let unread = 0;
		for (const peer of peers) unread += peer.unread;
		return (
			<>
				{opBadge} {d && <span className="tv-muted">{peers.length === 1 ? "1 peer" : `${peers.length} peers`}</span>}
				{unread > 0 && (
					<>
						{" "}
						<Badge tone="warn">{unread} unread</Badge>
					</>
				)}
			</>
		);
	}
	return opBadge;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const op = str(args.op);
	const to = str(args.to);
	const from = str(args.from);
	const message = str(args.message);
	const d = detailsRecord(result);
	const receipts = parseReceipts(d?.receipts);
	const waited = d ? parseMsg(d.waited) : null;
	const timedOut = d ? d.waited === null : false;
	const inbox = parseInbox(d?.inbox);
	const peers = parsePeers(d?.peers);
	const structured = receipts.length > 0 || waited !== null || timedOut || inbox.length > 0 || peers.length > 0;
	return (
		<>
			<Badges
				items={[
					op ?? "?",
					to && `to ${to}`,
					op === "wait" && from && `from ${from}`,
					to === "all" && "broadcast",
					args.await === true && "await reply",
					str(args.replyTo) && "reply",
					args.peek === true && "peek",
				]}
			/>
			{message && <Note>{message}</Note>}
			{receipts.length > 0 && (
				<div className="tv-list">
					{receipts.map((receipt, i) => (
						<Row key={i} k={receipt.to}>
							<Badge tone={outcomeTone(receipt.outcome)}>{receipt.outcome}</Badge>
							{receipt.error && <span className="tv-err-text"> — {receipt.error}</span>}
						</Row>
					))}
				</div>
			)}
			{waited && (
				<div className="tv-list">
					<Row k={`← ${waited.from}`}>
						{waited.body}
						{waited.replyTo && (
							<>
								{" "}
								<Badge>reply</Badge>
							</>
						)}
					</Row>
				</div>
			)}
			{timedOut && <Note tone="warn">No reply yet — they may answer later; check inbox or wait again.</Note>}
			{inbox.length > 0 && (
				<div className="tv-list">
					{inbox.map((msg, i) => (
						<Row key={i} k={msg.from}>
							{msg.body}
							{msg.replyTo && (
								<>
									{" "}
									<Badge>reply</Badge>
								</>
							)}
						</Row>
					))}
				</div>
			)}
			{peers.length > 0 && (
				<div className="tv-list">
					{peers.map(peer => (
						<Row key={peer.id} k={peer.id}>
							<Badge tone={statusTone(peer.status)}>{peer.status}</Badge>{" "}
							<span className="tv-faint">
								{peer.parentId ? `${peer.kind} · of ${peer.parentId}` : peer.kind}
							</span>
							{peer.unread > 0 && (
								<>
									{" "}
									<Badge tone="warn">{peer.unread} unread</Badge>
								</>
							)}
						</Row>
					))}
				</div>
			)}
			{(!structured || result?.isError) && <ResultText result={result} maxLines={8} />}
		</>
	);
}

export const ircRenderer: ToolRenderer = { Summary, Body };
