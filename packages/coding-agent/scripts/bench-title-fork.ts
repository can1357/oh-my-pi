#!/usr/bin/env bun
import { Database } from "bun:sqlite";
/**
 * Forked-title experiment harness.
 *
 * Samples random sessions from the prompt-history DB and replays each one's
 * first user message through a real headless `AgentSession`. The moment the
 * reply's first non-thinking block starts (immediately, when the model does not
 * think), the conversation is forked through the `/btw` side-turn pipeline
 * (`AgentSession.runEphemeralTurn`: same model, system prompt, tool catalog, and
 * prompt-cache key) to ask for a title. The main turn is aborted right after
 * the fork snapshot, so no tool ever runs.
 *
 * Each result records the fork title, its latency, and its usage — `cacheRead`
 * against the main request's prefix shows whether the fork hit the cache — next
 * to the session's recorded titles and the production title path
 * (`AgentSession.generateTitle`, the configured tiny/smol title model).
 *
 * The sample is drawn once into `<dir>/sample.json`; results append to
 * `<dir>/results-<variant>.jsonl`, so reruns skip finished sessions and a larger
 * `--limit` extends a run.
 *
 * Usage:
 *   bun scripts/bench-title-fork.ts --limit 10
 *   bun scripts/bench-title-fork.ts --limit 100 --concurrency 6
 *   bun scripts/bench-title-fork.ts --model anthropic/claude-opus-5-5 --thinking high --fork-thinking off
 *   bun scripts/bench-title-fork.ts --count 500 --resample
 *   bun scripts/bench-title-fork.ts --prompt scripts/bench-title-card.md --no-baseline
 *   bun scripts/bench-title-fork.ts --tiny --prompt scripts/bench-title-card-nf.md
 *   bun scripts/bench-title-fork.ts --report
 *
 * `--prompt` swaps the fork's title request (results go to their own file per
 * prompt); `--no-baseline` skips the production title path. Titles in the
 * card form `<emoji> <CODE>: <title>` are checked and tallied in the report.
 *
 * `--tiny` sends the same title request to the configured tiny title model
 * instead of forking: no agent turn, so no system prompt, tools, or reasoning —
 * just the first message (cleaned as production cleans tiny input) followed by
 * the request, with production's decoding (temperature 0, reasoning off).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, completeSimple, type Model, type Usage } from "@oh-my-pi/pi-ai";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { resolveRoleSelection } from "../src/config/model-resolver";
import { roleCandidatePool } from "../src/config/model-roles";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { loadEntriesFromFile } from "../src/session/session-loader";
import { SessionManager } from "../src/session/session-manager";
import { preprocessTinyMessage } from "../src/tiny/message-preproc";
import { normalizeGeneratedTitle } from "../src/tiny/text";
import { shutdownTinyTitleClient } from "../src/tiny/title-client";

/** The fork's title request when `--prompt` names none. */
const DEFAULT_PROMPT = path.join(import.meta.dir, "bench-title-fork.md");

/** One emoji: ZWJ sequences and variation selectors included. */
const EMOJI = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*`;
/** A card code: 1-6 capitals or digits. */
const CODE = "[A-Z0-9]{1,6}";
/** The line card form, `<emoji> <CODE>: <title>`. */
const CARD_LINE = new RegExp(String.raw`^(${EMOJI})\s+(${CODE}):\s+(\S.*)$`, "u");
/** The tag card form, `<title emoji="…" nf="…" code="…">title</title>`. */
const CARD_TAG = /<title\s+([^>]*)>([^<]*)<\/title>/;
const CARD_ATTR = /(\w+)="([^"]*)"/g;

/** A card-form title's parts; `nf` is the Nerd Fonts glyph name asked for (tag form only). */
interface CardTitle {
	emoji: string;
	code: string;
	title: string;
	nf?: string;
}

/** The card a fork's reply names, in either form. */
function parseCardTitle(reply: string | undefined, title: string | null | undefined): CardTitle | undefined {
	const tag = reply?.match(CARD_TAG);
	if (tag) {
		const attrs = Object.fromEntries([...tag[1]!.matchAll(CARD_ATTR)].map(m => [m[1]!, m[2]!]));
		const emoji = attrs.emoji ?? "";
		const code = attrs.code ?? "";
		const text = tag[2]!.trim();
		const ok = new RegExp(`^${EMOJI}$`, "u").test(emoji) && new RegExp(`^${CODE}$`).test(code) && text;
		return ok ? { emoji, code, title: text, nf: attrs.nf } : undefined;
	}
	const match = title?.match(CARD_LINE);
	return match ? { emoji: match[1]!, code: match[2]!, title: match[3]! } : undefined;
}

/** Looks Nerd Fonts glyph names (`nf-md-flask` or `md-flask`) up in findnerd's catalog (`--glyphs`). */
function glyphLookup(dbPath: string | undefined): (name: string) => string | undefined {
	if (!dbPath) return () => undefined;
	const db = new Database(dbPath, { readonly: true });
	const query = db.query<{ glyph: string }, [string]>("SELECT glyph FROM icon WHERE name = ?");
	return name => query.get(name.replace(/^nf-/, ""))?.glyph;
}

/** One sampled session: its first user message plus what was recorded for it. */
interface SampleEntry {
	sessionId: string;
	file: string;
	cwd: string;
	prompt: string;
	recorded: {
		model?: string;
		thinking?: string;
		/** First automatic title, from the title model of the time. */
		autoTitle?: string;
		/** Final title: replan refreshes and user renames included. */
		title?: string;
		titleSource?: string;
	};
}

/** Title produced by the production path for the same first message. */
interface BaselineResult {
	title: string | null;
	ms: number;
	error?: string;
}

/** The main turn at the fork point. */
interface MainSnapshot {
	/** Submit → first non-thinking block start. */
	forkAtMs: number;
	firstBlock: "text" | "toolCall";
	thinkingBlocks: number;
	thinkingChars: number;
	redactedThinkingBlocks: number;
	/** Usage reported so far (prefix input/cache buckets on Anthropic). */
	usage: Usage;
}

/** The title request: the forked side turn, or the tiny model call on the tiny lane. */
interface ForkResult {
	title: string | null;
	reply: string;
	ms: number;
	usage: Usage;
	thinkingChars: number;
	error?: string;
}

/** One finished session, as appended to the results JSONL. */
interface RunRecord {
	/** Absent on records written before `--tiny` existed, which are all fork-lane. */
	lane?: "fork" | "tiny";
	sessionId: string;
	prompt: string;
	recorded: SampleEntry["recorded"];
	/** Fork lane only. */
	cwd?: string;
	/** Fork lane only. */
	cwdFallback?: boolean;
	model: string;
	thinking?: string;
	/** Fork lane only. */
	forkThinking?: string;
	baseline: BaselineResult;
	main?: MainSnapshot;
	fork?: ForkResult;
	error?: string;
	finishedAt: string;
}

interface Config {
	dbPath: string;
	sessionsDir: string;
	dir: string;
	count: number;
	resample: boolean;
	limit: number;
	concurrency: number;
	model?: string;
	thinking?: ConfiguredThinkingLevel;
	forkThinking?: ConfiguredThinkingLevel;
	timeoutMs: number;
	reportOnly: boolean;
	promptPath: string;
	baseline: boolean;
	tiny: boolean;
	glyphs?: string;
}

const PROMPT_PREVIEW_CHARS = 160;

function parseArgs(argv: string[]): Config {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const thinking = (flag: string): ConfiguredThinkingLevel | undefined => {
		const raw = get(flag);
		if (raw === undefined) return undefined;
		const level = parseConfiguredThinkingLevel(raw);
		if (!level) throw new Error(`${flag}: unknown thinking level ${raw}`);
		return level;
	};
	const home = (value: string): string => value.replace(/^~(?=$|\/)/, os.homedir());
	return {
		dbPath: home(get("--db") ?? "~/.omp/agent/history.db"),
		sessionsDir: home(get("--sessions") ?? "~/.omp/agent/sessions"),
		dir: home(get("--dir") ?? path.join(os.tmpdir(), "title-fork")),
		count: Number(get("--count") ?? 500),
		resample: argv.includes("--resample"),
		limit: Number(get("--limit") ?? 10),
		concurrency: Number(get("--concurrency") ?? 4),
		model: get("--model"),
		thinking: thinking("--thinking"),
		forkThinking: thinking("--fork-thinking"),
		timeoutMs: Number(get("--timeout") ?? 300) * 1000,
		reportOnly: argv.includes("--report"),
		promptPath: path.resolve(get("--prompt") ?? DEFAULT_PROMPT),
		baseline: !argv.includes("--no-baseline"),
		tiny: argv.includes("--tiny"),
		glyphs: get("--glyphs") && home(get("--glyphs")!),
	};
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Map session id → top-level session file under every project directory. */
async function indexSessionFiles(sessionsDir: string): Promise<Map<string, string>> {
	const index = new Map<string, string>();
	for (const project of await fs.readdir(sessionsDir, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		const projectDir = path.join(sessionsDir, project.name);
		for (const name of await fs.readdir(projectDir)) {
			if (name.startsWith(".") || !name.endsWith(".jsonl")) continue;
			const sep = name.lastIndexOf("_");
			if (sep <= 0) continue;
			index.set(name.slice(sep + 1, -".jsonl".length), path.join(projectDir, name));
		}
	}
	return index;
}

/**
 * Read what the experiment needs from one session file. Forked/handed-off
 * sessions (`parentSession`) start from inherited history rather than a fresh
 * first message, so they are rejected along with sessions lacking typed input.
 */
async function readSampleEntry(sessionId: string, file: string): Promise<SampleEntry | undefined> {
	const entries = await loadEntriesFromFile(file);
	const header = entries[0];
	if (header?.type !== "session" || header.parentSession) return undefined;
	const recorded: SampleEntry["recorded"] = { title: header.title, titleSource: header.titleSource };
	let firstPrompt: string | undefined;
	for (const entry of entries) {
		if (entry.type === "model_change") recorded.model ??= entry.model;
		else if (entry.type === "thinking_level_change")
			recorded.thinking ??= entry.configured ?? entry.thinkingLevel ?? undefined;
		else if (entry.type === "title_change" && entry.source === "auto") recorded.autoTitle ??= entry.title;
		else if (
			entry.type === "message" &&
			firstPrompt === undefined &&
			entry.message.role === "user" &&
			entry.message.attribution !== "agent"
		) {
			const { content } = entry.message;
			firstPrompt = (
				typeof content === "string"
					? content
					: content
							.filter(block => block.type === "text")
							.map(block => block.text)
							.join("\n")
			).trim();
		}
	}
	if (!firstPrompt) return undefined;
	return { sessionId, file, cwd: header.cwd, prompt: firstPrompt, recorded };
}

/** Draw `count` random history sessions that still have a usable session file. */
async function drawSample(config: Config): Promise<SampleEntry[]> {
	const index = await indexSessionFiles(config.sessionsDir);
	const db = new Database(config.dbPath, { readonly: true });
	let ids: string[];
	try {
		ids = db
			.query<{ id: string }, []>("SELECT DISTINCT session_id AS id FROM history WHERE session_id IS NOT NULL")
			.all()
			.map(row => row.id)
			.filter(id => index.has(id));
	} finally {
		db.close();
	}
	for (let i = ids.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[ids[i], ids[j]] = [ids[j]!, ids[i]!];
	}
	const sample: SampleEntry[] = [];
	for (const id of ids) {
		if (sample.length >= config.count) break;
		const entry = await readSampleEntry(id, index.get(id)!).catch(() => undefined);
		if (entry) sample.push(entry);
	}
	return sample;
}

async function loadOrDrawSample(config: Config): Promise<SampleEntry[]> {
	const samplePath = path.join(config.dir, "sample.json");
	if (!config.resample) {
		try {
			const sample: SampleEntry[] = await Bun.file(samplePath).json();
			return sample;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}
	const sample = await drawSample(config);
	await Bun.write(samplePath, JSON.stringify(sample, null, 2));
	console.info(`Drew ${sample.length} sessions → ${samplePath}`);
	return sample;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

function snapshotMain(
	partial: AssistantMessage,
	forkAtMs: number,
	firstBlock: MainSnapshot["firstBlock"],
): MainSnapshot {
	let thinkingBlocks = 0;
	let thinkingChars = 0;
	let redactedThinkingBlocks = 0;
	for (const block of partial.content) {
		if (block.type === "thinking") {
			thinkingBlocks++;
			thinkingChars += block.thinking.length;
		} else if (block.type === "redactedThinking") {
			redactedThinkingBlocks++;
		}
	}
	return {
		forkAtMs,
		firstBlock,
		thinkingBlocks,
		thinkingChars,
		redactedThinkingBlocks,
		usage: structuredClone(partial.usage),
	};
}

/**
 * A headless in-memory session with the user's settings and credentials, minus
 * MCP, LSP, IRC, and extensions. Model discovery runs before returning, as the
 * CLI's startup refresh does; without it discovery-backed roles (e.g. an
 * Ollama `tiny`) resolve only while the catalog cache is fresh, and title
 * generation silently falls through to other models.
 */
async function createHeadlessSession(cwd: string, config: Config, agentId: string): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		modelPattern: config.model,
		thinkingLevel: config.thinking,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		disableExtensionDiscovery: true,
		skipPythonPreflight: true,
		cacheWarming: false,
		agentId,
	});
	await session.modelRegistry.refresh();
	return session;
}

/** Time the production title path (`AgentSession.generateTitle`) for one first message. */
async function runBaseline(session: AgentSession, firstMessage: string): Promise<BaselineResult> {
	const started = performance.now();
	try {
		const title = await session.generateTitle(firstMessage);
		return { title, ms: Math.round(performance.now() - started) };
	} catch (err) {
		return { title: null, ms: Math.round(performance.now() - started), error: errorText(err) };
	}
}

/** A finished title request; `reply` is the visible text the title is parsed from. */
function requestResult(reply: string, message: AssistantMessage, ms: number, firstMessage: string): ForkResult {
	return {
		title: normalizeGeneratedTitle(reply, firstMessage),
		reply,
		ms,
		usage: message.usage,
		thinkingChars: message.content.reduce(
			(sum, block) => sum + (block.type === "thinking" ? block.thinking.length : 0),
			0,
		),
	};
}

/** A title request that threw or came back as a provider error. */
function failedRequest(err: unknown, ms: number): ForkResult {
	return {
		title: null,
		reply: "",
		ms,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		thinkingChars: 0,
		error: errorText(err),
	};
}

/**
 * The `tiny` role's model. Production would fall through to `commit`/`smol`
 * and the session model when it does not resolve; the experiment must not
 * silently measure those instead.
 *
 * Throws when the role does not resolve, or resolves to an on-device model —
 * those take one system prompt plus one message, not the fork-shaped conversation.
 */
function resolveTinyModel(host: AgentSession): Model {
	const pool = roleCandidatePool("tiny", host.settings, host.modelRegistry);
	const model = resolveRoleSelection(["tiny"], host.settings, pool)?.model;
	if (!model) throw new Error("The tiny role does not resolve to an available model.");
	if (model.api === "local-inference") {
		throw new Error(`${model.provider}/${model.id} is on-device; --tiny needs an online title model.`);
	}
	return model;
}

/**
 * Send one session's first message plus the title request to the tiny model,
 * shaped like the fork's tail: two user turns, nothing else.
 */
async function runTinyEntry(
	entry: SampleEntry,
	config: Config,
	titlePrompt: string,
	host: AgentSession,
	model: Model,
): Promise<RunRecord> {
	const record: RunRecord = {
		lane: "tiny",
		sessionId: entry.sessionId,
		prompt: entry.prompt.slice(0, 2000),
		recorded: entry.recorded,
		model: `${model.provider}/${model.id}`,
		baseline: config.baseline ? await runBaseline(host, entry.prompt) : { title: null, ms: 0 },
		finishedAt: "",
	};
	const started = performance.now();
	try {
		const now = Date.now();
		const response = await completeSimple(
			model,
			{
				messages: [
					{ role: "user", content: preprocessTinyMessage(entry.prompt), timestamp: now },
					{ role: "user", content: titlePrompt, timestamp: now },
				],
			},
			{
				apiKey: host.modelRegistry.resolver(model, host.sessionId),
				sessionId: host.sessionId,
				// Production's ceiling: survives backends that ignore `disableReasoning`.
				maxTokens: 1024,
				disableReasoning: true,
				temperature: 0,
				signal: AbortSignal.timeout(config.timeoutMs),
			},
		);
		const ms = Math.round(performance.now() - started);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			record.fork = failedRequest(response.errorMessage ?? response.stopReason, ms);
		} else {
			const reply = response.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("")
				.trim();
			record.fork = requestResult(reply, response, ms, entry.prompt);
		}
	} catch (err) {
		record.fork = failedRequest(err, Math.round(performance.now() - started));
	}
	record.finishedAt = new Date().toISOString();
	return record;
}

/**
 * Replay one session's first message and fork a title request at the first
 * non-thinking block. The production title path runs first, on its own, so
 * the main turn's abort cannot cancel it.
 */
async function runForkEntry(
	entry: SampleEntry,
	config: Config,
	forkPrompt: string,
	fallbackCwd: string,
): Promise<RunRecord> {
	const cwdExists = await isDirectory(entry.cwd);
	const cwd = cwdExists ? entry.cwd : fallbackCwd;
	const session = await createHeadlessSession(cwd, config, `TitleFork-${entry.sessionId}`);
	const model = session.model;
	const record: RunRecord = {
		lane: "fork",
		sessionId: entry.sessionId,
		prompt: entry.prompt.slice(0, 2000),
		recorded: entry.recorded,
		cwd,
		cwdFallback: !cwdExists,
		model: model ? `${model.provider}/${model.id}` : "none",
		thinking: session.thinkingLevel,
		forkThinking: config.forkThinking ?? "inherit",
		baseline: { title: null, ms: 0 },
		finishedAt: "",
	};
	const deadline = setTimeout(() => void session.abort(), config.timeoutMs);
	try {
		if (config.baseline) record.baseline = await runBaseline(session, entry.prompt);

		let fork: Promise<ForkResult> | undefined;
		const submitted = performance.now();
		const unsubscribe = session.subscribe(event => {
			if (fork || event.type !== "message_update") return;
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type !== "text_start" && streamEvent.type !== "toolcall_start") return;
			const forkStarted = performance.now();
			record.main = snapshotMain(
				streamEvent.partial,
				Math.round(forkStarted - submitted),
				streamEvent.type === "text_start" ? "text" : "toolCall",
			);
			// The side turn snapshots the conversation synchronously, before its
			// first await; everything after this call is free to change state.
			const turn = session.runEphemeralTurn({
				promptText: forkPrompt,
				signal: AbortSignal.timeout(config.timeoutMs),
			});
			// Its request options (reasoning effort) are read after those awaits,
			// so a fork-only thinking level applies to the fork alone.
			if (config.forkThinking) session.setThinkingLevel(config.forkThinking);
			void session.abort();
			fork = turn.then(
				({ replyText, assistantMessage }) =>
					requestResult(replyText, assistantMessage, Math.round(performance.now() - forkStarted), entry.prompt),
				err => failedRequest(err, Math.round(performance.now() - forkStarted)),
			);
		});
		try {
			await session.prompt(entry.prompt, { expandPromptTemplates: false });
		} catch (err) {
			if (!fork) record.error = errorText(err);
		} finally {
			unsubscribe();
		}
		if (fork) {
			record.fork = await fork;
		} else {
			const last = session.messages.at(-1);
			record.error ??=
				last?.role === "assistant"
					? `no non-thinking block (stop: ${last.stopReason}${last.errorMessage ? `, ${last.errorMessage}` : ""})`
					: "no assistant reply";
		}
	} finally {
		clearTimeout(deadline);
		await session.dispose();
	}
	record.finishedAt = new Date().toISOString();
	return record;
}

async function readResults(resultsPath: string): Promise<RunRecord[]> {
	try {
		// Written only by this script, one RunRecord per line.
		const records = Bun.JSONL.parse(await Bun.file(resultsPath).text()) as RunRecord[];
		return records;
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

/** Run `pending` entries through `run`, `concurrency` at a time, appending each result as it lands. */
async function runPending(
	pending: SampleEntry[],
	config: Config,
	resultsPath: string,
	run: (entry: SampleEntry) => Promise<RunRecord>,
): Promise<void> {
	console.info(`Running ${pending.length} sessions (concurrency ${config.concurrency}) → ${resultsPath}`);
	let next = 0;
	let finished = 0;
	const worker = async (): Promise<void> => {
		while (next < pending.length) {
			const entry = pending[next++]!;
			let record: RunRecord;
			try {
				record = await run(entry);
			} catch (err) {
				console.error(`[${entry.sessionId}] setup failed: ${errorText(err)}`);
				continue;
			}
			await fs.appendFile(resultsPath, `${JSON.stringify(record)}\n`);
			finished++;
			const outcome = record.fork
				? `${record.fork.title ?? `∅ ${record.fork.error ?? record.fork.reply.slice(0, 60)}`}`
				: `ERROR ${record.error}`;
			console.info(`[${finished}/${pending.length}] ${record.model} · ${outcome}`);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, worker));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function percentile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))]!;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function printReport(records: RunRecord[], glyphs?: string): void {
	for (const record of records) {
		const { main, fork } = record;
		const lane = record.lane ?? "fork";
		const timing = !fork
			? (record.error ?? "")
			: main
				? `fork@${seconds(main.forkAtMs)} +${seconds(fork.ms)} · cache ${fork.usage.cacheRead}/${fork.usage.input + fork.usage.cacheRead + fork.usage.cacheWrite} · $${fork.usage.cost.total.toFixed(4)}`
				: `${lane} ${seconds(fork.ms)} · ${fork.usage.input + fork.usage.cacheRead} in / ${fork.usage.output} out`;
		console.info(`\n[${record.sessionId}] ${record.model} (${timing})`);
		console.info(`  ${oneLine(record.prompt, PROMPT_PREVIEW_CHARS)}`);
		console.info(`  recorded auto  : ${record.recorded.autoTitle ?? "∅"}`);
		console.info(`  recorded final : ${record.recorded.title ?? "∅"} (${record.recorded.titleSource ?? "?"})`);
		console.info(
			`  baseline       : ${record.baseline.title ?? `∅${record.baseline.error ? ` ${record.baseline.error}` : ""}`} (${seconds(record.baseline.ms)})`,
		);
		if (fork) console.info(`  ${lane.padEnd(15)}: ${fork.title ?? `∅ ${oneLine(fork.error ?? fork.reply, 80)}`}`);
	}

	// Card-form titles: what a pile card shows (glyph or emoji + code) and how well codes tell sessions apart.
	const cards = records.map(record => parseCardTitle(record.fork?.reply, record.fork?.title));
	const carded = cards.filter(card => card !== undefined);
	if (carded.length > 0) {
		const glyph = glyphLookup(glyphs);
		console.info("\nCards:");
		for (const card of carded) {
			const nf = card.nf === undefined ? "" : ` ${glyph(card.nf) ?? "✗"} ${card.nf}`;
			console.info(`  ${card.emoji} ${card.code.padEnd(6)} │ ${card.title}${nf ? `  ·${nf}` : ""}`);
		}
		const codes = new Set(carded.map(card => card.code));
		const emoji = new Map<string, number>();
		for (const card of carded) emoji.set(card.emoji, (emoji.get(card.emoji) ?? 0) + 1);
		const top = [...emoji].sort((a, b) => b[1] - a[1]).slice(0, 5);
		const named = carded.filter(card => card.nf);
		const real = glyphs ? `${named.filter(card => glyph(card.nf!)).length}/${named.length} nf names exist · ` : "";
		const lengths = carded.map(card => card.code.length);
		const answered = records.filter(r => r.fork?.reply.includes("<title") && !r.fork.reply.includes("<title/>"));
		console.info(
			`  card form ${carded.length}/${answered.length} · ${codes.size} distinct codes · code length ${Math.min(...lengths)}-${Math.max(...lengths)} · ${real}emoji: ${top.map(([e, n]) => `${e}×${n}`).join(" ")}`,
		);
		const off = answered.filter(record => !parseCardTitle(record.fork?.reply, record.fork?.title));
		for (const record of off) console.info(`  off-form: ${oneLine(record.fork!.reply, 120)}`);
	}

	const requested = records.filter(record => record.fork && !record.fork.error);
	const forked = requested.filter(record => record.main);
	const forkAt = forked.map(record => record.main!.forkAtMs);
	const requestMs = requested.map(record => record.fork!.ms);
	const ready = requested.map(record => (record.main?.forkAtMs ?? 0) + record.fork!.ms);
	const baselineMs = records.map(record => record.baseline.ms);
	const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
	// The main request's prompt is the fork's cacheable prefix.
	const mainPrompt = sum(forked.map(r => r.main!.usage.input + r.main!.usage.cacheRead + r.main!.usage.cacheWrite));
	const forkCacheRead = sum(forked.map(r => r.fork!.usage.cacheRead));
	console.info("\nSummary:");
	console.table({
		sessions: { value: records.length },
		"titled (plain form)": { value: requested.filter(r => r.fork!.title).length },
		"declined/unparsed (plain form)": { value: requested.filter(r => !r.fork!.title).length },
		"request errors": { value: records.filter(r => r.fork?.error).length },
		"main errors (no fork)": { value: records.filter(r => !r.fork).length },
		"baseline titled": { value: records.filter(r => r.baseline.title).length },
		"fork point p50 / p90": { value: `${seconds(percentile(forkAt, 0.5))} / ${seconds(percentile(forkAt, 0.9))}` },
		"title request p50 / p90": {
			value: `${seconds(percentile(requestMs, 0.5))} / ${seconds(percentile(requestMs, 0.9))}`,
		},
		"title ready p50 / p90": { value: `${seconds(percentile(ready, 0.5))} / ${seconds(percentile(ready, 0.9))}` },
		"baseline p50 / p90": {
			value: `${seconds(percentile(baselineMs, 0.5))} / ${seconds(percentile(baselineMs, 0.9))}`,
		},
		"fork cacheRead / main prompt": {
			value: `${forkCacheRead} / ${mainPrompt} (${mainPrompt ? ((100 * forkCacheRead) / mainPrompt).toFixed(1) : 0}%)`,
		},
		"request uncached input p50": {
			value: percentile(
				requested.map(r => r.fork!.usage.input + r.fork!.usage.cacheWrite),
				0.5,
			),
		},
		"request output p50": {
			value: percentile(
				requested.map(r => r.fork!.usage.output),
				0.5,
			),
		},
		"request cost mean": {
			value: `$${(sum(requested.map(r => r.fork!.usage.cost.total)) / (requested.length || 1)).toFixed(4)}`,
		},
	});
}

async function main(): Promise<void> {
	const config = parseArgs(Bun.argv.slice(2));
	// The baseline is requested explicitly; keep skill prompts from starting a second one.
	Bun.env.PI_NO_TITLE = "1";
	await fs.mkdir(config.dir, { recursive: true });
	const sample = await loadOrDrawSample(config);
	const promptName = path.basename(config.promptPath, ".md");
	const variant = [
		...(config.tiny
			? ["tiny"]
			: [config.model ?? "default", config.thinking ?? "default", `fork-${config.forkThinking ?? "inherit"}`]),
		...(config.promptPath === DEFAULT_PROMPT ? [] : [promptName]),
	]
		.join("-")
		.replace(/[^\w.-]+/g, "_");
	const resultsPath = path.join(config.dir, `results-${variant}.jsonl`);
	if (!config.reportOnly) {
		const done = new Set((await readResults(resultsPath)).map(record => record.sessionId));
		const pending = sample.filter(entry => !done.has(entry.sessionId)).slice(0, config.limit);
		if (pending.length > 0) {
			const titlePrompt = prompt.render(await Bun.file(config.promptPath).text());
			const fallbackCwd = path.join(config.dir, "cwd");
			await fs.mkdir(fallbackCwd, { recursive: true });
			if (config.tiny) {
				// One host session lends the tiny lane its settings, registry, and credentials.
				const host = await createHeadlessSession(fallbackCwd, config, "TitleFork-tiny");
				try {
					const model = resolveTinyModel(host);
					console.info(`Tiny model: ${model.provider}/${model.id}`);
					await runPending(pending, config, resultsPath, entry =>
						runTinyEntry(entry, config, titlePrompt, host, model),
					);
				} finally {
					await host.dispose();
				}
			} else {
				await runPending(pending, config, resultsPath, entry =>
					runForkEntry(entry, config, titlePrompt, fallbackCwd),
				);
			}
		}
		await shutdownTinyTitleClient();
	}
	printReport(await readResults(resultsPath), config.glyphs);
	console.info(`\nResults: ${resultsPath}`);
}

await main();
process.exit(0);
