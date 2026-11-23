/**
 * Live status of every interactive omp session on this machine, for the
 * `omp agents` view.
 *
 * Each top-level interactive process publishes one record file,
 * `~/.omp/run/agents/status/<instanceId>.json`, named by a random per-process
 * instance id and rewritten atomically (owner-only) as the session's status
 * changes: `waiting` (a dialog waits on the user, timed ones included) over
 * `compacting` over `error` (the last run failed) over `running` over `idle`.
 * Waiting, error, idle, and identity changes (session switch, branch,
 * relocation, model, title) are written at once; other activity is coalesced
 * into one write per {@link ACTIVITY_DEBOUNCE_MS}. The file is removed on
 * dispose and process exit; a crash leaves a record that the next
 * {@link listAgentSessions} prunes once its `(pid, pidStartedAt)` no longer
 * names a live process.
 *
 * The reader joins records with the daemon's `agent-*` units (hosted sessions;
 * see `host.ts`) through a probe that never spawns a daemon: a record whose
 * unit is alive is attachable, and a unit with no record yet is `starting`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { getBaseConfigRoot, isEnoent, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { isSameProcess, processStartTime } from "../daemon/children";
import { probeDaemon } from "../daemon/client";
import { GLOBAL_SCOPE, type UnitSnapshot } from "../daemon/protocol";
import { lastAssistantStop } from "../session/assistant-stop";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { SessionEntry } from "../session/session-entries";
import { writeFileAtomically } from "../utils/atomic-file";
import { assertPrivateRuntimeDir, ensurePrivateRuntimeDir } from "../utils/owner-private-dir";
import { type BlockedStatus, currentBlockedStatus, subscribeBlockedStatus } from "../utils/run-status";

export type AgentRowStatus = "starting" | "waiting" | "compacting" | "error" | "running" | "idle";

/** One live session as `omp agents` lists it. */
export interface AgentSessionRow {
	/** Publisher instance id; absent for a hosted unit that has not published yet. */
	instanceId?: string;
	pid?: number;
	/** Daemon unit key of a hosted (background) session. */
	hostKey?: string;
	/**
	 * Secret the hosted session requires in attach/detach markers. Read from the
	 * user-private status record; never print it (`omp agents --json` strips it).
	 */
	attachToken?: string;
	/** True when the session runs in a live daemon unit that a viewer can attach to. */
	attachable: boolean;
	sessionId?: string;
	sessionFile?: string;
	title: string;
	cwd: string;
	model?: string;
	status: AgentRowStatus;
	/** Question text, `approval: <tool>`, the running tool, or the failure. */
	detail?: string;
	lastActivityAt: number;
	startedAt: number;
	/**
	 * Hosted units of other processes on the same session (collapsed into this
	 * row by {@link collapseSessionDuplicates}); stopping the row stops them too.
	 */
	duplicateHostKeys?: string[];
}

/** Record schema version; records of another version are skipped, never pruned. */
const RECORD_VERSION = 1;
/** Coalescing window for activity-only updates. */
const ACTIVITY_DEBOUNCE_MS = 500;
/** How often identity (session, cwd, model, title) is re-read; covers switches that emit no session event. */
const IDENTITY_POLL_MS = 1_000;
/** Longest display string (title, detail, model) a record carries. */
const MAX_DISPLAY_CHARS = 200;
/** Instance ids are generated here; only files named by one are ever pruned. */
const INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;
const RECORD_NAME_PATTERN = /^([0-9a-f]{32})\.json$/;
/** Hosted-session daemon units; see `host.ts`. */
const HOSTED_KEY_PREFIX = "agent-";
const DIR_LABEL = "agents status directory";
/** Daemon unit states whose process is (or is about to be) running. */
const ALIVE_UNIT_STATES: Record<string, true> = { starting: true, running: true, ready: true, restarting: true };
/** Statuses written without waiting for the activity window. */
const URGENT_STATUSES: Record<string, true> = { waiting: true, error: true, idle: true };

/** Directory holding the per-process status records (`~/.omp/run/agents/status`). */
export function agentStatusDir(): string {
	return path.join(getBaseConfigRoot(), "run", "agents", "status");
}

type PublishedStatus = Exclude<AgentRowStatus, "starting">;

interface StatusRecord {
	v: number;
	instanceId: string;
	pid: number;
	pidStartedAt?: number;
	hostKey?: string;
	attachToken?: string;
	sessionId: string;
	sessionFile?: string;
	title: string;
	cwd: string;
	model?: string;
	status: PublishedStatus;
	detail?: string;
	lastActivityAt: number;
	startedAt: number;
	updatedAt: number;
}

const StatusRecordShape = type({
	"+": "delete",
	v: "number",
	instanceId: INSTANCE_ID_PATTERN,
	pid: "number.integer > 0",
	"pidStartedAt?": "number",
	"hostKey?": "string",
	"attachToken?": "string",
	sessionId: "string",
	"sessionFile?": "string",
	title: "string",
	cwd: "string",
	"model?": "string",
	status: "'waiting' | 'compacting' | 'error' | 'running' | 'idle'",
	"detail?": "string",
	lastActivityAt: "number",
	startedAt: "number",
	updatedAt: "number",
});

/** A display string as one control-free line of at most {@link MAX_DISPLAY_CHARS} code points. */
function displayText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = sanitizeText(text).replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	let end = 0;
	let count = 0;
	for (const codePoint of line) {
		if (count === MAX_DISPLAY_CHARS) return line.slice(0, end);
		end += codePoint.length;
		count++;
	}
	return line;
}

/** Text of the first user message on the branch, as one display line. */
function firstUserPrompt(branch: readonly SessionEntry[]): string | undefined {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = displayText(textContent(entry.message.content, " "));
		if (text) return text;
	}
	return undefined;
}

/** Inputs that decide a session's published status. */
export interface AgentStatusInputs {
	/** The newest dialog waiting on the user. */
	blocked?: BlockedStatus;
	compacting: boolean;
	/** The last run ended on an error; cleared when the next run starts. */
	failed: boolean;
	errorText?: string;
	running: boolean;
	/** Most recently started tool still executing. */
	tool?: string;
}

const APPROVAL_TITLE = /^Allow tool: (.+)$/;

function waitingDetail(blocked: BlockedStatus, tool: string | undefined): string | undefined {
	const lines = (blocked.msg ?? "")
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	if (blocked.kind === "permission") {
		const named = lines[0]?.match(APPROVAL_TITLE)?.[1];
		return displayText(`approval: ${named ?? tool ?? lines[0] ?? "tool"}`);
	}
	// Ask prompts put context first and the question last.
	return displayText(lines.at(-1));
}

/** Status and detail by precedence: waiting > compacting > error > running > idle. */
export function resolveAgentStatus(inputs: AgentStatusInputs): { status: PublishedStatus; detail?: string } {
	if (inputs.blocked) return { status: "waiting", detail: waitingDetail(inputs.blocked, inputs.tool) };
	if (inputs.compacting) return { status: "compacting" };
	if (inputs.failed) return { status: "error", detail: displayText(inputs.errorText) };
	if (inputs.running) return { status: "running", detail: displayText(inputs.tool) };
	return { status: "idle" };
}

/** The session surface the publisher reads; an `AgentSession` satisfies it. */
export interface AgentStatusSource {
	readonly sessionManager: {
		getCwd(): string;
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getSessionName(): string | undefined;
		getBranch(): readonly SessionEntry[];
	};
	readonly model: { readonly id: string } | undefined;
	readonly runStartedAt: number | undefined;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	subscribeRunState(listener: (state: "running" | "idle") => void): () => void;
}

export interface AgentStatusPublisherOptions {
	/** Daemon unit key when this process is a verified hosted session. */
	hostKey?: string;
	/** Attach token of the hosted session; see {@link AgentSessionRow.attachToken}. */
	attachToken?: string;
	/** Record directory; defaults to {@link agentStatusDir}. */
	dir?: string;
}

export interface AgentStatusPublisher {
	/** Resolve once the current state is on disk, writing a pending debounced update now. */
	flush(): Promise<void>;
	/** Stop publishing and remove the record. */
	dispose(): Promise<void>;
}

function removeFileSync(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Best-effort: a survivor is pruned by the next listing once this process is gone.
	}
}

class StatusPublisher implements AgentStatusPublisher {
	readonly #source: AgentStatusSource;
	readonly #hostKey: string | undefined;
	readonly #attachToken: string | undefined;
	readonly #dir: string;
	readonly #instanceId = crypto.randomBytes(16).toString("hex");
	readonly #file: string;
	readonly #pidStartedAt = processStartTime(process.pid);
	readonly #startedAt = Date.now();
	readonly #unsubscribers: (() => void)[] = [];
	readonly #activeTools = new Map<string, string>();
	readonly #identityTimer: NodeJS.Timeout;
	readonly #removeOnExit = (): void => removeFileSync(this.#file);
	#lastActivityAt = this.#startedAt;
	#running: boolean;
	#compacting = 0;
	#failed = false;
	#errorText: string | undefined;
	#debounceTimer: NodeJS.Timeout | undefined;
	#writing: Promise<void> | undefined;
	#rewrite = false;
	/** Last written record without `updatedAt`, serialized; equal state writes nothing. */
	#writtenKey: string | undefined;
	#writtenStatus: PublishedStatus | undefined;
	#writtenIdentity: string | undefined;
	#dirReady = false;
	#warned = false;
	#disposed = false;
	/** First user prompt of the current session: the title until the session is named. */
	#firstPrompt: { sessionId: string; text: string | undefined } | undefined;

	constructor(source: AgentStatusSource, options: AgentStatusPublisherOptions) {
		this.#source = source;
		this.#hostKey = options.hostKey;
		this.#attachToken = options.attachToken;
		this.#dir = options.dir ?? agentStatusDir();
		this.#file = path.join(this.#dir, `${this.#instanceId}.json`);
		this.#running = source.runStartedAt !== undefined;
		this.#unsubscribers.push(
			source.subscribe(event => this.#onEvent(event)),
			source.subscribeRunState(state => {
				this.#running = state === "running";
				this.#touch();
			}),
			subscribeBlockedStatus(() => this.#touch()),
		);
		this.#identityTimer = setInterval(() => this.#update(), IDENTITY_POLL_MS);
		this.#identityTimer.unref();
		process.once("exit", this.#removeOnExit);
		this.#update();
	}

	#onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.#failed = false;
				this.#errorText = undefined;
				break;
			case "agent_end": {
				this.#activeTools.clear();
				const stop = lastAssistantStop(event.messages);
				this.#failed = stop.event === "stop_failure";
				this.#errorText = this.#failed ? stop.response || stop.error_type : undefined;
				break;
			}
			case "auto_compaction_start":
			case "manual_compaction_start":
				this.#compacting++;
				break;
			case "auto_compaction_end":
			case "manual_compaction_end":
				this.#compacting = Math.max(0, this.#compacting - 1);
				break;
			case "tool_execution_start":
				// Re-inserted so the newest running tool is the last entry.
				this.#activeTools.delete(event.toolCallId);
				this.#activeTools.set(event.toolCallId, event.toolName);
				break;
			case "tool_execution_end":
				this.#activeTools.delete(event.toolCallId);
				break;
		}
		this.#touch();
	}

	#touch(): void {
		this.#lastActivityAt = Date.now();
		this.#update();
	}

	/** Explicit session name, else the first user prompt, else `Untitled · HH:MM` (as the session picker shows). */
	#title(): string {
		const manager = this.#source.sessionManager;
		const name = displayText(manager.getSessionName());
		if (name) return name;
		const sessionId = manager.getSessionId();
		if (this.#firstPrompt?.sessionId !== sessionId || this.#firstPrompt.text === undefined) {
			this.#firstPrompt = { sessionId, text: firstUserPrompt(manager.getBranch()) };
		}
		if (this.#firstPrompt.text) return this.#firstPrompt.text;
		const time = new Date(this.#startedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		return `Untitled · ${time}`;
	}

	#compose(): Omit<StatusRecord, "updatedAt"> {
		const manager = this.#source.sessionManager;
		const cwd = manager.getCwd();
		const tool = [...this.#activeTools.values()].at(-1);
		const { status, detail } = resolveAgentStatus({
			blocked: currentBlockedStatus(),
			compacting: this.#compacting > 0,
			failed: this.#failed,
			errorText: this.#errorText,
			running: this.#running,
			tool,
		});
		const sessionFile = manager.getSessionFile();
		const model = displayText(this.#source.model?.id);
		return {
			v: RECORD_VERSION,
			instanceId: this.#instanceId,
			pid: process.pid,
			...(this.#pidStartedAt !== undefined ? { pidStartedAt: this.#pidStartedAt } : {}),
			...(this.#hostKey ? { hostKey: this.#hostKey } : {}),
			...(this.#attachToken ? { attachToken: this.#attachToken } : {}),
			sessionId: manager.getSessionId(),
			...(sessionFile ? { sessionFile } : {}),
			title: this.#title(),
			cwd,
			...(model ? { model } : {}),
			status,
			...(detail ? { detail } : {}),
			lastActivityAt: this.#lastActivityAt,
			startedAt: this.#startedAt,
		};
	}

	/** Schedule a write when the state moved: urgent changes now, activity within the debounce window. */
	#update(): void {
		if (this.#disposed) return;
		const record = this.#compose();
		if (JSON.stringify(record) === this.#writtenKey) return;
		const urgent =
			(record.status !== this.#writtenStatus && Object.hasOwn(URGENT_STATUSES, record.status)) ||
			identityKey(record) !== this.#writtenIdentity;
		if (urgent) {
			this.#startWrite();
		} else if (this.#writing) {
			// The in-flight write picks up the latest state once it lands.
			this.#rewrite = true;
		} else if (!this.#debounceTimer) {
			this.#debounceTimer = setTimeout(() => this.#startWrite(), ACTIVITY_DEBOUNCE_MS);
			this.#debounceTimer.unref();
		}
	}

	/** Serialized writer: one write in flight; changes meanwhile rewrite the latest state once it lands. */
	#startWrite(): Promise<void> {
		clearTimeout(this.#debounceTimer);
		this.#debounceTimer = undefined;
		if (this.#writing) {
			this.#rewrite = true;
			return this.#writing;
		}
		this.#writing = this.#writeLoop().finally(() => {
			this.#writing = undefined;
		});
		return this.#writing;
	}

	async #writeLoop(): Promise<void> {
		do {
			this.#rewrite = false;
			if (this.#disposed) return;
			const record = this.#compose();
			const key = JSON.stringify(record);
			if (key === this.#writtenKey) continue;
			try {
				if (!this.#dirReady) {
					await ensurePrivateRuntimeDir(this.#dir, DIR_LABEL);
					this.#dirReady = true;
				}
				if (this.#disposed) return;
				await writeFileAtomically(this.#file, JSON.stringify({ ...record, updatedAt: Date.now() }));
				this.#writtenKey = key;
				this.#writtenStatus = record.status;
				this.#writtenIdentity = identityKey(record);
			} catch (error) {
				if (!this.#warned) {
					this.#warned = true;
					logger.warn("Agent status record write failed", { path: this.#file, error: String(error) });
				}
				return;
			}
		} while (this.#rewrite);
	}

	async flush(): Promise<void> {
		if (this.#disposed) return;
		if (this.#debounceTimer || JSON.stringify(this.#compose()) !== this.#writtenKey) await this.#startWrite();
		else await this.#writing;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#debounceTimer);
		this.#debounceTimer = undefined;
		clearInterval(this.#identityTimer);
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		process.off("exit", this.#removeOnExit);
		removeFileSync(this.#file);
		// A write already past its dispose check can still publish; remove what it left.
		await this.#writing;
		removeFileSync(this.#file);
	}
}

function identityKey(record: Omit<StatusRecord, "updatedAt">): string {
	return JSON.stringify([record.sessionId, record.sessionFile, record.cwd, record.title, record.model]);
}

/**
 * Publish `session`'s live status for `omp agents` until the returned handle is
 * disposed. Install once per top-level interactive process.
 */
export function startAgentStatusPublisher(
	session: AgentStatusSource,
	opts: AgentStatusPublisherOptions,
): AgentStatusPublisher {
	return new StatusPublisher(session, opts);
}

function parseRecord(text: string): StatusRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	const record = StatusRecordShape(raw);
	if (record instanceof type.errors || record.v !== RECORD_VERSION) return undefined;
	return record as StatusRecord;
}

/** Live records in `dir`; records of processes that are gone are removed. */
async function readLiveRecords(dir: string): Promise<StatusRecord[]> {
	let names: string[];
	try {
		await assertPrivateRuntimeDir(dir, DIR_LABEL);
		names = await fs.promises.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const records = await Promise.all(
		names.map(async name => {
			const id = name.match(RECORD_NAME_PATTERN)?.[1];
			if (!id) return undefined;
			const file = path.join(dir, name);
			let text: string;
			try {
				text = await Bun.file(file).text();
			} catch (error) {
				// Removed by its publisher since the listing.
				if (isEnoent(error)) return undefined;
				throw error;
			}
			const record = parseRecord(text);
			if (!record || record.instanceId !== id) return undefined;
			if (!isSameProcess(record.pid, record.pidStartedAt)) {
				await fs.promises.rm(file, { force: true });
				return undefined;
			}
			return record;
		}),
	);
	return records.filter(record => record !== undefined);
}

/** Hosted-session units of a running daemon, by key; empty when none answers. Never spawns one. */
async function liveHostedUnits(): Promise<Map<string, UnitSnapshot>> {
	const units = new Map<string, UnitSnapshot>();
	const client = await probeDaemon();
	if (!client) return units;
	try {
		const result = await client.request({ op: "list", kind: "proc", scope: GLOBAL_SCOPE });
		for (const unit of result.units) {
			if (unit.key.startsWith(HOSTED_KEY_PREFIX) && Object.hasOwn(ALIVE_UNIT_STATES, unit.state)) {
				units.set(unit.key, unit);
			}
		}
	} catch (error) {
		logger.debug("Agent status: daemon list failed", { error: String(error) });
	} finally {
		client.close();
	}
	return units;
}

async function canonicalDir(dir: string): Promise<string> {
	try {
		return await fs.promises.realpath(dir);
	} catch {
		return path.resolve(dir);
	}
}

function isWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
	return child.startsWith(prefix);
}

function recordRow(record: StatusRecord, units: Map<string, UnitSnapshot>): AgentSessionRow {
	return {
		instanceId: record.instanceId,
		pid: record.pid,
		...(record.hostKey ? { hostKey: record.hostKey } : {}),
		...(record.attachToken ? { attachToken: record.attachToken } : {}),
		attachable: record.hostKey !== undefined && units.has(record.hostKey),
		sessionId: record.sessionId,
		...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
		title: displayText(record.title) ?? "",
		cwd: record.cwd,
		...(record.model ? { model: displayText(record.model) } : {}),
		status: record.status,
		...(record.detail ? { detail: displayText(record.detail) } : {}),
		lastActivityAt: record.lastActivityAt,
		startedAt: record.startedAt,
	};
}

function startingRow(unit: UnitSnapshot): AgentSessionRow {
	const cwd = unit.cwd ?? "";
	return {
		...(unit.pids[0] !== undefined ? { pid: unit.pids[0] } : {}),
		hostKey: unit.key,
		attachable: true,
		title: displayText(unit.label) ?? (cwd ? path.basename(cwd) : unit.key),
		cwd,
		status: "starting",
		lastActivityAt: unit.startedAt,
		startedAt: unit.startedAt,
	};
}

/**
 * One row per session: rows sharing a `sessionId` (two processes on one
 * session file) collapse into the attachable one, else the most recently
 * active. The other rows' hosted units are kept on it as `duplicateHostKeys`
 * so stopping the session stops them all. Rows without a session id (hosted
 * units still starting) pass through; order is otherwise kept.
 */
export function collapseSessionDuplicates(rows: readonly AgentSessionRow[]): AgentSessionRow[] {
	const groups = new Map<string, AgentSessionRow[]>();
	for (const row of rows) {
		if (!row.sessionId) continue;
		const group = groups.get(row.sessionId);
		if (group) group.push(row);
		else groups.set(row.sessionId, [row]);
	}
	/** Rows to replace: the winner by its merged copy, the others by nothing. */
	const replaced = new Map<AgentSessionRow, AgentSessionRow | undefined>();
	for (const group of groups.values()) {
		if (group.length === 1) continue;
		const [winner, ...others] = [...group].sort(
			(a, b) => Number(b.attachable) - Number(a.attachable) || b.lastActivityAt - a.lastActivityAt,
		);
		const duplicateHostKeys = others
			.flatMap(row => [row.hostKey, ...(row.duplicateHostKeys ?? [])])
			.filter((key): key is string => key !== undefined);
		replaced.set(winner, duplicateHostKeys.length > 0 ? { ...winner, duplicateHostKeys } : winner);
		for (const row of others) replaced.set(row, undefined);
	}
	if (replaced.size === 0) return [...rows];
	return rows.flatMap(row => {
		if (!replaced.has(row)) return [row];
		const kept = replaced.get(row);
		return kept ? [kept] : [];
	});
}

/**
 * Every live interactive session: published records joined with hosted daemon
 * units, plus hosted units that have not published yet (`starting`). With
 * `cwd`, only sessions whose working directory is it or lies under it.
 */
export async function listAgentSessions(opts?: { cwd?: string; dir?: string }): Promise<AgentSessionRow[]> {
	const [records, units] = await Promise.all([readLiveRecords(opts?.dir ?? agentStatusDir()), liveHostedUnits()]);
	const published = new Set<string>();
	const rows: AgentSessionRow[] = [];
	for (const record of records) {
		if (record.hostKey) published.add(record.hostKey);
		rows.push(recordRow(record, units));
	}
	for (const unit of units.values()) {
		if (!published.has(unit.key)) rows.push(startingRow(unit));
	}
	let shown = collapseSessionDuplicates(rows);
	if (opts?.cwd) {
		const base = await canonicalDir(opts.cwd);
		const candidates = shown;
		const canonical = await Promise.all(candidates.map(row => (row.cwd ? canonicalDir(row.cwd) : undefined)));
		shown = candidates.filter((_, index) => {
			const cwd = canonical[index];
			return cwd !== undefined && isWithin(cwd, base);
		});
	}
	return shown.sort(
		(a, b) =>
			a.startedAt - b.startedAt || (a.instanceId ?? a.hostKey ?? "").localeCompare(b.instanceId ?? b.hostKey ?? ""),
	);
}
