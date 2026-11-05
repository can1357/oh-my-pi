/**
 * Workflow journal: one JSONL line per agent-call state transition.
 *
 * Every append is synchronous (`appendFileSync`), so a `kill -9` between two
 * calls leaves a readable journal on disk. `readRun` tolerates a truncated
 * final line — the one a kill can leave mid-write — and folds repeated lines
 * for the same call index into the latest state.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export type WorkflowCallStatus = "started" | "completed" | "failed" | "cached";

/** One agent() call's latest known state. */
export interface WorkflowCallRecord {
	/** Position in the script's deterministic call order. */
	index: number;
	/** sha256 over the prompt and the call options that affect its result. */
	promptHash: string;
	/** Agent definition the call was routed to; `"default"` when omitted. */
	agent: string;
	/** Child output; `null` for a started/failed line. */
	result: string | null;
	tokens: number;
	status: WorkflowCallStatus;
	/** Failure message for a `failed` line. */
	error?: string;
}

export interface WorkflowJournalLine extends WorkflowCallRecord {
	runId: string;
}

export interface WorkflowRunRecord {
	runId: string;
	calls: WorkflowCallRecord[];
}

/** What the journal needs from a session; the tool session satisfies it. */
export interface WorkflowJournalHost {
	getSessionFile?: () => string | null;
	getSessionId?: () => string | null;
}

/**
 * Place the journal under the session's own directory:
 * `<session dir>/workflow/<session basename>/journal.jsonl`. A host without a
 * session file falls back to the agent directory.
 */
export function resolveWorkflowJournalPath(host: WorkflowJournalHost, override?: string): string {
	if (override !== undefined && override.length > 0) return path.resolve(override);
	const sessionFile = host.getSessionFile?.() ?? null;
	if (sessionFile) {
		const base = path.basename(sessionFile).replace(/\.jsonl$/i, "");
		return path.join(path.dirname(sessionFile), "workflow", base, "journal.jsonl");
	}
	const sessionId = host.getSessionId?.() ?? null;
	return sessionId
		? path.join(getAgentDir(), "workflow", sessionId, "journal.jsonl")
		: path.join(getAgentDir(), "workflow", "journal.jsonl");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Stable prompt fingerprint used for resume prefix matching. Only inputs that
 * can change the child's answer are part of the hash, so a cosmetic edit to
 * the script around a call does not invalidate it.
 */
export function hashAgentCall(call: { prompt: string; agent?: string; context?: string }): string {
	const canonical = canonicalJson([call.prompt, call.agent ?? "", call.context ?? ""]);
	return createHash("sha256").update(canonical).digest("hex");
}

function isJournalLine(value: unknown): value is WorkflowJournalLine {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record.runId !== "string") return false;
	if (typeof record.index !== "number" || !Number.isInteger(record.index) || record.index < 0) return false;
	if (typeof record.promptHash !== "string") return false;
	if (typeof record.agent !== "string") return false;
	if (typeof record.tokens !== "number") return false;
	if (record.result !== null && typeof record.result !== "string") return false;
	if (
		record.status !== "started" &&
		record.status !== "completed" &&
		record.status !== "failed" &&
		record.status !== "cached"
	) {
		return false;
	}
	return record.error === undefined || typeof record.error === "string";
}

export class WorkflowJournal {
	readonly path: string;

	constructor(journalPath: string) {
		this.path = journalPath;
	}

	/** Append one state transition and flush to the OS synchronously. */
	append(line: WorkflowJournalLine): void {
		fs.mkdirSync(path.dirname(this.path), { recursive: true });
		// A kill can truncate the line being written. Without a separator the
		// next append would concatenate onto it and lose that record too.
		if (this.#endsWithoutNewline()) fs.appendFileSync(this.path, "\n", "utf8");
		fs.appendFileSync(this.path, `${JSON.stringify(line)}\n`, "utf8");
	}

	#endsWithoutNewline(): boolean {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.path);
		} catch {
			return false;
		}
		if (stat.size === 0) return false;
		const buffer = Buffer.alloc(1);
		const fd = fs.openSync(this.path, "r");
		try {
			fs.readSync(fd, buffer, 0, 1, stat.size - 1);
		} finally {
			fs.closeSync(fd);
		}
		return buffer[0] !== 0x0a;
	}

	/** Fold every line for `runId` into the run's latest per-index call states. */
	readRun(runId: string): WorkflowRunRecord | undefined {
		let text: string;
		try {
			text = fs.readFileSync(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const byIndex = new Map<number, WorkflowCallRecord>();
		let found = false;
		for (const rawLine of text.split("\n")) {
			if (rawLine.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawLine);
			} catch {
				// A kill can truncate the line being written; the prefix before
				// it is still a valid resume source.
				continue;
			}
			if (!isJournalLine(parsed) || parsed.runId !== runId) continue;
			found = true;
			byIndex.set(parsed.index, {
				index: parsed.index,
				promptHash: parsed.promptHash,
				agent: parsed.agent,
				result: parsed.result,
				tokens: parsed.tokens,
				status: parsed.status,
				...(parsed.error !== undefined ? { error: parsed.error } : {}),
			});
		}
		if (!found) return undefined;
		return {
			runId,
			calls: Array.from(byIndex.values()).sort((left, right) => left.index - right.index),
		};
	}
}
