import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../async/job-manager";
import { type DaemonBrokerClient, daemonClientForProject } from "../launch/client";
import { registerServiceObservationBarrier } from "../launch/diagnostic-observers";
import type { DaemonCompletionNotification } from "../launch/protocol";
import stallReportPrompt from "../prompts/system/stall-report.md" with { type: "text" };
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { cfgLaunchEnabled } from "../tools/settings";
import { ACTIVE_TIME_CUSTOM_TYPE, type ActiveTimeSummary, readActiveTime } from "./active-time";
import type { AgentSession } from "./agent-session";
import type { SessionEntry } from "./session-entries";
import { loadEntriesFromFile, visitEntriesFromFileStream } from "./session-loader";
import { migrateToCurrentVersion } from "./session-migrations";
import { StallEventJournal } from "./stall-event-journal";

export interface StallReport {
	text: string;
	hasUnfinishedWork: boolean;
	/** Advance the baseline only after the report was inserted into model history. */
	commit(): void;
}

type TodoRow = { key: string; phase: string; content: string; status: string; blocker?: string };
type ToolRow = { id: string; name: string; outcome: string; startedAt?: number; intent?: string };
type Turn = { timestamp: number; text: string; tools: ToolRow[]; omittedTools: number };
type ReportHistory = {
	leaf: string | null;
	turns: number;
	tools: number;
	recent: Turn[];
	pending: ToolRow[];
	lastActivity?: number;
	diagnosticOnly?: boolean;
	hasDiagnostics?: boolean;
	diagnosticTurns?: number;
	activeTime?: ActiveTimeSummary;
	hasActiveTelemetry?: boolean;
	sessionId?: string;
	cwd?: string;
	incompleteAncestry?: boolean;
	parentSession?: string;
};
type History = Omit<ReportHistory, "pending"> & { pending: Map<string, ToolRow> };
type AgentSample = {
	ref: AgentRef;
	history?: ReportHistory;
	error?: string;
	activeMs?: number;
	partial: boolean;
	status: string;
};
type Event =
	| { type: "todo"; at: number; label: string; before?: string; after?: string }
	| { type: "agent"; at: number; label: string }
	| { type: "job"; at: number; label: string }
	| { type: "service"; at: number; label: string };
type Baseline = {
	at: number;
	leaf: string | null;
	agents: Map<string, { turns?: number; tools?: number; activeMs?: number; leaf?: string | null }>;
};
type ServiceSource = {
	owners: Set<string>;
	client?: DaemonBrokerClient;
	unsubscribe?: () => void;
	ready: Promise<void>;
	error?: string;
};

const MAX_ROWS = 100;
const MAX_SNIPPET = 700;
const MAX_METADATA = 240;
const MAX_TOOLS_PER_TURN = 8;
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_SECTION_BYTES = 8 * 1024;

/** Escape every interpolated datum before inserting it into the trusted Markdown template. */
function quoted(value: string, limit = MAX_METADATA): string {
	const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	const parts: { text: string; length: number; bytes: number }[] = [];
	let bytes = 6; // The two Unicode quotation marks.
	let consumed = 0;
	for (const char of clean) {
		const text = /[&<>`\\*_[\]{}#|!]/.test(char) ? `&#${char.charCodeAt(0)};` : char;
		const size = Buffer.byteLength(text);
		if (bytes + size > limit) break;
		parts.push({ text, length: char.length, bytes: size });
		bytes += size;
		consumed += char.length;
	}
	if (consumed < clean.length) {
		while (parts.length && bytes + Buffer.byteLength(` [${clean.length - consumed} characters omitted]`) > limit) {
			const part = parts.pop()!;
			bytes -= part.bytes;
			consumed -= part.length;
		}
	}
	return `“${parts.map(part => part.text).join("")}”${consumed < clean.length ? ` [${clean.length - consumed} characters omitted]` : ""}`;
}
function age(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}
function stamp(timestamp: number): string {
	const date = new Date(timestamp);
	return Number.isFinite(date.getTime()) ? date.toISOString() : "timestamp unavailable";
}
function agentKey(ref: AgentRef): string {
	return `${ref.id}:${ref.createdAt}`;
}
function todoRows(phases: TodoPhase[]): TodoRow[] {
	const occurrences = new Map<string, number>();
	return phases.flatMap(phase =>
		phase.tasks.map(task => {
			const identity = JSON.stringify([phase.name, task.content]);
			const ordinal = occurrences.get(identity) ?? 0;
			occurrences.set(identity, ordinal + 1);
			return { key: `${identity}:${ordinal}`, phase: phase.name, ...task };
		}),
	);
}
function emptyHistory(): History {
	return { leaf: null, turns: 0, tools: 0, recent: [], pending: new Map() };
}
function scanEntries(
	entries: readonly SessionEntry[],
	previous: History | undefined,
	quote: (value: string, limit?: number) => string,
): History {
	const oldIndex = previous?.leaf ? entries.findIndex(entry => entry.id === previous.leaf) : -1;
	const summary = previous && oldIndex >= 0 ? previous : emptyHistory();
	for (let index = oldIndex >= 0 ? oldIndex + 1 : 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === ACTIVE_TIME_CUSTOM_TYPE) summary.hasActiveTelemetry = true;
		if (entry.type === "custom" && entry.customType === "stall_diagnostic_turn" && isRecord(entry.data)) {
			if (entry.data.state === "started") {
				summary.diagnosticOnly = true;
				summary.hasDiagnostics = true;
			} else if (entry.data.state === "finished") summary.diagnosticOnly = false;
		}
		if (entry.type === "custom" && entry.customType === "tool_execution_start" && isRecord(entry.data)) {
			// Execution markers belong to the current turn, including diagnostic-only turns.
			const data = entry.data;
			const startedAt = typeof data.startedAt === "string" ? Date.parse(data.startedAt) : NaN;
			if (!summary.diagnosticOnly && Number.isFinite(startedAt))
				summary.lastActivity = Math.max(summary.lastActivity ?? 0, startedAt);
			if (typeof data.toolCallId === "string") {
				const pending = summary.pending.get(data.toolCallId);
				if (pending) {
					if (Number.isFinite(startedAt)) pending.startedAt = startedAt;
					if (typeof data.intent === "string") pending.intent = quote(data.intent);
				}
			}
		}
		if (entry.type !== "message") continue;
		const message: AgentMessage = entry.message;
		if (
			message.role === "user" ||
			((message.role === "developer" || message.role === "custom") && message.attribution === "user")
		)
			summary.diagnosticOnly = false;
		if (
			!summary.diagnosticOnly &&
			(message.role !== "developer" || message.attribution === "user") &&
			typeof message.timestamp === "number" &&
			Number.isFinite(message.timestamp)
		)
			summary.lastActivity = Math.max(summary.lastActivity ?? 0, message.timestamp);
		if (message.role === "assistant") {
			summary.turns++;
			if (summary.diagnosticOnly) summary.diagnosticTurns = (summary.diagnosticTurns ?? 0) + 1;
			summary.pending.clear();
			const calls = message.content.filter(block => block.type === "toolCall");
			summary.tools += calls.length;
			const turn: Turn = {
				timestamp: message.timestamp,
				text: quote(
					message.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n"),
					MAX_SNIPPET,
				),
				tools: calls
					.slice(0, MAX_TOOLS_PER_TURN)
					.map(call => ({ id: call.id, name: quote(call.name, 48), outcome: "no recorded result" })),
				omittedTools: Math.max(0, calls.length - MAX_TOOLS_PER_TURN),
			};
			for (const tool of turn.tools) summary.pending.set(tool.id, tool);
			summary.recent.push(turn);
			if (summary.recent.length > 5) summary.recent.shift();
		} else if (message.role === "toolResult") {
			for (const turn of summary.recent) {
				const call = turn.tools.find(tool => tool.id === message.toolCallId);
				if (call) call.outcome = message.isError ? "error" : "returned";
			}
			summary.pending.delete(message.toolCallId);
		}
	}
	summary.leaf = entries.at(-1)?.id ?? null;
	summary.activeTime = summary.hasActiveTelemetry ? readActiveTime(entries) : undefined;
	return summary;
}
function boundedRows(rows: string[], empty = "None."): string[] {
	if (rows.length === 0) return [empty];
	const retained: string[] = [];
	let bytes = 0;
	for (const row of rows.slice(0, MAX_ROWS)) {
		const size = Buffer.byteLength(row) + 1;
		if (bytes + size > MAX_SECTION_BYTES - 100) break;
		retained.push(row);
		bytes += size;
	}
	if (retained.length < rows.length) retained.push(`[${rows.length - retained.length} rows omitted]`);
	return retained;
}

function agentStatus(ref: AgentRef, removed = false): string {
	if (removed) return "removed";
	if (ref.session?.isStreaming) return ref.session.isStallDiagnosticTurn?.() ? "active (diagnostic-only)" : "active";
	return ref.session ? "idle" : ref.status;
}

/** Detached report metadata only: journals must never retain a live session graph. */
function snapshotAgentRef(ref: AgentRef): AgentRef {
	return {
		id: ref.id,
		displayName: ref.displayName,
		kind: ref.kind,
		parentId: ref.parentId,
		rootSessionId: ref.rootSessionId,
		status: ref.status,
		session: null,
		sessionFile: ref.sessionFile,
		createdAt: ref.createdAt,
		lastActivity: ref.lastActivity,
		activity: ref.activity,
		lifecycle: ref.lifecycle
			? {
					responseAt: ref.lifecycle.responseAt,
					acceptedAt: ref.lifecycle.acceptedAt,
					terminalAt: ref.lifecycle.terminalAt,
				}
			: undefined,
		activeTime: ref.activeTime
			? {
					durationMs: ref.activeTime.durationMs,
					historicalUnavailable: ref.activeTime.historicalUnavailable,
					runningSince: ref.activeTime.runningSince,
				}
			: undefined,
	};
}

/** Tool telemetry snapshots contain only the report's scalar fields, never execution state. */
function snapshotToolRow(tool: ToolRow): ToolRow {
	return {
		id: tool.id,
		name: tool.name,
		outcome: tool.outcome,
		startedAt: tool.startedAt,
		intent: tool.intent,
	};
}

/** Bounded, detached history: no transcript entries or mutable live-summary fields escape. */
function snapshotHistory(history: History): ReportHistory {
	return {
		leaf: history.leaf,
		turns: history.turns,
		tools: history.tools,
		pending: Array.from(history.pending.values(), snapshotToolRow),
		recent: history.recent.map(turn => ({
			timestamp: turn.timestamp,
			text: turn.text,
			omittedTools: turn.omittedTools,
			tools: turn.tools.map(snapshotToolRow),
		})),
		lastActivity: history.lastActivity,
		diagnosticOnly: history.diagnosticOnly,
		hasDiagnostics: history.hasDiagnostics,
		diagnosticTurns: history.diagnosticTurns,
		activeTime: history.activeTime
			? {
					durationMs: history.activeTime.durationMs,
					historicalUnavailable: history.activeTime.historicalUnavailable,
					runningSince: history.activeTime.runningSince,
				}
			: undefined,
		hasActiveTelemetry: history.hasActiveTelemetry,
		sessionId: history.sessionId,
		cwd: history.cwd,
		incompleteAncestry: history.incompleteAncestry,
		parentSession: history.parentSession,
	};
}

/** Session-owned diagnostic sampling. No lifecycle action or result consumption occurs here. */
export class StallReportCollector {
	readonly #session: AgentSession;
	readonly #registry: AgentRegistry;
	readonly #startedAt = Date.now();
	readonly #events = new StallEventJournal<Event>();
	readonly #disposers: (() => void)[] = [];
	readonly #liveHistory = new WeakMap<AgentSession, History>();
	readonly #parkedHistory = new WeakMap<AgentRef, { file: string | null; history: ReportHistory }>();
	readonly #watchedSessions = new WeakSet<AgentSession>();
	readonly #serviceSources = new Map<string, ServiceSource>();
	readonly #owners = new Set<string>();
	readonly #serviceEventIds = new Set<string>();
	readonly #agentOwners = new Set<string>();
	readonly #workActivity = new WeakMap<AgentSession, number>();
	readonly #agentChanges = new Map<string, { ref: AgentRef; at: number; sequence: number; removed: boolean }>();
	readonly #serviceMetadata = new Map<string, { sessionId?: string; cwd?: string; error?: string }>();
	readonly #serviceOwnerDiscoveries = new Set<Promise<void>>();
	#agentChangeSequence = 0;
	#agentSnapshotsEvicted = 0;
	#committedAgentEvictions = 0;
	readonly #activitySubscriptions = new Map<AgentSession, () => void>();
	#todos: TodoRow[];
	#baseline?: Baseline;
	#disposed = false;
	#sequence = 0;
	#committedSequence = 0;
	#quote = (value: string, limit = MAX_METADATA): string =>
		quoted(this.#session.obfuscator?.obfuscate(value) ?? value, limit);

	constructor(session: AgentSession) {
		this.#session = session;
		this.#registry = session.getStallReportToolSession()?.agentRegistry ?? AgentRegistry.global();
		this.#todos = todoRows(session.getTodoPhases());
		this.#disposers.push(session.subscribeTodoChanges(phases => this.#recordTodos(phases)));
		this.#disposers.push(
			this.#registry.onChange(event => {
				if (!this.#inScope(event.ref)) return;
				for (const [observed, unsubscribe] of this.#activitySubscriptions) {
					if (
						observed.getAgentId() === event.ref.id &&
						(event.type === "removed" || observed !== event.ref.session)
					) {
						unsubscribe();
						this.#activitySubscriptions.delete(observed);
					}
				}
				this.#parkedHistory.delete(event.ref);
				this.#agentOwners.add(event.ref.id);
				this.#watchSession(event.ref.session);
				if (!event.ref.session) {
					const discovery = this.#watchRefServiceOwner(snapshotAgentRef(event.ref));
					this.#serviceOwnerDiscoveries.add(discovery);
					void discovery.finally(() => this.#serviceOwnerDiscoveries.delete(discovery));
				}
				if (event.type === "registered" || event.type === "removed" || event.type === "status_changed") {
					const snapshot = snapshotAgentRef(event.ref);
					if (event.type === "removed" && event.ref.session) {
						this.#parkedHistory.set(snapshot, {
							file: snapshot.sessionFile,
							history: snapshotHistory(this.#sessionHistory(event.ref.session)),
						});
					}
					this.#agentChanges.delete(agentKey(event.ref));
					this.#agentChanges.set(agentKey(event.ref), {
						ref: snapshot,
						at: Date.now(),
						sequence: ++this.#agentChangeSequence,
						removed: event.type === "removed",
					});
					if (this.#agentChanges.size > 512) {
						const oldest = this.#agentChanges.keys().next().value;
						if (oldest !== undefined) this.#agentChanges.delete(oldest);
						this.#agentSnapshotsEvicted++;
					}
					this.#events.append({
						type: "agent",
						at: Date.now(),
						label: `${event.type}: ${this.#quote(event.ref.id)} → ${event.ref.status}`,
					});
				}
			}),
		);
		const manager = session.asyncJobManager;
		if (manager)
			this.#disposers.push(
				manager.onSettled(job => {
					if (this.#ownerInScope(job.ownerId))
						this.#events.append({
							type: "job",
							at: job.endTime ?? Date.now(),
							label: this.#jobLabel(job, Date.now()),
						});
				}),
			);
		this.#watchSession(session);
		for (const ref of this.#registry.list())
			if (this.#inScope(ref)) {
				this.#agentOwners.add(ref.id);
				this.#watchSession(ref.session);
			}
	}

	#inScope(ref: AgentRef): boolean {
		if (ref.kind === "advisor") return false;
		if (ref.session === this.#session) return true;
		const sessionId = this.#session.sessionManager.getSessionId();
		if (ref.rootSessionId !== undefined) return ref.kind === "sub" && ref.rootSessionId === sessionId;
		const seen = new Set<string>();
		let parent = ref.parentId;
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			const owner = this.#registry.get(parent);
			if (!owner || owner.kind === "advisor") return false;
			if (owner.session === this.#session) return true;
			parent = owner.parentId;
		}
		return false;
	}

	#ownerInScope(owner: string | undefined): boolean {
		if (!owner) return false;
		if (owner === this.#session.getAgentId()) {
			const current = this.#registry.get(owner);
			return !current || current.session === this.#session;
		}
		const ref = this.#registry.get(owner);
		return ref ? this.#inScope(ref) : this.#agentOwners.has(owner);
	}

	#watchSession(session: AgentSession | null): void {
		if (!session || this.#watchedSessions.has(session)) return;
		this.#watchedSessions.add(session);
		const unsubscribe = session.subscribe?.(event => {
			if (session.isStallDiagnosticTurn?.()) return;
			if (
				(event.type === "message_end" && event.message.role === "assistant") ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end"
			)
				this.#workActivity.set(session, Date.now());
		});
		if (unsubscribe) this.#activitySubscriptions.set(session, unsubscribe);
		const tool = session.getStallReportToolSession();
		if (!tool || !cfgLaunchEnabled.get(tool.settings)) return;
		const owner = tool.getSessionId?.() ?? tool.getAgentId?.();
		if (owner) this.#watchServiceOwner(tool.cwd, owner);
	}

	#observeService = (notification: DaemonCompletionNotification): void => {
		if (
			this.#disposed ||
			!this.#owners.has(notification.owner) ||
			this.#serviceEventIds.has(notification.completionId)
		)
			return;
		this.#serviceEventIds.add(notification.completionId);
		if (this.#serviceEventIds.size > 1024) {
			const first = this.#serviceEventIds.values().next().value;
			if (first !== undefined) this.#serviceEventIds.delete(first);
		}
		this.#events.append({
			type: "service",
			at: notification.daemon.exitedAt ?? Date.now(),
			label: this.#serviceLabel(notification.daemon, Date.now()),
		});
	};

	#watchServiceOwner(cwd: string, owner: string): void {
		this.#owners.add(owner);
		let source = this.#serviceSources.get(cwd);
		if (source?.owners.has(owner)) return;
		if (!source) {
			source = { owners: new Set(), ready: Promise.resolve() };
			this.#serviceSources.set(cwd, source);
		}
		source.owners.add(owner);
		const target = source;
		target.ready = target.ready.then(async () => {
			if (this.#disposed) return;
			try {
				const client = target.client ?? (await daemonClientForProject(cwd));
				if (this.#disposed) return;
				target.client = client;
				const previous = target.unsubscribe;
				target.unsubscribe = client.observeOwners([...target.owners], this.#observeService, reason => {
					if (!this.#disposed)
						this.#events.append({
							type: "service",
							at: Date.now(),
							label: `Observation coverage gap for project ${this.#quote(cwd)}: ${this.#quote(reason)}; exact completions during the gap are unavailable.`,
						});
				});
				previous?.();
				await client.request({ op: "ping" });
				target.error = undefined;
			} catch (error) {
				target.error = String(error);
			}
		});
		this.#disposers.push(registerServiceObservationBarrier(owner, target.ready));
	}

	async #watchRefServiceOwner(ref: AgentRef): Promise<void> {
		const rootTool = this.#session.getStallReportToolSession();
		if (this.#disposed || !rootTool || !cfgLaunchEnabled.get(rootTool.settings)) return;
		const header = ref.session?.sessionManager.getHeader();
		const cached = this.#parkedHistory.get(ref)?.history;
		const owner = header?.id ?? cached?.sessionId;
		const cwd = header?.cwd ?? cached?.cwd;
		if (owner && cwd) {
			this.#watchServiceOwner(cwd, owner);
			return;
		}
		if (ref.session || !ref.sessionFile) return;
		let metadata = this.#serviceMetadata.get(ref.sessionFile);
		if (!metadata) {
			metadata = {};
			this.#serviceMetadata.set(ref.sessionFile, metadata);
			try {
				await visitEntriesFromFileStream(
					ref.sessionFile,
					entry => {
						if (entry.type === "session") {
							metadata!.sessionId = entry.id;
							metadata!.cwd = entry.cwd;
						}
						return false;
					},
					{ maxRecords: 1, maxBytes: 64 * 1024 },
				);
				if (!metadata.sessionId || !metadata.cwd) metadata.error = "No readable bounded session header";
			} catch (failure) {
				metadata.error = String(failure);
			}
		}
		if (!this.#disposed && metadata.sessionId && metadata.cwd)
			this.#watchServiceOwner(metadata.cwd, metadata.sessionId);
	}

	#recordTodos(phases: TodoPhase[]): void {
		const next = todoRows(phases);
		const before = new Map(this.#todos.map(row => [row.key, row]));
		const after = new Map(next.map(row => [row.key, row]));
		for (const row of next) {
			const old = before.get(row.key);
			if (old?.status === row.status && old.blocker === row.blocker) continue;
			this.#events.append({
				type: "todo",
				at: Date.now(),
				label: `${this.#quote(row.phase)} / ${this.#quote(row.content)}: ${old?.status ?? "absent"} → ${row.status}${row.blocker ? `; blocker ${this.#quote(row.blocker)}` : ""}`,
				before: old?.status,
				after: row.status,
			});
		}
		for (const row of this.#todos)
			if (!after.has(row.key)) {
				this.#events.append({
					type: "todo",
					at: Date.now(),
					label: `${this.#quote(row.phase)} / ${this.#quote(row.content)}: ${row.status} → removed from current snapshot (edit, replacement, or branch navigation)`,
					before: row.status,
				});
			}
		this.#todos = next;
	}

	#sessionHistory(session: AgentSession): History {
		const summary = scanEntries(session.sessionManager.getBranch(), this.#liveHistory.get(session), this.#quote);
		this.#liveHistory.set(session, summary);
		const header = session.sessionManager.getHeader();
		summary.sessionId = header?.id;
		summary.cwd = header?.cwd;
		summary.parentSession = header?.parentSession;
		return summary;
	}

	async #history(ref: AgentRef): Promise<ReportHistory | undefined> {
		if (ref.session) {
			this.#parkedHistory.delete(ref);
			return snapshotHistory(this.#sessionHistory(ref.session));
		}
		const cached = this.#parkedHistory.get(ref);
		if (cached?.file === ref.sessionFile) return cached.history;
		if (!ref.sessionFile) return undefined;
		const entries = await loadEntriesFromFile(ref.sessionFile, undefined, { throwIfMissing: true });
		migrateToCurrentVersion(entries);
		const logical = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		const byId = new Map(logical.map(entry => [entry.id, entry]));
		const branch: SessionEntry[] = [];
		let leaf = logical.at(-1);
		const visited = new Set<string>();
		while (leaf && !visited.has(leaf.id)) {
			visited.add(leaf.id);
			branch.push(leaf);
			leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
		}
		branch.reverse();
		const history = scanEntries(branch, undefined, this.#quote);
		history.incompleteAncestry = Boolean(branch[0]?.parentId);
		const header = entries.find(entry => entry.type === "session");
		history.sessionId = header?.id;
		history.cwd = header?.cwd;
		history.parentSession = header?.parentSession;
		const snapshot = snapshotHistory(history);
		this.#parkedHistory.set(ref, { file: ref.sessionFile, history: snapshot });
		return snapshot;
	}

	#jobLabel(job: AsyncJob, now: number): string {
		return `${this.#quote(job.id)} [${job.type}] ${job.status}${job.queued ? " (queued, not executing)" : ""}; owner ${this.#quote(job.ownerId ?? "unowned")}; ${job.type === "task" ? this.#quote(job.label) : "command/source label omitted (may contain arguments or secrets)"}; elapsed ${age((job.endTime ?? now) - job.startTime)}${job.progressAt ? `; last progress ${age(now - job.progressAt)} ago` : "; no recorded progress"}${job.errorText ? "; failure body omitted (may contain arguments or secrets)" : ""}`;
	}
	#serviceLabel(service: DaemonSnapshot, now: number): string {
		return `${this.#quote(service.name)} [service] ${service.state}; owner ${this.#quote(service.owner ?? "unowned")}; runtime ${age((service.exitedAt ?? now) - service.startedAt)}; restarts ${service.restartCount}; output bytes ${service.outputBytes}${service.exitCode !== undefined ? `; exit code ${service.exitCode}` : ""}${service.exitReason ? `; exit ${this.#quote(service.exitReason)}` : ""}${service.readyPending?.length ? `; readiness pending ${service.readyPending.join(", ")}` : ""}`;
	}

	async collect(): Promise<StallReport> {
		if (this.#disposed) throw new Error("Stall report collector is disposed");
		const sequence = ++this.#sequence;
		const now = Date.now();
		const branch = this.#session.sessionManager.getBranch();
		const leaf = branch.at(-1)?.id ?? null;
		const baseline = this.#baseline;
		const branchChanged = Boolean(baseline?.leaf && !branch.some(entry => entry.id === baseline.leaf));
		this.#recordTodos(this.#session.getTodoPhases());
		const events = this.#events.snapshot();
		// Scope discovery remains complete even when the visible agent roster is bounded.
		const refs = this.#registry.list().filter(ref => this.#inScope(ref));
		if (!refs.some(ref => ref.session === this.#session))
			refs.unshift({
				id: this.#session.getAgentId() ?? this.#session.sessionManager.getSessionId(),
				displayName: "Main",
				kind: "main",
				status: this.#session.isStreaming ? "running" : "idle",
				session: this.#session,
				sessionFile: this.#session.sessionManager.getSessionFile() ?? null,
				createdAt: this.#startedAt,
				lastActivity: this.#startedAt,
			});
		const agentChanges = new Map(this.#agentChanges);
		const agentWatermark = this.#agentChangeSequence;
		const agentEvictions = this.#agentSnapshotsEvicted;
		const omittedAgentSnapshots = agentEvictions - this.#committedAgentEvictions;
		const currentKeys = new Set(refs.map(agentKey));
		for (const [key, change] of agentChanges) if (!currentKeys.has(key)) refs.push(change.ref);
		for (const ref of refs) {
			this.#agentOwners.add(ref.id);
			this.#watchSession(ref.session);
		}
		const candidates = refs
			.filter(ref => {
				const change = agentChanges.get(agentKey(ref));
				return ref.session?.isStreaming || ref.status === "running" || ref.status === "idle" || change;
			})
			.map(ref => {
				const change = agentChanges.get(agentKey(ref));
				return {
					ref,
					status: agentStatus(ref, change?.removed),
					changedAt: change?.at,
				};
			})
			.sort((left, right) => {
				const priority = (candidate: { ref: AgentRef; status: string }) =>
					candidate.ref.session === this.#session
						? 0
						: candidate.status.startsWith("active")
							? 1
							: candidate.status !== "removed" && candidate.ref.status === "running"
								? 2
								: 3;
				return (
					priority(left) - priority(right) ||
					Number(right.changedAt !== undefined) - Number(left.changedAt !== undefined) ||
					(right.changedAt ?? right.ref.lastActivity) - (left.changedAt ?? left.ref.lastActivity) ||
					agentKey(left.ref).localeCompare(agentKey(right.ref))
				);
			});
		const listed = candidates.slice(0, MAX_ROWS);
		const samples: AgentSample[] = await Promise.all(
			listed.map(async ({ ref, status }) => {
				let history: ReportHistory | undefined;
				let error: string | undefined;
				try {
					history = await this.#history(ref);
				} catch (failure) {
					error = String(failure);
				}
				const active = ref.activeTime ?? history?.activeTime;
				return {
					ref,
					history,
					error,
					status,
					activeMs: active
						? active.durationMs + (active.runningSince !== undefined ? Math.max(0, now - active.runningSince) : 0)
						: undefined,
					partial: active?.historicalUnavailable ?? true,
				};
			}),
		);
		const rootTool = this.#session.getStallReportToolSession();
		await Promise.all(refs.map(ref => this.#watchRefServiceOwner(ref)));
		await Promise.all(this.#serviceOwnerDiscoveries);
		await Promise.all([...this.#serviceSources.values()].map(source => source.ready));
		const services = new Map<string, DaemonSnapshot>();
		for (const [cwd, source] of this.#serviceSources) {
			try {
				if (!source.client) {
					source.client = await daemonClientForProject(cwd);
					source.unsubscribe = source.client.observeOwners([...source.owners], this.#observeService, reason => {
						if (!this.#disposed)
							this.#events.append({
								type: "service",
								at: Date.now(),
								label: `Observation coverage gap for project ${this.#quote(cwd)}: ${this.#quote(reason)}; exact completions during the gap are unavailable.`,
							});
					});
				}
				const result = await source.client.request({ op: "list" });
				if (result.op !== "list") throw new Error("Unexpected daemon list response");
				for (const service of result.daemons)
					if (service.owner && source.owners.has(service.owner))
						services.set(`${service.id}:${service.startedAt}`, service);
				source.error = undefined;
			} catch (failure) {
				source.error = String(failure);
			}
		}
		const activeServices = [...services.values()].filter(
			service => service.state !== "exited" && service.state !== "failed",
		);
		const manager = this.#session.asyncJobManager;
		const jobs = manager?.getAllJobs().filter(job => this.#ownerInScope(job.ownerId)) ?? [];
		const runningJobs = jobs.filter(job => job.status === "running");
		const open = this.#todos.filter(todo => todo.status !== "completed" && todo.status !== "abandoned");
		const lines: string[] = [];
		lines.push(
			"## Todos: current",
			`Open ${open.length}; completed ${this.#todos.filter(row => row.status === "completed").length}; abandoned ${this.#todos.filter(row => row.status === "abandoned").length}.`,
		);
		lines.push(
			...boundedRows(
				this.#todos.map(
					row =>
						`- ${row.status}: ${this.#quote(row.phase)} / ${this.#quote(row.content)}${row.blocker ? `; blocker ${this.#quote(row.blocker)}` : ""}`,
				),
			),
		);
		lines.push(
			"",
			"## Since previous successfully delivered reminder",
			branchChanged
				? "Branch changed: counter deltas are unavailable; todo transitions describe observed snapshots, not explicit deletion commands."
				: baseline
					? `Interval starts ${stamp(baseline.at)}.`
					: `No prior reminder: retained events begin at opt-in ${stamp(this.#startedAt)}.`,
		);
		lines.push(...boundedRows(events.events.map(event => `- ${stamp(event.at)} [${event.type}] ${event.label}`)));
		if (events.omitted)
			lines.push(
				`[Event retention overflow: ${events.omitted} earlier events omitted; exact interval transitions are incomplete.]`,
			);
		if (omittedAgentSnapshots)
			lines.push(
				`[Changed-agent snapshot retention overflow: ${omittedAgentSnapshots} earlier snapshots omitted; additional candidate identities/statuses unavailable. These are snapshot omissions, not a unique-agent count; roster counts below cover known candidates only.]`,
			);
		lines.push(
			"",
			"## Agents: current and interval-retained",
			`Active ${candidates.filter(candidate => candidate.status.startsWith("active")).length}; idle ${candidates.filter(candidate => candidate.status === "idle").length}; parked ${candidates.filter(candidate => candidate.status === "parked").length}; aborted ${candidates.filter(candidate => candidate.status === "aborted").length}; active diagnostic-only ${candidates.filter(candidate => candidate.status === "active (diagnostic-only)").length}; removed ${candidates.filter(candidate => candidate.status === "removed").length}; registry-running without an attached active turn ${candidates.filter(candidate => candidate.status !== "removed" && candidate.ref.status === "running" && candidate.ref.session?.isStreaming !== true).length}.`,
			`${omittedAgentSnapshots ? "Known candidate" : "Candidate"} agents ${candidates.length}; listed agent sections ${samples.length}; omitted agent sections ${candidates.length - samples.length}. Unchanged historical parked/aborted agents are excluded; task and service scope still includes all actual descendants.`,
		);
		const agentInsertion = lines.length;
		const agentSections: { key: string; text: string }[] = [];
		const nextAgents: Baseline["agents"] = new Map();
		for (const sample of samples) {
			const lines: string[] = [];
			const { ref, history } = sample;
			const key = agentKey(ref);
			const old = branchChanged ? undefined : baseline?.agents.get(key);
			const delta =
				old &&
				history &&
				!history.incompleteAncestry &&
				(old.leaf === null ||
					old.leaf === history.leaf ||
					ref.session?.sessionManager.getBranch().some(entry => entry.id === old.leaf))
					? `; since reminder turns +${history.turns - (old.turns ?? history.turns)}, tools +${history.tools - (old.tools ?? history.tools)}${old.activeMs !== undefined && sample.activeMs !== undefined ? `, active +${age(sample.activeMs - old.activeMs)}` : ""}`
					: "; since-reminder counters unavailable (no comparable baseline)";
			nextAgents.set(key, {
				turns: history?.turns,
				tools: history?.tools,
				activeMs: sample.activeMs,
				leaf: history?.leaf,
			});
			lines.push("", `### ${this.#quote(ref.id)} (${this.#quote(ref.displayName)}) — ${sample.status}`);
			lines.push(
				`TOTAL turns ${history?.incompleteAncestry ? `unavailable (${history.turns} readable responses)` : (history?.turns ?? "unavailable")}; tool calls ${history?.incompleteAncestry ? `unavailable (${history.tools} readable calls)` : (history?.tools ?? "unavailable")}; active time ${sample.activeMs === undefined ? "unavailable" : `${age(sample.activeMs)}${sample.partial ? " observed; historical running windows unavailable (partial total)" : " total observed running windows"}`}${delta}.`,
			);
			const activity = history?.hasDiagnostics
				? Math.max(history.lastActivity ?? 0, ref.session ? (this.#workActivity.get(ref.session) ?? 0) : 0)
				: Math.max(
						ref.lastActivity,
						history?.lastActivity ?? 0,
						ref.session ? (this.#workActivity.get(ref.session) ?? 0) : 0,
					);
			lines.push(
				`Last observable non-diagnostic activity ${activity ? `${age(now - activity)} ago` : "unavailable"}${ref.activity ? `; activity ${this.#quote(ref.activity)}` : ""}. Silence is not proof of a stall.`,
			);
			if (history?.hasDiagnostics)
				lines.push(
					`Diagnostic-only assistant responses ${history.diagnosticTurns ?? 0} are included in transcript totals, not useful-progress freshness; raw registry activity ${age(now - ref.lastActivity)} ago may include diagnostics.`,
				);
			if (ref.status === "running" && ref.session?.isStreaming !== true)
				lines.push(
					`Registry claims running but no attached live turn corroborates it${ref.lifecycle?.acceptedAt ? `; final result accepted at ${stamp(ref.lifecycle.acceptedAt)} but not terminalized` : ""}.`,
				);
			if (ref.status === "running" && sample.status === "active" && ref.lifecycle?.acceptedAt)
				lines.push(
					`Final result accepted at ${stamp(ref.lifecycle.acceptedAt)}; registry still running with an attached active turn (possibly a wake turn).`,
				);
			if (sample.error) lines.push(`Transcript unavailable: ${this.#quote(sample.error)}.`);
			if (history?.incompleteAncestry)
				lines.push(
					"Transcript ancestry is incomplete; readable tail turns follow, but cumulative counters are unavailable.",
				);
			if (!history) lines.push("Last five assistant turns unavailable: no readable transcript.");
			else {
				for (const pending of history.pending)
					lines.push(
						`- Pending/unpaired tool ${pending.name}${pending.startedAt !== undefined ? `; execution marker age ${age(now - pending.startedAt)}` : "; execution start time unavailable"}${pending.intent ? `; intent ${pending.intent}` : ""} (unpaired history is not proof of current execution).`,
					);
				lines.push(
					`Last ${history.recent.length} assistant turns, oldest → newest${history.turns > 5 ? `; ${history.turns - 5} earlier turns omitted` : ""}:`,
				);
				for (const turn of history.recent)
					lines.push(
						`- ${stamp(turn.timestamp)}: ${turn.text}; tools ${turn.tools.length ? turn.tools.map(tool => `${tool.name} (${tool.outcome})`).join(", ") : "none"}${turn.omittedTools ? ` [${turn.omittedTools} tool calls omitted]` : ""}`,
					);
			}
			agentSections.push({ key, text: lines.join("\n") });
		}
		const jobRows = runningJobs.map(job => `- ${this.#jobLabel(job, now)}`);
		if (!manager) jobRows.push("Async-job manager unavailable for this session (not an empty global snapshot).");
		else {
			for (const owner of [this.#session.getAgentId(), ...this.#agentOwners]) {
				if (owner === undefined || !this.#ownerInScope(owner)) continue;
				const delivery = manager.getDeliveryState({ ownerId: owner });
				if (delivery.queued || delivery.delivering || delivery.pendingJobIds.length)
					jobRows.push(
						`- Result delivery for ${this.#quote(owner)}: queued ${delivery.queued}, delivering ${delivery.delivering}; pending ${delivery.pendingJobIds.map(id => this.#quote(id)).join(", ")}${delivery.nextRetryAt ? `; retry at ${stamp(delivery.nextRetryAt)}` : ""}.`,
					);
			}
		}
		lines.push("", "## Tasks/jobs: current", ...boundedRows(jobRows));
		const serviceRows = activeServices.map(service => `- ${this.#serviceLabel(service, now)}`);
		if (!this.#session.getStallReportToolSession())
			serviceRows.push("Service source unavailable: this host supplied no ToolSession.");
		if (rootTool && !cfgLaunchEnabled.get(rootTool.settings) && this.#serviceSources.size === 0)
			serviceRows.push("Service diagnostics disabled by launch.enabled; no broker snapshot requested.");
		for (const [cwd, source] of this.#serviceSources)
			if (source.error)
				serviceRows.push(
					`Service source unavailable for project ${this.#quote(cwd)}: ${this.#quote(source.error)}.`,
				);
		for (const [file, metadata] of this.#serviceMetadata)
			if (metadata.error)
				serviceRows.push(
					`Service owner metadata unavailable for parked transcript ${this.#quote(file)}: ${this.#quote(metadata.error)}.`,
				);
		if (rootTool && cfgLaunchEnabled.get(rootTool.settings))
			for (const ref of refs) {
				const error = ref.sessionFile
					? undefined
					: "No parked transcript header; service-owner identity is unavailable unless previously observed";
				if (!ref.session && error)
					serviceRows.push(
						`Service owner metadata unavailable for ${this.#quote(ref.id)}: ${this.#quote(error)}.`,
					);
			}
		lines.push("", "## Services: current", ...boundedRows(serviceRows));
		lines.push(
			"",
			"Newly finished tasks/jobs and services, newly parked/removed agents, and todo close/reopen/remove transitions are retained in the interval section even after source-row eviction. Only observed transitions since opt-in are available; collection does not reconstruct earlier events.",
		);
		const framing = {
			sampledAt: stamp(now),
			interval: baseline
				? `Previous successfully delivered sample: ${stamp(baseline.at)}.`
				: "First reminder since opt-in.",
		};
		// Reserve count-label growth, then include only whole agent sections. Never slice trusted framing or data.
		let remaining =
			MAX_REPORT_BYTES -
			Buffer.byteLength(
				prompt.render(stallReportPrompt, {
					...framing,
					body: lines.join("\n"),
				}),
			) -
			128;
		const included: string[] = [];
		for (const section of agentSections) {
			const size = Buffer.byteLength(section.text) + 1;
			if (size <= remaining) {
				included.push(section.text);
				remaining -= size;
			} else nextAgents.delete(section.key);
		}
		lines[agentInsertion - 1] =
			`${omittedAgentSnapshots ? "Known candidate" : "Candidate"} agents ${candidates.length}; listed agent sections ${included.length}; omitted agent sections ${candidates.length - included.length}. Unchanged historical parked/aborted agents are excluded; task and service scope still includes all actual descendants.`;
		lines.splice(agentInsertion, 0, ...included);
		let committed = false;
		return {
			text: prompt
				.render(stallReportPrompt, {
					...framing,
					body: lines.join("\n"),
				})
				.trim(),
			hasUnfinishedWork:
				open.length > 0 ||
				candidates.some(candidate => candidate.status === "active") ||
				runningJobs.length > 0 ||
				activeServices.length > 0,
			commit: () => {
				if (committed || this.#disposed || sequence <= this.#committedSequence) return;
				committed = true;
				this.#committedSequence = sequence;
				events.commit();
				this.#committedAgentEvictions = agentEvictions;
				for (const [key, change] of this.#agentChanges)
					if (change.sequence <= agentWatermark) this.#agentChanges.delete(key);
				this.#baseline = { at: now, leaf, agents: nextAgents };
			},
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const dispose of this.#disposers.splice(0)) dispose();
		for (const unsubscribe of this.#activitySubscriptions.values()) unsubscribe();
		this.#activitySubscriptions.clear();
		for (const source of this.#serviceSources.values()) source.unsubscribe?.();
		this.#serviceSources.clear();
		this.#owners.clear();
		this.#serviceEventIds.clear();
		this.#agentOwners.clear();
		this.#agentChanges.clear();
		this.#serviceMetadata.clear();
		this.#serviceOwnerDiscoveries.clear();
	}
}
