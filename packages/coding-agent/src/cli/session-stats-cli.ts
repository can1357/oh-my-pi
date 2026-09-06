/**
 * Session stats CLI command handlers.
 *
 * `omp session-stats <session-id|previous|path>` prints the cumulative
 * token/cost totals of a persisted session, computed from its JSONL
 * transcript — the source of truth for usage (each assistant message entry
 * carries `usage` with `cost`, `model_usage` entries carry off-transcript
 * calls, `task` tool results embed subagent usage, and teardown appends a
 * `session_exit` entry on quit, kill, and error). A fresh process can
 * therefore report another session's exact totals.
 *
 * Totals are the LIFETIME totals for the active branch (root → last entry)
 * of the session file. This is deliberately broader than the live
 * `session_stats` surface, which is context-window-scoped (it resets after
 * compaction): for a compacted session these totals exceed anything the
 * live surface ever showed.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getSessionsDir, isRecord, readLines } from "@oh-my-pi/pi-utils";

export interface SessionStatsCommandArgs {
	/** Session id, "previous" (most recently modified), or a .jsonl path. */
	ref: string;
	/** Agent dir override (defaults to {@link getAgentDir}); used by tests. */
	agentDir?: string;
	/** Output sink for the JSON result (defaults to `console.log`). */
	out?: (text: string) => void;
	/** Error sink for the failure message (defaults to `console.error`). */
	err?: (text: string) => void;
}

export interface SessionStatsResult {
	session_id: string;
	session_file: string;
	input_tokens: number;
	output_tokens: number;
	cached_tokens: number;
	cache_write_tokens: number;
	reasoning_tokens: number;
	total_tokens: number;
	cost_usd: number;
	models: string[];
	/** Timestamp of the session header. */
	started: string;
	/** Timestamp of the most recent entry ON the active branch; off-branch forks are excluded. */
	ended: string;
	assistant_messages: number;
	user_messages: number;
	exit_reason?: string;
}

/** Cumulative token/cost accumulation; non-finite persisted fields count as zero. */
interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	totalTokens: number;
	costTotal: number;
}

const EMPTY_TOTALS: Totals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoningTokens: 0,
	totalTokens: 0,
	costTotal: 0,
};

function coerceNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Lenient projection of a persisted `usage` object. Returns undefined when
 * the value is not a usage object at all; otherwise missing fields coerce
 * to zero so one malformed entry cannot crash the rollup.
 */
function projectUsage(value: unknown): Totals | undefined {
	if (!isRecord(value) || !isRecord(value.cost)) return undefined;
	const cost = value.cost;
	return {
		input: coerceNumber(value.input),
		output: coerceNumber(value.output),
		cacheRead: coerceNumber(value.cacheRead),
		cacheWrite: coerceNumber(value.cacheWrite),
		reasoningTokens: coerceNumber(value.reasoningTokens),
		totalTokens: coerceNumber(value.totalTokens),
		costTotal: coerceNumber(cost.total),
	};
}

function addUsage(totals: Totals, usage: Totals): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.reasoningTokens += usage.reasoningTokens;
	totals.totalTokens += usage.totalTokens;
	totals.costTotal += usage.costTotal;
}

/** Parse the first `{"type":"session",...}` header line (skips the title slot). */
export async function readSessionHeader(sessionFile: string): Promise<{ id: string; timestamp: string } | undefined> {
	try {
		const chunk = await Bun.file(sessionFile).slice(0, 65_536).text();
		for (const line of chunk.split("\n")) {
			if (line.length === 0) continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (isRecord(record) && record.type === "session" && typeof record.id === "string") {
				return { id: record.id, timestamp: typeof record.timestamp === "string" ? record.timestamp : "" };
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

async function newestByMtime(files: string[]): Promise<string> {
	let best: { file: string; mtime: number } | undefined;
	for (const file of files) {
		const stat = await fs.stat(file).catch(() => undefined);
		if (!stat) continue;
		if (!best || stat.mtimeMs > best.mtime) best = { file, mtime: stat.mtimeMs };
	}
	if (!best) throw new Error("no readable session files found");
	return best.file;
}

/** Resolve `<session-id|previous|path>` to a session .jsonl file. */
export async function resolveSessionFile(ref: string, agentDir: string): Promise<string> {
	const resolved = path.resolve(ref);
	if (resolved.endsWith(".jsonl")) {
		const stat = await fs.stat(resolved).catch(() => undefined);
		if (stat?.isFile()) return resolved;
	}
	const sessionsRoot = getSessionsDir(agentDir);
	const files: string[] = [];
	try {
		for await (const name of new Bun.Glob("**/*.jsonl").scan(sessionsRoot)) {
			files.push(path.join(sessionsRoot, name));
		}
	} catch {
		// Missing sessions dir or unreadable root: treat as no sessions.
	}
	if (files.length === 0) {
		throw new Error(`no persisted sessions found under ${sessionsRoot}`);
	}
	if (ref === "previous" || ref === "latest") {
		return newestByMtime(files);
	}
	const byName = files.filter(file => file.endsWith(`_${ref}.jsonl`));
	if (byName.length > 0) {
		return byName.length === 1 ? byName[0] : newestByMtime(byName);
	}
	for (const file of files) {
		const header = await readSessionHeader(file);
		if (header?.id === ref) return file;
	}
	throw new Error(`no session with id "${ref}" found under ${sessionsRoot}`);
}

/**
 * Compute cumulative token/cost totals for the active branch of a session
 * file. The branch is the `parentId` chain from the last entry (the leaf),
 * mirroring how the session manager tracks its leaf.
 */
export async function computeSessionStats(sessionFile: string): Promise<SessionStatsResult> {
	const totals: Totals = { ...EMPTY_TOTALS };
	const models = new Set<string>();
	const byId = new Map<string, unknown>();
	const header = await readSessionHeader(sessionFile);
	if (!header) {
		throw new Error(`no session header found in ${sessionFile}`);
	}
	let leafId: string | null = null;
	let exitReason: string | undefined;
	let assistantMessages = 0;
	let userMessages = 0;
	let lastTimestamp = header.timestamp;

	const decoder = new TextDecoder();
	try {
		for await (const raw of readLines(Bun.file(sessionFile).stream())) {
			const line = decoder.decode(raw).trim();
			if (line.length === 0) continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue; // tolerate a torn tail line from a hard kill
			}
			if (!isRecord(record) || record.type === "title" || record.type === "session") continue;
			if (typeof record.id !== "string") continue;
			byId.set(record.id, record);
			leafId = record.id;
		}
	} catch (error) {
		throw new Error(
			`cannot read session file ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// Walk the active branch: leaf → root.
	const branch: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let cursor: unknown = leafId !== null ? byId.get(leafId) : undefined;
	while (isRecord(cursor) && !seen.has(String(cursor.id))) {
		const id = String(cursor.id);
		seen.add(id);
		branch.push(cursor);
		const parentId = cursor.parentId;
		cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
	}

	for (const record of branch) {
		if (typeof record.timestamp === "string" && record.timestamp > lastTimestamp) {
			lastTimestamp = record.timestamp;
		}
		if (record.type === "message" && isRecord(record.message)) {
			const message = record.message;
			if (message.role === "assistant") {
				assistantMessages++;
				const usage = projectUsage(message.usage);
				if (usage) {
					addUsage(totals, usage);
					if (typeof message.model === "string") models.add(message.model);
				}
			} else if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult" && message.toolName === "task" && isRecord(message.details)) {
				const usage = projectUsage(message.details.usage);
				if (usage) addUsage(totals, usage);
			}
		} else if (record.type === "model_usage") {
			const usage = projectUsage(record.usage);
			if (usage) {
				addUsage(totals, usage);
				const provider = typeof record.provider === "string" ? record.provider : "";
				if (typeof record.model === "string") {
					models.add(provider ? `${provider}/${record.model}` : record.model);
				}
			}
		} else if (record.type === "custom" && record.customType === "session_exit" && isRecord(record.data)) {
			const data = record.data;
			if (typeof data.reason === "string") exitReason = data.reason;
		}
	}

	const result: SessionStatsResult = {
		session_id: header.id,
		session_file: sessionFile,
		input_tokens: totals.input,
		output_tokens: totals.output,
		cached_tokens: totals.cacheRead,
		cache_write_tokens: totals.cacheWrite,
		reasoning_tokens: totals.reasoningTokens,
		total_tokens: totals.totalTokens,
		cost_usd: totals.costTotal,
		models: [...models].sort(),
		started: header.timestamp,
		ended: lastTimestamp,
		assistant_messages: assistantMessages,
		user_messages: userMessages,
	};
	if (exitReason !== undefined) result.exit_reason = exitReason;
	return result;
}

export async function runSessionStatsCommand(args: SessionStatsCommandArgs): Promise<void> {
	const out = args.out ?? ((text: string) => console.log(text));
	const err = args.err ?? ((text: string) => console.error(text));
	const agentDir = args.agentDir ?? getAgentDir();
	try {
		const sessionFile = await resolveSessionFile(args.ref, agentDir);
		const stats = await computeSessionStats(sessionFile);
		out(JSON.stringify(stats, null, 2));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		err(`omp session-stats: ${message}`);
		process.exitCode = 1;
	}
}
