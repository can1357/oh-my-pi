/**
 * Capability channel-store event port.
 *
 * omp's in-run events — background jobs, subagent tasks, owned services, IRC
 * inbox arrivals, and replies owed to this session — land as completion
 * records in the machine-state channel store the capability runtime owns
 * (capability-replicas mastra/src/capability/channel/store.ts): one
 * `completions.jsonl` under `~/.local/state/capability-channels/`, one JSON
 * line per record, addressed to the owning session by `to`. The capability
 * MCP server's `wait` settles on these records (`pendingFor`), which is what
 * lets one wait replace omp's built-in wait uniformly in every harness
 * (design §5/§8). The session record in
 * `~/.local/state/capability-sessions/<id>.json` mirrors the capability boot
 * reader's shape (sessions.ts `session_record_schema`), which the server —
 * stamped with `CAPABILITY_SESSION_ID` — overwrites authoritatively at its
 * own boot.
 *
 * Landed record shape, one JSON line per event:
 * `{ id: "c-<12hex>", kind: "completion", channel: "completions", to, from: "omp",
 *    subject, body, created_at: <epoch ms>, expires_at?, about?: { type, id, exit_code?, state? } }`
 */
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { getProjectDir, isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AsyncJob } from "../async/job-manager";
import { isCapabilityServerAvailable } from "../discovery/capability-server";

/** The one channel every completion record is written to (store.ts `COMPLETIONS_CHANNEL`). */
export const COMPLETIONS_CHANNEL = "completions";

/** `from` for every completion omp writes: the harness, not an agent. */
const COMPLETION_FROM = "omp";

/** The session a channel belongs to: omp's identity for the store. */
export interface CapabilityChannelIdentity {
	harness: "omp";
	session_id: string;
	checkout: string;
}

/**
 * What completed, as the landed store's `about` carries it. The capability
 * enum is being widened to the full set; `type` is the omp-side spelling of
 * the kinds the sketch named (job, task, service, reply, inbox, herdr, wait).
 */
export type CapabilityChannelAboutType = "job" | "task" | "service" | "reply" | "inbox" | "herdr" | "wait";

/** One completion record in the channel store (see the module doc for shape). */
export interface CapabilityChannelRecord {
	/** `c-` + 12 hex, in the store's id grammar (store.ts `newRecordId`). */
	id: string;
	kind: "completion";
	channel: "completions";
	/** The owning session id: whose `wait` may settle on this record. */
	to: string;
	from: "omp";
	/** Human-readable summary of what completed. */
	subject: string;
	/** Structured detail, as text. */
	body: string;
	/** Epoch milliseconds. */
	created_at: number;
	/** Completions never expire; the ack removes them. */
	expires_at?: number;
	about?: {
		type: CapabilityChannelAboutType;
		id: string;
		exit_code?: number;
		state?: string;
	};
}

/** The completion half of a record, before the store addressing is applied. */
export interface CapabilityChannelEvent {
	type: CapabilityChannelAboutType;
	/** The completed thing's own id: job id, service name, message id. */
	id: string;
	subject: string;
	body: string;
	exit_code?: number;
	state?: string;
}

/** State root override (tests point it at a temp dir): `OMP_CAPABILITY_STATE_DIR`. */
export function capabilityStateDir(): string {
	return process.env.OMP_CAPABILITY_STATE_DIR?.trim() || path.join(homedir(), ".local", "state");
}

export function capabilityChannelsDir(): string {
	return path.join(capabilityStateDir(), "capability-channels");
}

export function capabilitySessionsDir(): string {
	return path.join(capabilityStateDir(), "capability-sessions");
}

/** The one completions file every record lands in, whatever completed. */
export function completionsChannelFilePath(): string {
	return path.join(capabilityChannelsDir(), `${COMPLETIONS_CHANNEL}.jsonl`);
}

export function sessionRecordFilePath(sessionId: string): string {
	return path.join(capabilitySessionsDir(), `${sessionId}.json`);
}

/**
 * Whether omp writes channel records at all. The records exist so the
 * capability server's `wait` can settle on omp's in-run events, so nothing is
 * written when the capability CLI is absent. Test runs stay off the real
 * machine store unless they point `OMP_CAPABILITY_STATE_DIR` at a temp dir.
 */
export function channelRecordingEnabled(): boolean {
	if (!isCapabilityServerAvailable()) return false;
	return !isBunTestRuntime() || Boolean(process.env.OMP_CAPABILITY_STATE_DIR?.trim());
}

export function channelIdentity(sessionId: string, checkout: string): CapabilityChannelIdentity {
	return { harness: "omp", session_id: sessionId, checkout };
}

/** Identity of the channel a ToolSession's events belong to, when it names one. */
export function channelIdentityForSession(session: {
	getSessionId?: () => string | null | undefined;
	cwd?: string;
}): CapabilityChannelIdentity | undefined {
	const sessionId = session.getSessionId?.() ?? undefined;
	return sessionId ? channelIdentity(sessionId, session.cwd ?? getProjectDir()) : undefined;
}

/**
 * Ensure the capability session record for this session exists, mirroring the
 * boot reader's exact shape (sessions.ts `session_record_schema`): `pid` is
 * the liveness fact adoption checks, `cwd` the checkout it matches on. Only
 * written when absent — the capability server, stamped with
 * `CAPABILITY_SESSION_ID`, overwrites the record authoritatively at its own
 * boot (`startSession`).
 */
export function ensureCapabilitySessionRecord(identity: CapabilityChannelIdentity): void {
	if (!channelRecordingEnabled()) return;
	try {
		fs.mkdirSync(capabilitySessionsDir(), { recursive: true });
		const file = sessionRecordFilePath(identity.session_id);
		if (fs.existsSync(file)) return;
		const record = {
			id: identity.session_id,
			harness: identity.harness,
			started_at: Date.now(),
			pid: process.pid,
			cwd: identity.checkout,
			...(process.env.TMUX_PANE ? { pane: { kind: "tmux" as const, pane_id: process.env.TMUX_PANE } } : {}),
		};
		const temp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
		fs.renameSync(temp, file);
	} catch (error) {
		logger.warn("Failed to write capability session record", {
			file: sessionRecordFilePath(identity.session_id),
			error: String(error),
		});
	}
}

/**
 * Append one completion record to the store, addressed to the session.
 * Failures never break the event source.
 */
export function recordChannelCompletion(
	identity: CapabilityChannelIdentity,
	event: CapabilityChannelEvent,
): CapabilityChannelRecord | undefined {
	if (!channelRecordingEnabled()) return undefined;
	const record: CapabilityChannelRecord = {
		id: newCompletionRecordId(),
		kind: "completion",
		channel: COMPLETIONS_CHANNEL,
		to: identity.session_id,
		from: COMPLETION_FROM,
		subject: event.subject,
		body: event.body,
		created_at: Date.now(),
		about: {
			type: event.type,
			id: event.id,
			...(event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
			...(event.state !== undefined ? { state: event.state } : {}),
		},
	};
	try {
		fs.mkdirSync(capabilityChannelsDir(), { recursive: true });
		// O_APPEND makes a small single-line write atomic enough for one machine user.
		fs.appendFileSync(completionsChannelFilePath(), `${JSON.stringify(record)}\n`, "utf8");
	} catch (error) {
		logger.warn("Failed to write capability channel record", {
			file: completionsChannelFilePath(),
			error: String(error),
		});
		return undefined;
	}
	return record;
}

/** A fresh record id, in the store's id grammar (store.ts `newRecordId`). */
function newCompletionRecordId(): string {
	return `c-${randomBytes(6).toString("hex")}`;
}

/**
 * Read the completion records addressed to one session — the consumer's view
 * of the store, mirroring `pendingFor`: every live record `to` the session,
 * oldest first. A line that does not parse is skipped, not fatal.
 */
export function readChannelRecords(sessionId: string): CapabilityChannelRecord[] {
	let text: string;
	try {
		text = fs.readFileSync(completionsChannelFilePath(), "utf8");
	} catch {
		return [];
	}
	const records: CapabilityChannelRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const record = JSON.parse(trimmed) as CapabilityChannelRecord;
			if (record.to === sessionId) records.push(record);
		} catch {
			logger.warn("Skipping malformed capability channel record", {
				file: completionsChannelFilePath(),
			});
		}
	}
	return records;
}

/** A settled job as a channel event: subagent tasks carry their own type. */
export function jobCompletionEvent(job: AsyncJob): CapabilityChannelEvent {
	const exitCode = exitCodeOf(job);
	return {
		type: job.type === "task" ? "task" : "job",
		id: job.id,
		subject: job.label ?? job.id,
		body: `job ${job.id} ${job.status}`,
		state: job.status,
		...(exitCode !== undefined ? { exit_code: exitCode } : {}),
	};
}

function exitCodeOf(job: AsyncJob): number | undefined {
	for (const carrier of [job.structured, job.latestDetails]) {
		if (carrier && typeof carrier === "object" && "exitCode" in carrier) {
			const value = carrier.exitCode;
			if (typeof value === "number") return value;
		}
	}
	return undefined;
}

/** A service reaching a terminal state as a channel event. */
export function serviceCompletionEvent(daemon: DaemonSnapshot): CapabilityChannelEvent {
	return {
		type: "service",
		id: daemon.name,
		subject: daemon.name,
		body: `service ${daemon.name} ${daemon.state}`,
		state: daemon.state,
		...(daemon.exitCode !== undefined ? { exit_code: daemon.exitCode } : {}),
	};
}

/**
 * An arriving IRC message as a channel event. `type` is `reply` when the sender
 * owed this session an answer to a direct message it sent this run, `inbox`
 * for every other arrival; `state` says how the message landed.
 */
export function messageArrivalEvent(
	message: Pick<IrcMessage, "id" | "from">,
	type: "reply" | "inbox",
	outcome: string,
): CapabilityChannelEvent {
	return {
		type,
		id: message.id,
		subject: `message from ${message.from}`,
		body: `${message.id} from ${message.from} ${outcome}`,
		state: outcome,
	};
}
