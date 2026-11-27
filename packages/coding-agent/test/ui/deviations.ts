/**
 * Every corpus stage where the new UI deliberately differs from the capture:
 * the one registry all corpus suites read and the deviation report
 * (`scripts/ui-deviation-report.ts`) renders side by side.
 *
 * An entry names the corpus screen dir, the case (`"*"`: every case), the
 * stages (indices or labels; all when omitted), the widths (all when
 * omitted), what differs (`rows` or the `native` tree), why, and a category.
 * Each suite decides how a listed stage is checked (most skip it; some fail
 * when a listed stage starts matching, so the list cannot go stale).
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export type DeviationKind = "rows" | "native";

/**
 * - `capture artifact`: the capture clocked or drove something differently than the running app does;
 * - `old bug`: the old UI drew something plainly wrong that the rewrite does not reproduce;
 * - `design change`: the new screen looks or describes itself differently on purpose;
 * - `natives build`: the capture's pi-natives binary differs from the one built from this commit.
 */
export type DeviationCategory = "capture artifact" | "old bug" | "design change" | "natives build";

/** One deliberate difference. */
export interface Deviation {
	/** Corpus screen dir (`tools/todo`, `transcript/tool/edit`, `overlays/agent-hub`). */
	readonly screen: string;
	/** Case file stem, without theme and extension (`success-lifecycle`); `"*"` for every case. */
	readonly case: string;
	/** Stage indices or labels; every stage when omitted. */
	readonly stages?: readonly (number | string)[];
	/** Recorded widths; every width when omitted. */
	readonly widths?: readonly number[];
	readonly kind: DeviationKind;
	readonly category: DeviationCategory;
	readonly reason: string;
	/** Rows: only the recorded rows whose plain text contains this are covered; the rest of the stage is compared. */
	readonly rowsContaining?: string;
	/** Native: applied to the recorded tree before it is compared; it changes exactly what the deviation covers. */
	readonly normalize?: (recorded: unknown) => unknown;
}

/** A stage of a corpus case. */
export interface StageRef {
	readonly screen: string;
	/** Case stem or file name (`<case>.<theme>.json`). */
	readonly case: string;
	readonly index: number;
	readonly label: string;
}

/** The chart cases were recorded with a fixed 624×208 chart; the chart renderer draws 720 wide at the height its rows need. */
const CHART_SIZE =
	"the recorded chart is 624×208; charts are drawn 720 wide at a height that follows their rows, so the image's rows (and what follows them) differ";

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ── tool screens and transcript tool flows ─────────────────────────────────

const SHIMMER_WALL_CLOCK =
	"the capture timed the shimmer band by the wall clock and the spinner by a frame number; one terminal clock drives both";
const STALE_COMPACT_ELAPSED = "the old 2-row compact cached its elapsed time between spinner ticks and still read `0s`";
const FORCED_SPINNER =
	"the capture forced a spinner frame after the args completed; the app stops the edit/write spinner once args complete";
const TODO_STRIKE = "a separate strike counter ran past its 9 frames; the strike now plays once on the spinner clock";
const TODO_COMPACT_GLYPH = "the strike animation counter leaked into the compact glyph and drew `⣾` on a settled row";
const STALE_SPINNER =
	"old non-animated renderers drew the spinner frame current at their last unrelated repaint; the transcript holds non-animated looks at their still glyph";
const OLD_COMPACT_ROW =
	"the old compact row's seconds stayed cached until the next allocation, and the capture ticked a spinner that never runs in production";
const TASK_GENERIC_NATIVE =
	"the capture's block drew the task card in the terminal but described the generic card natively (its built-in describe hooks were off for a tool carrying its own renderers); the block now shows the task view on both sides";

const MCP_MERGE =
	"the capture's MCP tool fixture lacked `mergeCallAndResult`, which production `MCPTool` sets: the finished card is the result view alone (frameless), not the call and result views combined";

const TOOLS: Deviation[] = [
	...["tools/mcp", "transcript/tool/mcp"].map((screen): Deviation => ({
		screen,
		case: "*",
		kind: "native",
		category: "capture artifact",
		reason: MCP_MERGE,
	})),
	// Stages with a (partial) result: the call's pending head row gives way to the result's.
	...Object.entries({
		"cancelled-while-running": ["partial result", "elapsed 4.2s", "sealed"],
		"compact-allocations-running": ["partial result"],
		"compact-allocations-settled": ["result", "allocation full"],
		error: ["error result", "expanded"],
		"image-result": ["image result", "images hidden"],
		"success-lifecycle": [
			"partial result",
			"result",
			"expanded",
			"collapsed",
			"native fold",
			"native unfold",
			"sealed",
		],
		"tool-activity-hidden": ["result", "activity shown"],
	}).map(([name, stages]): Deviation => ({
		screen: "transcript/tool/mcp",
		case: name,
		stages,
		kind: "rows",
		category: "capture artifact",
		reason: MCP_MERGE,
	})),
	...["result-single-phase-task-done", "result-single-phase-task-done-partial"].map((name): Deviation => ({
		screen: "tools/todo",
		case: name,
		stages: ["strike frame 14"],
		kind: "rows",
		category: "old bug",
		reason: TODO_STRIKE,
	})),
	...[
		["tools/vibe_list", "result-wall-partial"],
		["tools/vibe_wait", "result-wall-partial"],
		["tools/vibe_wait", "result-wall-wait-timed-out-partial"],
	].map(([screen, name]): Deviation => ({
		screen: screen!,
		case: name!,
		kind: "rows",
		category: "capture artifact",
		reason: SHIMMER_WALL_CLOCK,
	})),
	...[
		"result-all-running-widgets-partial",
		"result-mixed-statuses-partial",
		"result-one-running-no-widget-partial",
	].map((name): Deviation => ({
		screen: "tools/wait",
		case: name,
		stages: ["expanded"],
		kind: "rows",
		category: "capture artifact",
		reason: SHIMMER_WALL_CLOCK,
	})),
	...["bash", "read", "mystery_tool", "custom", "task", "edit", "write"].map((tool): Deviation => ({
		screen: `transcript/tool/${tool}`,
		case: "compact-allocations-running",
		stages: ["elapsed 4.2s"],
		kind: "rows",
		category: "capture artifact",
		reason: STALE_COMPACT_ELAPSED,
	})),
	...["edit", "write", "apply_patch", "edit-multi-file-preview"].map((tool): Deviation => ({
		screen: `transcript/tool/${tool}`,
		case: "success-lifecycle",
		stages: ["spinner frame 5", "elapsed 4.2s"],
		kind: "rows",
		category: "capture artifact",
		reason: FORCED_SPINNER,
	})),
	{
		screen: "transcript/tool/todo",
		case: "compact-allocations-settled",
		stages: ["allocation 1 row"],
		kind: "rows",
		category: "old bug",
		reason: TODO_COMPACT_GLYPH,
	},
	...["presenter-compact-bare", "presenter-compact-with-label-and-rows"].map((name): Deviation => ({
		screen: "transcript/tool/todo",
		case: name,
		stages: ["result", "presenter again"],
		kind: "rows",
		category: "old bug",
		reason: TODO_COMPACT_GLYPH,
	})),
	{
		screen: "transcript/tool/github",
		case: "success-lifecycle",
		stages: ["elapsed 4.2s"],
		kind: "rows",
		category: "old bug",
		reason: STALE_SPINNER,
	},
	{
		screen: "transcript/tool/mcp",
		case: "success-lifecycle",
		stages: ["spinner frame 6"],
		kind: "rows",
		category: "old bug",
		reason: STALE_SPINNER,
	},
	{
		screen: "transcript/tool/mcp",
		case: "compact-allocations-running",
		stages: ["elapsed 4.2s", "allocation 1 row"],
		kind: "rows",
		category: "capture artifact",
		reason: OLD_COMPACT_ROW,
	},
	{
		screen: "transcript/tool/task",
		case: "*",
		kind: "native",
		category: "old bug",
		reason: TASK_GENERIC_NATIVE,
	},
];

// ── apps ───────────────────────────────────────────────────────────────────

const NATIVES_HIGHLIGHT =
	"the capture's pi-natives binary highlighted these lines differently from the one built from this commit's crates (syntax token colors only)";

const APPS: Deviation[] = [
	{
		screen: "apps/git",
		case: "dirty-working-tree",
		stages: [17, 19, 32, 33, ...range(34, 42), 54],
		kind: "rows",
		category: "natives build",
		reason: NATIVES_HIGHLIGHT,
	},
	...["changed-file-stage-target-h12", "changed-file-unstage-target-h30"].map((name): Deviation => ({
		screen: "apps/git-diff-pane",
		case: name,
		stages: [10, 54],
		kind: "rows",
		category: "natives build",
		reason: NATIVES_HIGHLIGHT,
	})),
	{
		screen: "apps/log-viewer",
		case: "*",
		widths: [40],
		kind: "rows",
		category: "old bug",
		reason:
			"the old viewer drew itself at least 48 cells wide, past a 40-column terminal; the new frame fits the width it gets",
	},
];

// ── overlays: panels ───────────────────────────────────────────────────────

const PANELS: Deviation[] = [
	{
		screen: "overlays/context-viewer",
		case: "*",
		stages: [9, 10, ...range(27, 33)],
		kind: "rows",
		category: "capture artifact",
		reason:
			"the full-content view scrolls on ↓/PgDn; the old screen recorded these keys while its native face was active, so its rows never moved",
	},
	...(
		[
			["native-bar-keys", [2, 3]],
			["native-dock-keys", [3]],
		] as const
	).map(([name, stages]): Deviation => ({
		screen: "overlays/plan-review",
		case: name,
		stages,
		kind: "rows",
		category: "capture artifact",
		reason:
			"the old capture carried the body's scroll through each recorded width in turn (rounding at each); the new keeps one scroll share, so this width lands one row apart",
	})),
	{
		screen: "overlays/snapcompact-shape-preview",
		case: "*",
		kind: "rows",
		category: "old bug",
		reason: "the old caption overflowed the width; it is cut to the row",
	},
	{
		screen: "overlays/snapcompact-shape-preview",
		case: "kitty",
		kind: "rows",
		category: "design change",
		reason: "the sample image: the terminal backend draws a notice where the old screen drew Kitty placeholders",
	},
	...["capped", "tiny-cap"].map((name): Deviation => ({
		screen: "overlays/report-panel",
		case: name,
		stages: [10],
		kind: "rows",
		category: "capture artifact",
		reason:
			"End @40: the old panel kept the end offset of the last width it drew (120 columns) at every width; the new one scrolls to the end of the body at each width",
	})),
	{
		screen: "overlays/codex-reset-fireworks",
		case: "*",
		kind: "rows",
		category: "design change",
		reason:
			"the fireworks sky is a new animation (own stars, rockets and bursts); the banner rows match the old screen",
	},
];

// ── overlays: pickers ──────────────────────────────────────────────────────

/**
 * The capture's `message` activity rows are of no kind the hub knows: the
 * old hub drew their glyph as the text `undefined` (a `null` span natively);
 * the new one draws none.
 */
function withoutUnknownGlyph(native: unknown): unknown {
	if (Array.isArray(native)) return native.map(withoutUnknownGlyph);
	if (!native || typeof native !== "object") return native;
	const node = native as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key in node) {
		const value = node[key];
		out[key] =
			key === "spans" && Array.isArray(value) && value.length === 1 && value[0] === null
				? []
				: withoutUnknownGlyph(value);
	}
	return out;
}

const UNKNOWN_ACTIVITY_GLYPH =
	"the capture's activity rows are of a kind (`message`) the hub does not know: the old hub drew their glyph as the text `undefined` (a `null` span natively); the new one draws none";
const STALE_KILL_NOTICE =
	"the old hub re-described only on a repaint request, which `x` on a running agent does not make before its release settles: its native tree kept the cleared notice";
const PENDING_SPEND =
	"the old screen dropped the pending spend silently when an unknown account was selected (stage 3) and kept drawing the stale confirm strip, so its `cancel` closed the sheet; ours keeps the pending spend until `cancel` drops it";
const NO_NATIVE_LINKS =
	"the old browser had no native form (a Tern terminal clicks extension links in the transcript); the new one describes its link list";

const PICKERS: Deviation[] = [
	{
		screen: "overlays/reset-usage-selector",
		case: "many",
		stages: [5],
		kind: "native",
		category: "old bug",
		reason: PENDING_SPEND,
	},
	{
		screen: "overlays/reset-usage-selector",
		case: "many",
		stages: [5],
		kind: "rows",
		category: "old bug",
		reason: PENDING_SPEND,
	},
	{
		screen: "overlays/agent-hub",
		case: "*",
		kind: "native",
		category: "old bug",
		reason: UNKNOWN_ACTIVITY_GLYPH,
		normalize: withoutUnknownGlyph,
	},
	{
		screen: "overlays/agent-hub",
		case: "*",
		kind: "rows",
		category: "old bug",
		reason: UNKNOWN_ACTIVITY_GLYPH,
		rowsContaining: " undefined ",
	},
	...(
		[
			["roster-wide", 68],
			["roster-short", 48],
		] as const
	).map(([name, stage]): Deviation => ({
		screen: "overlays/agent-hub",
		case: name,
		stages: [stage],
		kind: "native",
		category: "old bug",
		reason: STALE_KILL_NOTICE,
	})),
	...["transcript", "long-history", "empty"].map((name): Deviation => ({
		screen: "overlays/link-browser",
		case: name,
		kind: "native",
		category: "design change",
		reason: NO_NATIVE_LINKS,
	})),
	{
		screen: "overlays/link-browser",
		case: "transcript",
		stages: [1, 2, 3],
		kind: "rows",
		category: "capture artifact",
		reason:
			"the old browser clamped its scroll offset by the width it painted last (120 columns in the capture), so its 40-column rows after the first stage show the 120-column offset; the new browser opens at the bottom of whatever width the terminal has",
	},
];

// ── setup and forms ────────────────────────────────────────────────────────

const ANIMATED = "animated frame (starfield/nebula/dissolve/outro backdrop): own animation, not the old one";
const NARROW_DROPDOWN =
	"dropdown window/arrows at 20 columns: the option window is sized from the rows left under the field, which differ there";
const SHORT_SCROLL =
	"a card shorter than its content (narrow widths, short terminals): its scroll offset and scrollbar thumb sit a row off where the old view kept its own scroll memory";

const SETUP: Deviation[] = [
	...(
		[
			["all-scenes-walkthrough", [...range(0, 6), 15, 16, 17]],
			["custom-scenes-mouse-and-resize", [...range(0, 6), 22, 23]],
			["native-skip-then-ctrl-c", [0, 1, 4, 5]],
			["outro-without-default-model", [0, 1, 4, 5]],
		] as const
	).map(([name, stages]): Deviation => ({
		screen: "setup/wizard",
		case: name,
		stages,
		kind: "rows",
		category: "design change",
		reason: ANIMATED,
	})),
	...["animation", "enter-skips", "native-skip"].map((name): Deviation => ({
		screen: "setup/startup-splash",
		case: name,
		kind: "rows",
		category: "design change",
		reason: ANIMATED,
	})),
	{
		screen: "forms/html-form",
		case: "rich-content",
		stages: range(0, 8),
		widths: [20, 40],
		kind: "rows",
		category: "design change",
		reason: SHORT_SCROLL,
	},
	{
		screen: "forms/html-form",
		case: "select-dropdown",
		stages: [3, 5, 10],
		widths: [20],
		kind: "rows",
		category: "design change",
		reason: NARROW_DROPDOWN,
	},
	{
		screen: "forms/html-form",
		case: "short-terminal-countdown-skip-notice",
		stages: range(0, 8),
		kind: "rows",
		category: "design change",
		reason: SHORT_SCROLL,
	},
];

// ── transcript figures and messages ────────────────────────────────────────

const LEGACY_FIGURES =
	"natively a figure is an `image` (an embed an `image`/`web`) node between Markdown runs; the old renderer described the terminal's fallback (one `md` with the fence, or legacy `rows`)";

const TRANSCRIPT: Deviation[] = [
	...[
		"images-hidden-embed-note-max-rows-3",
		"numeric-table-with-chart",
		"numeric-table-with-chart-kitty-images",
		"prose-broken-svg-prose",
		"prose-broken-svg-prose-kitty-images",
		"prose-iframe-embed",
		"prose-iframe-embed-kitty-images",
		"prose-missing-img-embed",
		"prose-missing-img-embed-kitty-images",
		"table-svg-table",
		"table-svg-table-kitty-images",
		"two-broken-svgs",
		"two-broken-svgs-kitty-images",
		"max-rows-0",
	].map((name): Deviation => ({
		screen: "transcript/figure-markdown",
		case: name,
		kind: "native",
		category: "design change",
		reason: LEGACY_FIGURES,
	})),
	...(
		[
			["transcript/table-chart", "kitty", [1], [120]],
			["transcript/table-chart", "no-images", [1], undefined],
			["transcript/figure-markdown", "numeric-table-with-chart-kitty-images", [0], [120]],
			["transcript/figure-markdown", "table-svg-table-kitty-images", [0], [120]],
		] as const
	).map(([screen, name, stages, widths]): Deviation => ({
		screen,
		case: name,
		stages: [...stages],
		...(widths ? { widths: [...widths] } : {}),
		kind: "rows",
		category: "capture artifact",
		reason: CHART_SIZE,
	})),
	{
		screen: "transcript/figure-markdown",
		case: "streaming-states",
		stages: [0, 4],
		kind: "native",
		category: "design change",
		reason: LEGACY_FIGURES,
	},
	{
		screen: "transcript/figure-markdown",
		case: "streaming-states",
		stages: [2],
		kind: "rows",
		category: "design change",
		reason:
			"pi-tui `md` (stream) highlights the open fence's unfinished last line (`<svg><rect`); today's draws it whole in the code color",
	},
	{
		screen: "transcript/message-divider",
		case: "cache-miss-icon-label",
		stages: [0],
		widths: [20],
		kind: "rows",
		category: "old bug",
		reason:
			"a label wider than the row with truncation off ran past the width; rows never exceed it now, so it is cut",
	},
];

// ── app corpus (interactive mode end to end) ────────────────────────────────

const APP_CORPUS: Deviation[] = [
	{
		screen: "app/dock",
		case: "model-cycle",
		stages: [4],
		kind: "rows",
		category: "capture artifact",
		reason:
			"the capture's `gotta` ghost after typing `go` came from the n-gram model of the capture machine's prompt history; replays turn word completion off, so the draft shows no ghost",
	},
	{
		screen: "app/turn",
		case: "tool-calls",
		stages: [8, 9],
		widths: [80],
		kind: "rows",
		category: "old bug",
		reason:
			"when Ctrl+O changed a card whose rows were already in scrollback, the old renderer appended a second copy of the whole card to scrollback; the new one replays history, so each row is in scrollback exactly once (the screen matches)",
	},
	{
		screen: "app/overlay",
		case: "settings",
		stages: [3, 4],
		widths: [80],
		kind: "rows",
		category: "old bug",
		reason:
			"the old fullscreen Settings panel kept its height on a 24-row terminal and drew only its bottom 24 rows (title, tabs and the selected row clipped off the top); the new panel fits the screen and scrolls its list",
	},
	{
		screen: "app/overlay",
		case: "settings",
		stages: [3, 4, 5],
		widths: [120],
		kind: "rows",
		category: "old bug",
		reason:
			"while the `/settings` completion popup was open the old renderer pushed 3 blank rows into scrollback (the screen and the transcript rows above match); the popup now draws over the live transcript without writing anything to history",
	},
];

export const DEVIATIONS: readonly Deviation[] = [
	...TOOLS,
	...APPS,
	...PANELS,
	...PICKERS,
	...SETUP,
	...TRANSCRIPT,
	...APP_CORPUS,
];

const byScreen = new Map<string, Deviation[]>();
for (const entry of DEVIATIONS) {
	const list = byScreen.get(entry.screen);
	if (list) list.push(entry);
	else byScreen.set(entry.screen, [entry]);
}

/** The case stem of a case name or file (`<case>.<theme>.json`). */
export function caseStem(name: string): string {
	return name.replace(/\.(dark|light)\.json$/, "").replace(/\.json$/, "");
}

/** Whether `entry` covers stage `ref` (any width when `width` is omitted). */
export function covers(entry: Deviation, ref: StageRef, width?: number | string): boolean {
	if (entry.screen !== ref.screen) return false;
	if (entry.case !== "*" && entry.case !== caseStem(ref.case)) return false;
	if (entry.stages && !entry.stages.includes(ref.index) && !entry.stages.includes(ref.label)) return false;
	// App stages key by size (`80x24`): the width is its leading number.
	return width === undefined || !entry.widths || entry.widths.includes(Number.parseInt(String(width), 10));
}

/** Every `kind` deviation covering stage `ref` (at `width`, or at any width when omitted). */
export function deviationsAt(ref: StageRef, kind?: DeviationKind, width?: number | string): Deviation[] {
	return (byScreen.get(ref.screen) ?? []).filter(
		entry => (kind === undefined || entry.kind === kind) && covers(entry, ref, width),
	);
}

/** Deviations that skip the whole comparison (not row masks or native normalizers). */
export function skipsAt(ref: StageRef, kind: DeviationKind, width?: number | string): Deviation | undefined {
	return deviationsAt(ref, kind, width).find(entry => !entry.rowsContaining && !entry.normalize);
}

// ── capture for the deviation report ───────────────────────────────────────

/** A stage as the new UI drew it, for the deviation report. */
export interface StageCapture {
	readonly screen: string;
	/** Case file (`<case>.<theme>.json`) or stem (dark theme). */
	readonly file: string;
	readonly index: number;
	readonly label: string;
	/** Painted rows by width. */
	readonly rows: Readonly<Record<string, readonly string[]>>;
	/** Described native tree (absent when the suite did not compare it). */
	readonly native?: unknown;
	/** The recorded tree as the suite compared it, when it rewrote it (format canonicalisation). */
	readonly expectedNative?: unknown;
}

/** Directory `scripts/ui-deviation-report.ts` collects captures in; unset in normal runs. */
const CAPTURE_DIR = Bun.env.PI_UI_DEVIATION_DUMP;

/** Whether stages are being captured for the deviation report. */
export const capturing = CAPTURE_DIR !== undefined && CAPTURE_DIR !== "";

/** Record a stage a listed deviation covers (no-op outside a deviation-report run). */
export function captureStage(capture: StageCapture): void {
	if (!capturing) return;
	const ref = {
		screen: capture.screen,
		case: capture.file,
		index: capture.index,
		label: capture.label,
	};
	if (deviationsAt(ref).length === 0) return;
	fs.appendFileSync(path.join(CAPTURE_DIR!, `${process.pid}.jsonl`), `${JSON.stringify(capture)}\n`);
}

// ── tool suites ────────────────────────────────────────────────────────────

/** A stage's comparison outcome: null fields matched. */
export interface StageResult {
	readonly label: string;
	readonly native: string | null;
	readonly rows: Readonly<Record<string, string | null>>;
	/** Stage index. */
	readonly index: number;
	/** Painted rows by width and the described tree, kept only while {@link capturing}. */
	readonly painted?: Readonly<Record<string, readonly string[]>>;
	readonly described?: unknown;
}

/**
 * One test for a corpus stage: it must match, or, when it has a listed row
 * deviation, still differ (so a fixed or vanished deviation fails). A listed
 * native deviation leaves the native tree out of the comparison.
 */
export function stageTest(screen: string, file: string, result: StageResult): void {
	const ref = { screen, case: file, index: result.index, label: result.label };
	if (result.painted)
		captureStage({
			screen,
			file,
			index: result.index,
			label: result.label,
			rows: result.painted,
			native: result.described,
		});
	const failures: string[] = [];
	if (result.native && !skipsAt(ref, "native")) failures.push(`native: ${result.native}`);
	for (const width in result.rows) {
		const diff = result.rows[width];
		if (diff) failures.push(`rows@${width}: ${diff}`);
	}
	const deviation = skipsAt(ref, "rows");
	if (deviation) {
		test(`${file} · ${result.label} [deviation: ${deviation.category}: ${deviation.reason}]`, () => {
			expect(failures).not.toEqual([]);
		});
		return;
	}
	test(`${file} · ${result.label}`, () => {
		expect(failures).toEqual([]);
	});
}
