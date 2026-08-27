/**
 * Shared types for the hub tool — the merged agent-coordination surface
 * covering peer messaging (IRC bus), background-job control, and supervised
 * long-running processes (launch).
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AsyncJobType } from "../../async";
import type { IrcDeliveryReceipt, IrcMessage } from "../../irc/bus";
import type { LaunchParams, LaunchToolDetails } from "./launch";

/**
 * Hub operations: messaging (`send`/`wait`/`inbox`/`list`), jobs
 * (`wait`/`cancel`/`jobs`), and process supervision (`start`/`ps`/`logs`/
 * `stop`/`restart`/`describe`, plus `send`/`wait` when they carry `name`).
 */
export type HubOp =
	| "send"
	| "wait"
	| "inbox"
	| "list"
	| "jobs"
	| "cancel"
	| "start"
	| "ps"
	| "logs"
	| "stop"
	| "restart"
	| "describe";

/** Peer row surfaced by `op:"list"`. */
export interface HubPeerInfo {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
	lastActivity: number;
	activity?: string;
}

/** Status values `op:"list"` can filter on. Advisor is a kind, not a status. */
export type HubListStatus = "running" | "idle" | "parked";
/** Model-facing roster bounds shared by the hub schema and executor. */
export const DEFAULT_HUB_LIST_LIMIT = 32;
export const MAX_HUB_LIST_LIMIT = 100;

/** Addressable roster tallies always returned by `op:"list"`. */
export interface HubRosterCounts {
	running: number;
	idle: number;
	parked: number;
	shown: number;
	truncated: number;
}

/** Background-job row surfaced by `wait`/`cancel`/`jobs` results. */
export interface JobSnapshot {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	/** Effective task model selector, including an explicit reasoning suffix when configured. */
	resolvedModel?: string;
	resultText?: string;
	errorText?: string;
}

export type CancelStatus = "cancelled" | "not_found" | "already_completed";

export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/**
 * A live subagent from the AgentRegistry that has no backing job in the
 * AsyncJobManager — e.g. an idle agent woken (or a parked agent revived) via
 * a hub message, or a spawn owned by another agent. Surfaced by `jobs` and
 * empty-wait snapshots so the hub's picture matches the UI's running-agent
 * count.
 */
export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry (display-only). */
	activity?: string;
	/** Time since the agent was registered. */
	ageMs: number;
	/**
	 * Whether an attached session corroborates the `running` claim. False marks
	 * a ref that says `running` with no turn in flight — either a spawn still
	 * wiring up or a stale registration that `hub cancel <id>` clears (#8634).
	 */
	live: boolean;
}

/** Result details for messaging and job ops; fields are disjoint per op. */
export interface CoordinationDetails {
	op: HubOp;
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** Message consumed by `wait` / `send await:true`; null when the wait timed out. */
	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: HubPeerInfo[];
	/** Present on `op:"list"`: addressable running/idle/parked plus page size. */
	counts?: HubRosterCounts;
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
}

/** Hub result details: coordination snapshots or launch (process) state. */
export type HubDetails = CoordinationDetails | LaunchToolDetails;

/** Partially-streamed hub call arguments, as seen by the renderers. */
export type HubRenderArgs = {
	op?: string;
	to?: string;
	message?: string;
	replyTo?: string;
	await?: boolean;
	from?: string;
	timeoutMs?: number;
	peek?: boolean;
	ids?: string[];
} & Partial<Omit<LaunchParams, "op">>;

export function hubErrorResult(text: string, details: CoordinationDetails): AgentToolResult<HubDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}
