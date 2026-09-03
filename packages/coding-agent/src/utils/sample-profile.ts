/**
 * Parser and renderer for macOS `/usr/bin/sample` call-tree reports
 * (conventionally saved as `*.sample.txt`).
 *
 * The raw report is a 10k+ line ASCII call tree with mangled symbols —
 * expensive for an agent to digest. `renderSampleProfile` converts it into a
 * compact bottleneck summary:
 *
 * - per-thread hot paths, pruned to frames with meaningful on-CPU samples,
 *   with pass-through chains collapsed and direct recursion flattened
 * - blocked/idle threads reduced to a one-line classification
 * - a process-wide "top functions by self samples" table
 * - Rust v0 and legacy symbols demangled (best-effort, path extraction)
 *
 * Consumed by the read tool: `*.sample.txt` reads show the summary, `:raw`
 * returns the original bytes.
 */

import { formatPct, mergeInto, type ProfileNode, type RenderTreeContext, renderProfileNode } from "./profile-tree";

/** Matches paths the read tool should treat as macOS sample reports. */
export function isSampleProfilePath(filePath: string): boolean {
	return /\.sample\.txt$/i.test(filePath);
}

/** Leaf symbols that mean "thread is parked in the kernel", not burning CPU. */
const WAIT_SYMBOLS: Record<string, true> = {
	__accept: true,
	__psynch_cvwait: true,
	__psynch_mutexwait: true,
	__psynch_rw_rdlock: true,
	__psynch_rw_wrlock: true,
	__recvfrom: true,
	__select: true,
	__semwait_signal: true,
	__sigwait: true,
	__ulock_wait: true,
	__ulock_wait2: true,
	__wait4: true,
	__workq_kernreturn: true,
	kevent: true,
	kevent64: true,
	kevent_qos: true,
	mach_msg2_trap: true,
	mach_msg_trap: true,
	poll: true,
	semaphore_timedwait_trap: true,
	semaphore_wait_trap: true,
	start_wqthread: true,
	swtch_pri: true,
	thread_suspend: true,
	usleep: true,
};

/** One frame in the sampled call tree. Counts are sample hits (subtree total). */
export interface SampleFrame {
	count: number;
	symbol: string;
	module?: string;
	children: SampleFrame[];
}

/** One sampled thread: `Thread_<id>` root plus its call tree. */
export interface SampleThread {
	id: string;
	name?: string;
	total: number;
	roots: SampleFrame[];
}

/** Metadata from the report preamble (everything before `Call graph:`). */
export interface SampleProfileHeader {
	process: string;
	pid: number;
	intervalMs: number;
	path?: string;
	codeType?: string;
	osVersion?: string;
	footprint?: string;
	footprintPeak?: string;
}

/** Parsed macOS sample report. */
export interface SampleProfile {
	header: SampleProfileHeader;
	threads: SampleThread[];
}

const ANALYSIS_RE = /^Analysis of sampling (.+?) \(pid (\d+)\) every (\d+) milliseconds?/;
const THREAD_RE = /^Thread_([^\s:]+):?\s*(.*)$/;

/**
 * Parse a macOS `sample` report. Returns null when the text does not look
 * like sample output (missing analysis preamble or `Call graph:` section).
 */
export function parseSampleProfile(text: string): SampleProfile | null {
	const lines = text.split("\n");
	const analysis = ANALYSIS_RE.exec(lines[0] ?? "");
	if (!analysis) return null;
	const callGraphIx = lines.indexOf("Call graph:");
	if (callGraphIx === -1) return null;

	const header: SampleProfileHeader = {
		process: analysis[1],
		pid: Number(analysis[2]),
		intervalMs: Number(analysis[3]),
	};
	for (const line of lines.slice(1, callGraphIx)) {
		const kv = /^([A-Za-z/ ()]+?):\s+(.*)$/.exec(line);
		if (!kv) continue;
		const value = kv[2].trim();
		switch (kv[1]) {
			case "Path":
				header.path = value;
				break;
			case "Code Type":
				header.codeType = value;
				break;
			case "OS Version":
				header.osVersion = value;
				break;
			case "Physical footprint":
				header.footprint = value;
				break;
			case "Physical footprint (peak)":
				header.footprintPeak = value;
				break;
		}
	}

	const threads: SampleThread[] = [];
	let thread: SampleThread | undefined;
	// Stack of (depth, frame) for the current thread; depth 1 = thread root frame.
	const stack: Array<{ depth: number; frame: SampleFrame }> = [];

	for (let ix = callGraphIx + 1; ix < lines.length; ix++) {
		const line = lines[ix];
		if (/^(Total number in stack|Sort by top of stack|Binary Images:)/.test(line)) break;
		if (!line.startsWith("    ")) continue;
		const body = line.slice(4);
		// Decorators are one char + one space per tree level (`+ ! : | `), so the
		// sample count starts at an even offset; scan pairs until the first digit.
		let p = 0;
		while (p < body.length && (body[p] < "0" || body[p] > "9")) p += 2;
		if (p >= body.length) continue;
		const depth = p / 2;
		const rest = /^(\d+)\s+(.*)$/.exec(body.slice(p));
		if (!rest) continue;
		const count = Number(rest[1]);
		const frameText = rest[2];

		if (depth === 0) {
			const tm = THREAD_RE.exec(frameText);
			if (!tm) continue;
			const name = tm[2].trim().replace(/\s+/g, " ");
			thread = { id: tm[1], name: name || undefined, total: count, roots: [] };
			threads.push(thread);
			stack.length = 0;
			continue;
		}
		if (!thread) continue;
		const frame: SampleFrame = { count, ...parseFrameText(frameText), children: [] };
		while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
		const siblings = stack.length > 0 ? stack[stack.length - 1].frame.children : thread.roots;
		siblings.push(frame);
		stack.push({ depth, frame });
	}

	if (threads.length === 0) return null;
	return { header, threads };
}

/** Split `symbol  (in module) + offsets  [addrs]` into symbol + module. */
function parseFrameText(text: string): { symbol: string; module?: string } {
	let s = text;
	const addrIx = s.lastIndexOf("  [");
	if (addrIx !== -1 && s.endsWith("]")) s = s.slice(0, addrIx);
	s = s.replace(/ \+ [0-9][0-9,.]*$/, "");
	const modIx = s.lastIndexOf("  (in ");
	if (modIx !== -1 && s.endsWith(")")) {
		return { symbol: s.slice(0, modIx).trim(), module: s.slice(modIx + 6, -1) };
	}
	return { symbol: s.trim() };
}

// ---------------------------------------------------------------------------
// Demangling
// ---------------------------------------------------------------------------

const LEGACY_ESCAPES: ReadonlyArray<[string, string]> = [
	["$LT$", "<"],
	["$GT$", ">"],
	["$RF$", "&"],
	["$BP$", "*"],
	["$C$", ","],
	["$u20$", " "],
	["$u27$", "'"],
	["$u7b$", "{"],
	["$u7d$", "}"],
	["..", "::"],
];

const IDENT_RE = /^[A-Za-z0-9_.$]+$/;
const LEGACY_HASH_RE = /^h[0-9a-f]{16}$/;

/**
 * Best-effort demangle of Rust symbols (v0 `_R…` and legacy `_ZN…E`).
 * For v0 this is a path extractor, not a full demangler: identifiers are
 * pulled out in order and joined with `::`, so generic arguments appear as
 * extra path segments. Non-Rust symbols pass through unchanged.
 */
export function demangleSymbol(raw: string): string {
	if (raw.startsWith("_R")) return demangleV0(raw) ?? raw;
	const legacy = /^_?_ZN(.*)$/.exec(raw);
	if (legacy) return demangleLegacy(legacy[1]) ?? raw;
	return raw;
}

function demangleV0(raw: string): string | null {
	const s = raw.slice(2);
	const parts: string[] = [];
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch >= "1" && ch <= "9") {
			let j = i;
			while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
			const len = Number(s.slice(i, j));
			// v0 inserts a `_` separator when the identifier starts with a digit or `_`.
			let k = j;
			if (s[k] === "_") k++;
			const ident = s.slice(k, k + len);
			if (ident.length === len && IDENT_RE.test(ident)) {
				parts.push(ident);
				i = k + len;
			} else {
				i = j;
			}
		} else if (ch === "s" || ch === "B") {
			// Disambiguator (`s<base62>_`) or backref (`B<base62>_`): skip.
			const m = /^[sB][0-9a-zA-Z]*_/.exec(s.slice(i));
			i += m ? m[0].length : 1;
		} else {
			i++;
		}
	}
	return parts.length > 0 ? parts.join("::") : null;
}

function demangleLegacy(s: string): string | null {
	const parts: string[] = [];
	let i = 0;
	while (i < s.length && s[i] >= "0" && s[i] <= "9") {
		let j = i;
		while (j < s.length && s[j] >= "0" && s[j] <= "9") j++;
		const len = Number(s.slice(i, j));
		const ident = s.slice(j, j + len);
		if (ident.length !== len) break;
		if (!LEGACY_HASH_RE.test(ident)) parts.push(unescapeLegacy(ident));
		i = j + len;
	}
	return parts.length > 0 ? parts.join("::") : null;
}

function unescapeLegacy(ident: string): string {
	let out = ident;
	for (const [from, to] of LEGACY_ESCAPES) out = out.replaceAll(from, to);
	return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Fraction of a thread's on-CPU samples a subtree needs to stay visible. */
const PRUNE_FRACTION = 0.02;
/** Threads with fewer on-CPU samples than this share of their total are "idle". */
const IDLE_FRACTION = 0.002;
const IDLE_MIN_SAMPLES = 10;
const TOP_FUNCTIONS = 20;

function selfOf(frame: SampleFrame): number {
	let children = 0;
	for (const child of frame.children) children += child.count;
	return Math.max(0, frame.count - children);
}

/**
 * Build a display node for a frame subtree: demangled label, on-CPU value
 * (self samples of non-wait frames), same-symbol siblings merged (`sample`
 * splits them by call-site offset, which only fragments hot totals).
 */
function buildProfileNode(frame: SampleFrame, demangleCache: Map<string, string>, mainModule: string): ProfileNode {
	let symbol = demangleCache.get(frame.symbol);
	if (symbol === undefined) {
		symbol = demangleSymbol(frame.symbol);
		demangleCache.set(frame.symbol, symbol);
	}
	const children: ProfileNode[] = [];
	for (const rawChild of frame.children) {
		const child = buildProfileNode(rawChild, demangleCache, mainModule);
		const existing = children.find(c => c.key === child.key);
		if (existing) mergeInto(existing, child);
		else children.push(child);
	}
	let cpu = WAIT_SYMBOLS[frame.symbol] ? 0 : selfOf(frame);
	for (const child of children) cpu += child.value;
	const label = frame.module && frame.module !== mainModule ? `${symbol} (${frame.module})` : symbol;
	return { key: symbol, label, value: cpu, recursion: 0, children };
}

/** Aggregate on-CPU self samples per demangled symbol across all threads. */
function aggregateSelf(
	profile: SampleProfile,
	demangleCache: Map<string, string>,
): Map<string, { cpu: number; module?: string }> {
	const totals = new Map<string, { cpu: number; module?: string }>();
	const visit = (frame: SampleFrame): void => {
		if (!WAIT_SYMBOLS[frame.symbol]) {
			const self = selfOf(frame);
			if (self > 0) {
				let symbol = demangleCache.get(frame.symbol);
				if (symbol === undefined) {
					symbol = demangleSymbol(frame.symbol);
					demangleCache.set(frame.symbol, symbol);
				}
				const entry = totals.get(symbol);
				if (entry) entry.cpu += self;
				else totals.set(symbol, { cpu: self, module: frame.module });
			}
		}
		for (const child of frame.children) visit(child);
	};
	for (const thread of profile.threads) for (const root of thread.roots) visit(root);
	return totals;
}

/** Dominant wait leaf of an idle thread ("what is it blocked on"). */
function dominantWait(thread: SampleThread): string | undefined {
	let best: { symbol: string; count: number } | undefined;
	const visit = (frame: SampleFrame): void => {
		if (frame.children.length === 0 && WAIT_SYMBOLS[frame.symbol]) {
			if (!best || frame.count > best.count) best = { symbol: frame.symbol, count: frame.count };
		}
		for (const child of frame.children) visit(child);
	};
	for (const root of thread.roots) visit(root);
	return best?.symbol;
}

/**
 * Render a macOS sample report as an agent-friendly bottleneck summary.
 * Returns null when `text` is not sample output (caller falls back to the
 * plain-text path).
 */
export function renderSampleProfile(text: string): string | null {
	const profile = parseSampleProfile(text);
	if (!profile) return null;
	const { header, threads } = profile;
	const demangleCache = new Map<string, string>();

	const annotated = threads.map(thread => {
		const roots = thread.roots.map(root => buildProfileNode(root, demangleCache, header.process));
		let cpu = 0;
		for (const root of roots) cpu += root.value;
		return { thread, roots, cpu };
	});
	const processCpu = annotated.reduce((sum, t) => sum + t.cpu, 0);
	const maxSamples = threads.reduce((max, t) => Math.max(max, t.total), 0);

	const out: string[] = [];
	out.push(`macOS sample profile: ${header.process} (pid ${header.pid}), sampled every ${header.intervalMs} ms`);
	const meta: string[] = [];
	if (header.path) meta.push(header.path);
	if (header.codeType) meta.push(header.codeType);
	if (header.osVersion) meta.push(`macOS ${header.osVersion.replace(/^macOS\s+/, "")}`);
	if (meta.length > 0) out.push(meta.join(" | "));
	const durationSec = (maxSamples * header.intervalMs) / 1000;
	let statLine = `Duration: ~${durationSec.toFixed(1)} s (${maxSamples} samples/thread)`;
	if (header.footprint) {
		statLine += ` | Footprint: ${header.footprint}${header.footprintPeak ? ` (peak ${header.footprintPeak})` : ""}`;
	}
	out.push(statLine);
	out.push("");
	out.push(
		`Process total: ${processCpu} on-CPU samples across ${threads.length} threads. Counts and percentages below are on-CPU samples (blocked time excluded).`,
	);

	const active: typeof annotated = [];
	const idle: typeof annotated = [];
	for (const entry of annotated) {
		const threshold = Math.max(IDLE_MIN_SAMPLES, entry.thread.total * IDLE_FRACTION);
		(entry.cpu >= threshold ? active : idle).push(entry);
	}
	active.sort((a, b) => b.cpu - a.cpu);

	for (const { thread, roots, cpu } of active) {
		out.push("");
		const title = thread.name ? `${thread.name} (Thread_${thread.id})` : `Thread_${thread.id}`;
		out.push(`## ${title} — ${thread.total} samples, ${cpu} on-CPU (${formatPct(cpu, thread.total)})`);
		const ctx: RenderTreeContext = {
			out,
			total: cpu,
			minValue: Math.max(3, Math.round(cpu * PRUNE_FRACTION)),
			formatValue: String,
			valueWidth: 6,
		};
		const kept = roots.filter(root => root.value >= ctx.minValue).sort((a, b) => b.value - a.value);
		for (const root of kept) renderProfileNode(root, 0, ctx);
		if (kept.length === 0) out.push(`  (no call path above ${ctx.minValue} on-CPU samples)`);
	}

	if (idle.length > 0) {
		out.push("");
		out.push(`## Idle / negligible threads (${idle.length})`);
		for (const { thread, cpu } of idle) {
			const title = thread.name ? `${thread.name} (Thread_${thread.id})` : `Thread_${thread.id}`;
			const wait = dominantWait(thread);
			const state = wait ? `blocked in ${wait} (${cpu} on-CPU)` : `${cpu}/${thread.total} samples on-CPU`;
			out.push(`- ${title}: ${state}`);
		}
	}

	const totals = [...aggregateSelf(profile, demangleCache).entries()].sort((a, b) => b[1].cpu - a[1].cpu);
	if (totals.length > 0) {
		out.push("");
		out.push("## Top functions by self samples (process-wide, blocked time excluded)");
		for (const [symbol, { cpu, module }] of totals.slice(0, TOP_FUNCTIONS)) {
			const suffix = module && module !== header.process ? ` (${module})` : "";
			out.push(`${String(cpu).padStart(6)} ${formatPct(cpu, processCpu).padStart(6)}  ${symbol}${suffix}`);
		}
	}

	out.push("");
	out.push("[Summarized view of a macOS `sample` call-tree report. Use ':raw' to read the original file.]");
	return out.join("\n");
}
