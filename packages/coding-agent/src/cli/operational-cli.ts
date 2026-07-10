/**
 * Durable operational runtime CLI (`omp runtime ...`).
 *
 * Core logic lives here so tests can drive enqueue/list/state/search/schedule
 * flows against a temp DB with an injected executor.
 */

import * as path from "node:path";
import { getProjectDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import {
	type DurableJob,
	DurableRunner,
	getNextOccurrenceUtc,
	type JobExecutor,
	type JsonValue,
	type NotificationSink,
	OperationalStore,
	type ScheduledJobPayload,
	type StateScope,
	type TrajectoryEvent,
	validateCron,
} from "../operational";
import {
	composeNotificationSinks,
	createFileNotificationSink,
	createWebhookNotificationSink,
} from "../operational/notification-sinks";
import {
	APPROVAL_MODES,
	createOmpProcessExecutor,
	type OmpApprovalMode,
	type OmpProcessJobPayload,
	parseOmpProcessJobPayload,
} from "../operational/omp-process-executor";
import { OperationalTrajectoryRecorder } from "../operational/trajectory-recorder";

export const RUNTIME_ACTIONS = [
	"enqueue",
	"run",
	"list",
	"show",
	"pause",
	"resume",
	"cancel",
	"schedule-add",
	"schedule-list",
	"state-get",
	"state-set",
	"state-delete",
	"state-list",
	"history-search",
	"events",
	"correct",
] as const;

export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number];

export interface RuntimeCommandFlags {
	readonly db?: string;
	readonly prompt?: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly approvalMode?: string;
	readonly cron?: string;
	readonly name?: string;
	readonly notifyFile?: string;
	readonly webhookUrl?: string;
	readonly once?: boolean;
	readonly pollMs?: number;
	readonly project?: string;
	readonly key?: string;
	readonly value?: string;
	readonly query?: string;
	readonly rating?: number;
	readonly json?: boolean;
	readonly summary?: string;
	readonly category?: string;
}

export interface RuntimeCommandArgs {
	readonly action: RuntimeAction;
	readonly id?: string;
	readonly flags: RuntimeCommandFlags;
}

export interface RuntimeCliIo {
	readonly writeStdout: (line: string) => void;
	readonly writeStderr: (line: string) => void;
}

export interface RuntimeCliDeps {
	readonly store?: OperationalStore;
	readonly executor?: JobExecutor;
	readonly notificationSink?: NotificationSink;
	readonly now?: () => number;
	readonly createId?: () => string;
	readonly signal?: AbortSignal;
	readonly installSignalHandlers?: boolean;
	readonly io?: RuntimeCliIo;
}

const SECRET_KEY_RE =
	/(api[_-]?key|apikey|authorization|auth|cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|bearer|webhook)/i;
const SECRET_VALUE_RE =
	/(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/i;

const MAX_CORRECTION_SUMMARY = 280;

function defaultIo(): RuntimeCliIo {
	return {
		writeStdout: line => {
			process.stdout.write(`${line}\n`);
		},
		writeStderr: line => {
			process.stderr.write(`${line}\n`);
		},
	};
}

function isRuntimeAction(value: string): value is RuntimeAction {
	return (RUNTIME_ACTIONS as readonly string[]).includes(value);
}

export function parseRuntimeAction(value: string | undefined): RuntimeAction {
	if (!value || !isRuntimeAction(value)) {
		throw new Error(`runtime action required: ${RUNTIME_ACTIONS.join("|")}`);
	}
	return value;
}

function resolveDbPath(flags: RuntimeCommandFlags): string | undefined {
	if (!flags.db?.trim()) return undefined;
	return path.resolve(flags.db.trim());
}

function resolveScope(flags: RuntimeCommandFlags): StateScope {
	if (flags.project !== undefined) {
		const projectPath = flags.project.trim() || getProjectDir();
		if (!projectPath) throw new Error("--project requires a project path");
		return { kind: "project", projectPath: path.resolve(projectPath) };
	}
	return { kind: "user" };
}

function requireFlag(name: string, value: string | undefined): string {
	if (!value?.trim()) throw new Error(`--${name} is required`);
	return value.trim();
}

function parseApprovalMode(value: string | undefined): OmpApprovalMode | undefined {
	if (value === undefined) return undefined;
	if (!(APPROVAL_MODES as readonly string[]).includes(value)) {
		throw new Error(`--approval-mode must be one of ${APPROVAL_MODES.join("|")}`);
	}
	return value as OmpApprovalMode;
}

function buildOmpPayload(flags: RuntimeCommandFlags): OmpProcessJobPayload {
	const payload = parseOmpProcessJobPayload({
		prompt: requireFlag("prompt", flags.prompt),
		cwd: requireFlag("cwd", flags.cwd ?? process.cwd()),
		...(flags.model ? { model: flags.model } : {}),
		approvalMode: parseApprovalMode(flags.approvalMode) ?? "always-ask",
	});
	return payload;
}

function looksSecretLikeKey(key: string): boolean {
	return SECRET_KEY_RE.test(key);
}

function looksSecretLikeValue(value: string): boolean {
	return SECRET_VALUE_RE.test(value);
}

function redactJsonValue(value: JsonValue): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		return looksSecretLikeValue(value) ? "[redacted]" : value;
	}
	if (Array.isArray(value)) {
		return value.map(item => redactJsonValue(item));
	}
	const out: { [key: string]: JsonValue } = {};
	for (const [key, nested] of Object.entries(value)) {
		if (looksSecretLikeKey(key)) {
			out[key] = "[redacted]";
			continue;
		}
		out[key] = redactJsonValue(nested);
	}
	return out;
}

function redactEvent(event: TrajectoryEvent): TrajectoryEvent {
	return {
		...event,
		payload: redactJsonValue(event.payload),
	};
}

function sanitizeDisplay(value: string, maxChars = 240): string {
	const normalized = value
		.replace(/[\t\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function formatJobLine(job: DurableJob): string {
	return `${sanitizeDisplay(job.id, 80)}  ${job.status.padEnd(10)}  ${sanitizeDisplay(job.type, 80)}  updated=${new Date(job.updatedAt).toISOString()}`;
}

function emit(io: RuntimeCliIo, flags: RuntimeCommandFlags, value: unknown, humanLines: string[]): void {
	if (flags.json) {
		io.writeStdout(JSON.stringify(value, null, 2));
		return;
	}
	for (const line of humanLines) io.writeStdout(line);
}

function openStore(flags: RuntimeCommandFlags, deps: RuntimeCliDeps): { store: OperationalStore; owned: boolean } {
	if (deps.store) return { store: deps.store, owned: false };
	const store = new OperationalStore({
		dbPath: resolveDbPath(flags),
		now: deps.now,
		createId: deps.createId,
	});
	return { store, owned: true };
}

function buildNotificationSink(flags: RuntimeCommandFlags, deps: RuntimeCliDeps): NotificationSink | undefined {
	if (deps.notificationSink) return deps.notificationSink;
	const sinks: NotificationSink[] = [];
	if (flags.notifyFile?.trim()) {
		sinks.push(createFileNotificationSink({ filePath: flags.notifyFile.trim() }));
	}
	if (flags.webhookUrl?.trim()) {
		sinks.push(createWebhookNotificationSink({ url: flags.webhookUrl.trim() }));
	}
	return composeNotificationSinks(sinks);
}

function buildOperationalContext(store: OperationalStore, job: DurableJob): string {
	let projectPath: string | undefined;
	try {
		projectPath = parseOmpProcessJobPayload(job.payload).cwd;
	} catch {
		// Non-OMP jobs can still receive user state and corrections.
	}
	const userState = store.listState({ kind: "user" }).slice(0, 100);
	const projectState = projectPath ? store.listState({ kind: "project", projectPath }).slice(0, 100) : [];
	const corrections = store
		.listEvents({ kind: "human_correction", jobId: job.id, limit: 100 })
		.slice(-20)
		.map(event => event.payload);
	return JSON.stringify({ userState, projectState, corrections }, null, 2).slice(0, 8_000);
}

function createRunner(store: OperationalStore, flags: RuntimeCommandFlags, deps: RuntimeCliDeps): DurableRunner {
	const executor =
		deps.executor ?? createOmpProcessExecutor({ getOperationalContext: job => buildOperationalContext(store, job) });
	return new DurableRunner({
		store,
		executor,
		pollIntervalMs: flags.pollMs,
		notificationSink: buildNotificationSink(flags, deps),
		now: deps.now,
		createId: deps.createId,
	});
}

function requireId(id: string | undefined, action: string): string {
	if (!id?.trim()) throw new Error(`${action} requires a job id`);
	return id.trim();
}

async function runWorkerLoop(
	runner: DurableRunner,
	flags: RuntimeCommandFlags,
	deps: RuntimeCliDeps,
	io: RuntimeCliIo,
): Promise<void> {
	const controller = new AbortController();
	const external = deps.signal;
	const onExternalAbort = (): void => controller.abort();
	if (external) {
		if (external.aborted) controller.abort();
		else external.addEventListener("abort", onExternalAbort, { once: true });
	}

	const installHandlers = deps.installSignalHandlers !== false && !deps.signal;
	const onSignal = (): void => {
		controller.abort();
	};
	if (installHandlers) {
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	}

	try {
		if (flags.once) {
			const job = await runner.runOnce(controller.signal);
			if (!job) {
				emit(io, flags, { ran: false }, ["No queued job claimed."]);
				return;
			}
			emit(io, flags, job, [formatJobLine(job), `result=${job.status}`]);
			return;
		}
		io.writeStderr("runtime worker running (Ctrl+C to stop)");
		await runner.runLoop(controller.signal);
	} finally {
		if (installHandlers) {
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
		}
		if (external) external.removeEventListener("abort", onExternalAbort);
		runner.dispose();
	}
}

export async function runRuntimeCommand(cmd: RuntimeCommandArgs, deps: RuntimeCliDeps = {}): Promise<void> {
	const io = deps.io ?? defaultIo();
	const { store, owned } = openStore(cmd.flags, deps);
	try {
		switch (cmd.action) {
			case "enqueue": {
				const payload = buildOmpPayload(cmd.flags);
				const runner = createRunner(store, cmd.flags, deps);
				try {
					const job = runner.enqueue({ type: "omp", payload });
					emit(io, cmd.flags, job, [`Enqueued ${job.id}`, formatJobLine(job)]);
				} finally {
					runner.dispose();
				}
				return;
			}
			case "run": {
				const runner = createRunner(store, cmd.flags, deps);
				await runWorkerLoop(runner, cmd.flags, deps, io);
				return;
			}
			case "list": {
				const jobs = store.listJobs({ limit: 100 });
				emit(io, cmd.flags, jobs, jobs.length === 0 ? ["No jobs."] : jobs.map(formatJobLine));
				return;
			}
			case "show": {
				const id = requireId(cmd.id, "show");
				const job = store.getJob(id);
				if (!job) throw new Error(`job not found: ${id}`);
				const checkpoint = store.getCheckpoint(id);
				const value = { job, checkpoint };
				emit(io, cmd.flags, value, [
					formatJobLine(job),
					`type=${job.type}`,
					`error=${job.error ?? "-"}`,
					`checkpoint=${checkpoint ? JSON.stringify(checkpoint.data) : "-"}`,
				]);
				return;
			}
			case "pause":
			case "resume":
			case "cancel": {
				const id = requireId(cmd.id, cmd.action);
				const runner = createRunner(store, cmd.flags, deps);
				try {
					const job =
						cmd.action === "pause"
							? runner.pause(id)
							: cmd.action === "resume"
								? runner.resume(id)
								: runner.cancel(id);
					emit(io, cmd.flags, job, [formatJobLine(job)]);
				} finally {
					runner.dispose();
				}
				return;
			}
			case "schedule-add": {
				const cron = requireFlag("cron", cmd.flags.cron);
				validateCron(cron);
				const name = requireFlag("name", cmd.flags.name);
				const ompPayload = buildOmpPayload(cmd.flags);
				const scheduledPayload: ScheduledJobPayload = {
					jobType: "omp",
					jobPayload: ompPayload,
				};
				const now = deps.now?.() ?? Date.now();
				const nextRunAt = getNextOccurrenceUtc(cron, now);
				const schedule = store.upsertSchedule({
					name,
					cron,
					enabled: true,
					nextRunAt,
					payload: scheduledPayload,
				});
				emit(io, cmd.flags, schedule, [
					`Scheduled ${sanitizeDisplay(schedule.id, 80)} name=${sanitizeDisplay(schedule.name)}`,
					`cron=${sanitizeDisplay(schedule.cron, 120)}`,
					`nextRunAt=${schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : "-"}`,
				]);
				return;
			}
			case "schedule-list": {
				const schedules = store.listSchedules();
				emit(
					io,
					cmd.flags,
					schedules,
					schedules.length === 0
						? ["No schedules."]
						: schedules.map(
								s =>
									`${sanitizeDisplay(s.id, 80)}  ${s.enabled ? "on " : "off"}  ${sanitizeDisplay(s.name)}  ${sanitizeDisplay(s.cron, 120)}  next=${s.nextRunAt ? new Date(s.nextRunAt).toISOString() : "-"}`,
							),
				);
				return;
			}
			case "state-get": {
				const key = requireFlag("key", cmd.flags.key);
				const scope = resolveScope(cmd.flags);
				const value = store.getState(scope, key);
				emit(io, cmd.flags, { scope, key, value }, [value === null ? "(null)" : JSON.stringify(value)]);
				return;
			}
			case "state-set": {
				const key = requireFlag("key", cmd.flags.key);
				const raw = requireFlag("value", cmd.flags.value);
				let parsed: JsonValue = raw;
				try {
					parsed = JSON.parse(raw) as JsonValue;
				} catch {
					parsed = raw;
				}
				const scope = resolveScope(cmd.flags);
				const entry = store.setState(scope, key, parsed);
				emit(io, cmd.flags, entry, [`Set ${key}=${JSON.stringify(entry.value)}`]);
				return;
			}
			case "state-delete": {
				const key = requireFlag("key", cmd.flags.key);
				const scope = resolveScope(cmd.flags);
				const deleted = store.deleteState(scope, key);
				emit(io, cmd.flags, { scope, key, deleted }, [deleted ? `Deleted ${key}` : `Missing ${key}`]);
				return;
			}
			case "state-list": {
				const scope = resolveScope(cmd.flags);
				const entries = store.listState(scope, cmd.flags.key);
				emit(
					io,
					cmd.flags,
					entries,
					entries.length === 0
						? ["No state entries."]
						: entries.map(e => `${sanitizeDisplay(e.key, 120)}=${sanitizeDisplay(JSON.stringify(e.value), 240)}`),
				);
				return;
			}
			case "history-search": {
				const query = requireFlag("query", cmd.flags.query);
				const episodes = store.searchEpisodes(query, { limit: 50 });
				emit(
					io,
					cmd.flags,
					episodes,
					episodes.length === 0
						? ["No episodes matched."]
						: episodes.map(
								e =>
									`${sanitizeDisplay(e.id, 80)}  ${sanitizeDisplay(e.title, 160)}  ${sanitizeDisplay(e.summary, 320)}`,
							),
				);
				return;
			}
			case "events": {
				const events = store
					.listEvents({
						jobId: cmd.id?.trim() || undefined,
						limit: 100,
					})
					.map(redactEvent);
				emit(
					io,
					cmd.flags,
					events,
					events.length === 0
						? ["No events."]
						: events.map(
								e =>
									`${new Date(e.createdAt).toISOString()}  ${e.kind}  job=${e.jobId ?? "-"}  ${JSON.stringify(e.payload)}`,
							),
				);
				return;
			}
			case "correct": {
				const summary = cmd.flags.summary?.trim();
				if (summary && summary.length > MAX_CORRECTION_SUMMARY) {
					throw new Error(`--summary must be <= ${MAX_CORRECTION_SUMMARY} characters`);
				}
				if (summary && looksSecretLikeValue(summary)) {
					throw new Error("--summary looks secret-like");
				}
				const category = (cmd.flags.category?.trim() || "other").slice(0, MAX_CORRECTION_SUMMARY);
				if (looksSecretLikeKey(category) || looksSecretLikeValue(category)) {
					throw new Error("--category looks secret-like");
				}
				if (cmd.flags.rating !== undefined && (cmd.flags.rating < 1 || cmd.flags.rating > 5)) {
					throw new Error("--rating must be between 1 and 5");
				}
				const recorder = new OperationalTrajectoryRecorder({
					store,
					jobId: cmd.id?.trim() || null,
					now: deps.now,
				});
				recorder.recordHumanCorrection({
					category,
					summary,
					rating: cmd.flags.rating,
				});
				const latest = store
					.listEvents({
						kind: "human_correction",
						jobId: cmd.id?.trim() || undefined,
						limit: 10_000,
					})
					.at(-1);
				emit(io, cmd.flags, latest ?? { ok: true }, [
					latest ? `Recorded human_correction ${latest.id}` : "Recorded human_correction",
				]);
				return;
			}
			default: {
				const _exhaustive: never = cmd.action;
				throw new Error(`unsupported runtime action: ${String(_exhaustive)}`);
			}
		}
	} finally {
		if (owned) store.close();
	}
}
