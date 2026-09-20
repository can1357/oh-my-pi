#!/usr/bin/env bun
/**
 * Token-usage audit over the local omp session corpus (~/.omp/agent/sessions/).
 *
 * Phase 1 (scan, no LLM): walks recent sessions, sums *real* per-request usage
 * (input/output/cacheRead/cacheWrite + nominal cost recorded in each assistant
 * message), splits main-context vs subagent usage, and aggregates tool traffic
 * (estimated tokens in args/results, context residency, repeated reads, edit
 * failures, compactions).
 *
 * Phase 2 (classify): for the costliest sessions, builds a compact digest and
 * asks a small model (default: anthropic/claude-sonnet-4-6 via @oh-my-pi/pi-ai)
 * to judge:
 *   a) session hygiene — multiple topics in one chat, missed handoff points,
 *   b) task-spawn quality — wasteful spawns, context-transfer failures,
 *   c) the biggest sources of waste given the tool traffic.
 * A final aggregate call distills systemic findings across sessions.
 *
 * Usage:
 *   bun scripts/session-stats/audit.ts                      # last week, scan + LLM
 *   bun scripts/session-stats/audit.ts --since 3d --no-llm  # scan only
 *   bun scripts/session-stats/audit.ts --folder Projects-pi --max-llm 6
 *   bun scripts/session-stats/audit.ts --json out.json
 *
 * Auth: resolves an API key for the classifier provider through omp's auth
 * storage (~/.omp/agent/agent.db: stored key, OAuth, or env var fallback).
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
	type Api,
	AuthStorage,
	completeSimple,
	type Model,
	SqliteAuthCredentialStore,
	type Tool,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getAgentDbPath, isEnoent } from "@oh-my-pi/pi-utils";
import SYSTEM_PROMPT from "./audit-prompt.md" with { type: "text" };

const SESSIONS_ROOT = path.join(os.homedir(), ".omp", "agent", "sessions");
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const CACHE_PATH = path.join(os.homedir(), ".omp", "stats-audit-cache.json");

// --------------------------------------------------------------------------
// CLI

interface CliOptions {
	since: number; // ms window
	folder?: string;
	exclude?: string;
	model: string;
	maxLlm: number;
	minCost: number;
	concurrency: number;
	json?: string;
	noLlm: boolean;
	limit?: number;
	digestDir?: string;
	session?: string;
	noCache: boolean;
}

export function parseSince(raw: string): number {
	const m = /^(\d+)?\s*(h|d|w|mo|m)$/.exec(raw.trim());
	if (!m) throw new Error(`invalid --since "${raw}" (use e.g. 12h, 3d, 1w, 1mo)`);
	const n = m[1] ? Number.parseInt(m[1], 10) : 1;
	const HOUR = 3_600_000;
	switch (m[2]) {
		case "h":
			return n * HOUR;
		case "d":
			return n * 24 * HOUR;
		case "w":
			return n * 7 * 24 * HOUR;
		default: // m | mo
			return n * 30 * 24 * HOUR;
	}
}

function parseCli(argv: string[]): CliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			since: { type: "string", default: "1w" },
			folder: { type: "string" },
			exclude: { type: "string" },
			model: { type: "string", default: DEFAULT_MODEL },
			"max-llm": { type: "string", default: "12" },
			"min-cost": { type: "string", default: "1" },
			concurrency: { type: "string", default: "4" },
			json: { type: "string" },
			"no-llm": { type: "boolean", default: false },
			limit: { type: "string" },
			"digest-dir": { type: "string" },
			session: { type: "string" },
			"no-cache": { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(
			`session audit — token usage analysis over ~/.omp/agent/sessions\n\n` +
				`  --since <12h|3d|1w|1mo>  window by session mtime (default 1w)\n` +
				`  --folder <substr>        only folders containing substring\n` +
				`  --exclude <substr>       drop folders containing substring\n` +
				`  --model <prov/id>        classifier model (default ${DEFAULT_MODEL})\n` +
				`  --max-llm <n>            classify at most n sessions (default 12)\n` +
				`  --min-cost <usd>         classify only sessions >= cost (default 1)\n` +
				`  --concurrency <n>        parallel classifier calls (default 4)\n` +
				`  --json <file>            write full machine-readable results\n` +
				`  --digest-dir <dir>       dump per-session digests fed to the model\n` +
				`  --session <substr>       classify sessions whose id/title matches (ignores --min-cost)\n` +
				`  --no-cache               skip the verdict cache (~/.omp/stats-audit-cache.json)\n` +
				`  --no-llm                 scan + report only\n` +
				`  --limit <n>              scan at most n session groups (debug)`,
		);
		process.exit(0);
	}
	return {
		since: parseSince(values.since),
		folder: values.folder,
		exclude: values.exclude,
		model: values.model,
		maxLlm: Number.parseInt(values["max-llm"], 10),
		minCost: Number.parseFloat(values["min-cost"]),
		concurrency: Math.max(1, Number.parseInt(values.concurrency, 10)),
		json: values.json,
		noLlm: values["no-llm"],
		limit: values.limit ? Number.parseInt(values.limit, 10) : undefined,
		digestDir: values["digest-dir"],
		session: values.session,
		noCache: values["no-cache"],
	};
}

// --------------------------------------------------------------------------
// Usage accounting

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	requests: number;
}

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 };
}

function addUsage(into: UsageTotals, from: UsageTotals): void {
	into.input += from.input;
	into.output += from.output;
	into.cacheRead += from.cacheRead;
	into.cacheWrite += from.cacheWrite;
	into.cost += from.cost;
	into.requests += from.requests;
}

function billedTokens(u: UsageTotals): number {
	return u.input + u.output + u.cacheRead + u.cacheWrite;
}

// --------------------------------------------------------------------------
// Per-file scan

interface ToolAgg {
	calls: number;
	argToks: number;
	resultToks: number;
	errors: number;
	/** Σ resultToks × (requests issued after the result landed) — how heavily
	 * the result sat in context for the rest of the session. */
	residency: number;
}

interface SpawnCall {
	callId: string;
	agent: string;
	labels: string[];
	descriptions: string[];
	argToks: number;
	ts: number;
	resultToks: number;
	isError: boolean;
	resultSnippet: string;
}

interface TurnInfo {
	ts: number;
	text: string;
	tokens: number;
	synthetic: boolean;
	requests: number;
	outToks: number;
	cost: number;
	tools: Map<string, number>;
	spawnAgents: string[];
}

interface TopResult {
	tool: string;
	summary: string;
	toks: number;
}

interface FileScan {
	path: string;
	stem: string;
	title?: string;
	usage: UsageTotals;
	models: Map<string, number>;
	turns: TurnInfo[];
	toolAgg: Map<string, ToolAgg>;
	spawns: SpawnCall[];
	readCounts: Map<string, { count: number; toks: number; residency: number }>;
	editErrors: number;
	editCalls: number;
	compactions: number;
	asstErrors: number;
	contextPeak: number;
	firstTs: number;
	lastTs: number;
	topResults: TopResult[];
	lastAssistantText: string;
	lastToolName: string;
}

function estTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Matches the placeholder the session writer stores when a tool result was
 * pruned from context (`[Output truncated - N tokens]`); N is the true size. */
const TRUNCATED_RESULT_RE = /\[Output truncated - (\d+) tokens?\]/;

/** Group key for repeated-read detection: keep `scheme://` URLs intact and
 * strip trailing line/raw selectors (`:50-200`, `:raw`, `:2-4:raw`, …). */
export function normalizeReadPath(p: string): string {
	let out = p;
	for (;;) {
		const next = out.replace(/:(?:raw|conflicts|[0-9][0-9+\-,]*)$/i, "");
		if (next === out) return out;
		out = next;
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const item of content) {
		if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
			out += (item as { text?: string }).text ?? "";
		}
	}
	return out;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Human-meaningful one-liner for a tool call's arguments. */
function argSummary(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const pick = (...keys: string[]): string => {
		for (const k of keys) {
			const v = args[k];
			if (typeof v === "string" && v) return v;
		}
		return "";
	};
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return clip(pick("path", "file_path", "input"), 80);
		case "bash":
			return clip(pick("command", "cmd"), 80);
		case "search":
			return clip(pick("pattern"), 60);
		case "find":
			return clip(JSON.stringify(args.paths ?? args.pattern ?? ""), 60);
		case "task": {
			const tasks = Array.isArray(args.tasks) ? args.tasks : [];
			const ids = tasks.map(t => (t as { id?: string }).id ?? "?").join(",");
			return clip(`agent=${args.agent ?? "?"} tasks=[${ids}]`, 100);
		}
		default:
			return clip(JSON.stringify(args), 70);
	}
}

interface PendingCall {
	name: string;
	args: Record<string, unknown> | undefined;
	requestIndex: number;
}

export async function scanFile(filePath: string): Promise<FileScan | undefined> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch {
		return undefined;
	}
	const scan: FileScan = {
		path: filePath,
		stem: path.basename(filePath, ".jsonl"),
		usage: emptyUsage(),
		models: new Map(),
		turns: [],
		toolAgg: new Map(),
		spawns: [],
		readCounts: new Map(),
		editErrors: 0,
		editCalls: 0,
		compactions: 0,
		asstErrors: 0,
		contextPeak: 0,
		firstTs: 0,
		lastTs: 0,
		topResults: [],
		lastAssistantText: "",
		lastToolName: "",
	};
	const pending = new Map<string, PendingCall>();
	const resultLog: { tool: string; toks: number; requestIndex: number }[] = [];
	const readLog: { path: string; toks: number; requestIndex: number }[] = [];
	const spawnByCallId = new Map<string, SpawnCall>();
	let requestCount = 0;

	const tool = (name: string): ToolAgg => {
		let agg = scan.toolAgg.get(name);
		if (!agg) {
			agg = { calls: 0, argToks: 0, resultToks: 0, errors: 0, residency: 0 };
			scan.toolAgg.set(name, agg);
		}
		return agg;
	};

	for (const line of text.split("\n")) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // torn tail line from a crashed writer
		}
		const type = entry.type;
		if (type === "session") {
			scan.title = (entry.title as string) ?? undefined;
			const ts = Date.parse((entry.timestamp as string) ?? "");
			if (Number.isFinite(ts)) scan.firstTs = ts;
			continue;
		}
		if (type === "compaction") {
			scan.compactions++;
			continue;
		}
		if (type !== "message") continue;
		const msg = entry.message as Record<string, unknown> | undefined;
		if (!msg) continue;
		const ts = typeof msg.timestamp === "number" ? msg.timestamp : 0;
		if (ts) {
			if (!scan.firstTs) scan.firstTs = ts;
			scan.lastTs = Math.max(scan.lastTs, ts);
		}
		const role = msg.role;

		if (role === "user") {
			const textBlob = contentText(msg.content);
			scan.turns.push({
				ts,
				text: clip(textBlob, 400),
				tokens: estTokens(textBlob),
				synthetic: msg.synthetic === true || msg.steering === true,
				requests: 0,
				outToks: 0,
				cost: 0,
				tools: new Map(),
				spawnAgents: [],
			});
			continue;
		}

		if (role === "assistant") {
			requestCount++;
			const usage = msg.usage as Record<string, unknown> | undefined;
			const u: UsageTotals = {
				input: (usage?.input as number) || 0,
				output: (usage?.output as number) || 0,
				cacheRead: (usage?.cacheRead as number) || 0,
				cacheWrite: (usage?.cacheWrite as number) || 0,
				cost: ((usage?.cost as Record<string, number> | undefined)?.total as number) || 0,
				requests: 1,
			};
			addUsage(scan.usage, u);
			scan.contextPeak = Math.max(scan.contextPeak, u.input + u.cacheRead + u.cacheWrite);
			if (typeof msg.model === "string") {
				scan.models.set(msg.model, (scan.models.get(msg.model) ?? 0) + 1);
			}
			if (msg.stopReason === "error") scan.asstErrors++;

			const turn = scan.turns[scan.turns.length - 1];
			if (turn) {
				turn.requests++;
				turn.outToks += u.output;
				turn.cost += u.cost;
			}

			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const block of content) {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
					scan.lastAssistantText = clip(b.text, 300);
				}
				if (b.type !== "toolCall") continue;
				const name = (b.name as string) ?? "?";
				const args = b.arguments as Record<string, unknown> | undefined;
				const argToks = estTokens(JSON.stringify(args ?? {}));
				const agg = tool(name);
				agg.calls++;
				agg.argToks += argToks;
				const callId = (b.id as string) ?? "";
				pending.set(callId, { name, args, requestIndex: requestCount });
				scan.lastToolName = name;
				if (turn) turn.tools.set(name, (turn.tools.get(name) ?? 0) + 1);
				if (name === "edit") scan.editCalls++;
				if (name === "read") {
					const p = typeof args?.path === "string" ? normalizeReadPath(args.path as string) : "";
					if (p) {
						const rec = scan.readCounts.get(p) ?? { count: 0, toks: 0, residency: 0 };
						rec.count++;
						scan.readCounts.set(p, rec);
					}
				}
				if (name === "task") {
					const tasks = Array.isArray(args?.tasks) ? (args?.tasks as Record<string, unknown>[]) : [];
					const spawn: SpawnCall = {
						callId,
						agent: typeof args?.agent === "string" ? (args.agent as string) : "?",
						labels: tasks.map(t => (typeof t.id === "string" ? t.id : "?")),
						descriptions: tasks.map(t => clip(String(t.description ?? t.assignment ?? ""), 90)),
						argToks,
						ts,
						resultToks: 0,
						isError: false,
						resultSnippet: "",
					};
					scan.spawns.push(spawn);
					spawnByCallId.set(callId, spawn);
					if (turn) turn.spawnAgents.push(spawn.agent);
				}
			}
			continue;
		}

		if (role === "toolResult") {
			const callId = (msg.toolCallId as string) ?? "";
			const call = pending.get(callId);
			const name = call?.name ?? (msg.toolName as string) ?? "?";
			const textBlob = contentText(msg.content);
			const truncated = TRUNCATED_RESULT_RE.exec(textBlob);
			const toks = truncated
				? Math.max(estTokens(textBlob), Number.parseInt(truncated[1], 10))
				: estTokens(textBlob);
			const agg = tool(name);
			agg.resultToks += toks;
			if (msg.isError === true) {
				agg.errors++;
				if (name === "edit") scan.editErrors++;
			}
			resultLog.push({ tool: name, toks, requestIndex: call?.requestIndex ?? requestCount });
			if (name === "read" && call?.args && typeof call.args.path === "string") {
				const p = normalizeReadPath(call.args.path as string);
				const rec = scan.readCounts.get(p);
				if (rec) rec.toks += toks;
				readLog.push({ path: p, toks, requestIndex: call.requestIndex });
			}
			const spawn = spawnByCallId.get(callId);
			if (spawn) {
				spawn.resultToks = toks;
				spawn.isError = msg.isError === true;
				spawn.resultSnippet = clip(textBlob, 240);
			}
			if (toks > 2000) {
				scan.topResults.push({ tool: name, summary: argSummary(name, call?.args), toks });
				if (scan.topResults.length > 24) {
					scan.topResults.sort((a, b) => b.toks - a.toks);
					scan.topResults.length = 12;
				}
			}
			pending.delete(callId);
		}
	}

	// Context residency: result tokens weighted by how many later requests re-paid them.
	for (const r of resultLog) {
		const later = Math.max(0, requestCount - r.requestIndex);
		const agg = scan.toolAgg.get(r.tool);
		if (agg) agg.residency += r.toks * later;
	}
	// Per-path read residency: same weighting, attributed to the normalized path.
	for (const r of readLog) {
		const rec = scan.readCounts.get(r.path);
		if (rec) rec.residency += r.toks * Math.max(0, requestCount - r.requestIndex);
	}
	scan.topResults.sort((a, b) => b.toks - a.toks);
	scan.topResults.length = Math.min(scan.topResults.length, 12);
	return scan;
}

// --------------------------------------------------------------------------
// Session groups (main + subagent files)

interface SessionGroup {
	folder: string;
	id: string;
	mtime: number;
	main: FileScan;
	children: FileScan[];
	usage: UsageTotals; // main + children
	subUsage: UsageTotals; // children only
}

interface DiscoveredGroup {
	folder: string;
	id: string;
	mainPath: string;
	childPaths: string[];
	mtime: number;
}

async function discoverGroups(opts: CliOptions): Promise<DiscoveredGroup[]> {
	const cutoff = Date.now() - opts.since;
	const groups: DiscoveredGroup[] = [];
	let folders: string[];
	try {
		folders = await fs.readdir(SESSIONS_ROOT);
	} catch {
		throw new Error(`sessions root not found: ${SESSIONS_ROOT}`);
	}
	for (const folder of folders) {
		if (opts.folder && !folder.includes(opts.folder)) continue;
		if (opts.exclude && folder.includes(opts.exclude)) continue;
		const folderPath = path.join(SESSIONS_ROOT, folder);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(folderPath, { withFileTypes: true });
		} catch {
			continue;
		}
		const subdirs = new Set<string>();
		const mains = new Map<string, { path: string; mtime: number }>();
		for (const e of entries) {
			if (e.isDirectory()) {
				subdirs.add(e.name);
			} else if (e.name.endsWith(".jsonl")) {
				const p = path.join(folderPath, e.name);
				const stat = await fs.stat(p);
				mains.set(e.name.slice(0, -6), { path: p, mtime: stat.mtimeMs });
			}
		}
		for (const [id, main] of mains) {
			const childPaths: string[] = [];
			let mtime = main.mtime;
			if (subdirs.has(id)) {
				const dirPath = path.join(folderPath, id);
				const nested = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
				for (const e of nested) {
					if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
					const p = path.join(e.parentPath, e.name);
					childPaths.push(p);
				}
				childPaths.sort();
				for (const p of childPaths) {
					const stat = await fs.stat(p);
					mtime = Math.max(mtime, stat.mtimeMs);
				}
			}
			if (mtime < cutoff) continue;
			groups.push({ folder, id, mainPath: main.path, childPaths, mtime });
		}
	}
	groups.sort((a, b) => b.mtime - a.mtime);
	if (opts.limit !== undefined) groups.length = Math.min(groups.length, opts.limit);
	return groups;
}

async function scanGroup(d: DiscoveredGroup): Promise<SessionGroup | undefined> {
	const main = await scanFile(d.mainPath);
	if (!main) return undefined;
	const children: FileScan[] = [];
	for (const p of d.childPaths) {
		const child = await scanFile(p);
		if (child) children.push(child);
	}
	const usage = emptyUsage();
	const subUsage = emptyUsage();
	addUsage(usage, main.usage);
	for (const c of children) {
		addUsage(usage, c.usage);
		addUsage(subUsage, c.usage);
	}
	if (usage.requests === 0) return undefined; // header-only session, never used
	return { folder: d.folder, id: d.id, mtime: d.mtime, main, children, usage, subUsage };
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
async function mapPool<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

// --------------------------------------------------------------------------
// Formatting helpers

function fmtTok(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

function fmtMoney(n: number): string {
	return `$${n.toFixed(2)}`;
}

function fmtPct(part: number, whole: number): string {
	if (whole <= 0) return "0%";
	return `${((part / whole) * 100).toFixed(1)}%`;
}

function fmtDur(ms: number): string {
	if (ms <= 0) return "0m";
	const m = Math.round(ms / 60000);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
}

function pad(s: string, w: number): string {
	return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padl(s: string, w: number): string {
	return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

// --------------------------------------------------------------------------
// Digest builder (classifier input)

function toolLine(name: string, agg: ToolAgg): string {
	const err = agg.errors ? ` errors=${agg.errors}` : "";
	return `${name}: ${agg.calls} calls, args~${fmtTok(agg.argToks)}, results~${fmtTok(agg.resultToks)}, residency~${fmtTok(agg.residency)}${err}`;
}

function mergeToolAggs(scans: FileScan[]): Map<string, ToolAgg> {
	const merged = new Map<string, ToolAgg>();
	for (const s of scans) {
		for (const [name, agg] of s.toolAgg) {
			const m = merged.get(name);
			if (m) {
				m.calls += agg.calls;
				m.argToks += agg.argToks;
				m.resultToks += agg.resultToks;
				m.errors += agg.errors;
				m.residency += agg.residency;
			} else {
				merged.set(name, { ...agg });
			}
		}
	}
	return merged;
}

/** Strip a `-2`/`-3` retry suffix from a subagent file stem. */
function baseLabel(stem: string): string {
	return stem.replace(/-\d+$/, "");
}

/** How a (sub)agent transcript ended, for digests. A child ending on a tool
 * call is normal — its report flows back through the task result channel. */
function endedStr(s: FileScan): string {
	if (s.lastAssistantText) return `"${s.lastAssistantText}"`;
	if (s.lastToolName) return `(no final text; last tool: ${s.lastToolName})`;
	return `(no output)`;
}

function buildDigest(g: SessionGroup): string {
	const lines: string[] = [];
	const m = g.main;
	const models = [...m.models.entries()].map(([id, n]) => `${id}×${n}`).join(", ");
	const cacheable = m.usage.input + m.usage.cacheRead;
	const wall = m.lastTs - m.firstTs;
	lines.push(`# SESSION ${g.id}`);
	lines.push(`title: ${m.title ?? "(untitled)"}`);
	lines.push(`project folder: ${g.folder}`);
	lines.push(`models: ${models || "?"}`);
	lines.push(`wall time: ${fmtDur(wall)}; user turns: ${m.turns.filter(t => !t.synthetic).length}`);
	lines.push(
		`MAIN context totals: ${m.usage.requests} requests, billed-in ${fmtTok(m.usage.input + m.usage.cacheRead + m.usage.cacheWrite)} ` +
			`(cache-read ${fmtPct(m.usage.cacheRead, cacheable)}), out ${fmtTok(m.usage.output)}, cost ${fmtMoney(m.usage.cost)}`,
	);
	lines.push(
		`context peak: ${fmtTok(m.contextPeak)} tok; compactions: ${m.compactions}; assistant errors: ${m.asstErrors}`,
	);
	lines.push(
		`SUBAGENTS: ${g.children.length} runs, cost ${fmtMoney(g.subUsage.cost)} (${fmtPct(g.subUsage.cost, g.usage.cost)} of session), ` +
			`billed ${fmtTok(billedTokens(g.subUsage))} tok`,
	);

	lines.push(`\n## Turn flow (main context)`);
	const t0 = m.turns[0]?.ts ?? m.firstTs;
	const shown = m.turns.slice(0, 40);
	for (let i = 0; i < shown.length; i++) {
		const t = shown[i];
		const toolStr =
			[...t.tools.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6)
				.map(([n, c]) => `${n}×${c}`)
				.join(" ") || "none";
		const spawnStr = t.spawnAgents.length ? ` | spawns: ${t.spawnAgents.join(",")}` : "";
		const syn = t.synthetic ? " [synthetic/steering]" : "";
		lines.push(
			`T${i + 1} +${fmtDur(t.ts - t0)}${syn} [${fmtTok(t.tokens)}t] "${t.text}"` +
				`\n    → ${t.requests} req | tools: ${toolStr} | out ${fmtTok(t.outToks)} | ${fmtMoney(t.cost)}${spawnStr}`,
		);
	}
	if (m.turns.length > shown.length) lines.push(`… ${m.turns.length - shown.length} more turns`);

	lines.push(`\n## Tool traffic in main context (token counts are ~estimates)`);
	const sortedTools = [...m.toolAgg.entries()].sort((a, b) => b[1].resultToks - a[1].resultToks);
	for (const [name, agg] of sortedTools.slice(0, 14)) lines.push(toolLine(name, agg));

	const repeats = [...m.readCounts.entries()]
		.filter(([, r]) => r.count >= 3)
		.sort((a, b) => b[1].residency - a[1].residency)
		.slice(0, 8);
	if (repeats.length) {
		lines.push(`\n## Repeated reads of the same file (waste signal)`);
		for (const [p, r] of repeats)
			lines.push(`${p} ×${r.count} (~${fmtTok(r.toks)}tok total, ~${fmtTok(r.residency)} residency)`);
	}

	if (m.topResults.length) {
		lines.push(`\n## Largest single tool results in main context`);
		for (const r of m.topResults.slice(0, 8)) lines.push(`${r.tool} "${r.summary}" → ~${fmtTok(r.toks)} tok`);
	}

	if (m.editCalls) {
		lines.push(`\n## Edits: ${m.editCalls} calls, ${m.editErrors} failed`);
	}

	// Spawn ↔ child linkage
	const childByLabel = new Map<string, FileScan[]>();
	for (const c of g.children) {
		const key = baseLabel(c.stem);
		const list = childByLabel.get(key) ?? [];
		list.push(c);
		childByLabel.set(key, list);
	}
	const linked = new Set<FileScan>();
	if (m.spawns.length) {
		lines.push(`\n## Task spawns from main context`);
		for (const spawn of m.spawns.slice(0, 24)) {
			const head = `task(agent=${spawn.agent}) prompt~${fmtTok(spawn.argToks)} → merged result~${fmtTok(spawn.resultToks)}${spawn.isError ? " [ERRORED]" : ""}`;
			lines.push(head);
			for (let i = 0; i < spawn.labels.length; i++) {
				const label = spawn.labels[i];
				const kids = childByLabel.get(label) ?? [];
				const kid = kids.find(k => !linked.has(k)) ?? kids[0];
				let childStr = "child log missing";
				if (kid) {
					linked.add(kid);
					childStr =
						`child: ${kid.usage.requests} req, billed ${fmtTok(billedTokens(kid.usage))}, ${fmtMoney(kid.usage.cost)}, ` +
						`${fmtDur(kid.lastTs - kid.firstTs)}, ended: ${endedStr(kid)}`;
				}
				lines.push(`  - ${label}: "${spawn.descriptions[i] ?? ""}" | ${childStr}`);
			}
			if (spawn.resultSnippet) lines.push(`  merged result snippet: "${spawn.resultSnippet}"`);
		}
		if (m.spawns.length > 24) lines.push(`… ${m.spawns.length - 24} more spawn calls`);
	}
	const unlinked = g.children.filter(c => !linked.has(c));
	if (unlinked.length) {
		lines.push(`\n## Other subagent runs (eval agent()/irc/etc., not matched to a task call)`);
		for (const c of unlinked.slice(0, 16)) {
			lines.push(
				`${c.stem}: ${c.usage.requests} req, billed ${fmtTok(billedTokens(c.usage))}, ${fmtMoney(c.usage.cost)}, ended: ${endedStr(c)}`,
			);
		}
		if (unlinked.length > 16) lines.push(`… ${unlinked.length - 16} more`);
	}

	let digest = lines.join("\n");
	if (digest.length > 26000) digest = `${digest.slice(0, 26000)}\n…[digest truncated]`;
	return digest;
}

// --------------------------------------------------------------------------
// Classifier

interface SpawnVerdict {
	label: string;
	verdict: "good" | "unnecessary" | "wrong-granularity" | "context-transfer-failure" | "failed";
	why: string;
}

interface WasteItem {
	source: string;
	estTokens: number;
	estUsd: number;
	fix: string;
}

interface SessionVerdict {
	score: number;
	multiTopic: boolean;
	topics: string[];
	shouldHaveSplit: boolean;
	handoffOpportunities: string[];
	spawnVerdicts: SpawnVerdict[];
	waste: WasteItem[];
	headline: string;
}

const SESSION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		score: { type: "integer", minimum: 0, maximum: 10, description: "token-efficiency score for this session" },
		multiTopic: { type: "boolean" },
		topics: { type: "array", maxItems: 5, items: { type: "string" } },
		shouldHaveSplit: { type: "boolean", description: "true when separate chats/handoff would have saved tokens" },
		handoffOpportunities: {
			type: "array",
			maxItems: 4,
			items: { type: "string" },
			description: "specific turns/moments where a fresh session, /handoff, or a subagent would have been cheaper",
		},
		spawnVerdicts: {
			type: "array",
			maxItems: 10,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					label: { type: "string" },
					verdict: {
						type: "string",
						enum: ["good", "unnecessary", "wrong-granularity", "context-transfer-failure", "failed"],
					},
					why: { type: "string" },
				},
				required: ["label", "verdict", "why"],
			},
		},
		waste: {
			type: "array",
			maxItems: 5,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: { type: "string" },
					estTokens: { type: "integer", description: "rough wasted tokens attributable to this source" },
					estUsd: {
						type: "number",
						description: "realistic dollars this waste cost — what a leaner workflow would have saved",
					},
					fix: { type: "string" },
				},
				required: ["source", "estTokens", "estUsd", "fix"],
			},
			description: "biggest sources of waste, largest first",
		},
		headline: { type: "string", description: "one-sentence takeaway for this session" },
	},
	required: [
		"score",
		"multiTopic",
		"topics",
		"shouldHaveSplit",
		"handoffOpportunities",
		"spawnVerdicts",
		"waste",
		"headline",
	],
} as const;

interface AggregateFindings {
	systemicIssues: { issue: string; evidence: string; fix: string }[];
	quickWins: string[];
	summary: string;
}

const AGGREGATE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		systemicIssues: {
			type: "array",
			maxItems: 6,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					issue: { type: "string" },
					evidence: { type: "string", description: "which sessions/numbers support this" },
					fix: { type: "string", description: "concrete habit or workflow change" },
				},
				required: ["issue", "evidence", "fix"],
			},
		},
		quickWins: { type: "array", maxItems: 5, items: { type: "string" } },
		summary: { type: "string" },
	},
	required: ["systemicIssues", "quickWins", "summary"],
} as const;

function validateSessionVerdict(v: SessionVerdict): string | undefined {
	if (typeof v.headline !== "string" || !v.headline.trim()) return "headline missing or empty";
	if (typeof v.score !== "number" || !Number.isFinite(v.score)) return "score is not a finite number";
	if (!Array.isArray(v.waste)) return "waste is not an array";
	if (!Array.isArray(v.spawnVerdicts)) return "spawnVerdicts is not an array";
	if (!Array.isArray(v.topics)) return "topics is not an array";
	if (!Array.isArray(v.handoffOpportunities)) return "handoffOpportunities is not an array";
	return undefined;
}

function validateAggregate(a: AggregateFindings): string | undefined {
	if (typeof a.summary !== "string" || !a.summary.trim()) return "summary missing or empty";
	if (!Array.isArray(a.systemicIssues)) return "systemicIssues is not an array";
	return undefined;
}

function finiteNumber(n: unknown, fallback: number): number {
	return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Clamp/default every field the renderer touches so `undefined` can never
 * reach the report, and sort waste by dollars desc (tokens desc tie-break).
 * Also applied to cached verdicts, which may predate schema changes. */
function normalizeVerdict(v: SessionVerdict): SessionVerdict {
	const waste = (Array.isArray(v.waste) ? v.waste : [])
		.map(w => ({
			source: typeof w.source === "string" && w.source ? w.source : "(unspecified)",
			estTokens: finiteNumber(w.estTokens, 0),
			estUsd: finiteNumber(w.estUsd, 0),
			fix: typeof w.fix === "string" ? w.fix : "",
		}))
		.sort((a, b) => b.estUsd - a.estUsd || b.estTokens - a.estTokens);
	const spawnVerdicts = (Array.isArray(v.spawnVerdicts) ? v.spawnVerdicts : []).map(s => ({
		label: typeof s.label === "string" ? s.label : "?",
		verdict: s.verdict,
		why: typeof s.why === "string" ? s.why : "",
	}));
	return {
		score: Math.min(10, Math.max(0, Math.round(finiteNumber(v.score, 0)))),
		multiTopic: v.multiTopic === true,
		topics: (Array.isArray(v.topics) ? v.topics : []).map(String),
		shouldHaveSplit: v.shouldHaveSplit === true,
		handoffOpportunities: (Array.isArray(v.handoffOpportunities) ? v.handoffOpportunities : []).map(String),
		spawnVerdicts,
		waste,
		headline: typeof v.headline === "string" ? v.headline : "",
	};
}

interface Classifier {
	model: Model<Api>;
	apiKey: string;
}

async function openClassifier(modelSpec: string): Promise<Classifier> {
	const slash = modelSpec.indexOf("/");
	if (slash <= 0) throw new Error(`--model must be <provider>/<model-id>, got "${modelSpec}"`);
	const provider = modelSpec.slice(0, slash);
	const modelId = modelSpec.slice(slash + 1);
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	if (!model) throw new Error(`unknown model "${modelSpec}" (not in bundled catalog)`);
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	const storage = new AuthStorage(store);
	await storage.reload();
	const apiKey = await storage.getApiKey(provider);
	if (!apiKey) {
		throw new Error(`no credentials for provider "${provider}" (omp login or env var required)`);
	}
	return { model, apiKey };
}

async function completeStructured<T>(
	cls: Classifier,
	prompt: string,
	schema: Record<string, unknown>,
	validate: (value: T) => string | undefined,
): Promise<{ value: T; usage: UsageTotals }> {
	const respond: Tool = {
		name: "respond",
		description: "Return your analysis by calling this tool with the requested structured fields.",
		parameters: schema as Tool["parameters"],
		strict: false,
	};
	let lastError = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		const response = await completeSimple(
			cls.model,
			{
				systemPrompt: [SYSTEM_PROMPT],
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				tools: [respond],
			},
			{
				apiKey: cls.apiKey,
				toolChoice: { type: "tool", name: "respond" },
				disableReasoning: true,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			lastError = response.errorMessage ?? response.stopReason;
			await Bun.sleep(1500 * (attempt + 1));
			continue;
		}
		const call = response.content.find((c): c is ToolCall => c.type === "toolCall" && c.name === "respond");
		if (!call) {
			lastError = "model returned no structured tool call";
			continue;
		}
		const value = call.arguments as T;
		const problem = validate(value);
		if (problem !== undefined) {
			lastError = `invalid structured response: ${problem}`;
			continue;
		}
		return { value, usage: usageOf(response) };
	}
	throw new Error(`classifier call failed: ${lastError}`);
}

function usageOf(response: AssistantMessageLike): UsageTotals {
	const u = response.usage;
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		cost: u.cost.total,
		requests: 1,
	};
}

/** Narrow view of pi-ai's AssistantMessage used here (content + usage). */
interface AssistantMessageLike {
	content: (ToolCall | { type: string })[];
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
	stopReason: string;
	errorMessage?: string;
}

// --------------------------------------------------------------------------
// Verdict cache

interface VerdictCacheEntry {
	verdict: SessionVerdict;
	model: string;
	ts: number;
}

interface VerdictCache {
	entries: Record<string, VerdictCacheEntry>;
}

async function loadVerdictCache(): Promise<VerdictCache> {
	try {
		const parsed = (await Bun.file(CACHE_PATH).json()) as Partial<VerdictCache> | null;
		if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
			return { entries: parsed.entries };
		}
	} catch (err) {
		if (!isEnoent(err)) process.stderr.write(`verdict cache unreadable, starting fresh (${CACHE_PATH})\n`);
	}
	return { entries: {} };
}

/** Persist the cache, pruned to the newest 500 entries by timestamp. */
async function saveVerdictCache(cache: VerdictCache): Promise<void> {
	const newest = Object.entries(cache.entries)
		.sort((a, b) => b[1].ts - a[1].ts)
		.slice(0, 500);
	await Bun.write(CACHE_PATH, JSON.stringify({ entries: Object.fromEntries(newest) }));
}

/** Digest + system-prompt hashes make staleness automatic: any change to the
 * session transcript, digest format, model, or prompt misses the cache. */
function verdictCacheKey(groupId: string, digest: string, model: string): string {
	return `${groupId}:${Bun.hash(digest).toString(16)}:${model}:${Bun.hash(SYSTEM_PROMPT).toString(16)}`;
}

// --------------------------------------------------------------------------
// Report

interface AuditResult {
	windowMs: number;
	groups: SessionGroup[];
	verdicts: Map<string, SessionVerdict>;
	aggregate?: AggregateFindings;
	classifierUsage: UsageTotals;
	classifierModel?: string;
}

function printScanReport(res: AuditResult): void {
	const { groups } = res;
	const total = emptyUsage();
	const sub = emptyUsage();
	let files = 0;
	let compactions = 0;
	for (const g of groups) {
		addUsage(total, g.usage);
		addUsage(sub, g.subUsage);
		files += 1 + g.children.length;
		compactions += g.main.compactions;
	}
	const days = res.windowMs / 86_400_000;
	console.log(`\nSESSION AUDIT — last ${days >= 1 ? `${days.toFixed(0)}d` : fmtDur(res.windowMs)}`);
	console.log(`corpus: ${groups.length} sessions (${files} jsonl files)`);
	console.log(
		`spend (nominal): ${fmtMoney(total.cost)} | billed ${fmtTok(billedTokens(total))} tok ` +
			`(in ${fmtTok(total.input)}, cache-read ${fmtTok(total.cacheRead)}, cache-write ${fmtTok(total.cacheWrite)}, out ${fmtTok(total.output)})`,
	);
	console.log(
		`subagent share: ${fmtPct(sub.cost, total.cost)} of cost (${fmtMoney(sub.cost)}), ` +
			`${fmtPct(billedTokens(sub), billedTokens(total))} of tokens, ${fmtPct(sub.requests, total.requests)} of requests`,
	);
	console.log(`compactions in main contexts: ${compactions}`);

	// Folder split
	const byFolder = new Map<string, { usage: UsageTotals; sub: UsageTotals; n: number }>();
	for (const g of groups) {
		let rec = byFolder.get(g.folder);
		if (!rec) {
			rec = { usage: emptyUsage(), sub: emptyUsage(), n: 0 };
			byFolder.set(g.folder, rec);
		}
		addUsage(rec.usage, g.usage);
		addUsage(rec.sub, g.subUsage);
		rec.n++;
	}
	console.log(`\nby project folder (top 12 by cost):`);
	const folders = [...byFolder.entries()].sort((a, b) => b[1].usage.cost - a[1].usage.cost).slice(0, 12);
	for (const [folder, rec] of folders) {
		console.log(
			`  ${pad(clip(folder, 44), 46)} ${padl(fmtMoney(rec.usage.cost), 9)}  ${padl(fmtTok(billedTokens(rec.usage)), 8)} tok  ` +
				`${padl(String(rec.n), 4)} sess  sub ${fmtPct(rec.sub.cost, rec.usage.cost)}`,
		);
	}

	// Tool traffic across everything
	const allScans: FileScan[] = [];
	for (const g of groups) {
		allScans.push(g.main, ...g.children);
	}
	const tools = mergeToolAggs(allScans);
	console.log(`\ntool traffic, all contexts (arg/result tokens are ~estimates):`);
	console.log(
		`  ${pad("tool", 16)} ${padl("calls", 7)} ${padl("argTok", 9)} ${padl("resTok", 9)} ${padl("res/call", 9)} ${padl("errs", 6)} ${padl("residency", 11)}`,
	);
	const toolRows = [...tools.entries()].sort((a, b) => b[1].resultToks - a[1].resultToks).slice(0, 16);
	for (const [name, agg] of toolRows) {
		console.log(
			`  ${pad(clip(name, 15), 16)} ${padl(String(agg.calls), 7)} ${padl(fmtTok(agg.argToks), 9)} ${padl(fmtTok(agg.resultToks), 9)} ` +
				`${padl(fmtTok(agg.calls ? agg.resultToks / agg.calls : 0), 9)} ${padl(String(agg.errors), 6)} ${padl(fmtTok(agg.residency), 11)}`,
		);
	}

	// Biggest single results anywhere
	const allTop: TopResult[] = [];
	for (const s of allScans) allTop.push(...s.topResults);
	allTop.sort((a, b) => b.toks - a.toks);
	if (allTop.length) {
		console.log(`\nlargest single tool results (corpus-wide):`);
		for (const r of allTop.slice(0, 10)) {
			console.log(`  ~${padl(fmtTok(r.toks), 7)}  ${r.tool}  ${r.summary}`);
		}
	}

	// Top sessions
	console.log(`\ntop sessions by cost:`);
	const top = [...groups].sort((a, b) => b.usage.cost - a.usage.cost).slice(0, 15);
	for (const g of top) {
		const flags: string[] = [];
		if (g.main.compactions) flags.push(`${g.main.compactions} compactions`);
		if (g.main.asstErrors) flags.push(`${g.main.asstErrors} errors`);
		const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
		console.log(
			`  ${padl(fmtMoney(g.usage.cost), 8)}  ${pad(new Date(g.main.firstTs).toISOString().slice(0, 16), 17)} ` +
				`${pad(clip(g.folder, 26), 27)} "${clip(g.main.title ?? g.id, 46)}" sub ${fmtPct(g.subUsage.cost, g.usage.cost)}${flagStr}`,
		);
	}
}

function printVerdicts(res: AuditResult): void {
	if (!res.verdicts.size) return;
	console.log(`\n${"─".repeat(72)}`);
	console.log(`LLM analysis (${res.classifierModel}) — ${res.verdicts.size} sessions`);
	const ordered = res.groups.filter(g => res.verdicts.has(g.id)).sort((a, b) => b.usage.cost - a.usage.cost);
	for (const g of ordered) {
		const v = res.verdicts.get(g.id);
		if (!v) continue;
		console.log(
			`\n[${fmtMoney(g.usage.cost)}] "${clip(g.main.title ?? g.id, 60)}" (${g.folder}) — score ${v.score}/10`,
		);
		console.log(`  ${v.headline}`);
		if (v.multiTopic)
			console.log(`  topics: ${v.topics.join(" | ")}${v.shouldHaveSplit ? "  → should have split" : ""}`);
		for (const h of v.handoffOpportunities) console.log(`  handoff: ${h}`);
		for (const s of v.spawnVerdicts) {
			if (s.verdict === "good") continue;
			console.log(`  spawn ${s.label}: ${s.verdict} — ${s.why}`);
		}
		for (const w of v.waste) {
			console.log(`  waste ~${fmtMoney(w.estUsd)} (~${fmtTok(w.estTokens)}tok): ${w.source} → ${w.fix}`);
		}
	}
}

function printAggregate(res: AuditResult): void {
	const agg = res.aggregate;
	if (!agg) return;
	console.log(`\n${"─".repeat(72)}`);
	console.log(`SYSTEMIC FINDINGS`);
	console.log(`\n${agg.summary}`);
	for (let i = 0; i < agg.systemicIssues.length; i++) {
		const s = agg.systemicIssues[i];
		console.log(`\n${i + 1}. ${s.issue}`);
		console.log(`   evidence: ${s.evidence}`);
		console.log(`   fix: ${s.fix}`);
	}
	if (agg.quickWins.length) {
		console.log(`\nquick wins:`);
		for (const q of agg.quickWins) console.log(`  - ${q}`);
	}
	console.log(
		`\nclassifier spend: ${fmtMoney(res.classifierUsage.cost)} (${res.classifierUsage.requests} calls, ` +
			`in ${fmtTok(res.classifierUsage.input + res.classifierUsage.cacheRead + res.classifierUsage.cacheWrite)}, out ${fmtTok(res.classifierUsage.output)})`,
	);
}

// --------------------------------------------------------------------------
// JSON export

function exportJson(res: AuditResult): Record<string, unknown> {
	return {
		windowMs: res.windowMs,
		classifierModel: res.classifierModel,
		classifierUsage: res.classifierUsage,
		aggregate: res.aggregate,
		sessions: res.groups.map(g => ({
			id: g.id,
			folder: g.folder,
			title: g.main.title,
			startedAt: g.main.firstTs,
			usage: g.usage,
			subUsage: g.subUsage,
			contextPeak: g.main.contextPeak,
			compactions: g.main.compactions,
			turns: g.main.turns.length,
			spawns: g.main.spawns.map(s => ({
				agent: s.agent,
				labels: s.labels,
				resultToks: s.resultToks,
				isError: s.isError,
			})),
			children: g.children.map(c => ({
				label: c.stem,
				usage: c.usage,
				requests: c.usage.requests,
			})),
			tools: Object.fromEntries(g.main.toolAgg),
			verdict: res.verdicts.get(g.id),
		})),
	};
}

// --------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
	const opts = parseCli(process.argv.slice(2));

	process.stderr.write(`discovering sessions under ${SESSIONS_ROOT} …\n`);
	const discovered = await discoverGroups(opts);
	process.stderr.write(`scanning ${discovered.length} session groups …\n`);

	let done = 0;
	const scanned = await mapPool(discovered, 8, async d => {
		const g = await scanGroup(d);
		done++;
		if (done % 50 === 0) process.stderr.write(`  ${done}/${discovered.length}\n`);
		return g;
	});
	const groups = scanned.filter((g): g is SessionGroup => g !== undefined);

	const res: AuditResult = {
		windowMs: opts.since,
		groups,
		verdicts: new Map(),
		classifierUsage: emptyUsage(),
	};

	printScanReport(res);

	if (!opts.noLlm && groups.length) {
		const sessionFilter = opts.session?.toLowerCase();
		const matched = sessionFilter
			? groups.filter(
					g =>
						g.id.toLowerCase().includes(sessionFilter) ||
						(g.main.title ?? "").toLowerCase().includes(sessionFilter),
				)
			: groups.filter(g => g.usage.cost >= opts.minCost);
		const candidates = matched.sort((a, b) => b.usage.cost - a.usage.cost).slice(0, opts.maxLlm);
		if (!candidates.length) {
			console.log(
				sessionFilter
					? `\n(no sessions matching "${opts.session}"; skipping LLM analysis)`
					: `\n(no sessions ≥ ${fmtMoney(opts.minCost)}; skipping LLM analysis)`,
			);
		} else {
			const cls = await openClassifier(opts.model);
			res.classifierModel = `${cls.model.provider}/${cls.model.id}`;
			process.stderr.write(`\nclassifying ${candidates.length} sessions with ${res.classifierModel} …\n`);
			if (opts.digestDir) await fs.mkdir(opts.digestDir, { recursive: true });

			const cache = await loadVerdictCache();
			let cacheHits = 0;
			await mapPool(candidates, opts.concurrency, async g => {
				const digest = buildDigest(g);
				if (opts.digestDir) {
					await Bun.write(path.join(opts.digestDir, `${g.id}.md`), digest);
				}
				const key = verdictCacheKey(g.id, digest, res.classifierModel ?? opts.model);
				if (!opts.noCache) {
					const hit = cache.entries[key];
					if (hit) {
						res.verdicts.set(g.id, normalizeVerdict(hit.verdict));
						cacheHits++;
						process.stderr.write(`  ✓ ${clip(g.main.title ?? g.id, 50)} (cached)\n`);
						return;
					}
				}
				try {
					const { value, usage } = await completeStructured<SessionVerdict>(
						cls,
						digest,
						SESSION_SCHEMA,
						validateSessionVerdict,
					);
					const verdict = normalizeVerdict(value);
					res.verdicts.set(g.id, verdict);
					cache.entries[key] = { verdict, model: res.classifierModel ?? opts.model, ts: Date.now() };
					addUsage(res.classifierUsage, usage);
					process.stderr.write(`  ✓ ${clip(g.main.title ?? g.id, 50)} (score ${verdict.score})\n`);
				} catch (err) {
					process.stderr.write(
						`  ✗ ${clip(g.main.title ?? g.id, 50)}: ${err instanceof Error ? err.message : err}\n`,
					);
				}
			});
			await saveVerdictCache(cache);
			process.stderr.write(`${res.verdicts.size}/${candidates.length} verdicts (${cacheHits} from cache)\n`);

			printVerdicts(res);

			if (res.verdicts.size >= 2) {
				const total = emptyUsage();
				const sub = emptyUsage();
				for (const g of groups) {
					addUsage(total, g.usage);
					addUsage(sub, g.subUsage);
				}
				const parts: string[] = [
					`# AGGREGATE across ${groups.length} sessions, window ${fmtDur(opts.since)}`,
					`total nominal cost ${fmtMoney(total.cost)}; subagent share ${fmtPct(sub.cost, total.cost)}`,
					`\nPer-session data (JSON, one per line):`,
				];
				const round2 = (n: number): number => Math.round(n * 100) / 100;
				for (const g of groups) {
					const v = res.verdicts.get(g.id);
					if (!v) continue;
					parts.push(
						JSON.stringify({
							id: g.id,
							title: g.main.title ?? g.id,
							costUsd: round2(g.usage.cost),
							subagentPct: round2(g.usage.cost > 0 ? (g.subUsage.cost / g.usage.cost) * 100 : 0),
							requests: g.usage.requests,
							contextPeak: g.main.contextPeak,
							compactions: g.main.compactions,
							score: v.score,
							headline: v.headline,
							topics: v.topics,
							shouldHaveSplit: v.shouldHaveSplit,
							spawnIssues: v.spawnVerdicts
								.filter(s => s.verdict !== "good")
								.map(s => ({ label: s.label, verdict: s.verdict })),
							waste: v.waste.map(w => ({ source: w.source, estTokens: w.estTokens, estUsd: round2(w.estUsd) })),
						}),
					);
				}
				parts.push(
					`\nProduce the cross-session aggregate: systemic issues (recurring patterns, not one-offs), quick wins, and a short summary addressed to the user. Cite only sessions and figures present in the data above.`,
				);
				try {
					const { value, usage } = await completeStructured<AggregateFindings>(
						cls,
						parts.join("\n"),
						AGGREGATE_SCHEMA,
						validateAggregate,
					);
					res.aggregate = value;
					addUsage(res.classifierUsage, usage);
				} catch (err) {
					process.stderr.write(`aggregate pass failed: ${err instanceof Error ? err.message : err}\n`);
				}
				printAggregate(res);
			}
		}
	}

	if (opts.json) {
		await Bun.write(opts.json, JSON.stringify(exportJson(res), null, 1));
		console.log(`\nwrote ${opts.json}`);
	}
}

if (import.meta.main) {
	await main();
}
