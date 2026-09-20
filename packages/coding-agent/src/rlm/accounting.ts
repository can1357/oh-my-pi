/**
 * Whole-session RLM accounting — partitions canonical session usage vs RLM ledger.
 *
 * Attribution rules (no silent double-count):
 * - **root**: assistant messages on the active branch (main agent turns).
 * - **rlm**: purpose=`rlm` model_usage entries when present; else ledger lease
 *   totals. Ops counters always come from RlmStore/RlmRuntime.
 * - **sideOther**: other model_usage purposes (e.g. auto-thinking) — not root, not RLM.
 * - **task**: nested task toolResult usage (subagents) — separate bucket.
 * - **unknown**: ledger tokens lacking input/output split, or residual notes.
 *
 * totalAttributable = root + rlm + sideOther + task (token fields sum).
 * Raw SessionManager.getUsageStatistics() may equal that sum when RLM is recorded
 * as model_usage; experiment reports always use this partitioner.
 */

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { ModelUsageEntry, SessionEntry } from "../session/session-entries";
import type { RlmRuntime } from "./runtime";
import type { RlmStore, RlmMetrics } from "./store";
import type { RlmTrajectoryRecord } from "./broker";

export const RLM_ACCOUNTING_SCHEMA_VERSION = 1 as const;

/** Manual / fixture evidence labels — never auto-inferred without a verifier. */
export type EvidenceQualityLabel = "SUPPORTED" | "WRONG_CITATION" | "UNSUPPORTED" | "MISSED_EVIDENCE";

export interface TokenBucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** input+output+cacheRead+cacheWrite when known; else provider totalTokens. */
	total: number;
	cost: number;
	/** Completed model requests attributed to this bucket. */
	requests: number;
}

export interface RlmOpsCounters {
	spills: number;
	bytesSpilled: number;
	bytesReintroduced: number;
	peeks: number;
	searches: number;
	queries: number;
	subcalls: number;
	/** Grants selected via search/select (count of grant ranges). */
	grantsSelected: number;
	/** Empty-pattern abstentions that skipped worker inference. */
	workerCallsAvoided: number;
	failOpen: number;
	resourceResolves: number;
	/** Ledger-admitted worker calls (begin). */
	workerCalls: number;
	failedCalls: number;
	cancelledCalls: number;
}

export interface RlmSessionAccounting {
	schemaVersion: typeof RLM_ACCOUNTING_SCHEMA_VERSION;
	sessionId?: string;
	taskId?: string;
	generatedAt: string;
	durationMs?: number;
	config: {
		contextEngine?: string;
		rlmEnabled?: boolean;
		rlmMaxDepth?: number;
		note?: string;
	};
	root: TokenBucket;
	rlm: TokenBucket & { source: "model_usage" | "ledger" | "mixed" | "none" };
	sideOther: TokenBucket;
	task: TokenBucket;
	/** Work that exists but cannot be cleanly bucketed. */
	unknown: {
		/** Ledger total tokens without I/O split. */
		ledgerTokensWithoutIoSplit: number;
		/** Notes for operators. */
		notes: string[];
	};
	totalAttributable: TokenBucket;
	/** Session-manager raw totals (may include all side channels). */
	sessionRaw?: TokenBucket;
	ops: RlmOpsCounters;
	compactions: number;
	retries: number;
	/** Optional manual/fixture label — never auto-filled without verifier. */
	evidenceQuality?: EvidenceQualityLabel;
	doubleCountCheck: {
		ok: boolean;
		/** root+rlm+sideOther+task vs sessionRaw when both known. */
		detail: string;
	};
}

export interface AccountingSources {
	sessionId?: string;
	taskId?: string;
	/** Active branch entries (SessionManager.getBranch()). */
	branch?: readonly SessionEntry[];
	/** Live agent messages (may mirror branch message entries). Prefer branch when both exist. */
	messages?: readonly AgentMessage[];
	/** Optional raw session usage for reconcile check. */
	sessionRaw?: Partial<TokenBucket> & { input?: number; output?: number; totalTokens?: number; cost?: number };
	runtime?: RlmRuntime | null;
	store?: RlmStore | null;
	config?: RlmSessionAccounting["config"];
	durationMs?: number;
	/** Manual only. */
	evidenceQuality?: EvidenceQualityLabel;
	retries?: number;
	startedAt?: number;
}

function emptyBucket(): TokenBucket {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 };
}

function addUsageToBucket(bucket: TokenBucket, usage: Usage | undefined): void {
	if (!usage) return;
	bucket.input += usage.input ?? 0;
	bucket.output += usage.output ?? 0;
	bucket.cacheRead += usage.cacheRead ?? 0;
	bucket.cacheWrite += usage.cacheWrite ?? 0;
	const parts = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	bucket.total += usage.totalTokens && usage.totalTokens > 0 ? usage.totalTokens : parts;
	bucket.cost += usage.cost?.total ?? 0;
	bucket.requests += 1;
}

function sumBuckets(...buckets: TokenBucket[]): TokenBucket {
	const out = emptyBucket();
	for (const b of buckets) {
		out.input += b.input;
		out.output += b.output;
		out.cacheRead += b.cacheRead;
		out.cacheWrite += b.cacheWrite;
		out.total += b.total;
		out.cost += b.cost;
		out.requests += b.requests;
	}
	return out;
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybe = (details as Record<string, unknown>).usage;
	return maybe !== null && typeof maybe === "object" ? (maybe as Usage) : undefined;
}

function isRlmPurpose(purpose: string | undefined): boolean {
	if (!purpose) return false;
	return purpose === "rlm" || purpose.startsWith("rlm:") || purpose.startsWith("rlm/");
}

function emptyOps(): RlmOpsCounters {
	return {
		spills: 0,
		bytesSpilled: 0,
		bytesReintroduced: 0,
		peeks: 0,
		searches: 0,
		queries: 0,
		subcalls: 0,
		grantsSelected: 0,
		workerCallsAvoided: 0,
		failOpen: 0,
		resourceResolves: 0,
		workerCalls: 0,
		failedCalls: 0,
		cancelledCalls: 0,
	};
}

function opsFromMetrics(m: RlmMetrics, store: RlmStore, runtime?: RlmRuntime | null): RlmOpsCounters {
	const snap = runtime?.ledger.snapshot();
	return {
		spills: m.spills,
		bytesSpilled: m.bytesSpilled,
		bytesReintroduced: m.bytesReintroduced,
		peeks: m.peeks,
		searches: m.searches,
		queries: m.queries,
		subcalls: m.subcalls,
		grantsSelected: m.grantsSelected,
		workerCallsAvoided: m.workerCallsAvoided,
		failOpen: m.failOpen,
		resourceResolves: m.resourceResolves,
		workerCalls: snap?.calls ?? store.budget.calls,
		failedCalls: snap?.failedCalls ?? 0,
		cancelledCalls: snap?.cancelledCalls ?? 0,
	};
}

/**
 * Build partitioned accounting from session branch + optional RLM runtime.
 * Pure: does not mutate sources.
 */
export function buildRlmSessionAccounting(sources: AccountingSources): RlmSessionAccounting {
	const root = emptyBucket();
	const rlmFromUsage = emptyBucket();
	const sideOther = emptyBucket();
	const task = emptyBucket();
	const notes: string[] = [];

	const branch = sources.branch ?? [];
	let compactions = 0;
	let retries = sources.retries ?? 0;

	for (const entry of branch) {
		if (entry.type === "compaction") {
			compactions += 1;
			continue;
		}
		if (entry.type === "model_usage") {
			const mu = entry as ModelUsageEntry;
			if (isRlmPurpose(mu.purpose)) addUsageToBucket(rlmFromUsage, mu.usage);
			else addUsageToBucket(sideOther, mu.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			addUsageToBucket(root, message.usage as Usage | undefined);
		} else if (message.role === "toolResult" && message.toolName === "task") {
			addUsageToBucket(task, taskUsageFrom(message.details));
		}
	}

	// Fallback: live messages when branch empty (unit tests / pre-persist).
	if (branch.length === 0 && sources.messages) {
		for (const message of sources.messages) {
			if (message.role === "assistant") {
				addUsageToBucket(root, (message as { usage?: Usage }).usage);
			} else if (message.role === "toolResult" && (message as { toolName?: string }).toolName === "task") {
				addUsageToBucket(task, taskUsageFrom((message as { details?: unknown }).details));
			}
		}
	}

	const store = sources.store ?? sources.runtime?.store ?? null;
	const runtime = sources.runtime ?? null;
	const ops = store ? opsFromMetrics(store.metrics, store, runtime) : emptyOps();

	// Ledger-based RLM bucket when model_usage has no rlm rows.
	const rlmFromLedger = emptyBucket();
	let ledgerTokensWithoutIoSplit = 0;
	let rlmSource: RlmSessionAccounting["rlm"]["source"] = "none";

	if (runtime) {
		const records: readonly RlmTrajectoryRecord[] = runtime.records;
		for (const rec of records) {
			if (rec.status !== "completed" && rec.status !== "overshoot") continue;
			const hasIo = rec.inputTokens !== undefined || rec.outputTokens !== undefined;
			if (hasIo) {
				rlmFromLedger.input += Math.max(0, rec.inputTokens ?? 0);
				rlmFromLedger.output += Math.max(0, rec.outputTokens ?? 0);
				const io = (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0);
				rlmFromLedger.total += rec.totalTokens && rec.totalTokens > 0 ? rec.totalTokens : io;
			} else if (rec.totalTokens && rec.totalTokens > 0) {
				rlmFromLedger.total += rec.totalTokens;
				ledgerTokensWithoutIoSplit += rec.totalTokens;
			}
			rlmFromLedger.cost += rec.cost ?? 0;
			rlmFromLedger.requests += 1;
		}
		// If trajectory empty but budget charged (legacy charge path), note it.
		if (records.length === 0 && store && store.budget.calls > 0) {
			rlmFromLedger.total += store.budget.tokens;
			rlmFromLedger.cost += store.budget.cost;
			rlmFromLedger.requests += store.budget.calls;
			ledgerTokensWithoutIoSplit += store.budget.tokens;
			notes.push("rlm budget tokens used without trajectory I/O split");
		}
	} else if (store && store.budget.calls > 0) {
		rlmFromLedger.total += store.budget.tokens;
		rlmFromLedger.cost += store.budget.cost;
		rlmFromLedger.requests += store.budget.calls;
		ledgerTokensWithoutIoSplit += store.budget.tokens;
		notes.push("rlm store present without runtime; ledger-only estimate");
	}

	let rlm = emptyBucket();
	if (rlmFromUsage.requests > 0 && rlmFromLedger.requests > 0) {
		// Prefer model_usage for provider-attributed I/O; do NOT sum with ledger (same work).
		rlm = { ...rlmFromUsage };
		rlmSource = "mixed";
		notes.push(
			"rlm model_usage and ledger both present — using model_usage for tokens/cost; ledger for ops only",
		);
		// Sanity: if totals diverge wildly, note it.
		const delta = Math.abs(rlmFromUsage.total - rlmFromLedger.total);
		if (delta > 1 && rlmFromUsage.total > 0) {
			notes.push(`rlm usage vs ledger total delta=${delta}`);
		}
	} else if (rlmFromUsage.requests > 0) {
		rlm = { ...rlmFromUsage };
		rlmSource = "model_usage";
	} else if (rlmFromLedger.requests > 0 || rlmFromLedger.total > 0) {
		rlm = { ...rlmFromLedger };
		rlmSource = "ledger";
	}

	const totalAttributable = sumBuckets(root, rlm, sideOther, task);

	let sessionRaw: TokenBucket | undefined;
	if (sources.sessionRaw) {
		sessionRaw = emptyBucket();
		sessionRaw.input = sources.sessionRaw.input ?? 0;
		sessionRaw.output = sources.sessionRaw.output ?? 0;
		sessionRaw.cacheRead = sources.sessionRaw.cacheRead ?? 0;
		sessionRaw.cacheWrite = sources.sessionRaw.cacheWrite ?? 0;
		sessionRaw.total =
			sources.sessionRaw.total ??
			sources.sessionRaw.totalTokens ??
			sessionRaw.input + sessionRaw.output + sessionRaw.cacheRead + sessionRaw.cacheWrite;
		sessionRaw.cost = sources.sessionRaw.cost ?? 0;
	}

	let doubleOk = true;
	let doubleDetail = "sessionRaw not provided — skipped raw reconcile";
	if (sessionRaw) {
		// When RLM is recorded as model_usage, sessionRaw should ≈ totalAttributable.
		// When RLM is ledger-only (not in session), sessionRaw ≈ root+sideOther+task.
		const expectedWithRlm = totalAttributable.total;
		const expectedWithoutRlm = sumBuckets(root, sideOther, task).total;
		const raw = sessionRaw.total;
		const dWith = Math.abs(raw - expectedWithRlm);
		const dWithout = Math.abs(raw - expectedWithoutRlm);
		if (dWith <= 1 || dWithout <= 1) {
			doubleOk = true;
			doubleDetail =
				dWith <= 1
					? `sessionRaw.total=${raw} matches root+rlm+side+task=${expectedWithRlm}`
					: `sessionRaw.total=${raw} matches root+side+task=${expectedWithoutRlm} (rlm ledger-only, not in session raw)`;
		} else {
			doubleOk = false;
			doubleDetail = `sessionRaw.total=${raw} neither matches withRlm=${expectedWithRlm} nor withoutRlm=${expectedWithoutRlm}`;
		}
	}

	return {
		schemaVersion: RLM_ACCOUNTING_SCHEMA_VERSION,
		sessionId: sources.sessionId,
		taskId: sources.taskId,
		generatedAt: new Date().toISOString(),
		durationMs: sources.durationMs,
		config: sources.config ?? {},
		root,
		rlm: { ...rlm, source: rlmSource },
		sideOther,
		task,
		unknown: {
			ledgerTokensWithoutIoSplit,
			notes,
		},
		totalAttributable,
		sessionRaw,
		ops,
		compactions,
		retries,
		evidenceQuality: sources.evidenceQuality,
		doubleCountCheck: { ok: doubleOk, detail: doubleDetail },
	};
}

/** One-line human summary for status / end-of-task. */
export function formatRlmAccountingSummary(a: RlmSessionAccounting): string {
	const parts = [
		`root_in=${a.root.input} root_out=${a.root.output} root_req=${a.root.requests}`,
		`rlm_in=${a.rlm.input} rlm_out=${a.rlm.output} rlm_req=${a.rlm.requests} rlm_src=${a.rlm.source}`,
		`side=${a.sideOther.total} task=${a.task.total}`,
		`total=${a.totalAttributable.total} cost=${a.totalAttributable.cost.toFixed(4)}`,
		`spills=${a.ops.spills} searches=${a.ops.searches} grants=${a.ops.grantsSelected} avoided=${a.ops.workerCallsAvoided}`,
		`queries=${a.ops.queries} subcalls=${a.ops.subcalls} worker_calls=${a.ops.workerCalls}`,
		`compactions=${a.compactions} retries=${a.retries}`,
		`dbl=${a.doubleCountCheck.ok ? "ok" : "WARN"}`,
	];
	if (a.evidenceQuality) parts.push(`quality=${a.evidenceQuality}`);
	return parts.join(" ");
}

export interface ExperimentRecordOptions {
	/** Directory for JSONL append (default ~/.omp/rlm-experiments). */
	dir?: string;
	/** Also write a single JSON snapshot next to the JSONL. */
	writeSnapshot?: boolean;
	filename?: string;
}

/**
 * Append one compact experiment record as JSONL (+ optional snapshot JSON).
 * Returns paths written.
 */
export function exportRlmExperimentRecord(
	accounting: RlmSessionAccounting,
	options?: ExperimentRecordOptions,
): { jsonlPath: string; snapshotPath?: string } {
	const dir = options?.dir ?? join(process.env.HOME ?? "/tmp", ".omp", "rlm-experiments");
	mkdirSync(dir, { recursive: true });
	const day = new Date().toISOString().slice(0, 10);
	const jsonlPath = join(dir, options?.filename ?? `rlm-sessions-${day}.jsonl`);
	const line = JSON.stringify(accounting);
	appendFileSync(jsonlPath, `${line}\n`, "utf8");
	let snapshotPath: string | undefined;
	if (options?.writeSnapshot !== false) {
		const id = accounting.sessionId ?? accounting.taskId ?? `anon-${Date.now()}`;
		snapshotPath = join(dir, `session-${id}.json`);
		mkdirSync(dirname(snapshotPath), { recursive: true });
		writeFileSync(snapshotPath, `${JSON.stringify(accounting, null, 2)}\n`, "utf8");
	}
	return { jsonlPath, snapshotPath };
}

/**
 * Convenience: build + format + optional export from a loosely typed session host.
 */
export function collectRlmSessionAccounting(host: {
	sessionId?: string | (() => string | undefined);
	getSessionId?: () => string | undefined;
	sessionManager?: {
		getBranch?: () => SessionEntry[];
		getSessionId?: () => string;
		getUsageStatistics?: () => {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: number;
		};
	};
	messages?: readonly AgentMessage[];
	rlmStore?: RlmStore | null;
	settings?: { get: (path: string) => unknown };
	getRlmRuntime?: () => RlmRuntime | null | undefined;
	durationMs?: number;
	evidenceQuality?: EvidenceQualityLabel;
	retries?: number;
	taskId?: string;
}): RlmSessionAccounting {
	const sessionId =
		typeof host.sessionId === "function"
			? host.sessionId()
			: (host.sessionId ?? host.getSessionId?.() ?? host.sessionManager?.getSessionId?.());
	const raw = host.sessionManager?.getUsageStatistics?.();
	const runtime =
		host.getRlmRuntime?.() ??
		(host.rlmStore
			? // lazy import avoided — caller may pass runtime via getRlmRuntime
				undefined
			: undefined);
	// Prefer explicit runtime; fall back to store-only.
	let resolvedRuntime: RlmRuntime | null | undefined = runtime;
	if (!resolvedRuntime && host.rlmStore) {
		// Store-only path; buildRlmSessionAccounting accepts store alone.
		resolvedRuntime = null;
	}
	return buildRlmSessionAccounting({
		sessionId,
		taskId: host.taskId,
		branch: host.sessionManager?.getBranch?.() ?? [],
		messages: host.messages,
		sessionRaw: raw
			? {
					input: raw.input,
					output: raw.output,
					cacheRead: raw.cacheRead,
					cacheWrite: raw.cacheWrite,
					total: raw.totalTokens,
					cost: raw.cost,
				}
			: undefined,
		runtime: resolvedRuntime ?? undefined,
		store: host.rlmStore ?? undefined,
		config: {
			contextEngine: host.settings?.get("context.engine") as string | undefined,
			rlmEnabled: host.settings?.get("rlm.enabled") === true,
			rlmMaxDepth: host.settings?.get("rlm.maxDepth") as number | undefined,
		},
		durationMs: host.durationMs,
		evidenceQuality: host.evidenceQuality,
		retries: host.retries,
	});
}
