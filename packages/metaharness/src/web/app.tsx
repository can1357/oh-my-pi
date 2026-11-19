/**
 * metaharness dashboard.
 *
 * Views (hash-routed):
 *   #/            experiments index — runs grouped by job-name prefix
 *   #/exp/<id>    experiment detail — arm table, dithered comparison charts
 *                 (projected values for in-flight arms, dimmed), task matrix
 *   #/runs        flat run list (legacy view)
 *   #/runs/<name> run detail — normalized trace grid + live trace viewer
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ── api types (mirrors server modules) ──────────────────────────────────────

/** How a run relates to its experiment's question. */
type RunRole = "baseline" | "variant" | "";

interface RunRow {
	benchmark: "harbor" | "edit" | "snapcompact";
	jobName: string;
	dataset: string;
	agent: string;
	models: string;
	prewalk: string | null;
	config: Record<string, unknown>;
	role: RunRole;
	note: string;
	label: string;
	status: "running" | "complete" | "failed" | "cancelled";
	pid: number | null;
	createdAt: number;
	finishedAt: number | null;
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	costUsd: number;
	score: number | null;
	metrics: Record<string, number | null>;
}

interface TraceRow {
	name: string;
	task: string;
	status: string;
	reward: number | null;
	costUsd: number;
	durationMs: number;
	detail: string;
}

interface ArmProjection {
	etaMs: number | null;
	passPct: number;
	costPerTask: number;
	totalCostUsd: number;
	meanTrialMs: number;
}

interface ArmSummary {
	run: RunRow;
	arm: string;
	config: string;
	passPct: number | null;
	costPerTask: number | null;
	meanTrialMs: number | null;
	projected: ArmProjection | null;
}

interface ExperimentSummary {
	id: string;
	goal: string;
	arms: number;
	runningArms: number;
	datasets: string[];
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	costUsd: number;
	updatedAt: number;
}

interface ExperimentDetail {
	id: string;
	goal: string;
	arms: ArmSummary[];
	tasks: string[];
	matrix: Record<string, Record<string, { status: string; reward: number | null }>>;
}

interface TranscriptEntry {
	kind: string;
	model?: string;
	tool?: string;
	isError?: boolean;
	text?: string;
	tools?: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

const fmtUsd = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
const fmtMin = (ms: number) => `${(ms / 60000).toFixed(1)}m`;
const fmtEta = (etaMs: number | null) => {
	if (etaMs === null) return "—";
	const mins = Math.max(0, Math.round((etaMs - Date.now()) / 60000));
	return mins >= 90 ? `~${(mins / 60).toFixed(1)}h` : `~${mins}m`;
};

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return (await res.json()) as T;
}

function useHashRoute(): string {
	const [hash, setHash] = useState(location.hash || "#/");
	useEffect(() => {
		const onChange = () => setHash(location.hash || "#/");
		window.addEventListener("hashchange", onChange);
		return () => window.removeEventListener("hashchange", onChange);
	}, []);
	return hash;
}

/** Poll a JSON endpoint on an interval (SSE covers the run list; details poll).
 *  Returns the latest payload plus a manual refresh for after mutations. */
function usePolled<T>(url: string | null, intervalMs: number): [T | null, () => void] {
	const [data, setData] = useState<T | null>(null);
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		void nonce; // manual refresh dependency
		if (!url) return;
		let live = true;
		const load = () =>
			getJson<T>(url)
				.then(d => live && setData(d))
				.catch(() => {});
		load();
		const timer = setInterval(load, intervalMs);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [url, intervalMs, nonce]);
	const refresh = useCallback(() => setNonce(n => n + 1), []);
	return [data, refresh];
}

const INPUT_CLASS = "rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm";

const STATUS_CLASS: Record<string, string> = {
	running: "text-sky-400 border-sky-400",
	complete: "text-emerald-400 border-emerald-400",
	failed: "text-red-400 border-red-400",
	cancelled: "text-zinc-500 border-zinc-500",
	pass: "text-emerald-400 border-emerald-400",
	fail: "text-red-400 border-red-400",
	error: "text-amber-400 border-amber-400",
};

function Chip({ label }: { label: string }) {
	return (
		<span
			className={`inline-block rounded-full border px-2 text-xs leading-5 ${STATUS_CLASS[label] ?? "text-zinc-400 border-zinc-500"}`}
		>
			{label}
		</span>
	);
}

function Progress({
	run,
}: {
	run: RunRow | { pass: number; fail: number; error: number; running: number; done: number; nTotal: number };
}) {
	const total = Math.max(run.nTotal, run.done + run.running, 1);
	const seg = (n: number) => `${(100 * n) / total}%`;
	return (
		<span className="inline-flex items-center gap-2">
			<span className="inline-flex h-2 w-32 overflow-hidden rounded bg-zinc-800 align-middle">
				<i style={{ width: seg(run.pass) }} className="bg-emerald-500" />
				<i style={{ width: seg(Math.max(0, run.fail - run.error)) }} className="bg-red-500" />
				<i style={{ width: seg(run.error) }} className="bg-amber-500" />
				<i style={{ width: seg(run.running) }} className="bg-sky-500/60" />
			</span>
			<span className="text-xs text-zinc-500">
				{run.done}/{run.nTotal || "?"}
			</span>
		</span>
	);
}

// ── experiments index ────────────────────────────────────────────────────────

function ExperimentsIndex() {
	const [experiments] = usePolled<ExperimentSummary[]>("/api/experiments", 3000);
	if (!experiments) return <div className="p-10 text-zinc-500">loading…</div>;
	return (
		<div className="mx-auto grid max-w-5xl gap-3 p-6">
			{experiments.map(exp => (
				<a
					key={exp.id}
					href={`#/exp/${encodeURIComponent(exp.id)}`}
					className="flex min-w-0 items-center gap-6 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60 px-5 py-4 hover:border-zinc-600"
				>
					<div className="w-40 shrink-0">
						<div className="font-semibold">{exp.id}</div>
						<div className="text-xs text-zinc-500">
							{exp.arms} arm{exp.arms === 1 ? "" : "s"}
							{exp.runningArms > 0 && <span className="text-sky-400"> · {exp.runningArms} live</span>}
						</div>
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-xs text-zinc-400" title={exp.goal}>
							{exp.goal || "—"}
						</div>
						<div className="text-xs text-zinc-600">{exp.datasets.join(", ")}</div>
					</div>
					<Progress run={{ ...exp, running: 0 }} />
					<div className="ml-auto flex gap-6 text-sm">
						<span className="text-emerald-400">
							{exp.done > 0 ? `${Math.round((100 * exp.pass) / exp.done)}%` : "—"}
						</span>
						<span>{fmtUsd(exp.costUsd)}</span>
					</div>
				</a>
			))}
		</div>
	);
}

// ── experiment detail ────────────────────────────────────────────────────────

/** Display name for an arm: user-set label when present, else the jobName-derived arm. */
const armName = (a: ArmSummary) => a.run.label || a.arm;

/** Short task id for chips and the matrix: drops the dataset prefix and the `repo__` stutter. */
function shortTask(task: string): string {
	const base = task.slice(task.lastIndexOf("/") + 1);
	const us = base.lastIndexOf("__");
	return us >= 0 ? base.slice(us + 2) : base;
}

/** PUT experiment metadata: goal and/or per-run label/note/role. */
async function putExperimentMeta(
	id: string,
	body: { goal?: string; runs?: Record<string, { role?: RunRole; note?: string; label?: string }> },
): Promise<void> {
	const res = await fetch(`/api/experiments/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const out = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(out?.error ?? `save failed (${res.status})`);
	}
}

function RoleTag({ role }: { role: RunRole }) {
	return (
		<span
			className={`ml-2 rounded-full border px-1.5 text-[10px] ${role === "baseline" ? "border-sky-500 text-sky-400" : "border-emerald-600 text-emerald-400"}`}
		>
			{role}
		</span>
	);
}

// ── arm table sorting ────────────────────────────────────────────────────────

type SortKey = "arm" | "note" | "status" | "progress" | "eta" | "pass" | "cost" | "time";

interface SortSpec {
	key: SortKey;
	dir: 1 | -1;
}

/** First-click direction per column: metrics start at "best first". */
const SORT_START_DIR: Record<SortKey, 1 | -1> = {
	arm: 1,
	note: 1,
	status: 1,
	progress: -1,
	eta: 1,
	pass: -1,
	cost: 1,
	time: 1,
};

const STATUS_RANK: Record<string, number> = { running: 0, complete: 1, failed: 2, cancelled: 3 };

function armSortValue(a: ArmSummary, key: SortKey): string | number | null {
	switch (key) {
		case "arm":
			return armName(a).toLowerCase();
		case "note":
			return (a.run.note || a.config).toLowerCase();
		case "status":
			return STATUS_RANK[a.run.status] ?? 9;
		case "progress":
			return a.run.nTotal > 0 ? a.run.done / a.run.nTotal : a.run.done > 0 ? 0 : null;
		case "eta":
			return a.projected?.etaMs ?? null;
		case "pass":
			return a.passPct;
		case "cost":
			return a.costPerTask;
		case "time":
			return a.meanTrialMs;
	}
}

/** Sorted copy of the arms; null metric values always sink to the bottom. */
function sortedArms(arms: ArmSummary[], sort: SortSpec | null): ArmSummary[] {
	if (!sort) return arms;
	return [...arms].sort((x, y) => {
		const vx = armSortValue(x, sort.key);
		const vy = armSortValue(y, sort.key);
		if (vx === null || vy === null) return vx === null ? (vy === null ? 0 : 1) : -1;
		const cmp = typeof vx === "string" && typeof vy === "string" ? vx.localeCompare(vy) : Number(vx) - Number(vy);
		return sort.dir * cmp;
	});
}

/** Sortable column header; click cycles best-first → reversed → default order. */
function SortHeader({
	label,
	col,
	sort,
	onSort,
}: {
	label: string;
	col: SortKey;
	sort: SortSpec | null;
	onSort: (col: SortKey) => void;
}) {
	const dir = sort !== null && sort.key === col ? sort.dir : null;
	return (
		<th className="py-1 pr-4" aria-sort={dir === null ? undefined : dir === 1 ? "ascending" : "descending"}>
			<button
				type="button"
				onClick={() => onSort(col)}
				title={`sort by ${label}`}
				className={`inline-flex items-center gap-1 hover:text-zinc-200 ${dir === null ? "" : "text-zinc-200"}`}
			>
				{label}
				<span aria-hidden="true" className={`text-[8px] ${dir === null ? "text-zinc-700" : "text-sky-400"}`}>
					{dir === null ? "↕" : dir === 1 ? "▲" : "▼"}
				</span>
			</button>
		</th>
	);
}

// ── arm comparison (focus mode) ──────────────────────────────────────────────

/** Trial statuses that count as decided when comparing arms (error = fail). */
function isDecided(s: string | undefined): s is string {
	return s === "pass" || s === "fail" || s === "error";
}

interface TaskStat {
	passes: number;
	decided: number;
	/** Display names of the arms that passed the task. */
	passedBy: string[];
}

function computeTaskStats(
	arms: ArmSummary[],
	matrix: ExperimentDetail["matrix"],
	tasks: string[],
): Map<string, TaskStat> {
	const stats = new Map<string, TaskStat>();
	for (const task of tasks) stats.set(task, { passes: 0, decided: 0, passedBy: [] });
	for (const arm of arms) {
		const cells = matrix[arm.arm] ?? {};
		for (const task of tasks) {
			const status = cells[task]?.status;
			if (!isDecided(status)) continue;
			const stat = stats.get(task);
			if (!stat) continue;
			stat.decided++;
			if (status === "pass") {
				stat.passes++;
				stat.passedBy.push(armName(arm));
			}
		}
	}
	return stats;
}

interface HeadToHead {
	arm: ArmSummary;
	/** Tasks the focused arm passed that this arm decided and failed. */
	focusWins: number;
	/** Tasks this arm passed that the focused arm decided and failed. */
	armWins: number;
	bothPass: number;
	bothFail: number;
	shared: number;
}

function headToHead(
	focusCells: Record<string, { status: string; reward: number | null }>,
	arm: ArmSummary,
	cells: Record<string, { status: string; reward: number | null }>,
	tasks: string[],
): HeadToHead {
	let focusWins = 0;
	let armWins = 0;
	let bothPass = 0;
	let bothFail = 0;
	for (const task of tasks) {
		const f = focusCells[task]?.status;
		const o = cells[task]?.status;
		if (!isDecided(f) || !isDecided(o)) continue;
		const fPass = f === "pass";
		const oPass = o === "pass";
		if (fPass && oPass) bothPass++;
		else if (fPass) focusWins++;
		else if (oPass) armWins++;
		else bothFail++;
	}
	return { arm, focusWins, armWins, bothPass, bothFail, shared: focusWins + armWins + bothPass + bothFail };
}

// ── charts ───────────────────────────────────────────────────────────────────

/** One horizontal bar per arm; running arms chart their projected value. */
interface MetricBar {
	key: string;
	label: string;
	role: RunRole;
	/** Value is a projection (arm still running) rather than a final observation. */
	projected: boolean;
	value: number;
}

function metricBars(
	arms: ArmSummary[],
	actual: (arm: ArmSummary) => number | null,
	projected: (proj: ArmProjection) => number,
): MetricBar[] {
	const bars: MetricBar[] = [];
	for (const arm of arms) {
		const proj = arm.run.status === "running" ? arm.projected : null;
		const value = proj ? projected(proj) : actual(arm);
		if (value === null) continue;
		bars.push({ key: arm.arm, label: armName(arm), role: arm.run.role, projected: proj !== null, value });
	}
	return bars;
}

const BAR_FILL: Record<RunRole, string> = {
	baseline: "bg-sky-500/85",
	variant: "bg-emerald-500/85",
	"": "bg-zinc-500/85",
};

const BAR_PROJECTED: Record<RunRole, string> = {
	baseline: "border border-dashed border-sky-400/70 bg-sky-400/15",
	variant: "border border-dashed border-emerald-400/70 bg-emerald-400/15",
	"": "border border-dashed border-zinc-400/70 bg-zinc-400/15",
};

/** Named horizontal bars, best value first, with a dashed tick at the anchor value. */
function BarChart({
	title,
	bars,
	best,
	format,
	anchor,
	focus,
	onFocus,
}: {
	title: string;
	bars: MetricBar[];
	best: "high" | "low";
	format: (v: number) => string;
	anchor: number | null;
	focus: string | null;
	onFocus: (key: string) => void;
}) {
	const sorted = [...bars].sort((a, b) => (best === "high" ? b.value - a.value : a.value - b.value));
	const max = Math.max(...bars.map(b => b.value), anchor ?? 0);
	const anchorLeft = anchor !== null && max > 0 ? Math.min((100 * anchor) / max, 100) : null;
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
			<div className="mb-2 flex items-baseline justify-between">
				<h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</h3>
				<span className="text-[9px] text-zinc-600">
					{best === "high" ? "higher is better" : "lower is better"} · best first
				</span>
			</div>
			{sorted.length === 0 ? (
				<div className="py-6 text-center text-xs text-zinc-600">no decided trials yet</div>
			) : (
				<div className="flex flex-col gap-px">
					{sorted.map(b => {
						const focusedBar = focus === b.key;
						const dim = focus !== null && !focusedBar;
						return (
							<button
								key={b.key}
								type="button"
								onClick={() => onFocus(b.key)}
								title={`${b.label} · ${format(b.value)}${b.projected ? " (projected)" : ""} — click to ${focusedBar ? "unfocus" : "focus"}`}
								className={`grid w-full grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)_4rem] items-center gap-x-2 rounded px-1 py-[2.5px] text-left hover:bg-zinc-800/50 ${dim ? "opacity-40" : ""}`}
							>
								<span
									className={`truncate text-right text-[11px] ${focusedBar ? "text-sky-300" : "text-zinc-400"}`}
								>
									{b.label}
								</span>
								<span className="relative h-[13px] overflow-hidden rounded-[2px] bg-zinc-800/60">
									<span
										className={`absolute inset-y-0 left-0 rounded-[2px] ${b.projected ? BAR_PROJECTED[b.role] : BAR_FILL[b.role]}`}
										style={{ width: `${max > 0 ? (100 * b.value) / max : 0}%` }}
									/>
									{anchorLeft !== null && (
										<span
											aria-hidden="true"
											className="absolute inset-y-0 border-l border-dashed border-zinc-300/70"
											style={{ left: `calc(${anchorLeft}% - ${anchorLeft > 99 ? 1 : 0}px)` }}
										/>
									)}
								</span>
								<span className="text-[10px] tabular-nums text-zinc-400">
									{b.projected && <span className="text-zinc-600">→</span>}
									{format(b.value)}
								</span>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** Width of a container tracked through resizes; charts render in pixel space. */
function useMeasuredWidth(): [RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}

interface ScatterPt {
	key: string;
	label: string;
	role: RunRole;
	/** Values are linear projections (arm still running). */
	projected: boolean;
	cost: number;
	pass: number;
}

const DOT_COLOR: Record<RunRole, string> = { baseline: "#38bdf8", variant: "#34d399", "": "#a1a1aa" };

interface LabelBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

const boxesOverlap = (a: LabelBox, b: LabelBox): boolean =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Greedy point-label placement: right → left → above → below; the first spot
 *  that stays inside the plot and clears every earlier label + dot wins. */
function placeLabels(
	pts: Array<{ key: string; label: string; px: number; py: number }>,
	plot: { x0: number; y0: number; x1: number; y1: number },
): Map<string, { lx: number; ly: number; anchor: "start" | "middle" | "end" }> {
	const placed: LabelBox[] = pts.map(p => ({ x: p.px - 6, y: p.py - 6, w: 12, h: 12 }));
	const out = new Map<string, { lx: number; ly: number; anchor: "start" | "middle" | "end" }>();
	for (const p of [...pts].sort((a, b) => a.py - b.py)) {
		const w = p.label.length * 5.8 + 4;
		const h = 11;
		const candidates: Array<{ lx: number; ly: number; anchor: "start" | "middle" | "end"; box: LabelBox }> = [
			{ lx: p.px + 8, ly: p.py + 3, anchor: "start", box: { x: p.px + 8, y: p.py - 5.5, w, h } },
			{ lx: p.px - 8, ly: p.py + 3, anchor: "end", box: { x: p.px - 8 - w, y: p.py - 5.5, w, h } },
			{ lx: p.px, ly: p.py - 9, anchor: "middle", box: { x: p.px - w / 2, y: p.py - 17, w, h } },
			{ lx: p.px, ly: p.py + 15, anchor: "middle", box: { x: p.px - w / 2, y: p.py + 7, w, h } },
		];
		let chosen = candidates[0];
		for (const c of candidates) {
			if (c.box.x < plot.x0 || c.box.x + c.box.w > plot.x1 || c.box.y < plot.y0 || c.box.y + c.box.h > plot.y1)
				continue;
			if (placed.some(b => boxesOverlap(b, c.box))) continue;
			chosen = c;
			break;
		}
		placed.push(chosen.box);
		out.set(p.key, chosen);
	}
	return out;
}

/** Cost-vs-success tradeoff, one labelled point per arm; the anchor arm gets
 *  crosshairs so "cheaper & better" reads as a quadrant. */
function ScatterChart({
	pts,
	anchor,
	focus,
	onFocus,
}: {
	pts: ScatterPt[];
	anchor: ScatterPt | null;
	focus: string | null;
	onFocus: (key: string) => void;
}) {
	const [ref, width] = useMeasuredWidth();
	const H = 268;
	const m = { l: 46, r: 14, t: 12, b: 30 };
	const maxCost = Math.max(...pts.map(p => p.cost), 0.01) * 1.12;
	const passVals = pts.length > 0 ? pts.map(p => p.pass) : [0, 100];
	const passLo = Math.max(0, Math.min(...passVals) - 8);
	const passHi = Math.min(100, Math.max(...passVals) + 8);
	const x = (c: number) => m.l + (c / maxCost) * Math.max(width - m.l - m.r, 1);
	const y = (p: number) => m.t + (1 - (p - passLo) / Math.max(passHi - passLo, 1e-9)) * (H - m.t - m.b);
	const labels = placeLabels(
		pts.map(p => ({ key: p.key, label: p.label, px: x(p.cost), py: y(p.pass) })),
		{ x0: 2, y0: 2, x1: Math.max(width - 2, 4), y1: H - 16 },
	);
	return (
		<div ref={ref} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
			<div className="mb-1 flex items-baseline justify-between">
				<h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">cost vs success</h3>
				<span className="text-[9px] text-zinc-600">↖ cheaper &amp; better</span>
			</div>
			{pts.length === 0 || width === 0 ? (
				<div className="flex h-[268px] items-center justify-center text-xs text-zinc-600">
					no decided trials yet
				</div>
			) : (
				<svg width={width} height={H} role="img" aria-label="pass rate versus cost per task; one point per arm">
					{[0, 1 / 3, 2 / 3, 1].map(f => {
						const v = passLo + f * (passHi - passLo);
						return (
							<g key={`y${f}`}>
								<line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke="#27272a" strokeDasharray="3,3" />
								<text x={m.l - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#71717a">
									{v.toFixed(0)}%
								</text>
							</g>
						);
					})}
					{[0.25, 0.5, 0.75, 1].map(f => {
						const v = f * maxCost;
						return (
							<g key={`x${f}`}>
								<line x1={x(v)} x2={x(v)} y1={m.t} y2={H - m.b} stroke="#27272a" strokeDasharray="3,3" />
								<text x={x(v)} y={H - m.b + 12} textAnchor="middle" fontSize={9} fill="#71717a">
									{fmtUsd(v)}
								</text>
							</g>
						);
					})}
					{anchor && (
						<g stroke="#52525b" strokeDasharray="2,3">
							<line x1={x(anchor.cost)} x2={x(anchor.cost)} y1={m.t} y2={H - m.b} />
							<line x1={m.l} x2={width - m.r} y1={y(anchor.pass)} y2={y(anchor.pass)} />
						</g>
					)}
					{pts.map(p => {
						const px = x(p.cost);
						const py = y(p.pass);
						const focusedPt = focus === p.key;
						const dim = focus !== null && !focusedPt;
						const color = DOT_COLOR[p.role];
						const lab = labels.get(p.key);
						return (
							<g
								key={p.key}
								role="button"
								tabIndex={0}
								aria-label={`focus ${p.label}`}
								opacity={dim ? 0.35 : 1}
								className="cursor-pointer focus:outline-none"
								onClick={() => onFocus(p.key)}
								onKeyDown={ev => {
									if (ev.key === "Enter" || ev.key === " ") {
										ev.preventDefault();
										onFocus(p.key);
									}
								}}
							>
								<title>{`${p.label} · ${p.pass.toFixed(0)}% · ${fmtUsd(p.cost)}/task${p.projected ? " (projected)" : ""}`}</title>
								<circle cx={px} cy={py} r={10} fill="transparent" />
								{focusedPt && <circle cx={px} cy={py} r={8} fill="none" stroke="#7dd3fc" />}
								{p.projected ? (
									<circle
										cx={px}
										cy={py}
										r={4.5}
										fill="none"
										stroke={color}
										strokeWidth={1.5}
										strokeDasharray="2,2"
									/>
								) : (
									<circle cx={px} cy={py} r={4.5} fill={color} fillOpacity={0.92} />
								)}
								{lab && (
									<text
										x={lab.lx}
										y={lab.ly}
										textAnchor={lab.anchor}
										fontSize={9.5}
										fill={focusedPt ? "#bae6fd" : "#a1a1aa"}
									>
										{p.label}
									</text>
								)}
							</g>
						);
					})}
				</svg>
			)}
		</div>
	);
}

const CELL_CLASS: Record<string, string> = {
	pass: "bg-emerald-500",
	fail: "bg-red-500",
	error: "bg-amber-500",
	running: "bg-sky-500 animate-pulse",
};

/**
 * The comparison anchor for an experiment: the completed baseline arm with the
 * highest pass rate (the "ceiling" a prewalk arm tries to preserve). Ties
 * break toward the cheaper arm. Returns null when no baseline has finished data.
 */
function pickReferenceArm(arms: ArmSummary[]): ArmSummary | null {
	let ref: ArmSummary | null = null;
	for (const a of arms) {
		if (a.run.role !== "baseline" || a.passPct === null) continue;
		if (
			ref === null ||
			a.passPct > (ref.passPct ?? -1) ||
			(a.passPct === ref.passPct && (a.costPerTask ?? Infinity) < (ref.costPerTask ?? Infinity))
		) {
			ref = a;
		}
	}
	return ref;
}

/**
 * Signed, colour-coded offset of a metric from the reference arm. `points`
 * shows absolute percentage-point difference (pass rate); `relative` shows a
 * percentage change (cost, time). `higherBetter` decides which direction is green.
 */
function Delta({
	value,
	reference,
	mode,
	higherBetter,
}: {
	value: number | null;
	reference: number | null;
	mode: "points" | "relative";
	higherBetter: boolean;
}) {
	if (value === null || reference === null) return null;
	const raw =
		mode === "points" ? value - reference : reference === 0 ? Number.NaN : ((value - reference) / reference) * 100;
	if (!Number.isFinite(raw) || Math.abs(raw) < 0.5) {
		return <span className="ml-1 text-[10px] text-zinc-600">≈</span>;
	}
	const good = higherBetter ? raw > 0 : raw < 0;
	const body = `${raw > 0 ? "+" : "−"}${Math.abs(raw).toFixed(0)}${mode === "relative" ? "%" : ""}`;
	return (
		<span className={`ml-1 whitespace-nowrap text-[10px] ${good ? "text-emerald-500" : "text-red-400"}`}>
			({body})
		</span>
	);
}

/**
 * Launch a new arm into an existing experiment. The server inherits the
 * experiment's dataset and exact task sample from a sibling arm, so only the
 * arm-specific knobs (name, model, role, note, optional prewalk) are collected here.
 */
function AddArmForm({ experimentId, onDone }: { experimentId: string; onDone: () => void }) {
	const [msg, setMsg] = useState("");
	const submit = useCallback(
		async (ev: React.FormEvent<HTMLFormElement>) => {
			ev.preventDefault();
			const f = new FormData(ev.currentTarget);
			const body: Record<string, unknown> = { arm: f.get("arm"), model: f.get("model") };
			if (f.get("role")) body.role = f.get("role");
			if (f.get("note")) body.note = f.get("note");
			if (f.get("prewalkInto") || f.get("prewalk")) {
				body.prewalk = f.get("prewalkInto") ? { into: f.get("prewalkInto") } : {};
			}
			setMsg("launching…");
			const res = await fetch(`/api/experiments/${encodeURIComponent(experimentId)}/arms`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const out = (await res.json()) as { jobName?: string; error?: string };
			setMsg(res.ok ? `launched ${out.jobName}` : `error: ${out.error}`);
			if (res.ok) setTimeout(onDone, 900);
		},
		[experimentId, onDone],
	);
	return (
		<form
			onSubmit={submit}
			className="mb-4 grid grid-cols-4 gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm"
		>
			<input name="arm" placeholder="arm name (e.g. opus48)" required className={INPUT_CLASS} />
			<input name="model" placeholder="model (provider/model)" required className={INPUT_CLASS} />
			<select name="role" className={INPUT_CLASS} defaultValue="">
				<option value="">role: unset</option>
				<option value="baseline">baseline</option>
				<option value="variant">variant</option>
			</select>
			<input name="note" placeholder="note (what this arm tests)" className={INPUT_CLASS} />
			<input name="prewalkInto" placeholder="prewalk into (model, optional)" className={INPUT_CLASS} />
			<label className="flex items-center gap-1 text-xs text-zinc-400">
				<input type="checkbox" name="prewalk" /> prewalk (default smol)
			</label>
			<div className="col-span-4 flex items-center gap-3">
				<button type="submit" className="rounded border border-zinc-600 px-3 py-1 hover:border-sky-400">
					launch arm
				</button>
				<span className="text-xs text-zinc-500">inherits dataset + task sample from existing arms · {msg}</span>
			</div>
		</form>
	);
}

/** Inline editor for the experiment's goal/description. */
function GoalEditor({ id, goal, onSaved }: { id: string; goal: string; onSaved: () => void }) {
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	if (!editing) {
		return (
			<div className="group mb-4 flex max-w-4xl items-start gap-2">
				<p className={`text-sm ${goal ? "text-zinc-400" : "text-zinc-600"}`}>{goal || "no description"}</p>
				<button
					type="button"
					onClick={() => setEditing(true)}
					aria-label="edit experiment description"
					title="edit description"
					className="rounded px-1 text-xs text-zinc-600 opacity-0 transition-opacity hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
				>
					✎
				</button>
			</div>
		);
	}
	const save = async (form: HTMLFormElement) => {
		const f = new FormData(form);
		setBusy(true);
		setErr("");
		try {
			await putExperimentMeta(id, { goal: String(f.get("goal") ?? "").trim() });
			onSaved();
			setEditing(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="mb-4 max-w-4xl"
			onSubmit={ev => {
				ev.preventDefault();
				void save(ev.currentTarget);
			}}
			onKeyDown={ev => {
				if (ev.key === "Escape") setEditing(false);
				if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
					ev.preventDefault();
					void save(ev.currentTarget);
				}
			}}
		>
			<textarea
				name="goal"
				defaultValue={goal}
				rows={3}
				autoFocus
				placeholder="what question does this experiment answer?…"
				className={`${INPUT_CLASS} w-full`}
			/>
			<div className="mt-1 flex items-center gap-2 text-xs">
				<button
					type="submit"
					disabled={busy}
					className="rounded border border-zinc-600 px-2 py-0.5 hover:border-sky-400"
				>
					{busy ? "saving…" : "save"}
				</button>
				<button
					type="button"
					onClick={() => setEditing(false)}
					className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:border-zinc-500"
				>
					cancel
				</button>
				<span className="text-zinc-600">⌘↵ save · esc cancel</span>
				{err && <span className="text-red-400">{err}</span>}
			</div>
		</form>
	);
}

/** Full-width row editor for one arm's display name, role, and description. */
function ArmEditorRow({
	arm,
	experimentId,
	onSaved,
	onCancel,
}: {
	arm: ArmSummary;
	experimentId: string;
	onSaved: () => void;
	onCancel: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const save = async (form: HTMLFormElement) => {
		const f = new FormData(form);
		setBusy(true);
		setErr("");
		try {
			await putExperimentMeta(experimentId, {
				runs: {
					[arm.run.jobName]: {
						label: String(f.get("label") ?? "").trim(),
						note: String(f.get("note") ?? "").trim(),
						role: String(f.get("role") ?? "") as RunRole,
					},
				},
			});
			onSaved();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	return (
		<tr className="border-t border-zinc-800/70 bg-zinc-900/70">
			<td colSpan={9} className="px-1 py-2">
				<form
					className="flex flex-wrap items-center gap-2 text-sm"
					onSubmit={ev => {
						ev.preventDefault();
						void save(ev.currentTarget);
					}}
					onKeyDown={ev => {
						if (ev.key === "Escape") onCancel();
					}}
				>
					<label className="flex items-center gap-1.5 text-xs text-zinc-500">
						name
						<input
							name="label"
							defaultValue={arm.run.label}
							placeholder={arm.run.jobName.slice(arm.run.jobName.indexOf("-") + 1)}
							autoFocus
							spellCheck={false}
							className={`${INPUT_CLASS} w-44`}
						/>
					</label>
					<label className="flex items-center gap-1.5 text-xs text-zinc-500">
						role
						<select name="role" defaultValue={arm.run.role} className={INPUT_CLASS}>
							<option value="">unset</option>
							<option value="baseline">baseline</option>
							<option value="variant">variant</option>
						</select>
					</label>
					<label className="flex min-w-64 flex-1 items-center gap-1.5 text-xs text-zinc-500">
						description
						<input
							name="note"
							defaultValue={arm.run.note}
							placeholder="what does this arm test?…"
							className={`${INPUT_CLASS} w-full`}
						/>
					</label>
					<button
						type="submit"
						disabled={busy}
						className="rounded border border-zinc-600 px-2 py-1 text-xs hover:border-sky-400"
					>
						{busy ? "saving…" : "save"}
					</button>
					<button
						type="button"
						onClick={onCancel}
						className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-500"
					>
						cancel
					</button>
					<span className="w-full text-[10px] text-zinc-600">
						display name only — job dir stays <span className="text-zinc-500">{arm.run.jobName}</span>
						{err && <span className="ml-2 text-red-400">{err}</span>}
					</span>
				</form>
			</td>
		</tr>
	);
}

/** One arm row: click to focus, hover reveals the metadata editor trigger. */
function ArmRow({
	arm,
	anchor,
	focused,
	onFocus,
	onEdit,
}: {
	arm: ArmSummary;
	anchor: ArmSummary | null;
	focused: boolean;
	onFocus: () => void;
	onEdit: () => void;
}) {
	const isAnchor = anchor?.arm === arm.arm;
	return (
		<tr
			onClick={ev => {
				if ((ev.target as HTMLElement).closest("a,button,input,select,textarea")) return;
				onFocus();
			}}
			className={`group cursor-pointer border-t border-zinc-800/70 ${focused ? "bg-sky-400/[0.07]" : "hover:bg-zinc-900/60"}`}
		>
			<td className="py-1.5 pr-4 font-medium">
				<button
					type="button"
					onClick={onFocus}
					title={focused ? "clear focus" : "focus this arm to compare it against the others"}
					className={`text-left hover:text-sky-300 ${focused ? "text-sky-300" : ""}`}
				>
					{armName(arm)}
				</button>
				{arm.run.label && (
					<span className="ml-1.5 text-[10px] text-zinc-600" title={`job ${arm.run.jobName}`}>
						{arm.run.jobName.slice(arm.run.jobName.indexOf("-") + 1)}
					</span>
				)}
				{arm.run.role && <RoleTag role={arm.run.role} />}
				{isAnchor && !focused && (
					<span
						className="ml-1 text-[10px] text-zinc-500"
						title="reference arm (highest-pass baseline); deltas are measured against it"
					>
						ref
					</span>
				)}
			</td>
			<td className="max-w-md truncate pr-4 text-xs text-zinc-400" title={`${arm.run.note} · ${arm.config}`}>
				{arm.run.note || arm.config || "—"}
			</td>
			<td className="pr-4">
				<Chip label={arm.run.status} />
			</td>
			<td className="pr-4">
				<Progress run={arm.run} />
			</td>
			<td className="pr-4 text-sky-300">{arm.projected ? fmtEta(arm.projected.etaMs) : "—"}</td>
			<td className="pr-4 tabular-nums">
				{arm.passPct !== null ? `${arm.passPct.toFixed(0)}%` : "—"}
				{arm.projected && <span className="text-zinc-500"> →{arm.projected.passPct.toFixed(0)}%</span>}
				{anchor && !isAnchor && <Delta value={arm.passPct} reference={anchor.passPct} mode="points" higherBetter />}
			</td>
			<td className="pr-4 tabular-nums">
				{arm.costPerTask !== null ? fmtUsd(arm.costPerTask) : "—"}
				{arm.projected && <span className="text-zinc-500"> Σ{fmtUsd(arm.projected.totalCostUsd)}</span>}
				{anchor && !isAnchor && (
					<Delta value={arm.costPerTask} reference={anchor.costPerTask} mode="relative" higherBetter={false} />
				)}
			</td>
			<td className="pr-4 tabular-nums">
				{arm.meanTrialMs !== null ? fmtMin(arm.meanTrialMs) : "—"}
				{anchor && !isAnchor && (
					<Delta value={arm.meanTrialMs} reference={anchor.meanTrialMs} mode="relative" higherBetter={false} />
				)}
			</td>
			<td className="whitespace-nowrap py-1.5 text-right">
				<button
					type="button"
					onClick={onEdit}
					aria-label={`edit ${armName(arm)} name and description`}
					title="rename · describe · set role"
					className="mr-2 rounded px-1 text-xs text-zinc-500 opacity-0 transition-opacity hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
				>
					✎
				</button>
				<a
					className="text-xs text-zinc-500 underline hover:text-zinc-300"
					href={`#/runs/${encodeURIComponent(arm.run.jobName)}`}
				>
					trials
				</a>
			</td>
		</tr>
	);
}

/** Ordinal standing of the focused arm among arms with data, e.g. "#2/9 by pass%". */
function rankLine(arms: ArmSummary[], focus: ArmSummary): string {
	const rank = (metric: (a: ArmSummary) => number | null, best: "high" | "low"): string => {
		const values = arms.map(metric).filter((v): v is number => v !== null);
		const own = metric(focus);
		if (own === null || values.length === 0) return "—";
		values.sort((a, b) => (best === "high" ? b - a : a - b));
		return `#${values.indexOf(own) + 1}/${values.length}`;
	};
	return `${rank(a => a.passPct, "high")} by pass% · ${rank(a => a.costPerTask, "low")} by $/task`;
}

/** Task chips for the focus panel (winnable misses / unique wins). */
function TaskChips({
	heading,
	items,
	tone,
	jobName,
	empty,
}: {
	heading: string;
	items: Array<{ task: string; title: string; badge?: string }>;
	tone: "fail" | "win";
	jobName: string;
	empty: string;
}) {
	return (
		<div className="mb-4">
			<div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
				{heading} <span className="text-zinc-600 normal-case">({items.length})</span>
			</div>
			{items.length === 0 ? (
				<div className="text-xs text-zinc-600">{empty}</div>
			) : (
				<div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">
					{items.map(item => (
						<a
							key={item.task}
							href={`#/runs/${encodeURIComponent(jobName)}`}
							title={`${item.task} — ${item.title}`}
							className={`rounded border px-1.5 py-0.5 text-[11px] ${
								tone === "fail"
									? "border-red-500/30 text-red-300/90 hover:border-red-400"
									: "border-emerald-500/30 text-emerald-300/90 hover:border-emerald-400"
							}`}
						>
							{shortTask(item.task)}
							{item.badge && <span className="ml-1 text-[9px] text-zinc-500">{item.badge}</span>}
						</a>
					))}
				</div>
			)}
		</div>
	);
}

/** Focused-arm drilldown: head-to-head vs every sibling plus the task sets
 *  that separate them (winnable misses, unique wins). */
function FocusPanel({
	arms,
	matrix,
	tasks,
	taskStats,
	focus,
	onFocus,
	onClear,
}: {
	arms: ArmSummary[];
	matrix: ExperimentDetail["matrix"];
	tasks: string[];
	taskStats: Map<string, TaskStat>;
	focus: ArmSummary;
	onFocus: (key: string) => void;
	onClear: () => void;
}) {
	const name = armName(focus);
	const focusCells = matrix[focus.arm] ?? {};
	const rivals = arms
		.filter(a => a.arm !== focus.arm)
		.map(a => headToHead(focusCells, a, matrix[a.arm] ?? {}, tasks))
		.sort((a, b) => b.armWins - b.focusWins - (a.armWins - a.focusWins));
	const fumbles: Array<{ task: string; passedBy: string[] }> = [];
	const uniques: string[] = [];
	for (const task of tasks) {
		const own = focusCells[task]?.status;
		if (!isDecided(own)) continue;
		const stat = taskStats.get(task);
		if (!stat) continue;
		if (own === "pass") {
			if (stat.passes === 1 && stat.decided > 1) uniques.push(task);
		} else if (stat.passes > 0) {
			fumbles.push({ task, passedBy: stat.passedBy });
		}
	}
	return (
		<section className="mb-6 rounded-lg border border-sky-500/25 bg-zinc-900/60 p-4">
			<div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h3 className="font-semibold text-sky-300">◉ {name}</h3>
				{focus.run.role && <RoleTag role={focus.run.role} />}
				<span className="text-xs text-zinc-500">{rankLine(arms, focus)}</span>
				<a
					href={`#/runs/${encodeURIComponent(focus.run.jobName)}`}
					className="text-xs text-zinc-500 underline hover:text-zinc-300"
				>
					trials
				</a>
				<button
					type="button"
					onClick={onClear}
					className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
				>
					clear focus
				</button>
			</div>
			<div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
				<div>
					<div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">head-to-head</div>
					<div className="mb-1.5 text-[10px] text-zinc-600">
						first mark = {name} · over tasks both arms decided · error counts as fail
					</div>
					<table className="w-full text-xs">
						<thead>
							<tr className="text-left text-[10px] text-zinc-600">
								<th className="py-0.5 pr-2 font-normal">vs</th>
								<th className="pr-2 font-normal" title="wins minus losses for the focused arm">
									net
								</th>
								<th className="pr-2 font-normal" title={`${name} passed · rival failed`}>
									✓·✗
								</th>
								<th className="pr-2 font-normal" title={`rival passed · ${name} failed`}>
									✗·✓
								</th>
								<th className="pr-2 font-normal" title="both passed">
									✓·✓
								</th>
								<th className="pr-2 font-normal" title="both failed">
									✗·✗
								</th>
							</tr>
						</thead>
						<tbody>
							{rivals.map(r => {
								const net = r.focusWins - r.armWins;
								return (
									<tr key={r.arm.arm} className="border-t border-zinc-800/60">
										<td className="py-1 pr-2">
											<button
												type="button"
												onClick={() => onFocus(r.arm.arm)}
												title={`switch focus to ${armName(r.arm)}`}
												className="underline decoration-zinc-700 underline-offset-2 hover:text-sky-300"
											>
												{armName(r.arm)}
											</button>
										</td>
										{r.shared === 0 ? (
											<td colSpan={5} className="pr-2 text-zinc-600">
												no shared decided tasks yet
											</td>
										) : (
											<>
												<td
													className={`pr-2 tabular-nums ${net > 0 ? "text-emerald-400" : net < 0 ? "text-red-400" : "text-zinc-500"}`}
												>
													{net > 0 ? `+${net}` : net}
												</td>
												<td className="pr-2 tabular-nums text-emerald-500">{r.focusWins}</td>
												<td className="pr-2 tabular-nums text-red-400">{r.armWins}</td>
												<td className="pr-2 tabular-nums text-zinc-500">{r.bothPass}</td>
												<td className="pr-2 tabular-nums text-zinc-600">{r.bothFail}</td>
											</>
										)}
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				<div className="min-w-0">
					<TaskChips
						heading={`${name} failed · another arm passed`}
						tone="fail"
						jobName={focus.run.jobName}
						empty="none — no winnable misses on this sample"
						items={fumbles.map(f => ({
							task: f.task,
							title: `passed by ${f.passedBy.join(", ")}`,
							badge: `✓${f.passedBy.length}`,
						}))}
					/>
					<TaskChips
						heading={`only ${name} passed`}
						tone="win"
						jobName={focus.run.jobName}
						empty="none"
						items={uniques.map(t => ({ task: t, title: `${name} is the only arm that passed` }))}
					/>
				</div>
			</div>
		</section>
	);
}

type TaskFilter = "all" | "split" | "focus-fail" | "focus-pass";

/** Per-task outcome grid with filters; a focused arm highlights its column. */
function TaskMatrix({
	arms,
	tasks,
	matrix,
	taskStats,
	focus,
	onFocus,
}: {
	arms: ArmSummary[];
	tasks: string[];
	matrix: ExperimentDetail["matrix"];
	taskStats: Map<string, TaskStat>;
	focus: ArmSummary | null;
	onFocus: (key: string) => void;
}) {
	const [filter, setFilter] = useState<TaskFilter>("all");
	const [hardestFirst, setHardestFirst] = useState(false);
	const effective: TaskFilter = !focus && (filter === "focus-fail" || filter === "focus-pass") ? "all" : filter;
	const focusCells = focus ? (matrix[focus.arm] ?? {}) : null;
	const splitCount = tasks.filter(t => {
		const s = taskStats.get(t);
		return s !== undefined && s.passes > 0 && s.passes < s.decided;
	}).length;
	const visible = tasks.filter(task => {
		switch (effective) {
			case "all":
				return true;
			case "split": {
				const s = taskStats.get(task);
				return s !== undefined && s.passes > 0 && s.passes < s.decided;
			}
			case "focus-fail": {
				const s = focusCells?.[task]?.status;
				return isDecided(s) && s !== "pass";
			}
			case "focus-pass":
				return focusCells?.[task]?.status === "pass";
			default:
				return false;
		}
	});
	if (hardestFirst) {
		const rate = (t: string) => {
			const s = taskStats.get(t);
			return s !== undefined && s.decided > 0 ? s.passes / s.decided : Number.POSITIVE_INFINITY;
		};
		visible.sort((a, b) => rate(a) - rate(b) || a.localeCompare(b));
	}
	const chip = (id: TaskFilter, label: string, title?: string) => (
		<button
			key={id}
			type="button"
			title={title}
			onClick={() => setFilter(id)}
			className={`rounded px-2 py-0.5 ${effective === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
		>
			{label}
		</button>
	);
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
			<div className="mb-2 flex flex-wrap items-center gap-1 text-[11px]">
				<span className="mr-2 text-xs text-zinc-400">task matrix</span>
				{chip("all", `all ${tasks.length}`)}
				{chip("split", `split ${splitCount}`, "tasks where arms disagree")}
				{focus && chip("focus-fail", `✗ ${armName(focus)}`, `tasks ${armName(focus)} failed or errored`)}
				{focus && chip("focus-pass", `✓ ${armName(focus)}`, `tasks ${armName(focus)} passed`)}
				<button
					type="button"
					onClick={() => setHardestFirst(v => !v)}
					className="ml-auto text-zinc-500 hover:text-zinc-300"
					title="toggle task ordering"
				>
					sort: {hardestFirst ? "hardest first" : "name"}
				</button>
			</div>
			<div className="overflow-x-auto">
				<table className="text-xs">
					<thead>
						<tr>
							<th className="pr-1 text-left font-normal text-zinc-500">task</th>
							<th className="pr-3 text-right font-normal text-zinc-600" title="arms passing / arms decided">
								✓
							</th>
							{arms.map(arm => (
								<th key={arm.arm} className="px-1 text-left font-normal" style={{ writingMode: "vertical-rl" }}>
									<button
										type="button"
										onClick={() => onFocus(arm.arm)}
										title={focus?.arm === arm.arm ? "clear focus" : `focus ${armName(arm)}`}
										className={`${focus?.arm === arm.arm ? "text-sky-300" : "text-zinc-500"} hover:text-sky-200`}
									>
										{armName(arm)}
									</button>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{visible.map(task => {
							const stat = taskStats.get(task);
							return (
								<tr key={task} className="hover:bg-zinc-900/70">
									<td className="whitespace-nowrap pr-1 text-zinc-400" title={task}>
										{shortTask(task)}
									</td>
									<td className="pr-3 text-right tabular-nums text-zinc-600">
										{stat !== undefined && stat.decided > 0 ? `${stat.passes}/${stat.decided}` : "—"}
									</td>
									{arms.map(arm => {
										const cell = matrix[arm.arm]?.[task];
										return (
											<td
												key={arm.arm}
												className={`px-1 py-0.5 ${focus?.arm === arm.arm ? "bg-sky-400/10" : ""}`}
											>
												<a
													href={`#/runs/${encodeURIComponent(arm.run.jobName)}`}
													title={`${armName(arm)} · ${task}: ${cell ? cell.status : "pending"}${cell && cell.reward !== null ? ` · reward ${cell.reward.toFixed(2)}` : ""}`}
													className={`block h-3.5 w-3.5 rounded-sm ${cell ? (CELL_CLASS[cell.status] ?? "bg-zinc-600") : "bg-zinc-800"}`}
												/>
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
				{visible.length === 0 && (
					<div className="py-4 text-center text-xs text-zinc-600">no tasks match this filter</div>
				)}
			</div>
		</div>
	);
}

function ExperimentPage({ id }: { id: string }) {
	const [adding, setAdding] = useState(false);
	const [sort, setSort] = useState<SortSpec | null>(null);
	const [focusKey, setFocusKey] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [detail, refresh] = usePolled<ExperimentDetail>(`/api/experiments/${encodeURIComponent(id)}`, 3000);
	const toggleFocus = useCallback((key: string) => setFocusKey(f => (f === key ? null : key)), []);
	if (!detail) return <div className="p-10 text-zinc-500">loading…</div>;
	const { arms, tasks, matrix, goal } = detail;

	const focusArm = focusKey ? (arms.find(a => a.arm === focusKey) ?? null) : null;
	const anchor = focusArm ?? pickReferenceArm(arms);
	const rows = sortedArms(arms, sort);
	const taskStats = computeTaskStats(arms, matrix, tasks);
	const cycleSort = (key: SortKey) =>
		setSort(s =>
			!s || s.key !== key
				? { key, dir: SORT_START_DIR[key] }
				: s.dir === SORT_START_DIR[key]
					? { key, dir: (s.dir * -1) as 1 | -1 }
					: null,
		);

	const passBars = metricBars(
		arms,
		a => a.passPct,
		p => p.passPct,
	);
	const costBars = metricBars(
		arms,
		a => a.costPerTask,
		p => p.costPerTask,
	);
	const timeBars = metricBars(
		arms,
		a => (a.meanTrialMs === null ? null : a.meanTrialMs / 60000),
		p => p.meanTrialMs / 60000,
	);
	const scatterPts: ScatterPt[] = [];
	for (const a of arms) {
		const proj = a.run.status === "running" ? a.projected : null;
		const cost = proj ? proj.costPerTask : a.costPerTask;
		const pass = proj ? proj.passPct : a.passPct;
		if (cost === null || pass === null) continue;
		scatterPts.push({ key: a.arm, label: armName(a), role: a.run.role, projected: proj !== null, cost, pass });
	}
	const anchorPass = anchor?.passPct ?? anchor?.projected?.passPct ?? null;
	const anchorCost = anchor?.costPerTask ?? anchor?.projected?.costPerTask ?? null;
	const anchorTimeMs = anchor?.meanTrialMs ?? anchor?.projected?.meanTrialMs ?? null;
	const scatterAnchor = anchor ? (scatterPts.find(p => p.key === anchor.arm) ?? null) : null;

	return (
		<div className="mx-auto max-w-7xl p-6">
			<div className="mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<h2 className="text-lg font-semibold">{id}</h2>
				<span className="text-xs text-zinc-500">
					{arms.length} arms · {tasks.length} tasks
					{anchor && (
						<>
							{" "}
							· Δ vs <span className={focusArm ? "text-sky-300" : "text-zinc-400"}>{armName(anchor)}</span>
							<span className="text-zinc-600">{focusArm ? " (focused)" : " (ref)"}</span>
						</>
					)}
					{!focusArm && <span className="text-zinc-600"> · click an arm to focus it</span>}
				</span>
				<button
					type="button"
					onClick={() => setAdding(v => !v)}
					className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-xs hover:border-sky-400"
				>
					{adding ? "cancel" : "+ add arm"}
				</button>
			</div>
			<GoalEditor id={id} goal={goal} onSaved={refresh} />
			{adding && <AddArmForm experimentId={id} onDone={() => setAdding(false)} />}

			<table className="mb-6 w-full text-sm">
				<thead>
					<tr className="text-left text-xs text-zinc-500">
						<SortHeader label="arm" col="arm" sort={sort} onSort={cycleSort} />
						<SortHeader label="description" col="note" sort={sort} onSort={cycleSort} />
						<SortHeader label="status" col="status" sort={sort} onSort={cycleSort} />
						<SortHeader label="progress" col="progress" sort={sort} onSort={cycleSort} />
						<SortHeader label="eta" col="eta" sort={sort} onSort={cycleSort} />
						<SortHeader label="pass%" col="pass" sort={sort} onSort={cycleSort} />
						<SortHeader label="$/task" col="cost" sort={sort} onSort={cycleSort} />
						<SortHeader label="mean" col="time" sort={sort} onSort={cycleSort} />
						<th />
					</tr>
				</thead>
				<tbody>
					{rows.map(arm =>
						editing === arm.run.jobName ? (
							<ArmEditorRow
								key={arm.run.jobName}
								arm={arm}
								experimentId={id}
								onSaved={() => {
									setEditing(null);
									refresh();
								}}
								onCancel={() => setEditing(null)}
							/>
						) : (
							<ArmRow
								key={arm.run.jobName}
								arm={arm}
								anchor={anchor}
								focused={focusKey === arm.arm}
								onFocus={() => toggleFocus(arm.arm)}
								onEdit={() => setEditing(arm.run.jobName)}
							/>
						),
					)}
				</tbody>
			</table>

			{focusArm && (
				<FocusPanel
					arms={arms}
					matrix={matrix}
					tasks={tasks}
					taskStats={taskStats}
					focus={focusArm}
					onFocus={toggleFocus}
					onClear={() => setFocusKey(null)}
				/>
			)}

			<section className="mb-6">
				<div className="mb-2 flex select-none flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[9px] text-zinc-500">
					<span className="flex items-center gap-1">
						<i aria-hidden="true" className="h-2 w-2 rounded-[1px] bg-sky-500" /> baseline
					</span>
					<span className="flex items-center gap-1">
						<i aria-hidden="true" className="h-2 w-2 rounded-[1px] bg-emerald-500" /> variant
					</span>
					<span className="flex items-center gap-1">
						<i aria-hidden="true" className="h-2 w-2 rounded-[1px] border border-dashed border-zinc-400" />{" "}
						projected (running)
					</span>
					{anchor && (
						<span className="flex items-center gap-1">
							<i aria-hidden="true" className="h-2.5 w-0 border-l border-dashed border-zinc-300/80" />{" "}
							{armName(anchor)}
						</span>
					)}
				</div>
				<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
					<ScatterChart pts={scatterPts} anchor={scatterAnchor} focus={focusKey} onFocus={toggleFocus} />
					<BarChart
						title="success %"
						bars={passBars}
						best="high"
						format={v => `${v.toFixed(1)}%`}
						anchor={anchorPass}
						focus={focusKey}
						onFocus={toggleFocus}
					/>
					<BarChart
						title="$ / task"
						bars={costBars}
						best="low"
						format={fmtUsd}
						anchor={anchorCost}
						focus={focusKey}
						onFocus={toggleFocus}
					/>
					<BarChart
						title="mean minutes / task"
						bars={timeBars}
						best="low"
						format={v => `${v.toFixed(1)}m`}
						anchor={anchorTimeMs === null ? null : anchorTimeMs / 60000}
						focus={focusKey}
						onFocus={toggleFocus}
					/>
				</div>
			</section>

			<TaskMatrix
				arms={rows}
				tasks={tasks}
				matrix={matrix}
				taskStats={taskStats}
				focus={focusArm}
				onFocus={toggleFocus}
			/>
		</div>
	);
}

// ── runs (legacy flat view) ──────────────────────────────────────────────────

function useRunsSse(): RunRow[] | null {
	const [runs, setRuns] = useState<RunRow[] | null>(null);
	useEffect(() => {
		const es = new EventSource("/api/events");
		es.onmessage = ev => setRuns(JSON.parse(ev.data) as RunRow[]);
		return () => es.close();
	}, []);
	return runs;
}

function RunsPage({ selected }: { selected: string | null }) {
	const runs = useRunsSse();
	const [detail] = usePolled<{ run: RunRow; traces: TraceRow[] }>(
		selected ? `/api/runs/${encodeURIComponent(selected)}` : null,
		2500,
	);
	const [trace, setTrace] = useState<string | null>(null);
	const [traceData] = usePolled<{ entries: TranscriptEntry[] }>(
		selected && trace
			? `/api/runs/${encodeURIComponent(selected)}/traces/${encodeURIComponent(trace)}?tail=60`
			: null,
		2500,
	);
	const traceRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!traceData) return;
		const el = traceRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [traceData]);
	const cancel = useCallback(async (name: string) => {
		if (confirm(`stop ${name}?`)) await fetch(`/api/runs/${encodeURIComponent(name)}/cancel`, { method: "POST" });
	}, []);
	const resume = useCallback(async (name: string) => {
		if (!confirm(`resume ${name}? completed trials are kept; interrupted, pending, and errored ones re-run`)) return;
		const res = await fetch(`/api/runs/${encodeURIComponent(name)}/resume`, { method: "POST" });
		if (!res.ok) alert((await res.json().catch(() => null))?.error ?? `resume failed (${res.status})`);
	}, []);

	if (!runs) return <div className="p-10 text-zinc-500">loading…</div>;
	return (
		<div className="grid h-[calc(100vh-49px)] grid-cols-[minmax(420px,44%)_1fr]">
			<section className="overflow-auto border-r border-zinc-800">
				<table className="w-full text-sm">
					<thead className="sticky top-0 bg-zinc-900 text-xs text-zinc-500">
						<tr>
							<th className="px-3 py-1.5 text-left">run</th>
							<th className="text-left">status</th>
							<th className="text-left">progress</th>
							<th className="text-left">spend</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{runs.map(r => (
							<tr
								key={r.jobName}
								onClick={() => (location.hash = `#/runs/${encodeURIComponent(r.jobName)}`)}
								className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900 ${r.jobName === selected ? "bg-zinc-900" : ""}`}
							>
								<td className="px-3 py-1.5" title={r.models}>
									{r.jobName}
									<div className="text-[10px] uppercase tracking-wide text-zinc-600">{r.benchmark}</div>
									{(r.note || r.role) && (
										<div className="text-[11px] text-zinc-500">
											{r.role && (
												<span className={r.role === "baseline" ? "text-sky-500" : "text-emerald-500"}>
													{r.role}
												</span>
											)}
											{r.role && r.note ? " · " : ""}
											{r.note}
										</div>
									)}
								</td>
								<td>
									<Chip label={r.status} />
								</td>
								<td>
									<Progress run={r} />
								</td>
								<td>{fmtUsd(r.costUsd)}</td>
								<td>
									{r.status === "running" ? (
										<button
											type="button"
											onClick={ev => {
												ev.stopPropagation();
												void cancel(r.jobName);
											}}
											className="rounded border border-zinc-700 px-2 text-xs hover:border-red-500 hover:text-red-400"
										>
											stop
										</button>
									) : (
										r.benchmark === "harbor" &&
										(r.done < r.nTotal || r.error > 0) && (
											<button
												type="button"
												onClick={ev => {
													ev.stopPropagation();
													void resume(r.jobName);
												}}
												className="rounded border border-zinc-700 px-2 text-xs hover:border-emerald-500 hover:text-emerald-400"
											>
												resume
											</button>
										)
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
			<section className="flex flex-col overflow-hidden">
				{detail ? (
					<>
						<div className="border-b border-zinc-800 px-4 py-2 text-sm">
							<span className="font-semibold">{detail.run.jobName}</span> <Chip label={detail.run.status} />{" "}
							<span className="text-xs text-zinc-500">
								{detail.run.benchmark} · {detail.run.dataset} · {detail.run.models}
								{detail.run.score !== null ? ` · score ${(100 * detail.run.score).toFixed(1)}%` : ""}
								{detail.run.prewalk ? ` → ${detail.run.prewalk}` : ""}
							</span>
							<div className="mt-1 flex gap-3 text-xs text-zinc-400">
								{Object.entries(detail.run.metrics).map(([key, value]) => (
									<span key={key}>
										{key.replaceAll("_", " ")}: {value === null ? "—" : `${(100 * value).toFixed(1)}%`}
									</span>
								))}
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-auto">
							<table className="w-full text-sm">
								<tbody>
									{detail.traces.map(t => (
										<tr
											key={t.name}
											onClick={() => setTrace(t.name)}
											className={`cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900 ${t.name === trace ? "bg-zinc-900" : ""}`}
										>
											<td className="px-4 py-1">{t.task}</td>
											<td>
												<Chip label={t.status} />
											</td>
											<td>{t.reward === null ? "—" : t.reward.toFixed(3)}</td>
											<td>{fmtUsd(t.costUsd)}</td>
											<td>{t.durationMs ? fmtMin(t.durationMs) : "—"}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{trace && (
							<div ref={traceRef} className="h-2/5 overflow-auto border-t border-zinc-800 bg-zinc-950/60">
								{(traceData?.entries ?? []).map((e, i) => (
									// oxlint-disable-next-line react/no-array-index-key -- tail window, entries have no ids
									<div key={i} className="border-b border-zinc-900 px-4 py-2">
										<div className="text-xs text-zinc-500">
											{e.kind === "assistant" ? (e.model ?? "assistant") : (e.tool ?? e.kind)}
											{e.isError ? " · error" : ""}
										</div>
										{e.text && (
											<pre
												className={`whitespace-pre-wrap text-xs ${e.kind === "toolResult" ? "text-zinc-500" : ""} ${e.isError ? "text-red-400" : ""}`}
											>
												{e.text}
											</pre>
										)}
										{e.tools && e.tools.length > 0 && (
											<div className="text-xs text-sky-400">→ {e.tools.join(", ")}</div>
										)}
									</div>
								))}
							</div>
						)}
					</>
				) : (
					<div className="p-10 text-zinc-500">select a run</div>
				)}
			</section>
		</div>
	);
}

// ── launch form ──────────────────────────────────────────────────────────────

function LaunchForm({ onDone }: { onDone: () => void }) {
	const [msg, setMsg] = useState("");
	const submit = useCallback(
		async (ev: React.FormEvent<HTMLFormElement>) => {
			ev.preventDefault();
			const f = new FormData(ev.currentTarget);
			const body: Record<string, unknown> = { benchmark: f.get("benchmark"), model: f.get("model") };
			if (f.get("jobName")) body.jobName = f.get("jobName");
			if (f.get("dataset")) body.dataset = f.get("dataset");
			if (f.get("tasks")) body.tasks = Number(f.get("tasks"));
			if (f.get("concurrency")) body.concurrency = Number(f.get("concurrency"));
			if (f.get("timeoutMultiplier")) body.timeoutMultiplier = Number(f.get("timeoutMultiplier"));
			if (f.get("include")) {
				body.include = String(f.get("include"))
					.split(",")
					.map(s => s.trim())
					.filter(Boolean);
			}
			if (f.get("conditions")) {
				body.conditions = String(f.get("conditions"))
					.split(",")
					.map(s => s.trim())
					.filter(Boolean);
			}
			if (f.get("goal")) body.goal = f.get("goal");
			if (f.get("role")) body.role = f.get("role");
			if (f.get("note")) body.note = f.get("note");
			if (f.get("prewalkInto") || f.get("prewalk")) {
				body.prewalk = f.get("prewalkInto") ? { into: f.get("prewalkInto") } : {};
			}
			setMsg("launching…");
			const res = await fetch("/api/runs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const out = (await res.json()) as { jobName?: string; error?: string };
			setMsg(res.ok ? `launched ${out.jobName}` : `error: ${out.error}`);
			if (res.ok) setTimeout(onDone, 800);
		},
		[onDone],
	);
	const input = INPUT_CLASS;
	return (
		<form onSubmit={submit} className="grid grid-cols-4 gap-2 border-b border-zinc-800 bg-zinc-900/70 p-4 text-sm">
			<select name="benchmark" className={input}>
				<option value="harbor">Harbor</option>
				<option value="edit">TypeScript edit</option>
				<option value="snapcompact">SnapCompact</option>
			</select>
			<input name="model" placeholder="model (required)" required className={input} />
			<input name="dataset" placeholder="dataset (terminal-bench@2.0)" className={input} />
			<input name="jobName" placeholder="job name (exp-arm)" className={input} />
			<input name="tasks" type="number" placeholder="task/passages limit" className={input} />
			<input name="concurrency" type="number" placeholder="concurrency" className={input} />
			<input name="timeoutMultiplier" type="number" step="0.5" placeholder="timeout ×" className={input} />
			<input name="prewalkInto" placeholder="prewalk into (model)" className={input} />
			<label className="flex items-center gap-2 text-xs text-zinc-400">
				<input type="checkbox" name="prewalk" /> prewalk (default smol)
			</label>
			<input name="include" placeholder="include tasks, comma-sep" className={`${input} col-span-2`} />
			<input name="conditions" placeholder="SnapCompact conditions, comma-sep" className={`${input} col-span-2`} />
			<input
				name="goal"
				placeholder="experiment goal (what question does this answer?)"
				className={`${input} col-span-2`}
			/>
			<select name="role" className={input}>
				<option value="">role: unset</option>
				<option value="baseline">baseline</option>
				<option value="variant">variant</option>
			</select>
			<input name="note" placeholder="arm note (e.g. prewalk flash)" className={input} />
			<div className="col-span-4 flex items-center gap-3">
				<button type="submit" className="rounded border border-zinc-600 px-3 py-1 hover:border-sky-400">
					launch
				</button>
				<span className="text-xs text-zinc-500">{msg}</span>
			</div>
		</form>
	);
}

// ── shell ────────────────────────────────────────────────────────────────────

function App() {
	const hash = useHashRoute();
	const [showLaunch, setShowLaunch] = useState(false);
	useEffect(() => {
		if (hash !== undefined) {
			window.scrollTo(0, 0);
		}
	}, [hash]);
	const expMatch = hash.match(/^#\/exp\/(.+)$/);
	const runMatch = hash.match(/^#\/runs(?:\/(.+))?$/);
	const view = expMatch ? (
		<ExperimentPage id={decodeURIComponent(expMatch[1])} />
	) : runMatch ? (
		<RunsPage selected={runMatch[1] ? decodeURIComponent(runMatch[1]) : null} />
	) : (
		<ExperimentsIndex />
	);
	const tab = (href: string, label: string, active: boolean) => (
		<a
			href={href}
			className={`rounded px-2 py-0.5 ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
		>
			{label}
		</a>
	);
	return (
		<>
			<header className="sticky top-0 z-10 flex items-center gap-4 border-b border-zinc-800 bg-zinc-950/90 px-4 py-2 backdrop-blur">
				<h1 className="text-sm font-semibold tracking-wide">metaharness</h1>
				<nav className="flex gap-1 text-sm">
					{tab("#/", "experiments", !expMatch && !runMatch)}
					{tab("#/runs", "runs", !!runMatch)}
				</nav>
				<div className="ml-auto">
					<button
						type="button"
						onClick={() => setShowLaunch(s => !s)}
						className="rounded border border-zinc-700 px-3 py-1 text-sm hover:border-sky-400"
					>
						new run
					</button>
				</div>
			</header>
			{showLaunch && <LaunchForm onDone={() => setShowLaunch(false)} />}
			{view}
		</>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
