import type { ActivityLedger } from "./ledger";
import type { ActivityCategory, ActivityEvidence, ActivitySource, EvidenceReferenceKind } from "./types";

type JournalSource = "omp" | "codex" | "claude_code";

const JOURNAL_EVENT_TYPES: Record<JournalSource, readonly string[]> = {
	omp: ["message"],
	codex: ["event_msg", "response_item"],
	claude_code: ["user", "assistant", "tool_use", "tool_result"],
};

export interface JournalImportRequest {
	readonly source: JournalSource;
	readonly sessionId: string;
	readonly jsonl: string;
	readonly ledger: ActivityLedger;
	readonly projectId?: string;
	readonly workspaceId?: string;
	readonly activityCategory?: ActivityCategory;
	readonly maximumIdleMs?: number;
}

export interface JournalImportResult {
	readonly storedEvidenceIds: readonly string[];
	readonly duplicateEvidenceIds: readonly string[];
	readonly ignoredLineNumbers: readonly number[];
}

export interface PrimaryActivityInput {
	readonly id: string;
	readonly source: Extract<ActivitySource, "git" | "terminal">;
	readonly sourceEventId: string;
	readonly window: { readonly startedAt: string; readonly endedAt: string };
	readonly recordedAt: string;
	readonly activityCategory: ActivityCategory;
	readonly confidenceReason: string;
	readonly evidenceRef: { readonly id: string; readonly kind: Extract<EvidenceReferenceKind, "commit" | "terminal"> };
	readonly projectId?: string;
	readonly workspaceId?: string;
}

/**
 * Converts timestamped OMP, Codex, or Claude Code JSONL events into primary
 * agent-runtime evidence without retaining prompt, tool, or response content.
 */
export function importJournalJsonl(request: JournalImportRequest): JournalImportResult {
	const parsed = parseJournalEvents(request);
	const maximumIdleMs = request.maximumIdleMs ?? 5 * 60_000;
	if (!Number.isSafeInteger(maximumIdleMs) || maximumIdleMs <= 0)
		throw new Error("maximumIdleMs must be a positive integer");

	const storedEvidenceIds: string[] = [];
	const duplicateEvidenceIds: string[] = [];
	for (let index = 0; index < parsed.events.length; index++) {
		const event = parsed.events[index];
		if (!event) continue;
		const next = parsed.events[index + 1];
		const startedAt = event.timestamp;
		const startedMs = Date.parse(startedAt);
		const nextMs = next ? Date.parse(next.timestamp) : Number.NaN;
		const endMs =
			Number.isFinite(nextMs) && nextMs > startedMs
				? Math.min(nextMs, startedMs + maximumIdleMs)
				: startedMs + maximumIdleMs;
		const endedAt = new Date(endMs).toISOString();
		const evidence: ActivityEvidence = {
			id: `${request.source}:${request.sessionId}:${event.id}`,
			source: request.source,
			sourceEventId: event.id,
			window: { startedAt, endedAt },
			recordedAt: startedAt,
			...(request.projectId ? { projectId: request.projectId } : {}),
			...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
			activityCategory: request.activityCategory ?? "unknown",
			strength: "primary",
			signal: "agent_runtime",
			confidence: "medium",
			confidenceReason: `Timestamped ${request.source} journal event.`,
			evidenceRefs: [{ id: request.sessionId, kind: "session" }],
		};
		if (request.ledger.record(evidence)) storedEvidenceIds.push(evidence.id);
		else duplicateEvidenceIds.push(evidence.id);
	}
	return { storedEvidenceIds, duplicateEvidenceIds, ignoredLineNumbers: parsed.ignoredLineNumbers };
}

/** Record deterministic Git or terminal evidence in the same local ledger. */
export function ingestPrimaryActivity(ledger: ActivityLedger, input: PrimaryActivityInput): boolean {
	return ledger.record({
		id: input.id,
		source: input.source,
		sourceEventId: input.sourceEventId,
		window: input.window,
		recordedAt: input.recordedAt,
		...(input.projectId ? { projectId: input.projectId } : {}),
		...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
		activityCategory: input.activityCategory,
		strength: "primary",
		signal: "human_active",
		confidence: "medium",
		confidenceReason: input.confidenceReason,
		evidenceRefs: [input.evidenceRef],
	});
}

function parseJournalEvents(request: JournalImportRequest): {
	events: Array<{ id: string; timestamp: string }>;
	ignoredLineNumbers: number[];
} {
	const events: Array<{ id: string; timestamp: string }> = [];
	const ignoredLineNumbers: number[] = [];
	const supportedTypes = JOURNAL_EVENT_TYPES[request.source];
	for (const [index, line] of request.jsonl.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		const parsed = parseJournalLine(line);
		if (!parsed || !supportedTypes.includes(parsed.type)) {
			ignoredLineNumbers.push(index + 1);
			continue;
		}
		events.push({ id: parsed.id ?? `${index + 1}`, timestamp: parsed.timestamp });
	}
	events.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
	return { events, ignoredLineNumbers };
}

function parseJournalLine(line: string): { id?: string; timestamp: string; type: string } | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as Record<string, unknown>;
		if (typeof record.type !== "string" || typeof record.timestamp !== "string") return undefined;
		if (!Number.isFinite(Date.parse(record.timestamp))) return undefined;
		return {
			type: record.type,
			timestamp: record.timestamp,
			...(typeof record.id === "string" ? { id: record.id } : {}),
		};
	} catch {
		return undefined;
	}
}
