/**
 * Event-loop stack sampling for `ui.loop-blocked` attribution.
 *
 * Phase labels cover only a handful of call sites, so most blocks used to log
 * as "unknown". JavaScriptCore's sampling profiler records the JS thread's
 * stack every millisecond while it runs JS and nothing while the loop idles,
 * so the samples taken during a block name the code that caused it.
 */
import { type SamplingProfileStackTraces, samplingProfilerStackTraces, startSamplingProfiler } from "bun:jsc";

// Exported by bun:jsc at runtime but not yet declared by bun-types.
declare module "bun:jsc" {
	/** Returns the samples recorded since the previous call and clears the profiler's buffer. */
	function samplingProfilerStackTraces(): SamplingProfileStackTraces;
}

/** One stack frame of a {@link LoopSample}. `url` is "" for native frames. */
export interface LoopSampleFrame {
	name: string;
	url: string;
	line: number;
}

/** One stack sample of the JS thread; `frames` run innermost first. */
export interface LoopSample {
	atMs: number;
	frames: readonly LoopSampleFrame[];
}

/** Source of JS-thread stack samples the watchdog drains every tick. */
export interface LoopSampler {
	/** Starts sampling; idempotent. */
	start(): void;
	/** Returns the samples taken since the previous drain, oldest first, and forgets them. */
	drain(): LoopSample[];
}

/** What dominated a blocked window, from {@link summarizeBlock}. */
export interface LoopBlockSummary {
	/** Most frequent innermost source frame, `name (path:line)`. */
	cause: string;
	/** Fraction of window samples whose stack contains the cause frame. */
	share: number;
	/** Callers present in at least half the window samples, outermost first, `name (path:line) NN%`. */
	top: string[];
}

/** Line JSC reports for frames without a source position (native functions). */
const UNKNOWN_LINE = 4294967295;
/** Most callers `top` lists. */
const TOP_LIMIT = 4;

// JSC has no stop call: one profiler serves every sampler for the rest of the process.
let profilerStarted = false;
/** `performance.now()` of the last drain by any sampler. */
let lastDrainAt = 0;
/**
 * How long the buffer may go undrained before its samples are dropped. Nothing
 * drains while every watchdog is stopped (an external editor, a suspended
 * TUI), and the profiler keeps recording each millisecond of JS that runs.
 */
const IDLE_DISCARD_MS = 2_000;

/**
 * The bun:jsc-backed sampler, or null unless `PI_LOOP_SAMPLER=1|true`.
 * Sampling can repeatedly restart slow native calls on WSL2; the event-loop
 * watchdog still reports blocks without stack attribution by default.
 * Also disabled under `--cpu-prof`, whose profiler would steal its samples.
 */
export function createJscLoopSampler(): LoopSampler | null {
	const env = Bun.env.PI_LOOP_SAMPLER;
	if (env !== "1" && env !== "true") return null;
	for (const arg of process.execArgv) {
		if (arg.startsWith("--cpu-prof")) return null;
	}
	return {
		start(): void {
			if (profilerStarted) return;
			startSamplingProfiler();
			profilerStarted = true;
			lastDrainAt = performance.now();
			const discard: Timer = setInterval(() => {
				if (performance.now() - lastDrainAt >= IDLE_DISCARD_MS) samplingProfilerStackTraces();
			}, IDLE_DISCARD_MS);
			discard.unref();
		},
		drain(): LoopSample[] {
			lastDrainAt = performance.now();
			const { traces } = samplingProfilerStackTraces();
			const samples: LoopSample[] = new Array(traces.length);
			for (let i = 0; i < traces.length; i++) {
				const trace = traces[i]!;
				const frames: LoopSampleFrame[] = new Array(trace.frames.length);
				for (let j = 0; j < trace.frames.length; j++) {
					const frame = trace.frames[j]!;
					frames[j] = { name: frame.name, url: frame.sourceURL ?? "", line: frame.line };
				}
				samples[i] = { atMs: trace.timestamp * 1000, frames };
			}
			return samples;
		},
	};
}

interface FrameStat {
	frame: LoopSampleFrame;
	/** Window samples whose stack contains this frame. */
	presence: number;
	/** Window samples whose cause frame this is. */
	innermost: number;
	/** Sum over containing samples of the frame's distance from the outermost frame. */
	depthSum: number;
	/** Sample count per sampled line, to report the hottest one. */
	lines: Map<number, number>;
}

function isNativeFrame(frame: LoopSampleFrame): boolean {
	return frame.url === "" || frame.line === UNKNOWN_LINE;
}

/** Shortens a source url to the part that identifies it in this repo or its dependencies. */
function shortenPath(url: string): string {
	const path = url.replaceAll("\\", "/");
	const packages = path.indexOf("/packages/");
	if (packages !== -1) return path.slice(packages + "/packages/".length);
	const modules = path.lastIndexOf("node_modules/");
	if (modules !== -1) return `nm/${path.slice(modules + "node_modules/".length)}`;
	return path.slice(path.lastIndexOf("/") + 1);
}

function hottestLine(stat: FrameStat): number {
	let line = stat.frame.line;
	let best = 0;
	for (const [candidate, count] of stat.lines) {
		if (count > best) {
			best = count;
			line = candidate;
		}
	}
	return line;
}

function formatFrame(stat: FrameStat): string {
	const name = stat.frame.name || "(anonymous)";
	if (stat.frame.url === "") return name;
	const line = hottestLine(stat);
	const path = shortenPath(stat.frame.url);
	return line === UNKNOWN_LINE || line <= 0 ? `${name} (${path})` : `${name} (${path}:${line})`;
}

/**
 * Names the code that dominated the last `blockedMs` of `samples` (oldest
 * first): the window ends at the newest sample. Frames are identified by
 * function name and source url, so samples on different lines of one function
 * count together. Returns undefined when the window holds no frame to name.
 */
export function summarizeBlock(samples: readonly LoopSample[], blockedMs: number): LoopBlockSummary | undefined {
	if (samples.length === 0) return undefined;
	const windowStart = samples[samples.length - 1]!.atMs - blockedMs;
	const stats = new Map<string, Map<string, FrameStat>>();
	const seen = new Set<FrameStat>();
	let windowSize = 0;
	for (let i = samples.length - 1; i >= 0; i--) {
		const sample = samples[i]!;
		if (sample.atMs < windowStart) break;
		windowSize++;
		seen.clear();
		const frames = sample.frames;
		let cause: FrameStat | undefined;
		let fallback: FrameStat | undefined;
		for (let j = 0; j < frames.length; j++) {
			const frame = frames[j]!;
			let byName = stats.get(frame.url);
			if (!byName) {
				byName = new Map();
				stats.set(frame.url, byName);
			}
			let stat = byName.get(frame.name);
			if (!stat) {
				stat = { frame, presence: 0, innermost: 0, depthSum: 0, lines: new Map() };
				byName.set(frame.name, stat);
			}
			if (!cause && !isNativeFrame(frame)) cause = stat;
			if (!fallback && frame.name !== "") fallback = stat;
			// Recursion: a function counts once per sample, at its innermost occurrence.
			if (seen.has(stat)) continue;
			seen.add(stat);
			stat.presence++;
			stat.depthSum += frames.length - 1 - j;
			stat.lines.set(frame.line, (stat.lines.get(frame.line) ?? 0) + 1);
		}
		const chosen = cause ?? fallback;
		if (chosen) chosen.innermost++;
	}

	let cause: FrameStat | undefined;
	for (const byName of stats.values()) {
		for (const stat of byName.values()) {
			if (stat.innermost > (cause?.innermost ?? 0)) cause = stat;
		}
	}
	if (!cause) return undefined;

	const callers: FrameStat[] = [];
	for (const byName of stats.values()) {
		for (const stat of byName.values()) {
			if (stat !== cause && !isNativeFrame(stat.frame) && stat.presence * 2 >= windowSize) callers.push(stat);
		}
	}
	callers.sort((a, b) => a.depthSum / a.presence - b.depthSum / b.presence);
	// Keep the entry point plus the callers nearest the cause: the entry says
	// which subsystem ran, the inner callers say what it was doing.
	const kept =
		callers.length > TOP_LIMIT ? [callers[0]!, ...callers.slice(callers.length - (TOP_LIMIT - 1))] : callers;
	const top = kept.map(stat => `${formatFrame(stat)} ${Math.round((stat.presence / windowSize) * 100)}%`);
	return { cause: formatFrame(cause), share: cause.presence / windowSize, top };
}
