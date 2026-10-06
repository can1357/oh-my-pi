import type { PermissionClass } from "./policy";

export const MESSAGING_WIRE_VERSION = 1;
export const MAX_SERIALIZED_CHARS = 1_048_576;
export const LINE_DEADLINE_MS = 30_000;
export const ACCEPTED_QUEUE_CAP = 50;
export const HELD_CAP = 100;
export const IDLE_SUBSCRIPTION_TTL_MS = 12 * 60 * 60 * 1000;
export const SNAPSHOT_TIMEOUT_MS = 1_500;
export const SEND_TIMEOUT_MS = 30_000;

export interface AuthLine {
	type: "auth";
	token: string;
}
export interface ServerChallengeLine {
	type: "challenge";
	nonce: string;
}
export interface ServerProofLine {
	type: "proof";
	proof: string;
}
export interface SenderInfo {
	sessionId: string;
	name: string | null;
	shortId: string;
	cwd: string;
	entryId: string;
	class: PermissionClass;
}
export interface SessionSnapshot {
	v: number;
	sessionId: string;
	name: string | null;
	shortId: string;
	title: string | null;
	cwd: string;
	busy: boolean;
	pid: number;
	startedAt: number;
}
export type DropReason = "queue_full" | "rate" | "repeat" | "relay_loop";
export type InboxRequest =
	| { type: "snapshot" }
	| { type: "message"; id: string; from?: SenderInfo; body: string; chain?: string[]; notifyWhenIdle?: boolean }
	| { type: "subscribe"; id: string; from: SenderInfo }
	| {
			type: "notice";
			id: string;
			from: SenderInfo;
			kind: "refused";
			subject: "message";
			aboutId: string;
			toSessionId: string;
	  }
	| {
			type: "notice";
			id: string;
			from: SenderInfo;
			kind: "idle" | "exited" | "expired" | "dropped" | "subscribed" | "retired";
			subject?: "message" | "subscription";
			finishedAt?: number;
			status?: string;
			reason?: DropReason;
			aboutId?: string;
	  };
export type InboxResponse =
	| { ok: true; snapshot: SessionSnapshot }
	| { ok: true; outcome: "delivered" | "held" | "refused" | "subscribed" }
	| { ok: true; outcome: "queued"; receivingSuspended?: true }
	| { ok: true; outcome: "dropped"; reason: DropReason }
	| { ok: false; error: string };

export class MessagingUnavailableError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.name = "MessagingUnavailableError";
		this.reason = reason;
	}
}

export function isMailboxSessionId(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) && value !== "." && value !== "..";
}

function isSender(raw: unknown): raw is SenderInfo {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
	const value = raw as Record<string, unknown>;
	return (
		Object.keys(value).every(key => ["sessionId", "name", "shortId", "cwd", "entryId", "class"].includes(key)) &&
		isMailboxSessionId(value.sessionId) &&
		(value.name === null || typeof value.name === "string") &&
		typeof value.shortId === "string" &&
		/^[0-9a-f]{8}$/.test(value.shortId) &&
		typeof value.cwd === "string" &&
		value.cwd.length <= 4096 &&
		typeof value.entryId === "string" &&
		/^[a-z0-9-]{8,64}$/.test(value.entryId) &&
		(value.class === "bypass" || value.class === "prompting")
	);
}

/** Validate untrusted inbox JSON without coercing or silently dropping fields. */
export function parseInboxRequest(raw: unknown): InboxRequest | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.type === "snapshot") return Object.keys(value).length === 1 ? { type: "snapshot" } : undefined;
	if (typeof value.id !== "string" || value.id.length === 0) return undefined;
	switch (value.type) {
		case "message":
			if (
				!Object.keys(value).every(key => ["type", "id", "from", "body", "chain", "notifyWhenIdle"].includes(key)) ||
				typeof value.body !== "string" ||
				(value.from !== undefined && !isSender(value.from)) ||
				(value.notifyWhenIdle !== undefined && typeof value.notifyWhenIdle !== "boolean") ||
				(value.chain !== undefined &&
					(!Array.isArray(value.chain) ||
						value.chain.length > 64 ||
						!value.chain.every(id => typeof id === "string" && /^[0-9a-f]{8}$/.test(id))))
			)
				return undefined;
			return value as InboxRequest;
		case "subscribe":
			if (!Object.keys(value).every(key => ["type", "id", "from"].includes(key)) || !isSender(value.from)) {
				return undefined;
			}
			return value as InboxRequest;
		case "notice":
			if (
				!Object.keys(value).every(key =>
					[
						"type",
						"id",
						"from",
						"kind",
						"subject",
						"finishedAt",
						"status",
						"reason",
						"aboutId",
						"toSessionId",
					].includes(key),
				) ||
				!isSender(value.from) ||
				typeof value.kind !== "string" ||
				!["idle", "exited", "expired", "dropped", "subscribed", "retired", "refused"].includes(value.kind) ||
				(value.kind === "refused"
					? value.subject !== "message" ||
						typeof value.aboutId !== "string" ||
						!value.aboutId ||
						!isMailboxSessionId(value.toSessionId)
					: value.toSessionId !== undefined) ||
				(value.subject !== undefined && value.subject !== "message" && value.subject !== "subscription") ||
				(value.finishedAt !== undefined &&
					(typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt))) ||
				(value.status !== undefined && typeof value.status !== "string") ||
				(value.reason !== undefined &&
					(typeof value.reason !== "string" ||
						!["queue_full", "rate", "repeat", "relay_loop"].includes(value.reason))) ||
				(value.aboutId !== undefined && typeof value.aboutId !== "string")
			)
				return undefined;
			return value as InboxRequest;
		default:
			return undefined;
	}
}
