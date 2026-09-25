/**
 * Cascade search: semantic passage maps before full-source reading.
 *
 * 1. Lexical scan ranks every eligible file by query keywords.
 * 2. Filename ranking judges the top candidates by name and place in the tree.
 * 3. Passage scoring reads the strongest files, cuts them into byte-bounded
 *    windows, and judges a budgeted verbatim sketch of each window.
 * 4. Verification judges the complete text of the sketches that survived.
 *
 * Sketch judgments are only routing signals: a reported heat range always
 * comes from a complete passage. Each judged phase runs its requests through
 * a bounded-parallel dispatcher and drains fully before the next begins, so
 * the critical path is three dependent waves.
 */
import * as path from "node:path";
import type { Judge, JudgmentResult, NoulQuestion } from "@oh-my-pi/pi-ai";
import type { FindHit, FindStats } from "@oh-my-pi/pi-tui/tools/find";
import type { InternalUrlFilesystem } from "../../internal-urls/url-filesystem";
import { throwIfAborted } from "../tool-errors";
import { fileScore, grepIndex, idf } from "./lexical";
import { keywords as deriveKeywords } from "./keywords";
import { type HeatRange, mergeHeat, type Passage, plainContent, selectWindows, sketch, windows } from "./passages";
import { nameBatch, passageBatch, passageKey, entryKey, type Request, type SketchCard, sketchBatch } from "./questions";
import { lines, readText, ReadTextError, takeChars } from "./text";
import { type FileEntry, listFiles, type SearchRoot } from "./tree";

/** Requests in flight per dispatched phase. */
const PARALLEL = 16;
/** Files per filename-ranking request. */
const NAME_BATCH = 64;
/** Lexically ranked files that receive a filename judgment. */
const CANDIDATES = 128;
/** Files whose content is read and sketched. */
const FILES = 20;
/** Windows kept per read file. */
const WINDOWS = 24;
/** Bytes per window, tags included. */
const WINDOW_BYTES = 8192;
/** Bytes per sketch card. */
const SKETCH_BYTES = 384;
/** Complete passages verified across all files. */
const FULL_LIMIT = 40;
/** Sketch probability below which a passage is not verified. */
const CUTOFF = 0.45;
/** Verified-passage probability at or above which a file is a hit. */
const THRESHOLD = 0.2;
/** Bytes of a file read for windowing. */
const READ_LIMIT = 4 * 1024 * 1024;
/** Sketch state budget per request; sized so cards stay well inside the judge's context. */
const SKETCH_STATE_BYTES = 18_000;
/** Hard cap on sketch cards per request. */
const SKETCH_CARDS_MAX = 48;
/** Passage state budget per verification request, tags included. */
const VERIFY_STATE_BYTES = 24 * 1024;
/** Wall-clock budget for the native lexical scan. */
const SCAN_TIMEOUT_MS = 30_000;
/** Distinct failure messages retained for the report. */
const FAILURES_KEPT = 5;

export interface CascadeOptions {
	root: SearchRoot;
	/** Filesystem the root is listed, scanned, and read through: host paths and internal URLs alike. */
	filesystem: InternalUrlFilesystem;
	query: string;
	/** Caller-supplied lexical keywords, added to those derived from the query. */
	extraKeywords: readonly string[];
	judge: Judge;
	includeHidden: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface CascadeResult {
	/** Files whose verified passages cleared the threshold, strongest first. */
	hits: FindHit[];
	threshold: number;
	keywords: string[];
	stats: FindStats;
}

interface FilePlan {
	node: number;
	total: number;
	truncated: boolean;
	passages: Passage[];
}

type Answers = JudgmentResult<Record<string, NoulQuestion>>;
type Outcome = { ok: true; result: Answers } | { ok: false; error: unknown };

/** A finite probability, or `undefined` when the judge produced nothing usable for the key. */
function noul(outcome: Outcome, key: string): number | undefined {
	if (!outcome.ok) return undefined;
	const p = outcome.result.answers[key]?.noul;
	return p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
	return out;
}

function compareRel(a: FileEntry, b: FileEntry): number {
	return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

class Cascade {
	readonly #options: CascadeOptions;
	readonly stats: FindStats = {
		listed: 0,
		requests: 0,
		errors: 0,
		judged: 0,
		filesRead: 0,
		fileBytes: 0,
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		apiMs: 0,
		windowsJudged: 0,
		windowsPruned: 0,
		mapCards: 0,
		failures: [],
	};

	constructor(options: CascadeOptions) {
		this.#options = options;
	}

	#fail(phase: string, error: unknown): void {
		const message = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
		const { failures } = this.stats;
		if (failures.length < FAILURES_KEPT && !failures.includes(message)) failures.push(message);
	}

	async #ask(request: Request): Promise<Outcome> {
		const { judge, signal } = this.#options;
		const started = performance.now();
		try {
			const result = await judge.judge(request, { signal });
			this.stats.requests++;
			this.stats.apiMs += performance.now() - started;
			this.stats.inputTokens += result.usage.input;
			this.stats.outputTokens += result.usage.output;
			this.stats.cost += result.usage.cost.total;
			return { ok: true, result };
		} catch (error) {
			throwIfAborted(signal);
			this.stats.requests++;
			this.stats.errors++;
			this.stats.apiMs += performance.now() - started;
			return { ok: false, error };
		}
	}

	/**
	 * Run every job with at most {@link PARALLEL} requests in flight, handing each
	 * outcome to `settle` in completion order. Resolves once the queue drains.
	 */
	async #dispatch<J extends { request: Request }>(jobs: readonly J[], settle: (job: J, outcome: Outcome) => void) {
		let next = 0;
		const worker = async () => {
			while (next < jobs.length) {
				throwIfAborted(this.#options.signal);
				const job = jobs[next++]!;
				settle(job, await this.#ask(job.request));
			}
		};
		await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
	}

	async run(): Promise<CascadeResult> {
		const { root, filesystem, query, includeHidden, signal, onProgress } = this.#options;
		const keywords = deriveKeywords(query, this.#options.extraKeywords);

		onProgress?.("lexical scan");
		const native = filesystem.shellFilesystem();
		const [entries, index] = await Promise.all([
			listFiles(root, { includeHidden, filesystem: native, signal }),
			grepIndex(root.path, keywords, { includeHidden, filesystem: native, signal, timeoutMs: SCAN_TIMEOUT_MS }),
		]);
		this.stats.listed = entries.length;
		const weights = idf(index);
		const noCounts = Array.from({ length: keywords.length }, () => 0);
		const ranked = entries
			.map((entry, node) => ({
				node,
				lex: fileScore(index.perFileKw.get(entry.rel) ?? noCounts, weights, entry.rel, keywords),
			}))
			.sort((a, b) => b.lex - a.lex || compareRel(entries[a.node]!, entries[b.node]!))
			.slice(0, CANDIDATES);
		const nameScore = Array.from<number | undefined>({ length: entries.length });

		// Wave 1: filename ranking over the lexical shortlist.
		const project = path.basename(root.path);
		const nameJobs = chunks(
			ranked.map(candidate => candidate.node),
			NAME_BATCH,
		).map(batch => ({
			batch,
			request: nameBatch(
				project,
				query,
				batch.map(node => entries[node]!),
			),
		}));
		let named = 0;
		onProgress?.(`filename ranking 0/${ranked.length}`);
		await this.#dispatch(nameJobs, (job, outcome) => {
			named += job.batch.length;
			if (!outcome.ok) this.#fail("filenames", outcome.error);
			job.batch.forEach((node, k) => {
				const p = noul(outcome, entryKey(k));
				nameScore[node] = p;
				if (p === undefined) {
					if (outcome.ok) this.stats.errors++;
				} else {
					this.stats.judged++;
				}
			});
			onProgress?.(`filename ranking ${named}/${ranked.length}`);
		});

		// The two strongest lexical candidates are read regardless of the name
		// judgment; the rest of the budget follows name score, then lexical rank.
		const selected = ranked.slice(0, Math.min(FILES, 2)).map(candidate => candidate.node);
		ranked.sort((a, b) => (nameScore[b.node] ?? 0) - (nameScore[a.node] ?? 0) || b.lex - a.lex);
		for (const candidate of ranked) {
			if (selected.length >= FILES) break;
			if (!selected.includes(candidate.node)) selected.push(candidate.node);
		}
		onProgress?.(`reading ${selected.length} files`);
		const plans = await Promise.all(
			selected.map(async (node): Promise<FilePlan | undefined> => {
				const entry = entries[node]!;
				try {
					const read = await readText(filesystem, entry.path, READ_LIMIT);
					const passages = selectWindows(windows(read.text, WINDOW_BYTES, keywords, weights), WINDOWS);
					if (passages.length === 0) return undefined;
					return { node, total: lines(read.text).length, truncated: read.truncated, passages };
				} catch (error) {
					// Binary and blank files are expected misses, not failures worth reporting.
					if (!(error instanceof ReadTextError) || error.kind === "io") this.#fail(`read ${entry.rel}`, error);
					return undefined;
				}
			}),
		);
		const files = plans.filter((plan): plan is FilePlan => plan !== undefined);

		// Wave 2: sketch routing over mixed-file cards.
		const cards: { f: number; p: number }[] = [];
		files.forEach((plan, f) => plan.passages.forEach((_, p) => cards.push({ f, p })));
		let sketchSentBytes = 0;
		const sketchJobs = chunks(
			cards,
			Math.min(SKETCH_CARDS_MAX, Math.max(1, Math.floor(SKETCH_STATE_BYTES / SKETCH_BYTES))),
		).map(batch => {
			const sketches: SketchCard[] = batch.map(({ f, p }) => {
				const text = sketch(files[f]!.passages[p]!, keywords, weights, SKETCH_BYTES);
				sketchSentBytes += Buffer.byteLength(text);
				return { fileKey: `f${f}`, rel: entries[files[f]!.node]!.rel, sketch: text };
			});
			return { batch, request: sketchBatch(query, sketches) };
		});
		this.stats.mapCards += cards.length;
		onProgress?.(`scoring ${cards.length} passage sketches across ${files.length} files`);
		const candidates: { f: number; p: number; score: number }[] = [];
		await this.#dispatch(sketchJobs, (job, outcome) => {
			if (!outcome.ok) this.#fail("sketches", outcome.error);
			job.batch.forEach(({ f, p }, k) => {
				const score = noul(outcome, passageKey(k));
				if (score === undefined && outcome.ok) this.stats.errors++;
				// Failure is unknown, never grounds for a negative judgment.
				candidates.push({ f, p, score: score ?? 1 });
			});
		});
		candidates.sort(
			(a, b) =>
				b.score - a.score ||
				files[b.f]!.passages[b.p]!.score - files[a.f]!.passages[a.p]!.score ||
				compareRel(entries[files[a.f]!.node]!, entries[files[b.f]!.node]!) ||
				files[a.f]!.passages[a.p]!.start - files[b.f]!.passages[b.p]!.start,
		);
		const survivors = candidates.filter(candidate => candidate.score >= CUTOFF).slice(0, FULL_LIMIT);
		this.stats.windowsPruned += cards.length - survivors.length;
		const chosen = new Map<number, number[]>();
		for (const { f, p } of survivors) {
			const list = chosen.get(f);
			if (list) list.push(p);
			else chosen.set(f, [p]);
		}

		// Wave 3: verification of complete passages, grouped per file.
		const verifyJobs: { f: number; passages: Passage[]; request: Request }[] = [];
		for (const f of [...chosen.keys()].sort((a, b) => a - b)) {
			const rel = entries[files[f]!.node]!.rel;
			const ps = chosen.get(f)!.sort((a, b) => a - b);
			for (const group of chunks(ps, Math.max(1, Math.floor(VERIFY_STATE_BYTES / WINDOW_BYTES)))) {
				const passages = group.map(p => files[f]!.passages[p]!);
				verifyJobs.push({ f, passages, request: passageBatch(query, rel, passages) });
			}
		}
		onProgress?.(`verifying ${survivors.length} passages in ${chosen.size} files`);
		const results = new Map<number, { score: number; heat: HeatRange[]; lines: number; bytes: number }>();
		await this.#dispatch(verifyJobs, (job, outcome) => {
			if (!outcome.ok) {
				this.#fail("verification", outcome.error);
				return;
			}
			let entry = results.get(job.f);
			if (!entry) {
				entry = { score: 0, heat: [], lines: 0, bytes: 0 };
				results.set(job.f, entry);
			}
			job.passages.forEach((passage, k) => {
				const score = noul(outcome, passageKey(k));
				if (score === undefined) {
					this.stats.errors++;
					return;
				}
				const text = plainContent(passage);
				entry.score = Math.max(entry.score, score);
				entry.heat.push({
					start: passage.start,
					end: passage.end,
					p: score,
					snippet: takeChars(lines(text).find(line => line.trim().length > 0) ?? "", 100),
				});
				entry.lines += passage.end - passage.start + 1;
				entry.bytes += Buffer.byteLength(text);
				this.stats.windowsJudged++;
			});
		});

		const hits: FindHit[] = [];
		for (const [f, entry] of results) {
			const plan = files[f]!;
			this.stats.filesRead++;
			this.stats.fileBytes += entry.bytes;
			if (entry.score < THRESHOLD) continue;
			hits.push({
				rel: entries[plan.node]!.rel,
				nameScore: nameScore[plan.node],
				contentScore: entry.score,
				ranges: mergeHeat(entry.heat, THRESHOLD),
				linesSeen: entry.lines,
				truncated: plan.truncated || entry.lines < plan.total,
			});
		}
		this.stats.fileBytes += sketchSentBytes;
		this.stats.filesRead += files.length - results.size;
		hits.sort((a, b) => b.contentScore - a.contentScore);
		return { hits, threshold: THRESHOLD, keywords, stats: this.stats };
	}
}

/** Run one cascade search over `options.root`. Judge failures degrade coverage and are reported in `stats.failures`, never thrown. */
export function runCascade(options: CascadeOptions): Promise<CascadeResult> {
	return new Cascade(options).run();
}
